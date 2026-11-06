import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorTransitorio,
} from "../errores.js";
import type {
  FilaPropuestaSire,
  LibroSire,
  PropuestaSire,
  SireApiClient,
  SolicitudPropuesta,
  TokenSire,
} from "../puertos.js";

export type ModoFallaSireApi = "401" | "timeout" | "5xx" | "datos" | null;

export interface OpcionesMockSireApiClient {
  /** Carpeta de `{ruc}-{libro}-{periodo}.json` y `generico-{libro}.json`. Por defecto `fixtures/sire`. */
  dirFixtures?: string;
}

/** Solicitud tal como la vio el mock. Nunca incluye el token ni credenciales. */
export interface RegistroSireApi {
  ruc: string;
  periodo: string;
  libro: LibroSire;
}

// Se resuelve desde la ubicación de este archivo (misma profundidad en `src/mock` y `dist/mock`) y no
// desde el `cwd`, porque el worker corre en `apps/worker`.
const DIR_POR_DEFECTO = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "sire",
);

const TOPE_BYTES = 1_048_576;
const RUC = /^\d{11}$/;
const PERIODO = /^(\d{4})(0[1-9]|1[0-2])$/;

function esLibro(valor: unknown): valor is LibroSire {
  return valor === "compras" || valor === "ventas";
}

/** Último día del mes (`mes` 1-12), para no inventar fechas como 31 de abril. */
function ultimoDia(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/**
 * Adaptador en memoria de `SireApiClient` (`SIRE_CLIENT=mock`): propuesta mensual desde
 * `fixtures/sire/{ruc}-{libro}-{periodo}.json`; si no existe, el conjunto genérico del libro.
 *
 * Genérico: las filas no llevan RUC del contribuyente, así que «ajustar al RUC» no cambia nada; el
 * periodo pedido reemplaza al de la plantilla y cada `fechaEmision` pasa a ese mes (mismo día, sin pasar
 * del fin de mes). Determinista.
 *
 * Entrada validada antes de tocar el disco: RUC de 11 dígitos, periodo `AAAAMM` con mes 01-12 y libro
 * `compras` o `ventas`; si no, `ErrorDatos`. Un token vacío da `ErrorCredencial`. El token no se conserva.
 *
 * Centinelas (último dígito del RUC): `7` -> `ErrorTransitorio`, `8` -> `ErrorDatos`, `9` ->
 * `ErrorCredencial`. `fallar(modo, {veces?})` fuerza el fallo de todas las llamadas (o de las
 * siguientes `veces`) y tiene prioridad sobre los centinelas.
 */
export class MockSireApiClient implements SireApiClient {
  private readonly dir: string;
  private readonly porRuc = new Map<string, number>();
  private readonly historial: RegistroSireApi[] = [];
  private total = 0;
  private modo: ModoFallaSireApi = null;
  private restantes: number | null = null;

  constructor(opciones: OpcionesMockSireApiClient = {}) {
    this.dir = opciones.dirFixtures ?? DIR_POR_DEFECTO;
  }

  get llamadas(): number {
    return this.total;
  }

  llamadasDe(ruc: string): number {
    return this.porRuc.get(ruc) ?? 0;
  }

  /** Solicitudes recibidas, en orden. Sin token ni credenciales. */
  registro(): readonly RegistroSireApi[] {
    return this.historial.map((r) => ({ ...r }));
  }

  fallar(modo: ModoFallaSireApi, opciones: { veces?: number } = {}): void {
    this.modo = modo;
    this.restantes = modo === null ? null : (opciones.veces ?? null);
  }

  descargarPropuesta(
    token: TokenSire,
    solicitud: SolicitudPropuesta,
  ): Promise<PropuestaSire> {
    try {
      return Promise.resolve(this.resolver(token, solicitud));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new ErrorTransitorio());
    }
  }

  private resolver(
    token: TokenSire,
    solicitud: SolicitudPropuesta,
  ): PropuestaSire {
    const { ruc, periodo, libro } = solicitud;
    this.total += 1;
    if (typeof ruc === "string") {
      this.porRuc.set(ruc, this.llamadasDe(ruc) + 1);
    }

    // Antes de tocar el disco, y antes de armar ninguna ruta.
    const coincidencia = typeof periodo === "string" ? PERIODO.exec(periodo) : null;
    if (
      typeof ruc !== "string" ||
      !RUC.test(ruc) ||
      coincidencia === null ||
      !esLibro(libro)
    ) {
      throw new ErrorDatos();
    }
    this.historial.push({ ruc, periodo, libro });

    if (typeof token?.token !== "string" || token.token.length === 0) {
      throw new ErrorCredencial();
    }

    if (this.modo !== null) {
      const modo = this.modo;
      if (this.restantes !== null) {
        this.restantes -= 1;
        if (this.restantes <= 0) {
          this.modo = null;
          this.restantes = null;
        }
      }
      if (modo === "401") throw new ErrorCredencial();
      if (modo === "datos") throw new ErrorDatos();
      throw new ErrorTransitorio();
    }

    const ultimo = ruc.slice(-1);
    if (ultimo === "7") throw new ErrorTransitorio();
    if (ultimo === "8") throw new ErrorDatos();
    if (ultimo === "9") throw new ErrorCredencial();

    const propio = this.leer(`${ruc}-${libro}-${periodo}.json`);
    if (propio !== null) return { libro, periodo, filas: propio };

    const plantilla = this.leer(`generico-${libro}.json`);
    if (plantilla === null) throw new ErrorDatos();
    const anio = Number(coincidencia[1]);
    const mes = Number(coincidencia[2]);
    const tope = ultimoDia(anio, mes);
    const filas = plantilla.map((fila) => {
      const dia = Math.min(Number(fila.fechaEmision.slice(8, 10)) || 1, tope);
      return {
        ...fila,
        fechaEmision: `${coincidencia[1]}-${coincidencia[2]}-${String(dia).padStart(2, "0")}`,
      };
    });
    return { libro, periodo, filas };
  }

  /** Filas del archivo, o `null` si no existe. Un archivo ilegible o fuera de forma es `ErrorDatos`. */
  private leer(nombre: string): FilaPropuestaSire[] | null {
    const ruta = join(this.dir, nombre);
    let tamano: number;
    try {
      tamano = statSync(ruta).size;
    } catch {
      return null;
    }
    if (tamano > TOPE_BYTES) throw new ErrorDatos();
    try {
      const datos: unknown = JSON.parse(readFileSync(ruta, "utf8"));
      const filas = (datos as { filas?: unknown } | null)?.filas;
      if (!Array.isArray(filas)) throw new ErrorDatos();
      return filas as FilaPropuestaSire[];
    } catch {
      throw new ErrorDatos();
    }
  }
}
