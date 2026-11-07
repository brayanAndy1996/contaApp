import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { igvEsperado, Money, TASA_IGV_18 } from "@contapp/domain";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorTransitorio,
} from "../errores.js";
import type {
  FilaPropuestaSire,
  FilaVentaSire,
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

/** Fila de cualquiera de los dos libros: el fixture del libro pedido ya trae sus columnas. */
type FilaSire = FilaPropuestaSire | FilaVentaSire;

/**
 * Arma la propuesta del libro pedido. Los archivos `{ruc}-{libro}-{periodo}.json` y `generico-{libro}.json`
 * son del libro que su nombre dice, así que las filas ya tienen la forma de ese libro; aquí solo se
 * estrecha el tipo para que la unión por `libro` quede bien formada.
 */
function armar(
  libro: LibroSire,
  periodo: string,
  filas: FilaSire[],
): PropuestaSire {
  return libro === "ventas"
    ? { libro, periodo, filas: filas as FilaVentaSire[] }
    : { libro, periodo, filas: filas as FilaPropuestaSire[] };
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
      // `resolver` solo lanza instancias de `Error` (los errores del paquete o un fallo de programación).
      return Promise.reject(e as Error);
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
    if (propio !== null) return armar(libro, periodo, propio);

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
    return armar(libro, periodo, filas);
  }

  /** Filas del archivo, o `null` si no existe. Un archivo ilegible o fuera de forma es `ErrorDatos`. */
  private leer(nombre: string): FilaSire[] | null {
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
      return filas as FilaSire[];
    } catch {
      throw new ErrorDatos();
    }
  }
}

// --- Volumen de compras para CA-15 (spec 014, T7) ----------------------------------------------------------------

/** Contribuyente de prueba: titular de las propuestas, no es un proveedor. */
const RUC_CONTRIBUYENTE_PRUEBA = "20700000002";
const ARCHIVO_RUCS_PRUEBA = join(__dirname, "..", "..", "..", "..", "fixtures", "rucs-prueba.json");

const CERO = "0.00";
const BASES_PEN = ["100.00", "250.50", "84.75", "1200.00", "35.20", "560.00", "19.90", "3400.00"];
const BASES_DGNG = ["40.00", "12.50"];
const BASES_USD = ["150.00", "75.25", "1000.00"];
/** 3 bolsas × 0.50: el mismo valor de prueba de 009 (ICBPER). */
const ICBPER_PRUEBA = "1.50";

interface Proveedor {
  ruc: string;
  razonSocial: string;
}

/** Proveedores de `fixtures/rucs-prueba.json` sin el contribuyente: la única fuente de RUC de prueba. */
function proveedoresDePrueba(): Proveedor[] {
  let datos: unknown;
  try {
    datos = JSON.parse(readFileSync(ARCHIVO_RUCS_PRUEBA, "utf8"));
  } catch {
    throw new ErrorDatos();
  }
  if (!Array.isArray(datos)) throw new ErrorDatos();
  const proveedores: Proveedor[] = [];
  for (const r of datos as Array<{ ruc?: unknown; razonSocial?: unknown } | null>) {
    const ruc = r?.ruc;
    const razonSocial = r?.razonSocial;
    if (typeof ruc !== "string" || typeof razonSocial !== "string") throw new ErrorDatos();
    if (ruc !== RUC_CONTRIBUYENTE_PRUEBA) proveedores.push({ ruc, razonSocial });
  }
  if (proveedores.length === 0) throw new ErrorDatos();
  return proveedores;
}

/** Número de comprobante `i` (desde 0): único, sin ceros a la izquierda y con último dígito 0-6 (sin centinelas). */
function numeroSinCentinela(i: number): string {
  const n = i + 1;
  return String(Math.floor(n / 7) * 10 + (n % 7));
}

function elegir(lista: readonly string[], i: number): string {
  const valor = lista[i % lista.length];
  if (valor === undefined) throw new ErrorDatos();
  return valor;
}

