// Soporte de las pruebas de integración del procesador `sire.propuesta.descargar` (spec 013, T5). No es código de
// producción ni una prueba (vive fuera de `src`, como `trabajos.ts` y `procesadores-007b.ts`).
//
// CONTRATO que fijan estas pruebas para T11/T12 (además del de `iniciarTrabajos` en src/trabajos/iniciar.ts):
// - `DepsTrabajos` gana `sireApi?: SireApiClient` (por defecto `new MockSireApiClient()`). `iniciarTrabajos` registra solo
//   el procesador `sire.propuesta.descargar` (junto a los de 007b) y le pasa `deps.sireApi`, el token SIRE de la caché
//   (`conToken`) y los persistidores por libro (`persistidores/index.ts`, hoy solo `ventas`).
// - `src/trabajos/procesadores/descargar-propuesta.ts` exporta `descargarPropuesta({ db, sireApi, persistidores? }): Procesador`
//   (mismo patrón que `consultarRuc({ db, consultaRuc })`); `persistidores` es opcional y por defecto el registro de
//   `persistidores/index.ts`. La prueba de la carrera de CA-11 lo invoca directo con dos trabajos a la vez, porque por la
//   cola es imposible: la deduplicación (008 D8) y el lock del RUC (canal `sire`) impiden dos descargas vivas del mismo
//   cliente.
// - El procesador baja la propuesta con `conToken` SIN transacción abierta (008 D6) y persiste en una sola `withTenant`
//   (encabezado, diferencias y filas nuevas). Devuelve el `resultado` de D16. Los campos que compara el persistidor de ventas se llaman como los de
//   `FilaVentaSire`: `fechaEmision`, `moneda`, `tipoCambio`, `tipoDocContraparte`, `docContraparte`, `baseGravada`,
//   `igv`, `exonerada`, `inafecta`, `isc`, `icbper`, `otros` y `total` (así salen en `propuesta_diferencia.campos`).
// - Tablas y columnas: las de plan.md (Contratos: tablas); la clave es `claveNormalizada` (`tipo|SERIE|numero`).
// Los secretos de las pruebas son canarios generados al vuelo (nunca claves reales). Datos sintéticos: sin RUC reales.
import { randomBytes } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { MockSireApiClient, type ModoFallaSireApi } from "@contapp/sunat";
import type {
  SireApiClient,
  SireAuth,
  SolicitudPropuesta,
  TokenSire,
} from "@contapp/sunat";
import { guardarCredencial } from "./procesadores-007b.js";
import { canario } from "./soporte.js";
import {
  encolarYPublicar,
  type ClientePrueba,
  type Escenario,
} from "./trabajos.js";

export const TIPO_DESCARGA = "sire.propuesta.descargar";
export const PERIODO = "202610";
/** Contribuyente de prueba con fixture propio (`fixtures/sire/20700000002-ventas-202610.json`, 11 filas). */
export const RUC_FIXTURE = "20700000002";

