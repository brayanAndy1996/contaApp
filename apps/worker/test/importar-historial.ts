// Soporte de las pruebas de integración del worker de la spec 025 (T5, rojo). No es código de producción ni una prueba.
// Lee y siembra con el rol administrativo (sin RLS ni grants; sí triggers y FK) y llama a las funciones acotadas de BD como
// lo hace el backend (rol `contapp_backend`, plan 025, Contratos: BD).
//
// CONTRATO que fija (T11 worker, T10 BD, T9 cola y puerto), además del de `ventas.ts` y `compras.ts`:
// - Tipo de trabajo `reglas.historial.importar`, parámetros `{importacionId}`; el worker lee los periodos y el cliente de la
//   fila de la importación (`regla_importacion`), no del payload.
// - `SireApiClient.descargarRegistroPresentado(token, {ruc, periodo}) -> {libro: "compras", periodo, filas}` (D-2, U-1). El
//   mock lo resuelve con `{ruc}-registro-compras-{periodo}.json` y `{ruc}-registro-sin-datos.json` (lista de periodos).
// - Tablas `regla_importacion` y `regla_candidata` con las columnas de plan.md (0061); funciones `reglas_importacion_iniciar`,
//   `reglas_importacion_trabajo`, `reglas_candidatas_activar` (0062).
// Todo lo sintético: razones sociales y RUC de proveedor inventados (RUC con dígito verificador válido).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContappDb } from "@contapp/db";
import {
  aPublicable,
  encolar,
  publicar,
  type EntradaEncolar,
} from "@contapp/queue";
import {
  MockSireApiClient,
  type FilaPropuestaSire,
  type SireApiClient,
  type SolicitudPropuesta,
  type TokenSire,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import { compuerta } from "./trabajos.js";
import type { MundoVentas } from "./ventas.js";

export const TIPO_IMPORTAR = "reglas.historial.importar";
/** Seis periodos del mes anterior hacia atrás (la prueba corre «el 2026-11-21»). */
export const PERIODOS_6 = [
  "202610",
  "202609",
  "202608",
  "202607",
  "202606",
  "202605",
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Falta de implementación: las pruebas fallan con un mensaje «no implementado» y no con un error de SQL o de cola
// ---------------------------------------------------------------------------------------------------------------

async function conAviso<T>(que: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string; name?: string };
    if (
      err.code === "42883" || // función inexistente
      err.code === "42P01" || // tabla inexistente
      err.name === "TipoInvalidoError" ||
      /tipo .*(registrad|desconocid|inv[aá]lid)/i.test(err.message ?? "")
    )
      throw new Error(`no implementado: ${que}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// RUC de proveedor y filas del registro
// ---------------------------------------------------------------------------------------------------------------

/** RUC de proveedor de prueba número `n`: `206` + 7 dígitos + dígito verificador (módulo 11). */
export function rucProveedor(n: number): string {
  const base = `206${String(n).padStart(7, "0")}`;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(base[i]), 0);
  return `${base}${(11 - (suma % 11)) % 10}`;
}

const centavos = (s: string): bigint => {
  const neg = s.startsWith("-");
  const [e, d = "00"] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(`${e}${d.padEnd(2, "0").slice(0, 2)}`);
  return neg ? -v : v;
};
const dinero = (c: bigint): string => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
};

export type DestinoFila = "DG" | "DGNG" | "DNG" | "MIXTA" | "CERO";

export interface OpcionesFilaRegistro {
  periodo: string;
  numero: string;
  /** Va tal cual en `rucContraparte` (puede traer espacios o ser «-»). */
  ruc: string;
  razon?: string;
  destino: DestinoFila;
  tipo?: string;
  tipoDoc?: string;
  /** Base y IGV del destino (por omisión 100.00 y 18.00). */
  base?: string;
  igv?: string;
  /** Nota de crédito: todos los montos con signo negativo. */
  negativa?: boolean;
}

const CERO = "0.00";

/** Fila de compras del registro presentado con la base en el destino pedido (el resto en cero). */
export function filaRegistro(o: OpcionesFilaRegistro): FilaPropuestaSire {
  const base = o.base ?? "100.00";
  const igv = o.igv ?? "18.00";
  const m = {
    biDg: CERO,
    igvDg: CERO,
    biDgng: CERO,
    igvDgng: CERO,
    biDng: CERO,
    igvDng: CERO,
    noGravado: CERO,
    total: CERO,
  };
  switch (o.destino) {
    case "DG":
      Object.assign(m, { biDg: base, igvDg: igv });
      break;
    case "DGNG":
      Object.assign(m, { biDgng: base, igvDgng: igv });
      break;
    case "DNG":
      Object.assign(m, { biDng: base, igvDng: igv });
      break;
    case "MIXTA":
      Object.assign(m, {
        biDg: "60.00",
        igvDg: "10.80",
        biDgng: "40.00",
        igvDgng: "7.20",
      });
      break;
    case "CERO":
      Object.assign(m, { noGravado: "50.00" });
      break;
  }
  const total = dinero(
    [m.biDg, m.igvDg, m.biDgng, m.igvDgng, m.biDng, m.igvDng, m.noGravado]
      .map(centavos)
      .reduce((a, b) => a + b, 0n),
  );
  const montos = { ...m, total };
  const firmado = o.negativa
    ? Object.fromEntries(
        Object.entries(montos).map(([k, v]) => [
          k,
          v === CERO ? v : dinero(-centavos(v)),
        ]),
      )
    : montos;
  return {
    tipo: o.tipo ?? "01",
    serie: "F001",
    numero: o.numero,
    rucContraparte: o.ruc,
    ...(o.tipoDoc === undefined ? {} : { tipoDocContraparte: o.tipoDoc }),
    ...(o.razon === undefined ? {} : { razonSocialContraparte: o.razon }),
    fechaEmision: `${o.periodo.slice(0, 4)}-${o.periodo.slice(4)}-15`,
    moneda: "PEN",
    isc: CERO,
    icbper: CERO,
    otros: CERO,
    ...firmado,
  } as FilaPropuestaSire;
}

// ---------------------------------------------------------------------------------------------------------------
// Oráculo simple de la deducción (plan 025, Contratos: domain `aprender.ts`; D-3, U-2) y escenario de seis periodos
// ---------------------------------------------------------------------------------------------------------------

export interface CandidataEsperada {
  doc_tipo: string;
  doc_numero: string;
  razon_social: string | null;
  destino_propuesto: "DG" | "DGNG" | "DNG" | null;
  n_dg: number;
  n_dgng: number;
  n_dng: number;
  n_mixto: number;
  n_total: number;
  periodos_con_proveedor: number;
}

const noCero = (s: string): boolean => /[1-9]/.test(s);

/**
 * Lo que debe salir de leer `periodosLeidos` de `porPeriodo`: proveedor normalizado (tipo ausente = «6», número recortado y
 * en mayúsculas; vacío o «-» = sin proveedor), un destino con base distinta de cero suma a ese destino, dos o más a «mixto»,
 * ninguno no cuenta; propone `d` con al menos 2 y `5 × n ≥ 4 × total`.
 */
export function deducir(
  porPeriodo: ReadonlyMap<string, readonly FilaPropuestaSire[]>,
  periodosLeidos: readonly string[],
): CandidataEsperada[] {
  const por = new Map<
    string,
    CandidataEsperada & { periodos: Set<string>; razonPeriodo: string }
  >();
  for (const periodo of periodosLeidos) {
    for (const f of porPeriodo.get(periodo) ?? []) {
      const numero = f.rucContraparte.trim().toUpperCase();
      if (numero === "" || numero === "-") continue;
      const tipo = (f.tipoDocContraparte ?? "6").trim() || "6";
      const bases = {
        DG: noCero(f.biDg),
        DGNG: noCero(f.biDgng),
        DNG: noCero(f.biDng),
      };
      const n = Object.values(bases).filter(Boolean).length;
      if (n === 0) continue;
      const clave = `${tipo}|${numero}`;
      const c = por.get(clave) ?? {
        doc_tipo: tipo,
        doc_numero: numero,
        razon_social: null,
        destino_propuesto: null,
        n_dg: 0,
        n_dgng: 0,
        n_dng: 0,
        n_mixto: 0,
        n_total: 0,
        periodos_con_proveedor: 0,
        periodos: new Set<string>(),
        razonPeriodo: "",
      };
      if (n > 1) c.n_mixto += 1;
      else if (bases.DG) c.n_dg += 1;
      else if (bases.DGNG) c.n_dgng += 1;
      else c.n_dng += 1;
      c.n_total += 1;
      c.periodos.add(periodo);
      if (f.razonSocialContraparte !== undefined && periodo >= c.razonPeriodo) {
        c.razon_social = f.razonSocialContraparte;
        c.razonPeriodo = periodo;
      }
      por.set(clave, c);
    }
  }
  return [...por.values()]
    .map(({ periodos, razonPeriodo, ...c }) => {
      void razonPeriodo;
      const cuentas = { DG: c.n_dg, DGNG: c.n_dgng, DNG: c.n_dng } as const;
      const propuesto = (
        Object.keys(cuentas) as Array<keyof typeof cuentas>
      ).find((d) => cuentas[d] >= 2 && 5 * cuentas[d] >= 4 * c.n_total);
      return {
        ...c,
        destino_propuesto: propuesto ?? null,
        periodos_con_proveedor: periodos.size,
      };
    })
    .sort(porDocumento);
}

export const porDocumento = (
  a: { doc_tipo: string; doc_numero: string },
  b: { doc_tipo: string; doc_numero: string },
): number =>
  a.doc_tipo === b.doc_tipo
    ? a.doc_numero < b.doc_numero
      ? -1
      : a.doc_numero > b.doc_numero
        ? 1
        : 0
    : a.doc_tipo < b.doc_tipo
      ? -1
      : 1;

export const PROV = {
  A: rucProveedor(1), // 12 comprobantes en DNG (dos por periodo); razón social cambia con el tiempo
  B: rucProveedor(2), // DG 5, DNG 1 (83 %)
  C: rucProveedor(3), // DG 4, DNG 1 (justo 80 %)
  D: rucProveedor(4), // DG 3, DNG 1 (75 %): sin criterio
  E: rucProveedor(5), // un solo comprobante: sin criterio
  F: rucProveedor(6), // DGNG 2 y una mixta: sin criterio
  I: rucProveedor(9), // DG 2 y una nota de crédito en DG
  K: "12345678", // DNI (tipo 1), DG 2
} as const;

export interface Escenario6 {
  porPeriodo: Map<string, FilaPropuestaSire[]>;
  /** A mano, sin pasar por el oráculo. */
  esperadas: CandidataEsperada[];
}

/** Seis periodos con los casos de la deducción. Los comprobantes de cada proveedor y periodo están en el comentario de `PROV`. */
export function escenario6(): Escenario6 {
  const porPeriodo = new Map<string, FilaPropuestaSire[]>(
    PERIODOS_6.map((p) => [p, []]),
  );
  let n = 0;
  const f = (
    periodo: string,
    o: Omit<OpcionesFilaRegistro, "periodo" | "numero">,
  ): void => {
    n += 1;
    porPeriodo
      .get(periodo)!
      .push(filaRegistro({ ...o, periodo, numero: String(1000 + n) }));
  };
  const antiguos = new Set(["202608", "202607", "202606", "202605"]);
  for (const p of PERIODOS_6) {
    const razon = antiguos.has(p) ? "ALFA ANTIGUA SA" : "ALFA SAC";
    f(p, { ruc: PROV.A, razon, destino: "DNG" });
    f(p, { ruc: PROV.A, razon, destino: "DNG" });
  }
  f("202610", { ruc: PROV.A, razon: "ALFA SAC", destino: "CERO" }); // base 0: no cuenta
  // B: un espacio alrededor del RUC no crea otro proveedor.
  f("202610", { ruc: ` ${PROV.B} `, razon: "BETA SAC", destino: "DG" });
  for (const p of ["202609", "202608", "202607", "202606"])
    f(p, { ruc: PROV.B, razon: "BETA SAC", destino: "DG" });
  f("202605", { ruc: PROV.B, razon: "BETA SAC", destino: "DNG" });
  for (const p of ["202610", "202609", "202608", "202607"])
    f(p, { ruc: PROV.C, razon: "GAMMA SAC", destino: "DG" });
  f("202606", { ruc: PROV.C, razon: "GAMMA SAC", destino: "DNG" });
  for (const p of ["202610", "202609", "202608"])
    f(p, { ruc: PROV.D, razon: "DELTA SAC", destino: "DG" });
  f("202607", { ruc: PROV.D, razon: "DELTA SAC", destino: "DNG" });
  f("202608", { ruc: PROV.E, razon: "EPSILON SAC", destino: "DG" });
  f("202609", { ruc: PROV.F, razon: "FI SAC", destino: "DGNG" });
  f("202608", { ruc: PROV.F, razon: "FI SAC", destino: "DGNG" });
  f("202607", { ruc: PROV.F, razon: "FI SAC", destino: "MIXTA" });
  f("202610", { ruc: PROV.I, razon: "IOTA SAC", destino: "DG" });
  f("202609", { ruc: PROV.I, razon: "IOTA SAC", destino: "DG" });
  f("202608", {
    ruc: PROV.I,
    razon: "IOTA SAC",
    destino: "DG",
    tipo: "07",
    negativa: true,
  });
  f("202610", {
    ruc: PROV.K,
    tipoDoc: "1",
    razon: "KAPPA PERSONA",
    destino: "DG",
  });
  f("202609", {
    ruc: PROV.K,
    tipoDoc: "1",
    razon: "KAPPA PERSONA",
    destino: "DG",
  });
  f("202610", { ruc: "-", destino: "DG" }); // sin proveedor: no es candidata
  f("202609", { ruc: "-", destino: "DG" });

  const c = (
    doc_tipo: string,
    doc_numero: string,
    razon_social: string,
    destino_propuesto: CandidataEsperada["destino_propuesto"],
    cuentas: [number, number, number, number],
    periodos_con_proveedor: number,
  ): CandidataEsperada => ({
    doc_tipo,
    doc_numero,
    razon_social,
    destino_propuesto,
    n_dg: cuentas[0],
    n_dgng: cuentas[1],
    n_dng: cuentas[2],
    n_mixto: cuentas[3],
    n_total: cuentas[0] + cuentas[1] + cuentas[2] + cuentas[3],
    periodos_con_proveedor,
  });
  const esperadas = [
    c("1", PROV.K, "KAPPA PERSONA", "DG", [2, 0, 0, 0], 2),
    c("6", PROV.A, "ALFA SAC", "DNG", [0, 0, 12, 0], 6),
    c("6", PROV.B, "BETA SAC", "DG", [5, 0, 1, 0], 6),
    c("6", PROV.C, "GAMMA SAC", "DG", [4, 0, 1, 0], 5),
    c("6", PROV.D, "DELTA SAC", null, [3, 0, 1, 0], 4),
    c("6", PROV.E, "EPSILON SAC", null, [1, 0, 0, 0], 1),
    c("6", PROV.F, "FI SAC", null, [0, 2, 0, 1], 3),
    c("6", PROV.I, "IOTA SAC", "DG", [3, 0, 0, 0], 3),
  ].sort(porDocumento);
  return { porPeriodo, esperadas };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures del mock (carpeta temporal por archivo de pruebas)
// ---------------------------------------------------------------------------------------------------------------

export interface DirFixtures {
  dir: string;
  /** Escribe `{ruc}-registro-compras-{periodo}.json` de cada periodo de `porPeriodo`. */
  registro(
    ruc: string,
    porPeriodo: ReadonlyMap<string, readonly FilaPropuestaSire[]>,
  ): void;
  /** `{ruc}-registro-sin-datos.json`: los periodos que el SIRE responde sin registro. */
  sinDatos(ruc: string, periodos: readonly string[]): void;
  /** `{ruc}-compras-{periodo}.json`: la propuesta de compras de la descarga. */
  propuesta(
    ruc: string,
    periodo: string,
    filas: readonly FilaPropuestaSire[],
  ): void;
  limpiar(): void;
}

export function crearDirFixtures(): DirFixtures {
  const raiz = mkdtempSync(join(tmpdir(), "contapp-025-t5-"));
  const dir = join(raiz, "sire");
  mkdirSync(dir);
  const escribir = (nombre: string, valor: unknown): void =>
    writeFileSync(join(dir, nombre), JSON.stringify(valor));
  return {
    dir,
    registro: (ruc, porPeriodo) => {
      for (const [periodo, filas] of porPeriodo)
        escribir(`${ruc}-registro-compras-${periodo}.json`, {
          libro: "compras",
          periodo,
          filas,
        });
    },
    sinDatos: (ruc, periodos) =>
      escribir(`${ruc}-registro-sin-datos.json`, periodos),
    propuesta: (ruc, periodo, filas) =>
      escribir(`${ruc}-compras-${periodo}.json`, {
        libro: "compras",
        periodo,
        filas,
      }),
    limpiar: () => rmSync(raiz, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Puerto SIRE de la prueba
// ---------------------------------------------------------------------------------------------------------------

export interface LlamadaRegistro {
  /** El token tal como lo recibió el puerto (solo vive en la memoria de la prueba). */
  token: string;
  solicitud: { ruc: string; periodo: string };
  /** Transacciones `withTenant`/`withSistema` abiertas del worker en el instante de la llamada. */
  en: number;
}

interface RegistroPresentado {
  libro: "compras";
  periodo: string;
  filas: FilaPropuestaSire[];
}

type ConRegistro = {
  descargarRegistroPresentado(
    token: TokenSire,
    solicitud: { ruc: string; periodo: string },
  ): Promise<RegistroPresentado>;
};

/**
 * `SireApiClient` de la prueba: delega en el mock con una carpeta de fixtures propia (`dirFixtures`), anota las llamadas del
 * registro presentado, puede pausarse dentro de la llamada y puede responder o fallar según la solicitud (`programar`).
 */
export class SireRegistroControlado implements SireApiClient {
  readonly llamadas: LlamadaRegistro[] = [];
  readonly propuestas: SolicitudPropuesta[] = [];
  readonly interno: MockSireApiClient;
  /** Cuántas transacciones tiene abiertas el worker (se conecta con `ProcesoWorker.dbEstado`). */
  contarTx: () => number = () => 0;
  private puerta: ReturnType<typeof compuerta> | null = null;
  private programada:
    ((s: { ruc: string; periodo: string }) => FilaPropuestaSire[]) | null =
    null;

  constructor(dirFixtures?: string) {
    this.interno = new MockSireApiClient(
      dirFixtures === undefined ? {} : { dirFixtures },
    );
  }

  /** Las llamadas siguientes esperan hasta `abrir()`. */
  pausar(): void {
    this.puerta = compuerta();
  }
  abrir(): void {
    this.puerta?.abrir();
    this.puerta = null;
  }
  /** Responde con la función (que puede lanzar un error del puerto) en vez de leer los fixtures. `null` vuelve al mock. */
  programar(
    f: ((s: { ruc: string; periodo: string }) => FilaPropuestaSire[]) | null,
  ): this {
    this.programada = f;
    return this;
  }

  descargarPropuesta(token: TokenSire, solicitud: SolicitudPropuesta) {
    this.propuestas.push({ ...solicitud });
    return this.interno.descargarPropuesta(token, solicitud);
  }

  async descargarRegistroPresentado(
    token: TokenSire,
    solicitud: { ruc: string; periodo: string },
  ): Promise<RegistroPresentado> {
    this.llamadas.push({
      token: token.token,
      solicitud: { ...solicitud },
      en: this.contarTx(),
    });
    await this.puerta?.esperar();
    if (this.programada !== null)
      return {
        libro: "compras",
        periodo: solicitud.periodo,
        filas: structuredClone(this.programada(solicitud)),
      };
    const m = this.interno as unknown as Partial<ConRegistro>;
    if (typeof m.descargarRegistroPresentado !== "function")
      throw new Error(
        "no implementado: MockSireApiClient.descargarRegistroPresentado (T9)",
      );
    return m.descargarRegistroPresentado(token, solicitud);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mundo, importación y encolado como lo hace el backend
// ---------------------------------------------------------------------------------------------------------------

export interface PerfilCliente {
  zona: "general" | "amazonia";
  ventasExoneradas: boolean;
  ventasMixtas: boolean;
}

export async function fijarPerfil(
  admin: ContappDb,
  clienteId: string,
  p: Partial<PerfilCliente>,
): Promise<void> {
  await admin.pool.query(
    `update cliente set zona = coalesce($2, zona), ventas_exoneradas = coalesce($3, ventas_exoneradas),
            ventas_mixtas = coalesce($4, ventas_mixtas) where id = $1`,
    [
      clienteId,
      p.zona ?? null,
      p.ventasExoneradas ?? null,
      p.ventasMixtas ?? null,
    ],
  );
}

/** `reglas_importacion_iniciar` como el backend (rol backend, con el usuario que actúa). Devuelve el id. */
export async function iniciarImportacion(
  backend: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  periodos: readonly string[],
): Promise<string> {
  return conAviso("reglas_importacion_iniciar (T10, 0062)", async () => {
    const r = await backend.withTenant({ tenantId: m.T, userId: m.u }, (tx) =>
      tx.query(
        "select reglas_importacion_iniciar($1::uuid, $2::char(6)[]) as id",
        [m.c.id, [...periodos]],
      ),
    );
    return r.rows[0].id as string;
  });
}

/**
 * Encola `reglas.historial.importar` con `{importacionId}`, fija el trabajo en la importación en la MISMA transacción
 * (`reglas_importacion_trabajo`) y publica después del commit, como el backend. Devuelve el id del trabajo.
 */
export async function encolarImportacion(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  importacionId: string,
): Promise<string> {
  const entrada: EntradaEncolar = {
    tipo: TIPO_IMPORTAR,
    clienteId: m.c.id,
    parametros: { importacionId },
    prioridad: "interactivo",
    creadoPor: m.u,
  };
  return conAviso(
    `tipo ${TIPO_IMPORTAR} (T9) o reglas_importacion_trabajo (T10)`,
    async () => {
      const r = await backend.withTenant(
        { tenantId: m.T, userId: m.u },
        async (tx) => {
          const enc = await encolar(tx, entrada);
          await tx.query(
            "select reglas_importacion_trabajo($1::uuid, $2::uuid)",
            [importacionId, enc.trabajo.id],
          );
          return enc;
        },
      );
      if (r.nuevo)
        await publicar(
          redis,
          [aPublicable(m.T, r.trabajo, entrada.prioridad)],
          {
            prefijo,
          },
        );
      return r.trabajo.id;
    },
  );
}

/** Activa candidatas como el backend: `todas` de una importación o `items` `[{id, destino?}]`. */
export async function activarCandidatas(
  backend: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  o: { todas: string } | { items: Array<{ id: string; destino?: string }> },
): Promise<
  Array<{ candidata_id: string; resultado: string; regla_id: string | null }>
> {
  return conAviso("reglas_candidatas_activar (T10, 0062)", async () => {
    const r = await backend.withTenant({ tenantId: m.T, userId: m.u }, (tx) =>
      tx.query(
        "select candidata_id, resultado, regla_id from reglas_candidatas_activar($1::uuid, $2::jsonb, $3::uuid)",
        [
          m.c.id,
          "items" in o ? JSON.stringify(o.items) : null,
          "todas" in o ? o.todas : null,
        ],
      ),
    );
    return r.rows;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas (rol administrativo)
// ---------------------------------------------------------------------------------------------------------------

export interface ImportacionBd {
  id: string;
  cliente_id: string;
  estado: string;
  periodos: string[];
  periodo_hasta: string;
  trabajo_id: string | null;
  terminada_en: Date | null;
  periodos_leidos: number | null;
  periodos_sin_datos: string[] | null;
  candidatas: number | null;
  sin_criterio: number | null;
  motivo: string | null;
}

export async function importacionDe(
  admin: ContappDb,
  id: string,
): Promise<ImportacionBd> {
  const r = await admin.pool.query(
    `select id, cliente_id, estado, periodos::text[] as periodos, periodo_hasta::text as periodo_hasta, trabajo_id,
            terminada_en, periodos_leidos::int as periodos_leidos, periodos_sin_datos::text[] as periodos_sin_datos,
            candidatas::int as candidatas, sin_criterio::int as sin_criterio, motivo
       from regla_importacion where id = $1`,
    [id],
  );
  return r.rows[0] as ImportacionBd;
}

/** Texto JSON completo de la fila (para comprobar que no cambió ni un campo). */
export async function importacionTexto(
  admin: ContappDb,
  id: string,
): Promise<string> {
  const r = await admin.pool.query(
    "select to_jsonb(t)::text as t from regla_importacion t where id = $1",
    [id],
  );
  return String(r.rows[0]?.t);
}

export interface CandidataBd extends CandidataEsperada {
  id: string;
  importacion_id: string;
  estado: string;
  destino_elegido: string | null;
  regla_id: string | null;
}

/** Candidatas de la importación (o de todo el cliente si no se da) ordenadas por documento. */
export async function candidatasDe(
  admin: ContappDb,
  filtro: { importacionId?: string; clienteId?: string },
): Promise<CandidataBd[]> {
  const r = await admin.pool.query(
    `select id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto, n_dg::int as n_dg,
            n_dgng::int as n_dgng, n_dng::int as n_dng, n_mixto::int as n_mixto, n_total::int as n_total,
            periodos_con_proveedor::int as periodos_con_proveedor, estado, destino_elegido, regla_id
       from regla_candidata
      where ($1::uuid is null or importacion_id = $1) and ($2::uuid is null or cliente_id = $2)
      order by doc_tipo, doc_numero`,
    [filtro.importacionId ?? null, filtro.clienteId ?? null],
  );
  return r.rows as CandidataBd[];
}

/** La forma de `CandidataEsperada` de lo que hay en BD (sin id ni estado). */
export const comoEsperada = (c: CandidataBd): CandidataEsperada => ({
  doc_tipo: c.doc_tipo,
  doc_numero: c.doc_numero,
  razon_social: c.razon_social,
  destino_propuesto: c.destino_propuesto,
  n_dg: c.n_dg,
  n_dgng: c.n_dgng,
  n_dng: c.n_dng,
  n_mixto: c.n_mixto,
  n_total: c.n_total,
  periodos_con_proveedor: c.periodos_con_proveedor,
});

export async function contarReglasAprendidas(
  admin: ContappDb,
  clienteId: string,
): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from regla_aprendida where cliente_id = $1",
    [clienteId],
  );
  return r.rows[0].n as number;
}

export interface ReglaBd {
  doc_tipo: string;
  doc_numero: string;
  destino: string;
  activa: boolean;
  origen: string;
  periodo_aprendido: string;
}

export async function reglasDeCliente(
  admin: ContappDb,
  clienteId: string,
): Promise<ReglaBd[]> {
  const r = await admin.pool.query(
    `select doc_tipo, doc_numero, destino, activa, origen, periodo_aprendido::text as periodo_aprendido
       from regla_aprendida where cliente_id = $1 and eliminada_en is null order by doc_tipo, doc_numero`,
    [clienteId],
  );
  return r.rows as ReglaBd[];
}

/** Hallazgos R-STD de una compra con lo que guarda `compra_hallazgo` (todas las versiones y evaluaciones). */
export interface HallazgoStdBd {
  version_n: number;
  evaluacion_n: number;
  requiere_confirmacion: boolean;
  sugerencia: { tipo?: string } | null;
  lecturas: Record<string, string>;
}

export async function hallazgosStdDe(
  admin: ContappDb,
  compraId: string,
): Promise<HallazgoStdBd[]> {
  const r = await admin.pool.query(
    `select version_n::int as version_n, evaluacion_n::int as evaluacion_n, requiere_confirmacion, sugerencia, lecturas
       from compra_hallazgo where compra_id = $1 and regla = 'R-STD' order by version_n, evaluacion_n`,
    [compraId],
  );
  return r.rows as HallazgoStdBd[];
}

/** Texto de las tablas de aprendizaje de los estudios dados (para buscar canarios). */
export async function volcarTablasAprendizaje(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const r = await admin.pool.query(
    `select to_jsonb(t)::text as t from regla_importacion t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from regla_candidata t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/**
 * Borra lo que dejan las pruebas en las tablas de 025 de los estudios dados (con `session_replication_role = replica`: son de
 * solo escritura por funciones y tienen trigger contra `DELETE`). Llamar ANTES de `limpiarReglas`. Si las tablas aún no
 * existen (rojo), no falla.
 */
export async function limpiarAprendizaje(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const sql of [
      "delete from regla_candidata where tenant_id = any($1::uuid[])",
      "delete from regla_importacion where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
}
