// Soporte de las pruebas del worker de la spec 027 (T5, rojo). No es código de producción ni una prueba.
//
// CONTRATO de BD que fija (T10 lo implementa; son los nombres del plan 027, «Contratos: BD», migración 0069 y semilla):
// - `gnd_palabra_global(id, palabra, categoria, excepciones, activa, version)`: la semilla trae «zapatilla» (calzado-ropa; excepciones
//   «seguridad» y «punta de acero»), «polo» (excepción «a tierra») y el resto de la tabla del plan.
// - Del estudio (con `tenant_id`; el rol administrativo las siembra y las lee, nadie más escribe directo):
//   `gnd_palabra_estudio(tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por, compra_origen_id)`,
//   `gnd_global_desactivada(tenant_id, palabra_global_id, usuario_id)`, `gnd_config(tenant_id, umbral, version)`,
//   `gnd_cliente_categorias(tenant_id, cliente_id, permitidas, quitadas, version)` y `gnd_ciiu(tenant_id, ruc, ciiu, consultado_en)`.
//
// CONTRATO del worker que fija (T11):
// - `persistidores/contexto-gastos.ts`: `contextoGastos(tx, clienteId, periodo, proveedores) -> ContextoGastos` (dominio).
// - `procesadores/ciiu.ts`: `asegurarCiiu({ db, consultaRuc }, { tenantId }, rucs) -> Promise<void>`; nunca lanza.
// - `procesadores/reevaluar-periodo.ts`: `reevaluarPeriodo({ db, logger? }) -> Procesador` del tipo `compras.reevaluar`
//   (parámetros `{ periodo }`, cola `xml`), registrado en `iniciarTrabajos`.
import { createHash, randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { guardarDocumentoXml } from "@contapp/db";
import { leerUbl } from "@contapp/domain";
import { rutaXml } from "@contapp/storage";
import {
  ErrorDatos,
  ErrorTransitorio,
  type ConsultaRuc,
  type DatosRuc,
} from "@contapp/sunat";
import type { ContextoProcesador } from "../src/trabajos/ejecutor.js";
import { encolarYPublicar, type ProcesoWorker } from "./trabajos.js";
import { liberarDedupe, type MundoVentas } from "./ventas.js";
import { arrancarXml, EMISORES, fixtureXml, reemplazar, type PuertosXml } from "./xml.js";
import type { Redis } from "ioredis";

type Mundo = Pick<MundoVentas, "T" | "u" | "c">;

// ---------------------------------------------------------------------------------------------------------------
// Estado de la implementación (rojo explícito)
// ---------------------------------------------------------------------------------------------------------------

const TABLAS_027 = [
  "gnd_palabra_global",
  "gnd_palabra_estudio",
  "gnd_global_desactivada",
  "gnd_config",
  "gnd_cliente_categorias",
  "gnd_ciiu",
] as const;

/** Falla con un mensaje claro si la migración 0069 (T10) aún no existe: así el rojo dice «no implementado», no «tabla ausente». */
export async function exigirImplementado027(admin: ContappDb): Promise<void> {
  const r = await admin.pool.query(
    `select t, to_regclass(t) is not null as existe from unnest($1::text[]) t`,
    [[...TABLAS_027]],
  );
  const faltan = (r.rows as Array<{ t: string; existe: boolean }>)
    .filter((f) => !f.existe)
    .map((f) => f.t);
  if (faltan.length > 0)
    throw new Error(
      `spec 027 no implementada: faltan las tablas ${faltan.join(", ")} (migración 0069, T10)`,
    );
  const s = await admin.pool.query(
    "select count(*)::int as n from gnd_palabra_global where palabra = 'zapatilla' and activa",
  );
  if ((s.rows[0].n as number) !== 1)
    throw new Error("spec 027 no implementada: la semilla global no trae «zapatilla» (migración 0069, T10)");
}

// ---------------------------------------------------------------------------------------------------------------
// Siembras (rol administrativo: no pasa por RLS ni por grants; sí por triggers y FK)
// ---------------------------------------------------------------------------------------------------------------

export interface OpcionesPalabra {
  categoria?: string;
  excepciones?: string[];
  activa?: boolean;
}

/** Palabra propia del estudio (origen `manual`, creada por `m.u`). */
export async function sembrarPalabra(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u">,
  palabra: string,
  o: OpcionesPalabra = {},
): Promise<void> {
  await admin.pool.query(
    `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por)
     values ($1, $2, $3, $4::text[], 'manual', $5, 1, $6)`,
    [m.T, palabra, o.categoria ?? "entretenimiento", o.excepciones ?? [], o.activa ?? true, m.u],
  );
}

/** El estudio desactiva una palabra global (sin fila = activa para él). */
export async function desactivarGlobal(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u">,
  palabra: string,
): Promise<void> {
  const r = await admin.pool.query(
    `insert into gnd_global_desactivada (tenant_id, palabra_global_id, usuario_id)
     select $1, id, $2 from gnd_palabra_global where palabra = $3`,
    [m.T, m.u, palabra],
  );
  if (r.rowCount !== 1) throw new Error(`la palabra global «${palabra}» no está en la semilla`);
}

/** Umbral del estudio (sin fila = 3, versión 0). */
export async function fijarUmbral(
  admin: ContappDb,
  m: Pick<MundoVentas, "T">,
  umbral: number,
): Promise<void> {
  await admin.pool.query(
    `insert into gnd_config (tenant_id, umbral, version) values ($1, $2, 1)
     on conflict (tenant_id) do update set umbral = excluded.umbral, version = gnd_config.version + 1`,
    [m.T, umbral],
  );
}

/** Ajuste de categorías del cliente (R-13). */
export async function fijarCategorias(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "c">,
  o: { permitidas?: string[]; quitadas?: string[] },
): Promise<void> {
  await admin.pool.query(
    `insert into gnd_cliente_categorias (tenant_id, cliente_id, permitidas, quitadas, version)
     values ($1, $2, $3::text[], $4::text[], 1)
     on conflict (tenant_id, cliente_id) do update set permitidas = excluded.permitidas, quitadas = excluded.quitadas,
       version = gnd_cliente_categorias.version + 1`,
    [m.T, m.c.id, o.permitidas ?? [], o.quitadas ?? []],
  );
}

/** Caché de CIIU: fila del RUC consultada hace `dias` días (con la hora de la BD). `ciiu` null = «sin dato». */
export async function sembrarCiiu(
  admin: ContappDb,
  tenantId: string,
  ruc: string,
  ciiu: string | null,
  dias = 0,
): Promise<void> {
  await admin.pool.query(
    `insert into gnd_ciiu (tenant_id, ruc, ciiu, consultado_en)
     values ($1, $2, $3, now() - make_interval(days => $4::int))
     on conflict (tenant_id, ruc) do update set ciiu = excluded.ciiu, consultado_en = excluded.consultado_en`,
    [tenantId, ruc, ciiu, dias],
  );
}

export interface FilaCiiu {
  ruc: string;
  ciiu: string | null;
  /** Segundos desde la última consulta, con el reloj de la BD. */
  antiguedad: number;
}

/** La caché de CIIU del estudio, por RUC. */
export async function ciiuDe(admin: ContappDb, tenantId: string): Promise<FilaCiiu[]> {
  const r = await admin.pool.query(
    `select ruc, ciiu, extract(epoch from (now() - consultado_en))::float8 as antiguedad
       from gnd_ciiu where tenant_id = $1 order by ruc`,
    [tenantId],
  );
  return r.rows as FilaCiiu[];
}

/** Texto de las tablas del estudio de 027 (para buscar canarios). */
export async function volcarTablasGastos(admin: ContappDb, estudios: string[]): Promise<string> {
  const r = await admin.pool.query(
    `select to_jsonb(t)::text as t from gnd_palabra_estudio t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from gnd_global_desactivada t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from gnd_config t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from gnd_cliente_categorias t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from gnd_ciiu t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/**
 * Borra lo que dejan las pruebas en las tablas nuevas del estudio. Con `session_replication_role = replica` (las FK compuestas a
 * `cliente` y `compra` impiden borrar en cualquier orden). Llamar antes de `e.limpiar()`.
 */
export async function limpiarGastos(admin: ContappDb, estudios: string[]): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const sql of [
      "delete from gnd_ciiu where tenant_id = any($1::uuid[])",
      "delete from gnd_cliente_categorias where tenant_id = any($1::uuid[])",
      "delete from gnd_config where tenant_id = any($1::uuid[])",
      "delete from gnd_global_desactivada where tenant_id = any($1::uuid[])",
      "delete from gnd_palabra_estudio where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
}

// ---------------------------------------------------------------------------------------------------------------
// XML de comprobantes sembrados (origen `subido`: se evalúa sin la bandera P-4)
// ---------------------------------------------------------------------------------------------------------------

/** La descripción del único ítem de F001-5070 (fixture de 016). */
export const GLOSA_5070 = "Par de zapatillas deportivas de prueba (PRUEBA)";

/**
 * Guarda el XML `subido` del comprobante F001-`numero` de un fixture (opcionalmente con otra glosa) por la función de 016, en una
 * transacción del estudio. La compra puede existir ya o llegar después (descarga).
 */
export async function sembrarXmlSubido(
  admin: ContappDb,
  m: Mundo,
  numero: string,
  o: { glosa?: string } = {},
): Promise<void> {
  const texto = o.glosa === undefined ? fixtureXml(numero) : reemplazar(fixtureXml(numero), GLOSA_5070, o.glosa);
  const bytes = Buffer.from(texto, "utf8");
  const detalle = leerUbl(bytes);
  const r = await admin.withTenant({ tenantId: m.T }, (tx) =>
    guardarDocumentoXml(tx, {
      clienteId: m.c.id,
      rucEmisor: EMISORES[numero]!,
      tipo: "01",
      serie: "F001",
      numero,
      origen: "subido",
      ruta: rutaXml(m.T, m.c.id, randomUUID()),
      sha256: createHash("sha256").update(bytes).digest(),
      tamano: bytes.length,
      detalle,
      subidoPor: m.u,
    }),
  );
  if (typeof r === "string") throw new Error("el XML sembrado no se guardó");
}

/**
 * Un XML `subido` por cada compra de `sembrarCompras` (serie F900, números 1..n, proveedor 20100070970) con el ítem de F001-5070
 * (con `glosa` si se da), en una sola sentencia. Sirve para llegar a 5.000 compras evaluables sin pasar por la descarga.
 */
export async function sembrarXmlMasivo(
  admin: ContappDb,
  m: Mundo,
  n: number,
  o: { glosa?: string } = {},
): Promise<void> {
  const texto = o.glosa === undefined ? fixtureXml("5070") : reemplazar(fixtureXml("5070"), GLOSA_5070, o.glosa);
  const bytes = Buffer.from(texto, "utf8");
  await admin.pool.query(
    `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle,
                                subido_por)
     select $1::uuid, $2::uuid, '20100070970', '01', 'F900', g::text, 1, 'subido',
            'xml/' || $1::text || '/' || $2::text || '/' || gen_random_uuid()::text || '.xml', $3::bytea, $4::int, $5::jsonb, $6::uuid
       from generate_series(1, $7::int) g`,
    [
      m.T,
      m.c.id,
      createHash("sha256").update(bytes).digest(),
      bytes.length,
      JSON.stringify(leerUbl(bytes)),
      m.u,
      n,
    ],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------------------------------------------

export interface SenalBd {
  codigo: string;
  puntos: number;
  palabra?: string;
  categoria?: string;
  items?: { coinciden: number; total: number };
}

export interface SugerenciaGp {
  tipo: string;
  palabra: string | null;
  categoria: string | null;
  puntaje: number;
  senales: SenalBd[];
}

/** El hallazgo R-GP de la evaluación `n` de la versión vigente de la compra (o `null` si esa evaluación no lo trae). */
export async function rgpDe(
  admin: ContappDb,
  compraId: string,
  n: number,
): Promise<{ sugerencia: SugerenciaGp; requiere_confirmacion: boolean } | null> {
  const r = await admin.pool.query(
    `select sugerencia, requiere_confirmacion from compra_hallazgo
      where compra_id = $1 and regla = 'R-GP' and evaluacion_n = $2 order by version_n desc limit 1`,
    [compraId, n],
  );
  return (r.rows[0] as { sugerencia: SugerenciaGp; requiere_confirmacion: boolean } | undefined) ?? null;
}

/** Cuántas compras del periodo tienen una evaluación con ese número (cualquier versión). */
export async function contarEvaluacionesN(
  admin: ContappDb,
  clienteId: string,
  periodo: string,
  n: number,
): Promise<number> {
  const r = await admin.pool.query(
    `select count(*)::int as n from compra_evaluacion e join compra c on c.id = e.compra_id
      where c.cliente_id = $1 and c.periodo = $2 and e.n = $3`,
    [clienteId, periodo, n],
  );
  return r.rows[0].n as number;
}

/** Filas de `compra_version` del cliente y periodo (las acciones del usuario crean versiones; la re-evaluación no). */
export async function contarVersiones(admin: ContappDb, clienteId: string, periodo: string): Promise<number> {
  const r = await admin.pool.query(
    `select count(*)::int as n from compra_version v join compra c on c.id = v.compra_id where c.cliente_id = $1 and c.periodo = $2`,
    [clienteId, periodo],
  );
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------------------------------------------
// ConsultaRuc de la prueba
// ---------------------------------------------------------------------------------------------------------------

/** Lo que responde el RUC: una clase CIIU, `null` (sin dato en el padrón), `datos` (ErrorDatos) o `transitorio` (ErrorTransitorio). */
export type RespuestaCiiu = string | null | "datos" | "transitorio";

export interface LlamadaCiiu {
  ruc: string;
  /** Transacciones del worker abiertas en el instante de la llamada (0 = ninguna, 008 D6). */
  en: number;
}

/** `ConsultaRuc` con respuestas por RUC que anota cada llamada. Los RUC que no se nombran responden `porDefecto`. */
export class ConsultaRucCiiu implements ConsultaRuc {
  readonly llamadas: LlamadaCiiu[] = [];
  /** Cuántas transacciones tiene abiertas el worker (se conecta con `ProcesoWorker.dbEstado`). */
  contarTx: () => number = () => 0;
  constructor(
    private readonly respuestas: Record<string, RespuestaCiiu> = {},
    private readonly porDefecto: RespuestaCiiu = "datos",
  ) {}

  responder(ruc: string, r: RespuestaCiiu): void {
    this.respuestas[ruc] = r;
  }

  /** RUC consultados, en orden. */
  get rucs(): string[] {
    return this.llamadas.map((l) => l.ruc);
  }

  async consultar(ruc: string): Promise<DatosRuc> {
    this.llamadas.push({ ruc, en: this.contarTx() });
    const r = Object.hasOwn(this.respuestas, ruc) ? this.respuestas[ruc]! : this.porDefecto;
    if (r === "datos") throw new ErrorDatos();
    if (r === "transitorio") throw new ErrorTransitorio();
    return { razonSocial: "RAZON PRUEBA S.A.C.", estado: "ACTIVO", condicion: "HABIDO", ciiu: r };
  }
}

/** El mismo mapa para casi todas las pruebas: ferretería (4752) y proveedor de F001-5070, tienda de calzado (4771). */
export function consultaFerreteria(cliente: string): ConsultaRucCiiu {
  return new ConsultaRucCiiu({ [cliente]: "4752", [EMISORES["5070"]!]: "4771" });
}

/** Arranca el worker de XML con la `ConsultaRuc` de la prueba y conecta su espía de transacciones abiertas. */
export async function arrancarConCiiu(
  prefijo: string,
  p: PuertosXml,
  consulta: ConsultaRucCiiu,
  extra: Record<string, unknown> = {},
): Promise<ProcesoWorker> {
  const w = await arrancarXml(prefijo, p, { simuladoEnReglas: true, consultaRuc: consulta, ...extra });
  consulta.contarTx = () => w.dbEstado.abiertas;
  return w;
}

// ---------------------------------------------------------------------------------------------------------------
// `compras.reevaluar`
// ---------------------------------------------------------------------------------------------------------------

export const TIPO_REEVALUAR = "compras.reevaluar";

/** Encola `compras.reevaluar` como lo hace el backend (rol backend). Con `liberar` suelta la clave de dedupe para poder repetirlo. */
export async function encolarReevaluar(
  admin: ContappDb,
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: Mundo,
  periodo: string,
  o: { liberar?: boolean } = {},
): Promise<{ id: string; nuevo: boolean }> {
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: TIPO_REEVALUAR,
    clienteId: m.c.id,
    parametros: { periodo },
    prioridad: "interactivo",
    creadoPor: m.u,
  });
  if (o.liberar === true) await liberarDedupe(admin, r.trabajo.id);
  return { id: r.trabajo.id, nuevo: r.nuevo };
}

/** El contexto que el ejecutor de 008 le pasa al procesador. */
export function ctxReevaluar(m: Mundo, trabajoId: string, parametros: unknown): ContextoProcesador {
  return {
    trabajo: {
      id: trabajoId,
      tenantId: m.T,
      clienteId: m.c.id,
      ruc: m.c.ruc,
      tipo: TIPO_REEVALUAR,
      parametros,
      intentos: 0,
      creadoPor: m.u,
    },
    conToken: () => {
      throw new Error("compras.reevaluar no usa credenciales ni token");
    },
  };
}

/** Cancela los trabajos pendientes de los estudios (los que se ejecutaron directo quedan `en_cola`). */
export async function cancelarPendientes(admin: ContappDb, estudios: string[]): Promise<void> {
  await admin.pool.query(
    `update job_registro set estado = 'cancelado', terminado_en = now(), actualizado_en = now()
      where tenant_id = any($1::uuid[]) and estado = 'en_cola'`,
    [estudios],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Gancho tras un COMMIT (simula que otro usuario cierra el periodo a mitad de un trabajo)
// ---------------------------------------------------------------------------------------------------------------

type ClientePg = { query: (...a: unknown[]) => unknown };
type PoolPg = { connect: (...a: unknown[]) => unknown };

/**
 * Envuelve el pool dado: la primera vez que una transacción que ejecutó una sentencia con `patron` hace COMMIT, espera a que
 * `hacer()` termine ANTES de devolverle el control al código que la usa. Sirve para fijar un estado entre dos lotes sin carreras.
 * Solo vale con `pool.connect()` en forma de promesa (la que usa `withTenant`).
 */
export function alConfirmarTrasSentencia(
  pool: unknown,
  patron: RegExp,
  hacer: () => Promise<void>,
): { disparos: () => number; restaurar(): void } {
  const p = pool as PoolPg;
  const original = p.connect;
  const vistos = new WeakSet<object>();
  const marcados = new WeakSet<object>();
  let disparos = 0;
  const instrumentar = (c: ClientePg): void => {
    if (vistos.has(c)) return;
    vistos.add(c);
    const q = c.query.bind(c);
    c.query = (...args: unknown[]) => {
      const a0 = args[0] as string | { text?: string } | undefined;
      const texto = typeof a0 === "string" ? a0 : String(a0?.text ?? "");
      if (/^\s*begin/i.test(texto)) marcados.delete(c);
      if (patron.test(texto)) marcados.add(c);
      if (/^\s*commit/i.test(texto) && marcados.has(c) && disparos === 0) {
        marcados.delete(c);
        disparos += 1;
        return Promise.resolve(q(...args)).then(async (r) => {
          await hacer();
          return r;
        });
      }
      return q(...args);
    };
  };
  p.connect = (...args: unknown[]) =>
    (original.call(p, ...args) as Promise<ClientePg>).then((c) => {
      instrumentar(c);
      return c;
    });
  return {
    disparos: () => disparos,
    restaurar: () => {
      p.connect = original;
    },
  };
}