/** `FilaVentaSire` (plan, Puertos); se repite aquí para que el soporte compile antes de T11. */
export interface FilaVenta {
  tipo: string;
  serie: string;
  numero: string;
  tipoDocContraparte?: string;
  docContraparte: string;
  fechaEmision: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

/** Boleta de S/ 118.00 (100 + 18) que cuadra; `extra` pisa cualquier campo. */
export function fila(
  serie: string,
  numero: string,
  extra: Partial<FilaVenta> = {},
): FilaVenta {
  return {
    tipo: "03",
    serie,
    numero,
    docContraparte: "-",
    fechaEmision: "2026-10-05",
    moneda: "PEN",
    baseGravada: "100.00",
    igv: "18.00",
    exonerada: "0.00",
    inafecta: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otros: "0.00",
    total: "118.00",
    ...extra,
  };
}

/** Las dos boletas del caso real: B001-290 (118.00) y B001-292 (59.00), sin la 291. */
export const boletas290y292 = (): FilaVenta[] => [
  fila("B001", "290"),
  fila("B001", "292", {
    fechaEmision: "2026-10-06",
    baseGravada: "50.00",
    igv: "9.00",
    total: "59.00",
  }),
];

/** `n` boletas distintas de la serie dada (números 1..n), todas de S/ 118.00 salvo que `extra` diga otra cosa. */
export function muchas(
  n: number,
  serie = "S001",
  extra: Partial<FilaVenta> = {},
): FilaVenta[] {
  return Array.from({ length: n }, (_, i) => fila(serie, String(i + 1), extra));
}

// ---------------------------------------------------------------------------------------------------------------
// Puertos de la descarga
// ---------------------------------------------------------------------------------------------------------------

export interface LlamadaApi {
  /** El token tal como lo recibió el puerto (solo vive en la memoria de la prueba). */
  token: string;
  solicitud: SolicitudPropuesta;
  /** Transacciones `withTenant`/`withSistema` abiertas del worker en el instante de la llamada (0 = ninguna, 008 D6). */
  en: number;
}

export type Respuesta = FilaVenta[] | ((s: SolicitudPropuesta) => FilaVenta[]);

/**
 * `SireApiClient` de la prueba: delega en el mock (fixtures y `fallar`) salvo que se le programe una respuesta
 * (`responder`), puede pausarse dentro de la llamada y puede esperar en una barrera de N llamadas simultáneas.
 */
export class SireApiControlado implements SireApiClient {
  readonly llamadas: LlamadaApi[] = [];
  readonly interno: MockSireApiClient;
  private respuesta: Respuesta | null = null;
  private fallando = false;
  private pausada: Promise<void> | null = null;
  private abrirPausa: (() => void) | null = null;
  private umbral = 0;
  private esperas: Array<() => void> = [];
  /** Llamadas detenidas ahora mismo en la barrera. */
  esperando = 0;
  /** Cuántas transacciones tiene abiertas el worker (se conecta con `ProcesoWorker.dbEstado`). */
  contarTx: () => number = () => 0;

  constructor(interno = new MockSireApiClient()) {
    this.interno = interno;
  }

  /** Programa las filas que devolverá (y deja de leer el fixture). `null` vuelve al mock. */
  responder(r: Respuesta | null): this {
    this.respuesta = r;
    return this;
  }

  fallar(modo: ModoFallaSireApi): void {
    this.fallando = modo !== null;
    this.interno.fallar(modo);
  }

  /** Las llamadas siguientes esperan hasta `abrir()`. */
  pausar(): void {
    this.pausada = new Promise<void>((r) => (this.abrirPausa = r));
  }

  abrir(): void {
    this.abrirPausa?.();
    this.pausada = null;
    this.abrirPausa = null;
  }

  /** Las `n` primeras llamadas esperan juntas y salen a la vez (o a los 10 s). `0` quita la barrera. */
  barrera(n: number): void {
    this.umbral = n;
    this.esperas = [];
  }

