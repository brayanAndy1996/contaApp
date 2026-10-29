// Soporte de las pruebas de integración de los trabajos del worker (spec 008, T5): PostgreSQL y Redis reales, BullMQ real.
// No es código de producción (vive fuera de `src`, como `bd.ts` y `soporte.ts`) ni una prueba.
// - Cada archivo crea sus propios estudios, usuarios, clientes y credenciales con la conexión administrativa
//   (MIGRATIONS_DATABASE_URL) y los borra al final; nada depende del seed (salvo `kek.rotar`, que rota todos los estudios).
// - Redis: base 15 y un prefijo aleatorio por archivo; `limpiarPrefijo` borra solo ese prefijo.
// - `config_sistema` es global: se cambia con `fijarConfig` y se devuelve a D12 con `restaurarConfig`.
// - Arranca el worker de trabajos con `arrancar()` (contrato de `iniciarTrabajos` en src/trabajos/iniciar.ts), con una BD
//   y un Redis ESPIADOS: cuentan transacciones abiertas (D6) y comandos emitidos tras `abortar()` (muerte del proceso).
// Los secretos de las pruebas son canarios generados al vuelo.
/* eslint-disable @typescript-eslint/no-explicit-any -- proxies de espionaje y filas de BD dinámicas en pruebas */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createDb, type ContappDb } from "@contapp/db";
import {
  aPublicable,
  crearClaves,
  encolar,
  publicar,
  registrarTipo,
  type EntradaEncolar,
  type ResultadoEncolar,
} from "@contapp/queue";
import { Redis } from "ioredis";
import { z } from "zod";
import {
  iniciarTrabajos,
  type DepsTrabajos,
  type TrabajosEnMarcha,
} from "../src/trabajos/iniciar.js";
import type {
  ContextoProcesador,
  Procesador,
} from "../src/trabajos/ejecutor.js";

export const dormir = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Espera a que `cond` sea verdadera (sondeo corto); falla con `etiqueta` si pasa `timeoutMs`. */
export async function esperarHasta(
  cond: () => boolean | Promise<boolean>,
  etiqueta: string,
  {
    timeoutMs = 15_000,
    cadenciaMs = 25,
  }: { timeoutMs?: number; cadenciaMs?: number } = {},
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > limite)
      throw new Error(`tiempo agotado esperando: ${etiqueta}`);
    await dormir(cadenciaMs);
  }
}

/** Reloj real con desplazamiento: `avanzar(ms)` simula que pasó el tiempo sin dormir. */
export class RelojAjustable {
  private desplazamientoMs = 0;
  ahora(): Date {
    return new Date(Date.now() + this.desplazamientoMs);
  }
  avanzar(ms: number): void {
    this.desplazamientoMs += ms;
  }
}

/** Texto único imposible de confundir con datos reales; se busca luego en logs, BD, Redis y eventos. */
export const canario = (etiqueta = "x"): string =>
  `CANARIO-${etiqueta}-${randomBytes(8).toString("hex")}`;

// ---------------------------------------------------------------------------------------------------------------
// Tipos de trabajo propios de las pruebas (el catálogo real los registra cada spec de negocio)
// ---------------------------------------------------------------------------------------------------------------

const parametrosPrueba = z.object({
  n: z.number().int().optional(),
  rango: z.string().max(64).optional(),
});

