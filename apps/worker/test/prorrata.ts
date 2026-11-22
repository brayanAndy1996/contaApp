// Soporte de las pruebas del worker de la spec 026 (T5): trabajo `sol.declaraciones.descargar` (PDT 621 por periodo). No es código de
// producción ni una prueba. Usa la BD y Redis reales de las demás pruebas de integración.
//
// CONTRATO DEL WORKER QUE FIJAN ESTAS PRUEBAS (lo implementa T11; plan 026, Contratos: Worker y Cola; spec D-1 a D-3, D-7):
// - `apps/worker/src/trabajos/procesadores/obtener-declaraciones.ts` exporta `obtenerDeclaraciones(deps): Procesador` con
//     deps = { db: Pick<ContappDb, "withTenant">, servicio: ServicioCredenciales, solPortal: SolPortal }
//   (mismo patrón que `revisarBuzon`). `iniciarTrabajos` lo registra como `sol.declaraciones.descargar` junto a `sol.buzon.*` con el
//   `solPortal` y la KEK de las deps (T11 es la única que edita `iniciar.ts`).
// - Parámetros `{periodo: AAAAMM}` (`.strict()`, de `SOL_DECLARACIONES_DESCARGAR.parametros`); inválidos -> `ErrorDatos` sin tocar el
//   portal ni descifrar. El cliente y el RUC salen del trabajo; la ventana de 12 periodos (M−11..M) se deriva del periodo.
// - Descifra UNA vez por trabajo (servicio auditado de 003, motivo = tipo) y llama a `solPortal.obtenerDeclaraciones621(cred,
//   {periodo})` UNA vez por periodo, del más reciente al más antiguo, SIN transacción abierta (008 D6). `ErrorDatos` o lista vacía =
//   periodo «sin declaración» y sigue. Cualquier otro error del puerto sale tal cual (el ejecutor de 008 lo clasifica: credencial ->
//   `error/credencial_invalida` sin reintento y credencial `invalida`; transitorio -> reintenta; `ErrorPortal` -> `portal_cambio`), sin
//   haber escrito nada.
// - Escribe en UNA transacción con una sola llamada a `registrarDeclaraciones` de `@contapp/db`
//     (tx, {clienteId, trabajoId, periodoHasta, leidos: string[12], sinDeclaracion: string[], declaraciones: DeclaracionNueva[]}) -> nuevas
//   (la función `prorrata_declaraciones_registrar` de 0066), sin SAVEPOINT y sin tocar ventas, compras ni manuales. `leidos` son los 12
//   periodos consultados (incluye los «sin declaración»). `55000` (cliente archivado entre medio) = el trabajo termina `completado`
//   sin escribir.
// - `resultado` = {periodosLeidos, sinDeclaracion, nuevas}: solo conteos enteros (D-7).
// - El bloqueo por RUC de 008 serializa este trabajo con `sol.buzon.*` del mismo RUC.
//
// El portal de estas pruebas es un doble en memoria (`PortalPdt`), no `MockSolPortal`: así el rojo es del worker y no del mock (salvo la
// prueba de volumen de 12 periodos, que usa el mock a propósito).
/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas en pruebas */
import type { ContappDb } from "@contapp/db";
import * as cola from "@contapp/queue";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorTransitorio,
  type CredencialSol,
  type MensajeSol,
  type PaginaMensajesSol,
  type SolPortal,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import { guardarCredencial } from "./procesadores-007b.js";
import { asignarResponsable } from "./notificaciones.js";
import { canario } from "./soporte.js";
import {
  compuerta,
  dormir,
  encolarYPublicar,
  type ClientePrueba,
  type Escenario,
} from "./trabajos.js";

export const TIPO_DECLARACIONES = "sol.declaraciones.descargar";
export const PERIODO_M = "202610";