  async descargarPropuesta(
    token: TokenSire,
    solicitud: SolicitudPropuesta,
  ): Promise<never> {
    this.llamadas.push({
      token: token.token,
      solicitud: { ...solicitud },
      en: this.contarTx(),
    });
    await this.pausada;
    if (this.umbral > 0) {
      this.esperando += 1;
      await new Promise<void>((salir) => {
        const timer = setTimeout(salir, 10_000);
        this.esperas.push(() => {
          clearTimeout(timer);
          salir();
        });
        if (this.esperas.length >= this.umbral) {
          const lista = this.esperas;
          this.esperas = [];
          for (const f of lista) f();
        }
      });
      this.esperando -= 1;
    }
    if (this.fallando || this.respuesta === null)
      return (await this.interno.descargarPropuesta(token, solicitud)) as never;
    const filas =
      typeof this.respuesta === "function"
        ? this.respuesta(solicitud)
        : this.respuesta;
    return {
      libro: solicitud.libro,
      periodo: solicitud.periodo,
      filas: structuredClone(filas),
    } as never;
  }
}

/** SireAuth que entrega siempre el mismo token (un canario) y anota cuántas veces se le pidió. */
export class SireAuthTokenFijo implements SireAuth {
  pedidos = 0;
  constructor(readonly token: string = canario("token_sire")) {}
  async obtenerToken(): Promise<TokenSire> {
    this.pedidos += 1;
    return { token: this.token, expiraEn: new Date(Date.now() + 3_600_000) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Escenario de datos
// ---------------------------------------------------------------------------------------------------------------

export interface MundoVentas {
  T: string;
  /** Contador asignado al cliente: quien encola. */
  u: string;
  c: ClientePrueba;
  secretos: {
    clave: string;
    clientSecret: string;
    clientId: string;
    usuario: string;
  };
}

/** Un estudio con un cliente asignado y sus credenciales `sol` y `sire_api` (canarios). */
export async function mundoVentas(
  e: Escenario,
  backend: ContappDb,
  o: { ruc?: string } = {},
): Promise<MundoVentas> {
  const T = await e.estudio();
  const u = await e.usuario(T, "contador");
  const c =
    o.ruc === undefined ? await e.cliente(T) : await e.cliente(T, o.ruc);
  await e.asignar(T, c.id, u);
  const secretos = {
    clave: canario("clave_sol"),
    clientSecret: canario("client_secret"),
    clientId: canario("client_id"),
    usuario: "USUARIOSOL",
  };
  await guardarCredencial(backend, T, c.id, "sol", {
    usuario: secretos.usuario,
    clave: secretos.clave,
  });
  await guardarCredencial(backend, T, c.id, "sire_api", {
    clientId: secretos.clientId,
    clientSecret: secretos.clientSecret,
  });
  return { T, u, c, secretos };
}

/** Encola `sire.propuesta.descargar` como lo hace el backend (rol backend, `interactivo`) y devuelve el id del trabajo. */
export async function encolarDescarga(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: MundoVentas,
  o: { periodo?: string; libro?: "ventas" | "compras" } = {},
): Promise<string> {
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: TIPO_DESCARGA,
    clienteId: m.c.id,
    parametros: { periodo: o.periodo ?? PERIODO, libro: o.libro ?? "ventas" },
    prioridad: "interactivo",
    creadoPor: m.u,
  });
  return r.trabajo.id;
}

/**
 * Cambia la clave de deduplicación de un trabajo vivo (con el rol administrativo) para poder encolar otro igual: así dos
 * descargas del mismo cliente y periodo corren a la vez, cosa que la cola evita a propósito (008 D8). Es la forma de
 * probar la carrera de CA-11, que en producción solo ocurre con otro proceso o con una importación.
 */
export async function liberarDedupe(
  admin: ContappDb,
  trabajoId: string,
): Promise<void> {
  await admin.pool.query(
    "update job_registro set clave_dedupe = $2 where id = $1",
    [trabajoId, randomBytes(32)],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas y siembras con el rol administrativo (no pasan por RLS ni por grants; sí por triggers y FK)
// ---------------------------------------------------------------------------------------------------------------

export interface PropuestaBd {
  id: string;
  cliente_id: string;
  periodo: string;
  libro: string;
  fuente: string;
  hash: string;
  filas_recibidas: number;
  filas_nuevas: number;
  filas_iguales: number;
  filas_distintas: number;
  usuario_id: string;
  trabajo_id: string | null;
}

export async function propuestasDe(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
): Promise<PropuestaBd[]> {
  const r = await admin.pool.query(
    `select id, cliente_id, periodo, libro, fuente, hash, filas_recibidas::int, filas_nuevas::int, filas_iguales::int,
            filas_distintas::int, usuario_id, trabajo_id
       from propuesta where cliente_id = $1 and periodo = $2 order by creada_en, id`,
    [clienteId, periodo],
  );
  return r.rows as PropuestaBd[];
}

/** Todas las propuestas del cliente, de cualquier periodo y libro. */
export async function contarPropuestas(
  admin: ContappDb,
  clienteId: string,
): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from propuesta where cliente_id = $1",
    [clienteId],
  );
  return r.rows[0].n as number;
}

export interface VentaBd {
  id: string;
  origen: string;
  propuesta_id: string | null;
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  numero_n: number | null;
  fecha: string;
  tipo_doc_contraparte: string | null;
  doc_contraparte: string;
  moneda: string;
  tipo_cambio: string | null;
  base_gravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
  creada_por: string | null;
}

export async function ventasDe(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
): Promise<VentaBd[]> {
  const r = await admin.pool.query(
    `select id, origen, propuesta_id, clave, tipo, serie, numero, numero_n, fecha::text as fecha, tipo_doc_contraparte,
            doc_contraparte, moneda, tipo_cambio::text as tipo_cambio, base_gravada::text as base_gravada, igv::text as igv,
            exonerada::text as exonerada, inafecta::text as inafecta, isc::text as isc, icbper::text as icbper,
            otros::text as otros, total::text as total, creada_por
       from venta where cliente_id = $1 and periodo = $2
      order by tipo, serie, numero_n nulls last, numero`,
    [clienteId, periodo],
  );
  return r.rows as VentaBd[];
}

export async function contarVentas(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from venta where cliente_id = $1 and periodo = $2",
    [clienteId, periodo],
  );
  return r.rows[0].n as number;
}

export interface DiferenciaBd {
  propuesta_id: string;
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  origen_existente: string;
  campos: string[];
  valores_sire: Record<string, string>;
}

export async function diferenciasDe(
  admin: ContappDb,
  propuestaId: string,
): Promise<DiferenciaBd[]> {
  const r = await admin.pool.query(
    `select propuesta_id, clave, tipo, serie, numero, origen_existente, campos, valores_sire
       from propuesta_diferencia where propuesta_id = $1 order by clave`,
    [propuestaId],
  );
  return r.rows as DiferenciaBd[];
}

export async function contarDiferencias(
  admin: ContappDb,
  clienteId: string,
): Promise<number> {
  const r = await admin.pool.query(
    `select count(*)::int as n from propuesta_diferencia d join propuesta p on p.id = d.propuesta_id
      where p.cliente_id = $1`,
    [clienteId],
  );
  return r.rows[0].n as number;
}

export interface SaltoBd {
  id: string;
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
  comentario: string;
  revertido_en: Date | null;
}

export async function saltosDe(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
): Promise<SaltoBd[]> {
  const r = await admin.pool.query(
    `select id, tipo, serie, desde::int, hasta::int, comentario, revertido_en
       from venta_salto_justificado where cliente_id = $1 and periodo = $2 order by creada_en, id`,
    [clienteId, periodo],
  );
  return r.rows as SaltoBd[];
}

/** Encabezado de propuesta de origen `api` sembrado (para colgar de él las ventas sembradas). Devuelve su id. */
export async function sembrarPropuesta(
  admin: ContappDb,
  m: MundoVentas,
  o: { periodo?: string; filas?: number } = {},
): Promise<string> {
  const n = o.filas ?? 0;
  const r = await admin.pool.query(
    `insert into propuesta (tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
                            filas_iguales, filas_distintas, usuario_id)
     values ($1, $2, $3, 'ventas', 'api', $4, $5, $5, 0, 0, $6) returning id`,
    [m.T, m.c.id, o.periodo ?? PERIODO, "a".repeat(64), n, m.u],
  );
  return r.rows[0].id as string;
}

/**
 * Siembra `n` ventas `sire` (S001-1 a S001-n, tipo 03, S/ 118.00 que cuadra) colgadas de una propuesta sembrada, en una
 * sola sentencia. Sirve para llegar a los topes de 20.000 sin pasar por la descarga.
 */
export async function sembrarVentas(
  admin: ContappDb,
  m: MundoVentas,
  n: number,
  o: { periodo?: string; serie?: string } = {},
): Promise<string> {
  const periodo = o.periodo ?? PERIODO;
  const serie = o.serie ?? "S001";
  const propuestaId = await sembrarPropuesta(admin, m, { periodo, filas: n });
  await admin.pool.query(
    `insert into venta (
      tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
  tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper, otros,
  total, creada_por)
     select $1, $2, $3, $4, 'sire', '03|' || $5::text || '|' || g, '03', $5::text, g::text, g, '2026-10-05', '0', '-', 'PEN',
            null, 100, 18, 0, 0, 0, 0, 0, 118, null
       from generate_series(1, $6::int) g`,
    [m.T, m.c.id, periodo, propuestaId, serie, n],
  );
  return propuestaId;
}

/** Venta agregada a mano por el contador (origen `manual`, sin propuesta). Devuelve su id. */
export async function sembrarManual(
  admin: ContappDb,
  m: MundoVentas,
  f: FilaVenta,
  o: { periodo?: string } = {},
): Promise<string> {
  const numero = f.numero.replace(/^0+(?=.)/, "");
  const r = await admin.pool.query(
    `insert into venta (
      tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
  tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper, otros,
  total, creada_por)
     values ($1, $2, $3, null, 'manual', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22) returning id`,
    [
      m.T,
      m.c.id,
      o.periodo ?? PERIODO,
      `${f.tipo}|${f.serie.toUpperCase()}|${numero}`,
      f.tipo,
      f.serie,
      f.numero,
      /^[0-9]{1,8}$/.test(f.numero) ? Number(f.numero) : null,
      f.fechaEmision,
      f.tipoDocContraparte ?? "0",
      f.docContraparte,
      f.moneda,
      f.tipoCambio ?? null,
      f.baseGravada,
      f.igv,
      f.exonerada,
      f.inafecta,
      f.isc,
      f.icbper,
      f.otros,
      f.total,
      m.u,
    ],
  );
  return r.rows[0].id as string;
}

/** Salto justificado vigente (como lo deja `justificar` de 013). Devuelve su id. */
export async function sembrarSalto(
  admin: ContappDb,
  m: MundoVentas,
  o: {
    periodo?: string;
    tipo?: string;
    serie?: string;
    desde?: number;
    hasta?: number;
    comentario?: string;
  } = {},
): Promise<string> {
  const r = await admin.pool.query(
    `insert into venta_salto_justificado (tenant_id, cliente_id, periodo, tipo, serie, desde, hasta, comentario, usuario_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      m.T,
      m.c.id,
      o.periodo ?? PERIODO,
      o.tipo ?? "03",
      o.serie ?? "B001",
      o.desde ?? 291,
      o.hasta ?? 291,
      o.comentario ?? "Boleta anulada en caja",
      m.u,
    ],
  );
  return r.rows[0].id as string;
}

/** Texto de las cuatro tablas nuevas de los estudios dados (para buscar canarios). */
export async function volcarTablasVentas(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const r = await admin.pool.query(
    `select to_jsonb(t)::text as t from propuesta t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from propuesta_diferencia t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from venta t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from venta_salto_justificado t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/**
 * Borra lo que dejan las pruebas en las cuatro tablas. Va con `session_replication_role = replica`: las filas `sire` de
 * `venta` son inmutables por trigger y las FK compuestas impiden borrar en cualquier orden. Llamar antes de `e.limpiar()`.
 */
export async function limpiarVentas(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    // Un DELETE estático por tabla, de la hija a la madre.
    const borrar = [
      "delete from venta_salto_justificado where tenant_id = any($1::uuid[])",
      "delete from venta where tenant_id = any($1::uuid[])",
      "delete from propuesta_diferencia where tenant_id = any($1::uuid[])",
      "delete from propuesta where tenant_id = any($1::uuid[])",
    ];
    for (const sql of borrar)
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
}