/** `prueba.eco` (idempotente) ya viene del catálogo con NODE_ENV=test; aquí se agregan los otros dos. */
export function registrarTiposDePrueba(): void {
  registrarTipo({
    tipo: "prueba.no_idempotente",
    cola: "sire",
    canal: "sire",
    credencial: null,
    permiso: "sire.descargar",
    idempotente: false,
    parametros: parametrosPrueba,
  });
  registrarTipo({
    tipo: "prueba.credencial_sol",
    cola: "sire",
    canal: "sire",
    credencial: "sol",
    permiso: "sire.descargar",
    idempotente: true,
    parametros: parametrosPrueba,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Conexiones
// ---------------------------------------------------------------------------------------------------------------

export function crearDbRol(
  rolApp: "contapp_backend" | "contapp_worker",
  poolMax = 4,
): ContappDb {
  return createDb({ rolApp, poolMax });
}

/** Conexión administrativa (superusuario): solo para sembrar, limpiar y leer. */
export function crearDbAdmin(): ContappDb {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url)
    throw new Error(
      "falta MIGRATIONS_DATABASE_URL para las pruebas de integracion",
    );
  return createDb({ rolApp: "contapp_worker", url, poolMax: 2 });
}

function urlRedis(): URL {
  const base = process.env.REDIS_URL;
  if (!base) throw new Error("falta REDIS_URL para las pruebas de integracion");
  const u = new URL(base);
  u.pathname = "/15"; // base propia de las pruebas (plan 008)
  return u;
}

export function conectarRedis(): Redis {
  return new Redis(urlRedis().toString());
}

/** Opciones de conexión para BullMQ, siempre en la base 15. */
export function opcionesBull() {
  const u = urlRedis();
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: 15,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

export const nuevoPrefijo = (): string =>
  `t5w-${randomBytes(4).toString("hex")}:`;

export async function limpiarPrefijo(
  redis: Redis,
  prefijo: string,
): Promise<void> {
  let cursor = "0";
  do {
    const [siguiente, claves] = await redis.scan(
      cursor,
      "MATCH",
      `${prefijo}*`,
      "COUNT",
      "500",
    );
    cursor = siguiente;
    if (claves.length > 0) await redis.del(...claves);
  } while (cursor !== "0");
}

/** Todo lo que hay bajo el prefijo (nombres de clave si `claves`, y valores) volcado a texto para buscar canarios. */
export async function volcarPrefijo(
  redis: Redis,
  prefijo: string,
  { claves: conClaves = true }: { claves?: boolean } = {},
): Promise<string> {
  const salida: string[] = [];
  let cursor = "0";
  do {
    const [siguiente, claves] = await redis.scan(
      cursor,
      "MATCH",
      `${prefijo}*`,
      "COUNT",
      "500",
    );
    cursor = siguiente;
    for (const clave of claves) {
      if (conClaves) salida.push(clave);
      const tipo = await redis.type(clave);
      if (tipo === "string") {
        const b = await redis.getBuffer(clave);
        if (b)
          salida.push(
            b.toString("latin1"),
            b.toString("utf8"),
            b.toString("hex"),
            b.toString("base64"),
          );
      } else if (tipo === "hash")
        salida.push(JSON.stringify(await redis.hgetall(clave)));
      else if (tipo === "list")
        salida.push(JSON.stringify(await redis.lrange(clave, 0, -1)));
      else if (tipo === "set")
        salida.push(JSON.stringify(await redis.smembers(clave)));
      else if (tipo === "zset")
        salida.push(
          JSON.stringify(await redis.zrange(clave, "0", "-1", "WITHSCORES")),
        );
    }
  } while (cursor !== "0");
  return salida.join("\n");
}

/** Suscriptor de `eventos:{tenantId}`: guarda cada mensaje JSON recibido. */
export async function suscribirEventos(prefijo: string, tenantIds: string[]) {
  const sub = conectarRedis();
  const k = crearClaves(prefijo);
  const mensajes: Array<{ canal: string; texto: string; evento: any }> = [];
  sub.on("message", (canal: string, texto: string) => {
    let evento: unknown = null;
    try {
      evento = JSON.parse(texto);
    } catch {
      /* texto inválido: la prueba lo verá en `texto` */
    }
    mensajes.push({ canal, texto, evento });
  });
  await sub.subscribe(...tenantIds.map((t) => k.eventos(t)));
  return {
    mensajes,
    de: (jobId: string) =>
      mensajes.filter((m) => m.evento?.id === jobId).map((m) => m.evento),
    estadosDe: (jobId: string) =>
      mensajes
        .filter((m) => m.evento?.id === jobId)
        .map((m) => m.evento.estado as string),
    cerrar: async () => {
      sub.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// config_sistema
// ---------------------------------------------------------------------------------------------------------------

export interface CambioConfig {
  global?: number;
  tenant?: number;
  espera?: number;
  reintentos?: number;
  base?: number;
  maxPendientes?: number;
}

export async function fijarConfig(
  admin: ContappDb,
  cola: string,
  c: CambioConfig,
): Promise<void> {
  await admin.pool.query(
    `update config_sistema set
       concurrencia_global = coalesce($2, concurrencia_global),
       concurrencia_tenant = coalesce($3, concurrencia_tenant),
       espera_ruc_ms = coalesce($4, espera_ruc_ms),
       reintentos = coalesce($5, reintentos),
       backoff_base_ms = coalesce($6, backoff_base_ms),
       max_pendientes_tenant = coalesce($7, max_pendientes_tenant),
       actualizado_en = now()
     where cola = $1`,
    [
      cola,
      c.global ?? null,
      c.tenant ?? null,
      c.espera ?? null,
      c.reintentos ?? null,
      c.base ?? null,
      c.maxPendientes ?? null,
    ],
  );
}

/** Valores por defecto de D12 (los que deja la migración 0018). */
export async function restaurarConfig(admin: ContappDb): Promise<void> {
  for (const [cola, v] of [
    ["sire", [4, 2, 2000]],
    ["sol", [2, 1, 2000]],
    ["xml", [8, 4, 2000]],
  ] as const) {
    await admin.pool.query(
      `update config_sistema set concurrencia_global = $2, concurrencia_tenant = $3, espera_ruc_ms = $4,
         reintentos = 3, backoff_base_ms = 5000, max_pendientes_tenant = 2000, actualizado_en = now()
       where cola = $1`,
      [cola, v[0], v[1], v[2]],
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Escenario de datos
// ---------------------------------------------------------------------------------------------------------------

export interface ClientePrueba {
  id: string;
  ruc: string;
}

export const rucNuevo = (): string =>
  `2${String(randomInt(0, 1e10)).padStart(10, "0")}`;

export class Escenario {
  readonly estudios: string[] = [];
  private readonly usuarios: string[] = [];
  private n = 0;

  constructor(readonly admin: ContappDb) {}

  async estudio(): Promise<string> {
    const id = randomUUID();
    await this.admin.pool.query(
      "insert into tenant (id, nombre) values ($1, $2)",
      [id, `Estudio T5 ${randomBytes(3).toString("hex")}-${++this.n}`],
    );
    this.estudios.push(id);
    return id;
  }

  async usuario(
    tenantId: string,
    rol: "dueno" | "admin" | "contador" | "asistente" | "lectura" = "contador",
    o: { desactivada?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    this.usuarios.push(id);
    await this.admin.pool.query(
      "insert into usuario (id, email, nombre) values ($1, $2, 'Usuario T5')",
      [id, `t5-${randomBytes(6).toString("hex")}@prueba.contapp.test`],
    );
    await this.admin.pool.query(
      "insert into membresia (tenant_id, usuario_id, rol, desactivada_en) values ($1, $2, $3, case when $4::boolean then now() else null end)",
      [tenantId, id, rol, o.desactivada ?? false],
    );
    return id;
  }

  async cliente(
    tenantId: string,
    ruc: string = rucNuevo(),
  ): Promise<ClientePrueba> {
    const r = await this.admin.pool.query(
      "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id",
      [tenantId, ruc, `Cliente T5 ${randomBytes(3).toString("hex")}`],
    );
    return { id: r.rows[0].id as string, ruc };
  }

  async asignar(
    tenantId: string,
    clienteId: string,
    usuarioId: string,
  ): Promise<void> {
    await this.admin.pool.query(
      "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')",
      [tenantId, clienteId, usuarioId],
    );
  }

  /** Credencial sintética (bytes aleatorios; nunca un secreto real). Devuelve su id. */
  async credencial(
    tenantId: string,
    clienteId: string,
    tipo: "sol" | "sire_api" = "sol",
  ): Promise<string> {
    const r = await this.admin.pool.query(
      `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
       values ($1, $2, $3, $4, $5, $6, $7, 'k1', 1) returning id`,
      [
        tenantId,
        clienteId,
        tipo,
        randomBytes(64),
        randomBytes(12),
        randomBytes(16),
        randomBytes(512),
      ],
    );
    return r.rows[0].id as string;
  }

  async fila(id: string): Promise<any | undefined> {
    return (
      await this.admin.pool.query("select * from job_registro where id = $1", [
        id,
      ])
    ).rows[0];
  }

  async credencialEstado(
    clienteId: string,
    tipo = "sol",
  ): Promise<{ estado: string; estado_motivo: string | null } | undefined> {
    return (
      await this.admin.pool.query(
        "select estado, estado_motivo from credencial where cliente_id = $1 and tipo = $2",
        [clienteId, tipo],
      )
    ).rows[0];
  }

  /** Texto de todo lo que hay en job_registro de los estudios de este escenario (columnas de texto/json). */
  async volcarJobs(): Promise<string> {
    const r = await this.admin.pool.query(
      "select to_jsonb(j)::text as t from job_registro j where tenant_id = any($1::uuid[])",
      [this.estudios],
    );
    return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
  }

  async limpiar(): Promise<void> {
    const t = this.estudios;
    const c = await this.admin.pool.connect();
    try {
      // Sin disparadores: el trigger del último Dueño impediría borrar la membresía de un Dueño de prueba.
      await c.query("SET session_replication_role = replica");
      const pasos: Array<[string, unknown[]]> = [
        ["delete from job_registro where tenant_id = any($1::uuid[])", [t]],
        [
          "delete from auditoria_descifrado where tenant_id = any($1::uuid[])",
          [t],
        ],
        ["delete from credencial where tenant_id = any($1::uuid[])", [t]],
        ["delete from asignacion where tenant_id = any($1::uuid[])", [t]],
        [
          "delete from membresia where tenant_id = any($1::uuid[]) or usuario_id = any($2::uuid[])",
          [t, this.usuarios],
        ],
        ["delete from cliente where tenant_id = any($1::uuid[])", [t]],
        ["delete from usuario where id = any($1::uuid[])", [this.usuarios]],
        ["delete from tenant where id = any($1::uuid[])", [t]],
      ];
      for (const [sql, v] of pasos)
        await c.query(sql, v).catch(() => undefined);
    } finally {
      c.release(true);
    }
  }
}

/** Patrón outbox del backend (D3): `encolar` en `withTenant` con el rol backend y `publicar` después del commit. */
export async function encolarYPublicar(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  tenantId: string,
  e: Omit<EntradaEncolar, "prioridad" | "creadoPor"> & {
    prioridad?: EntradaEncolar["prioridad"];
    creadoPor?: string | null;
  },
): Promise<ResultadoEncolar> {
  const entrada: EntradaEncolar = {
    prioridad: "interactivo",
    creadoPor: null,
    ...e,
  };
  const r = await backend.withTenant({ tenantId }, (tx) =>
    encolar(tx, entrada),
  );
  if (r.nuevo)
    await publicar(
      redis,
      [aPublicable(tenantId, r.trabajo, entrada.prioridad)],
      { prefijo },
    );
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Espías de BD y Redis
// ---------------------------------------------------------------------------------------------------------------

export interface Muerte {
  muerto: boolean;
}

/** BD que cuenta los callbacks de `withTenant`/`withSistema` abiertos (D6) y las aperturas tras la muerte del proceso. */
export function dbEspiada(db: ContappDb, muerte: Muerte) {
  const estado = {
    abiertas: 0,
    maxAbiertas: 0,
    aperturas: 0,
    aperturasTrasMuerte: 0,
  };
  const envolver =
    (original: (...a: any[]) => Promise<any>) =>
    async (...args: any[]) => {
      estado.aperturas += 1;
      if (muerte.muerto) estado.aperturasTrasMuerte += 1;
      const fn = args[args.length - 1] as (...a: any[]) => Promise<any>;
      const envuelta = async (...a: any[]) => {
        estado.abiertas += 1;
        estado.maxAbiertas = Math.max(estado.maxAbiertas, estado.abiertas);
        try {
          return await fn(...a);
        } finally {
          estado.abiertas -= 1;
        }
      };
      return original.apply(db, [...args.slice(0, -1), envuelta]);
    };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "withTenant" || prop === "withSistema")
        return envolver((target as any)[prop].bind(target));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy as ContappDb, estado };
}

/** Redis que cuenta los comandos emitidos tras la muerte del proceso (desconectar no cuenta). */
export function redisEspiado(redis: Redis, muerte: Muerte) {
  const estado = { comandosTrasMuerte: 0, comandos: 0 };
  const proxy = new Proxy(redis, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (
          prop !== "disconnect" &&
          prop !== "quit" &&
          prop !== "on" &&
          prop !== "once" &&
          prop !== "off" &&
          prop !== "removeListener"
        ) {
          estado.comandos += 1;
          if (muerte.muerto) estado.comandosTrasMuerte += 1;
        }
        return Reflect.apply(v, target, args);
      };
    },
  });
  return { redis: proxy as Redis, estado };
}

// ---------------------------------------------------------------------------------------------------------------
// Procesador programable y proceso del worker
// ---------------------------------------------------------------------------------------------------------------

export interface LlamadaProcesador {
  id: string;
  tenantId: string;
  clienteId: string;
  ruc: string;
  tipo: string;
  intentos: number;
  /** Date.now() al entrar al procesador. */
  en: number;
}

export type Comportamiento = (
  ctx: ContextoProcesador,
  llamada: LlamadaProcesador,
) => Promise<unknown>;

/** Procesador con comportamiento programable, contador de llamadas y marcas de tiempo. */
export class ProcesadorProgramable {
  readonly llamadas: LlamadaProcesador[] = [];
  comportamiento: Comportamiento = async () => ({ ok: true });

  readonly procesador: Procesador = async (ctx) => {
    const t = ctx.trabajo;
    const llamada: LlamadaProcesador = {
      id: t.id,
      tenantId: t.tenantId,
      clienteId: t.clienteId,
      ruc: t.ruc,
      tipo: t.tipo,
      intentos: t.intentos,
      en: Date.now(),
    };
    this.llamadas.push(llamada);
    return this.comportamiento(ctx, llamada);
  };

  de(id: string): LlamadaProcesador[] {
    return this.llamadas.filter((l) => l.id === id);
  }
}

export interface NotificacionCredencial {
  tenantId: string;
  clienteId: string;
  tipo: string;
  trabajoId: string;
}

/** Notificador de la prueba: anota lo recibido y, con `falla`, rechaza (el canal de avisos cae). */
export function notificadorEspia(falla = false) {
  const llamadas: NotificacionCredencial[] = [];
  return {
    llamadas,
    credencialInvalida: async (e: NotificacionCredencial): Promise<void> => {
      llamadas.push(e);
      if (falla) throw new Error("el canal de avisos cayó");
    },
  };
}

/**
 * Mínimo de transacciones abiertas (callbacks de withTenant/withSistema) durante `ms`. Con el procesador en marcha una
 * transacción del ejecutor dejaría el mínimo en 1 o más (D6); las del despachador y de otros trabajos van y vienen.
 */
export async function minimoTx(
  estado: { abiertas: number },
  ms = 300,
  cadaMs = 5,
): Promise<number> {
  let min = Number.POSITIVE_INFINITY;
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    min = Math.min(min, estado.abiertas);
    await dormir(cadaMs);
  }
  return min;
}

/** Compuerta: el procesador espera hasta que la prueba la abre (simula un trabajo largo o un proceso colgado). */
export function compuerta() {
  let abrir!: () => void;
  const abierta = new Promise<void>((r) => (abrir = r));
  return { esperar: () => abierta, abrir };
}

export interface OpcionesArranque extends Partial<
  Omit<DepsTrabajos, "db" | "redis" | "conexionBull" | "prefijo">
> {
  prefijo: string;
  /** Si es true no se pasan al worker las intervalos rápidos por defecto (despachador 20 ms, reconciliador 500 ms, latido 200 ms). */
  intervalosPropios?: boolean;
}

export interface ProcesoWorker {
  en: TrabajosEnMarcha;
  db: ContappDb;
  redis: Redis;
  dbEstado: ReturnType<typeof dbEspiada>["estado"];
  redisEstado: ReturnType<typeof redisEspiado>["estado"];
  muerte: Muerte;
  /** Simula `kill -9`: ver `TrabajosEnMarcha.abortar`. */
  abortar(): Promise<void>;
  /** Cierre ordenado y cierre de las conexiones propias de la prueba. */
  detener(o?: { esperaMs?: number }): Promise<void>;
}

/** Arranca el worker de trabajos (`iniciarTrabajos`) con BD y Redis espiados e intervalos cortos. */
export async function arrancar(o: OpcionesArranque): Promise<ProcesoWorker> {
  const muerte: Muerte = { muerto: false };
  const dbReal = crearDbRol("contapp_worker", 8);
  const redisReal = conectarRedis();
  const d = dbEspiada(dbReal, muerte);
  const r = redisEspiado(redisReal, muerte);
  const { prefijo, intervalosPropios, ...resto } = o;
  const en = await iniciarTrabajos({
    db: d.db,
    redis: r.redis,
    conexionBull: opcionesBull(),
    prefijo,
    ...(intervalosPropios
      ? {}
      : {
          intervalos: {
            despachadorMs: 20,
            reconciliadorMs: 500,
            latidoMs: 200,
          },
        }),
    ...resto,
  });
  const cerrarConexiones = async () => {
    redisReal.disconnect();
    await dbReal.close().catch(() => undefined);
  };
  let cerrado = false;
  return {
    en,
    db: d.db,
    redis: r.redis,
    dbEstado: d.estado,
    redisEstado: r.estado,
    muerte,
    abortar: async () => {
      muerte.muerto = true;
      await en.abortar();
    },
    detener: async (opciones) => {
      if (cerrado) return;
      cerrado = true;
      try {
        if (!muerte.muerto) await en.detener(opciones);
      } finally {
        await cerrarConexiones();
      }
    },
  };
}