type IdentidadFila = Pick<
  FilaPropuestaSire,
  "tipo" | "serie" | "numero" | "rucContraparte" | "razonSocialContraparte" | "fechaEmision"
>;

/**
 * Una fila de volumen, en cuatro formas según `i`: USD con TC 3.300 (cada 20), PEN mixta DG + DGNG (cada 5, desde
 * el 2), PEN con ICBPER (cada 5, desde el 4) y PEN gravada (el resto). El IGV es el de 010 (`igvEsperado`).
 */
function filaDeVolumen(i: number, id: IdentidadFila): FilaPropuestaSire {
  if (i % 20 === 19) {
    const bi = Money.desde(elegir(BASES_USD, i), "USD");
    const igv = igvEsperado(bi, TASA_IGV_18);
    return {
      ...id,
      moneda: "USD",
      tipoCambio: "3.300",
      biDg: bi.toString(),
      igvDg: igv.toString(),
      biDgng: CERO,
      igvDgng: CERO,
      biDng: CERO,
      igvDng: CERO,
      noGravado: CERO,
      isc: CERO,
      icbper: CERO,
      otros: CERO,
      total: Money.suma([bi, igv], "USD").toString(),
    };
  }
  const bi = Money.desde(elegir(BASES_PEN, i), "PEN");
  const igv = igvEsperado(bi, TASA_IGV_18);
  const ng = i % 5 === 2 ? Money.desde(elegir(BASES_DGNG, i), "PEN") : Money.cero("PEN");
  const igvNg = igvEsperado(ng, TASA_IGV_18);
  const icbper = i % 5 === 4 ? Money.desde(ICBPER_PRUEBA, "PEN") : Money.cero("PEN");
  return {
    ...id,
    moneda: "PEN",
    biDg: bi.toString(),
    igvDg: igv.toString(),
    biDgng: ng.toString(),
    igvDgng: igvNg.toString(),
    biDng: CERO,
    igvDng: CERO,
    noGravado: CERO,
    isc: CERO,
    icbper: icbper.toString(),
    otros: CERO,
    total: Money.suma([bi, igv, ng, igvNg, icbper], "PEN").toString(),
  };
}

/**
 * Filas de compras para el caso de volumen de CA-15: 5.000 por defecto, del periodo `periodo` (AAAAMM).
 * Deterministas: la misma entrada da el mismo arreglo, y una cantidad menor da su prefijo. Sin RUC reales: los RUC
 * y las razones sociales son los de `fixtures/rucs-prueba.json` (sin el contribuyente). Los números de comprobante
 * son únicos y terminan en 0-6, así que ningún número cae en un centinela. Montos con `Money`. No se guarda como
 * archivo: el mock rechaza los de más de 1 MiB.
 */
export function generarFilasComprasVolumen(cantidad = 5_000, periodo = "202610"): FilaPropuestaSire[] {
  const coincidencia = PERIODO.exec(periodo);
  if (coincidencia === null || !Number.isInteger(cantidad) || cantidad < 0) throw new ErrorDatos();
  const anio = coincidencia[1] ?? "";
  const mes = coincidencia[2] ?? "";
  const proveedores = proveedoresDePrueba();
  const filas: FilaPropuestaSire[] = [];
  for (let i = 0; i < cantidad; i += 1) {
    const proveedor = proveedores[i % proveedores.length];
    if (proveedor === undefined) throw new ErrorDatos();
    filas.push(
      filaDeVolumen(i, {
        tipo: "01",
        serie: "F001",
        numero: numeroSinCentinela(i),
        rucContraparte: proveedor.ruc,
        razonSocialContraparte: proveedor.razonSocial,
        fechaEmision: `${anio}-${mes}-${String(1 + (i % 28)).padStart(2, "0")}`,
      }),
    );
  }
  return filas;
}
