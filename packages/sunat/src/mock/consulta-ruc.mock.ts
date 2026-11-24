import { createHash } from "node:crypto";
import { ErrorDatos, ErrorTransitorio } from "../errores.js";
import type { ConsultaRuc, DatosRuc } from "../puertos.js";
import { dirFixturesRucPorDefecto, leerFixtureCiiu } from "./ruta-fixture.js";

export type ModoFallaConsultaRuc = "timeout" | "5xx" | "datos" | null;

export interface OpcionesMockConsultaRuc {
  /** Carpeta con `ciiu.json`. Por defecto `fixtures/ruc` del repositorio. */
  dirFixtures?: string;
}

const RE_RUC = /^[0-9]{11}$/;
const RE_CIIU = /^[0-9]{4}$/;

/** Clases CIIU (rev. 4) que el mock reparte, de forma determinista por RUC, a los que no están en el fixture. */
const CLASES_MOCK: readonly string[] = [
  "4711",
  "4719",
  "4752",
  "4771",
  "4772",
  "5610",
  "4659",
  "4663",
  "4921",
  "6201",
  "6920",
  "7020",
  "8559",
  "9602",
];

type Fixture = { ok: true; porRuc: Map<string, string | null> } | { ok: false };

/**
 * Adaptador en memoria de `ConsultaRuc` (`RUC_CLIENT=mock`). Determinista por RUC: la razón social deriva
 * de un hash del RUC y nunca es la provisional «RUC <ruc>».
 *
 * Centinelas (último dígito del RUC), para simular fallos con el stack real sin código:
 * - termina en `7` -> `ErrorTransitorio` (se reintenta);
 * - termina en `8` -> `ErrorDatos` (no se reintenta).
 *
 * `fallar(modo, {veces?})` fuerza el fallo de todas las llamadas (o de las siguientes `veces`).
 *
 * CIIU (spec 027, R-14): `{dirFixtures}/ciiu.json` es `{ruc: clase | null}`. Un RUC del fixture devuelve su clase;
 * otro, una clase determinista de `CLASES_MOCK` según el hash del RUC. Un fixture defectuoso hace que `consultar`
 * rechace con `ErrorDatos` de mensaje fijo (nunca lleva el RUC ni la ruta).
 */
export class MockConsultaRuc implements ConsultaRuc {
  private readonly porRuc = new Map<string, number>();
  private total = 0;
  private modo: ModoFallaConsultaRuc = null;
  private restantes: number | null = null;
  private readonly dirFixtures: string;
  private fixture: Promise<Fixture> | null = null;

  constructor(opciones: OpcionesMockConsultaRuc = {}) {
    this.dirFixtures = opciones.dirFixtures ?? dirFixturesRucPorDefecto();
  }

  get llamadas(): number {
    return this.total;
  }

  llamadasDe(ruc: string): number {
    return this.porRuc.get(ruc) ?? 0;
  }

  fallar(
    modo: ModoFallaConsultaRuc,
    opciones: { veces?: number } = {},
  ): void {
    this.modo = modo;
    this.restantes = modo === null ? null : (opciones.veces ?? null);
  }

  async consultar(ruc: string): Promise<DatosRuc> {
    this.total += 1;
    this.porRuc.set(ruc, this.llamadasDe(ruc) + 1);

    if (this.modo !== null) {
      const modo = this.modo;
      if (this.restantes !== null) {
        this.restantes -= 1;
        if (this.restantes <= 0) {
          this.modo = null;
          this.restantes = null;
        }
      }
      throw modo === "datos" ? new ErrorDatos() : new ErrorTransitorio();
    }

    const ultimo = ruc.slice(-1);
    if (ultimo === "7") throw new ErrorTransitorio();
    if (ultimo === "8") throw new ErrorDatos();

    const fixture = await this.cargarFixture();
    if (!fixture.ok) throw new ErrorDatos();

    const sufijo = createHash("sha256")
      .update(`mock-ruc:${ruc}`)
      .digest("hex")
      .slice(0, 8)
      .toUpperCase();
    return {
      razonSocial: `EMPRESA MOCK ${sufijo} S.A.C.`,
      estado: "ACTIVO",
      condicion: "HABIDO",
      ciiu: fixture.porRuc.has(ruc)
        ? (fixture.porRuc.get(ruc) as string | null)
        : claseDeterminista(ruc),
    };
  }

  private cargarFixture(): Promise<Fixture> {
    this.fixture ??= leerFixture(this.dirFixtures);
    return this.fixture;
  }
}

/** Una clase de la lista fija, elegida por el hash del RUC: sin reloj ni azar. */
function claseDeterminista(ruc: string): string {
  const h = createHash("sha256").update(`mock-ciiu:${ruc}`).digest();
  return CLASES_MOCK[h.readUInt32BE(0) % CLASES_MOCK.length] as string;
}

/** Nunca rechaza: un defecto (lectura o contenido) se resume en `{ok: false}`. */
async function leerFixture(dir: string): Promise<Fixture> {
  let texto: string | null;
  try {
    texto = await leerFixtureCiiu(dir);
  } catch {
    return { ok: false };
  }
  const porRuc = new Map<string, string | null>();
  if (texto === null) return { ok: true, porRuc };
  let datos: unknown;
  try {
    datos = JSON.parse(texto);
  } catch {
    return { ok: false };
  }
  if (typeof datos !== "object" || datos === null || Array.isArray(datos)) {
    return { ok: false };
  }
  for (const [ruc, clase] of Object.entries(datos)) {
    if (!RE_RUC.test(ruc)) return { ok: false };
    if (clase !== null && !(typeof clase === "string" && RE_CIIU.test(clase))) {
      return { ok: false };
    }
    porRuc.set(ruc, clase);
  }
  return { ok: true, porRuc };
}