/** Ventana de 12 periodos de `hasta` (M−11..M), del más reciente al más antiguo. Oráculo simple de la prueba. */
export function ventanaDe(hasta: string): string[] {
  let a = Number(hasta.slice(0, 4));
  let m = Number(hasta.slice(4, 6));
  const salida: string[] = [];
  for (let i = 0; i < 12; i++) {
    salida.push(`${a}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      a -= 1;
    }
  }
  return salida;
}

export const VENTANA_12 = ventanaDe(PERIODO_M);

// ---------------------------------------------------------------------------------------------------------------
// Guardas «no implementado» (para que el rojo sea por la razón correcta y no por un detalle del arnés)
// ---------------------------------------------------------------------------------------------------------------

/** Falla con «no implementado» mientras falte el procesador (T11) o el tipo del catálogo (T9). */
export async function exigirImplementado(): Promise<void> {
  if (
    (cola as Record<string, unknown>).SOL_DECLARACIONES_DESCARGAR === undefined
  )
    throw new Error(
      "no implementado: SOL_DECLARACIONES_DESCARGAR en @contapp/queue (spec 026, T9)",
    );
  const ruta = "../src/trabajos/procesadores/obtener-declaraciones.js";
  let modulo: Record<string, unknown>;
  try {
    modulo = (await import(/* @vite-ignore */ ruta)) as Record<string, unknown>;
  } catch {
    throw new Error(
      "no implementado: procesadores/obtener-declaraciones.ts (spec 026, T11)",
    );
  }
  if (typeof modulo.obtenerDeclaraciones !== "function")
    throw new Error(
      "no implementado: obtenerDeclaraciones en obtener-declaraciones.ts (spec 026, T11)",
    );
}

// ---------------------------------------------------------------------------------------------------------------
// PDT 621 de prueba
// ---------------------------------------------------------------------------------------------------------------

export interface Decl621 {
  periodo: string;
  numeroOrden: string;
  fechaPresentacion: string;
  tipo: "original" | "rectificatoria";
  ventasGravadasBase: string;
  ventasGravadasIgv: string;
  exportaciones: string;
  noGravadas: string;
  igvAdquisicionesDg: string;
  igvAdquisicionesDgng: string;
  prorrataUsada: string | null;
}

export type RespuestaPeriodo = Decl621[] | "error_datos";
export type PdtPrueba = Record<string, RespuestaPeriodo>;

/** Una presentación original con montos distintos por periodo (para detectar que se guardó cada una en su sitio). */
export function decl(periodo: string, o: Partial<Decl621> = {}): Decl621 {
  const n = Number(periodo.slice(4, 6));
  return {
    periodo,
    numeroOrden: `${Number(periodo) * 10 + 1}`,
    fechaPresentacion: `${periodo.slice(0, 4)}-${periodo.slice(4, 6)}-15`,
    tipo: "original",
    ventasGravadasBase: `${100000 + n * 1000}.00`,
    ventasGravadasIgv: `${18000 + n * 180}.00`,
    exportaciones: "0.00",
    noGravadas: `${20000 + n}.50`,
    igvAdquisicionesDg: `${9000 + n}.00`,
    igvAdquisicionesDgng: `${3600 + n}.25`,
    prorrataUsada: null,
    ...o,
  };
}

/**
 * Los 12 periodos de 2026-10: 202602 sin declaración (lista vacía), 202605 con `ErrorDatos`, 202607 con original y rectificatoria,
 * 202610 con prorrata usada y exportaciones. Esperado: 12 leídos, 2 sin declaración, 11 presentaciones nuevas.
 */
export function pdtDoce(): PdtPrueba {
  const d: PdtPrueba = {};
  for (const p of VENTANA_12) d[p] = [decl(p)];
  d["202602"] = [];
  d["202605"] = "error_datos";
  d["202607"] = [
    decl("202607", { numeroOrden: "2026070100" }),
    decl("202607", {
      numeroOrden: "2026070101",
      tipo: "rectificatoria",
      fechaPresentacion: "2026-09-03",
      ventasGravadasBase: "130000.00",
    }),
  ];
  d["202610"] = [
    decl("202610", { exportaciones: "4000.00", prorrataUsada: "87.35" }),
  ];
  return d;
}

export const ESPERADO_DOCE = {
  periodosLeidos: 12,
  sinDeclaracion: 2,
  nuevas: 11,
  periodosSinDeclaracion: ["202602", "202605"],
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Portal controlado (doble de `SolPortal` con `obtenerDeclaraciones621`)
// ---------------------------------------------------------------------------------------------------------------

type ModoFalla = "credencial" | "transitorio" | "error";

export interface LlamadaPdt {
  ruc: string;
  periodo: string;
  /** Transacciones del worker abiertas en el instante de la llamada. */
  tx: number;
}

/**
 * Doble de `SolPortal`: PDT por RUC (o el mismo para todos), fallos programables, pausa dentro de la llamada, demora fija y medida de
 * llamadas simultáneas (buzón y PDT juntas: sirve para probar la serialización por RUC y la concurrencia por tenant).
 */
export class PortalPdt implements SolPortal {
  private readonly porRuc = new Map<string, PdtPrueba>();
  private paraTodos: PdtPrueba | null = null;
  private falla: {
    modo: ModoFalla;
    despuesDe: number;
    veces: number;
    error?: Error;
  } | null = null;
  private puerta: ReturnType<typeof compuerta> | null = null;
  private enPausa = 0;
  private desdeArmado = 0;
  private simultaneas = 0;
  readonly llamadas: LlamadaPdt[] = [];
  readonly credenciales: CredencialSol[] = [];
  /** Llamadas a `listarMensajes` (buzón) recibidas. */
  llamadasBuzon = 0;
  maxSimultaneas = 0;
  /** Transacciones abiertas del worker en este instante (se conecta con `ProcesoWorker.dbEstado`). */
  contarTx: () => number = () => 0;
  /** Demora de cada llamada, para que las simultáneas se superpongan. */
  demoraMs = 0;

  pdt(ruc: string, datos: PdtPrueba): this {
    this.porRuc.set(ruc, datos);
    return this;
  }
  todos(datos: PdtPrueba): this {
    this.paraTodos = datos;
    return this;
  }

  fallar(
    modo: ModoFalla | null,
    o: { despuesDe?: number; veces?: number; error?: Error } = {},
  ): void {
    this.desdeArmado = 0;
    this.falla =
      modo === null
        ? null
        : {
            modo,
            despuesDe: o.despuesDe ?? 0,
            veces: o.veces ?? Number.POSITIVE_INFINITY,
            ...(o.error ? { error: o.error } : {}),
          };
  }

  pausar(): void {
    this.puerta = compuerta();
  }
  abrir(): void {
    this.puerta?.abrir();
    this.puerta = null;
  }
  /** Llamadas que están esperando dentro de la pausa. */
  enEspera(): number {
    return this.enPausa;
  }

  /** Periodos pedidos, en orden de llamada (de un RUC o de todos). */
  periodos(ruc?: string): string[] {
    return this.llamadas
      .filter((l) => ruc === undefined || l.ruc === ruc)
      .map((l) => l.periodo);
  }

  private async entrar(): Promise<void> {
    this.simultaneas += 1;
    this.maxSimultaneas = Math.max(this.maxSimultaneas, this.simultaneas);
  }
  private salir(): void {
    this.simultaneas -= 1;
  }

  private async pasar(): Promise<void> {
    await this.entrar();
    try {
      if (this.puerta) {
        this.enPausa += 1;
        try {
          await this.puerta.esperar();
        } finally {
          this.enPausa -= 1;
        }
      }
      if (this.demoraMs > 0) await dormir(this.demoraMs);
      const n = this.desdeArmado++;
      const f = this.falla;
      if (f && n >= f.despuesDe && n < f.despuesDe + f.veces) {
        if (f.modo === "credencial") throw new ErrorCredencial();
        if (f.modo === "transitorio") throw new ErrorTransitorio();
        throw f.error ?? new Error("falla del portal de la prueba");
      }
    } finally {
      this.salir();
    }
  }

  async obtenerDeclaraciones621(
    c: CredencialSol,
    o: { periodo: string },
  ): Promise<Decl621[]> {
    this.llamadas.push({
      ruc: c.ruc,
      periodo: o.periodo,
      tx: this.contarTx(),
    });
    this.credenciales.push({ ...c });
    await this.pasar();
    const datos = this.porRuc.get(c.ruc) ?? this.paraTodos ?? {};
    const r = datos[o.periodo] ?? [];
    if (r === "error_datos") throw new ErrorDatos();
    return structuredClone(r);
  }

  async listarMensajes(
    c: CredencialSol,
    _o: { cursor: string | null; limite: number },
  ): Promise<PaginaMensajesSol> {
    this.llamadasBuzon += 1;
    this.credenciales.push({ ...c });
    await this.pasar();
    return { mensajes: [], siguiente: null };
  }

  async obtenerMensaje(): Promise<MensajeSol> {
    throw new Error("obtenerMensaje no se usa en las pruebas de la prorrata");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mundo y encolado
// ---------------------------------------------------------------------------------------------------------------

export interface MundoProrrata {
  T: string;
  /** Responsable del cliente (contador). */
  u: string;
  c: ClientePrueba;
  secretos: { usuario: string; clave: string };
}

/** Estudio con un cliente con credencial SOL real (canarios) y responsable; o solo un cliente más en el `T` dado. */
export async function mundoProrrata(
  e: Escenario,
  admin: ContappDb,
  backend: ContappDb,
  existente?: Pick<MundoProrrata, "T" | "u">,
): Promise<MundoProrrata> {
  const T = existente?.T ?? (await e.estudio());
  const u = existente?.u ?? (await e.usuario(T, "contador"));
  const c = await e.cliente(T);
  await asignarResponsable(admin, T, c.id, u);
  const secretos = {
    usuario: canario("usuario_sol"),
    clave: canario("clave_sol"),
  };
  await guardarCredencial(backend, T, c.id, "sol", secretos);
  return { T, u, c, secretos };
}

/** Encola como lo hace el backend (rol backend, `interactivo`). Devuelve el id del trabajo y si es nuevo. */
export async function encolarDeclaraciones(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: Pick<MundoProrrata, "T" | "u" | "c">,
  periodo: string = PERIODO_M,
): Promise<{ id: string; nuevo: boolean }> {
  await exigirImplementado();
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: TIPO_DECLARACIONES,
    clienteId: m.c.id,
    parametros: { periodo },
    prioridad: "interactivo",
    creadoPor: m.u,
  });
  return { id: r.trabajo.id, nuevo: r.nuevo };
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas con el rol administrativo (las tablas las crea T10, 0065)
// ---------------------------------------------------------------------------------------------------------------

export interface FilaDeclaracion {
  periodo: string;
  numero_orden: string;
  fecha_presentacion: string;
  tipo: string;
  ventas_gravadas_base: string;
  ventas_gravadas_igv: string;
  exportaciones: string;
  no_gravadas: string;
  igv_adq_dg: string;
  igv_adq_dgng: string;
  prorrata_usada: string | null;
  obtencion_id: string;
}

export async function declaracionesDe(
  admin: ContappDb,
  clienteId: string,
): Promise<FilaDeclaracion[]> {
  const r = await admin.pool.query(
    `select periodo::text as periodo, numero_orden::text as numero_orden, fecha_presentacion::text as fecha_presentacion, tipo,
            ventas_gravadas_base::text as ventas_gravadas_base, ventas_gravadas_igv::text as ventas_gravadas_igv,
            exportaciones::text as exportaciones, no_gravadas::text as no_gravadas, igv_adq_dg::text as igv_adq_dg,
            igv_adq_dgng::text as igv_adq_dgng, prorrata_usada::text as prorrata_usada, obtencion_id
       from declaracion_mensual where cliente_id = $1 order by periodo, numero_orden`,
    [clienteId],
  );
  return r.rows as FilaDeclaracion[];
}

export interface FilaObtencion {
  id: string;
  periodo_hasta: string;
  trabajo_id: string | null;
  periodos_leidos: string[];
  periodos_sin_declaracion: string[];
  nuevas: number;
}

export async function obtencionesDe(
  admin: ContappDb,
  clienteId: string,
): Promise<FilaObtencion[]> {
  const r = await admin.pool.query(
    `select id, periodo_hasta::text as periodo_hasta, trabajo_id, periodos_leidos::text[] as periodos_leidos,
            periodos_sin_declaracion::text[] as periodos_sin_declaracion, nuevas
       from prorrata_obtencion where cliente_id = $1 order by obtenida_en, id`,
    [clienteId],
  );
  return r.rows as FilaObtencion[];
}

/** Filas escritas por el trabajo en los estudios dados (obtenciones y presentaciones). */
export async function escrituras(
  admin: ContappDb,
  estudios: string[],
): Promise<{ obtenciones: number; declaraciones: number }> {
  const o = await admin.pool.query(
    "select count(*)::int as n from prorrata_obtencion where tenant_id = any($1::uuid[])",
    [estudios],
  );
  const d = await admin.pool.query(
    "select count(*)::int as n from declaracion_mensual where tenant_id = any($1::uuid[])",
    [estudios],
  );
  return { obtenciones: o.rows[0].n, declaraciones: d.rows[0].n };
}

/** Lo que la prueba espera de la fila de una presentación (montos de `Decl621` tal cual). */
export function comoFila(d: Decl621): Omit<FilaDeclaracion, "obtencion_id"> {
  return {
    periodo: d.periodo,
    numero_orden: d.numeroOrden,
    fecha_presentacion: d.fechaPresentacion,
    tipo: d.tipo,
    ventas_gravadas_base: d.ventasGravadasBase,
    ventas_gravadas_igv: d.ventasGravadasIgv,
    exportaciones: d.exportaciones,
    no_gravadas: d.noGravadas,
    igv_adq_dg: d.igvAdquisicionesDg,
    igv_adq_dgng: d.igvAdquisicionesDgng,
    prorrata_usada: d.prorrataUsada,
  };
}

/** Borra las filas de la prorrata de los estudios (modo replica: los triggers de solo inserción no corren). Antes de `Escenario.limpiar`. */
export async function limpiarProrrata(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  if (estudios.length === 0) return;
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const sql of [
      "delete from declaracion_mensual where tenant_id = any($1::uuid[])",
      "delete from prorrata_obtencion where tenant_id = any($1::uuid[])",
      "delete from prorrata_mes_manual where tenant_id = any($1::uuid[])",
      "delete from prorrata_usada_manual where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
  } catch {
    // limpieza de mejor esfuerzo
  } finally {
    c.release(true);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registro de sentencias del pool del worker (una sola escritura, sin SAVEPOINT)
// ---------------------------------------------------------------------------------------------------------------

export interface Sentencia {
  /** Número de la conexión del pool (cada una ejecuta sus sentencias en orden). */
  cliente: number;
  texto: string;
}

type ClientePg = { query: (...a: unknown[]) => unknown };
type PoolPg = { connect: (...a: unknown[]) => unknown };

/** Anota el texto de cada sentencia que el pool dado envía a la BD (valores y resultados no se guardan). */
export function espiarSentencias(pool: unknown): {
  sentencias: Sentencia[];
  restaurar(): void;
} {
  const p = pool as PoolPg;
  const original = p.connect;
  const sentencias: Sentencia[] = [];
  const ids = new WeakMap<object, number>();
  let n = 0;
  const instrumentar = (c: ClientePg): void => {
    if (ids.has(c)) return;
    const id = (n += 1);
    ids.set(c, id);
    const q = c.query.bind(c);
    c.query = (...args: unknown[]) => {
      const a0 = args[0] as string | { text?: string } | undefined;
      sentencias.push({
        cliente: id,
        texto: typeof a0 === "string" ? a0 : String(a0?.text ?? ""),
      });
      return q(...args);
    };
  };
  p.connect = (...args: unknown[]) => {
    const ultimo = args[args.length - 1];
    if (typeof ultimo === "function") {
      const cb = ultimo as (err: unknown, c: ClientePg, done: unknown) => void;
      return original.call(
        p,
        ...args.slice(0, -1),
        (err: unknown, c: ClientePg, done: unknown) => {
          if (c) instrumentar(c);
          cb(err, c, done);
        },
      );
    }
    return (original.call(p, ...args) as Promise<ClientePg>).then((c) => {
      instrumentar(c);
      return c;
    });
  };
  return {
    sentencias,
    restaurar: () => {
      p.connect = original;
    },
  };
}

/** Las sentencias de la transacción de `s`: desde su BEGIN hasta su COMMIT o ROLLBACK, en su conexión. */
export function transaccionDe(todas: Sentencia[], s: Sentencia): Sentencia[] {
  const propias = todas.filter((x) => x.cliente === s.cliente);
  const i = propias.indexOf(s);
  let ini = i;
  while (ini > 0 && !/^\s*begin/i.test(propias[ini]!.texto)) ini -= 1;
  let fin = i;
  while (
    fin < propias.length - 1 &&
    !/^\s*(commit|rollback)/i.test(propias[fin]!.texto)
  )
    fin += 1;
  return propias.slice(ini, fin + 1);
}

/** DML directo sobre las tablas de la prorrata, ventas, compras o manuales (el worker solo escribe por la función acotada). */
export const DML_PROHIBIDO =
  /\b(insert\s+into|update|delete\s+from)\s+"?(public"?\."?)?(declaracion_mensual|prorrata_[a-z_]+|venta[a-z_]*|compra[a-z_]*)\b/i;
