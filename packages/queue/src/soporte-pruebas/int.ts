// Soporte de las pruebas de integración de `queue` (spec 008, T5): PostgreSQL y Redis reales.
// No es código de producción (vive en `soporte-pruebas`, fuera de `dist` y de la cobertura) ni una prueba.
// - Cada archivo crea sus propios estudios, usuarios, clientes y credenciales con la conexión administrativa
//   (MIGRATIONS_DATABASE_URL) y los borra al final; nada depende del seed.
// - Redis: base 15 y un prefijo aleatorio por archivo (`nuevoPrefijo`); `limpiarPrefijo` borra solo ese prefijo.
// - `config_sistema` es global: las pruebas la cambian con `fijarConfig` y la devuelven a D12 con `restaurarConfig`.
// - `EjecutorMinimo` hace de ejecutor del worker (T10) con comportamiento programable: así el despachador, los
//   cupos, los locks y el reconciliador se prueban aquí sin el worker. Los secretos son canarios generados al vuelo.
/* eslint-disable @typescript-eslint/no-explicit-any -- eventos y filas de BD dinámicos en pruebas */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  createDb,
  leerTrabajo,
  transicionar,
  type ContappDb,
  type TrabajoFila,
} from "@contapp/db";
import { Redis } from "ioredis";
import {
  iniciarLatido,
  liberarArriendos,
  renovarArriendos,
  tomarEjecucion,
} from "../arriendos.js";
import { crearClaves } from "../claves.js";
import { Despachador } from "../despachador.js";
import {
  aPublicable,
  encolar,
  publicar,
  type EntradaEncolar,
  type ResultadoEncolar,
} from "../encolado.js";
import { publicarEvento, vistaDeFila } from "../eventos.js";
import { Reconciliador } from "../reconciliador.js";
import type { NombreCola, PayloadTrabajo, Reloj } from "../tipos.js";
import {
  crearColas,
  crearWorkers,
  type ColasBull,
  type WorkersBull,
} from "../worker/index.js";

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
export class RelojAjustable implements Reloj {
  private desplazamientoMs = 0;
  ahora(): Date {
    return new Date(Date.now() + this.desplazamientoMs);
  }
  avanzar(ms: number): void {
    this.desplazamientoMs += ms;
  }
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

/** Opciones de conexión para BullMQ (`crearColas`/`crearWorkers`), siempre en la base 15. */
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
  `t5q-${randomBytes(4).toString("hex")}:`;

/** Borra solo las claves del prefijo (también las de BullMQ, que cuelgan de `{prefijo}bull`). */
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

/** Todas las claves del prefijo (si `claves`) con su valor volcado a texto, para buscar canarios. */
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
      if (tipo === "string")
        salida.push(String((await redis.getBuffer(clave))?.toString("latin1")));
      else if (tipo === "hash")
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
      /* texto inválido: el test lo verá en `texto` */
    }
    mensajes.push({ canal, texto, evento });
  });
  await sub.subscribe(...tenantIds.map((t) => k.eventos(t)));
  return {
    mensajes,
    de: (jobId: string) =>
      mensajes.filter((m) => m.evento?.id === jobId).map((m) => m.evento),
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

/** UPDATE de una fila de `config_sistema` con el rol administrativo (los CHECK se aplican igual). */
export async function fijarConfig(
  admin: ContappDb,
  cola: NombreCola,
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
    // Primero el tenant (<= global/2 vale con el valor nuevo y con el viejo en ambos órdenes: una sola sentencia).
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

  /** Usuario con membresía en el estudio (rol por defecto `contador`). */
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

  /**
   * Inserta `cuantos` trabajos `en_cola` de golpe (sin pasar por `encolar`) repartidos en rueda entre `clientes`
   * (el trabajo g es del cliente g mod n); `creado_en` crece 1 ms por trabajo. Devuelve los ids en orden de creación.
   */
  async trabajosEnMasa(
    tenantId: string,
    clientes: ClientePrueba | ClientePrueba[],
    cuantos: number,
    o: {
      tipo?: string;
      cola?: string;
      canal?: string;
      prioridad?: string;
      creadoPor?: string | null;
      desplazarMs?: number;
    } = {},
  ): Promise<string[]> {
    const cs = Array.isArray(clientes) ? clientes : [clientes];
    const r = await this.admin.pool.query(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe,
                                 creado_por, intentos, max_intentos, creado_en, actualizado_en)
       select $1::uuid, ($2::uuid[])[1 + (g - 1) % $3::int], ($4::text[])[1 + (g - 1) % $3::int],
              $5::text, $6::text, $7::text, $8::text, 'en_cola', jsonb_build_object('n', g),
              sha256(convert_to(gen_random_uuid()::text || g::text, 'UTF8')),
              $9::uuid, 0, 4, clock_timestamp() + make_interval(secs => (g + $11::int) / 1000.0), clock_timestamp()
         from generate_series(1, $10::int) g
       returning id`,
      [
        tenantId,
        cs.map((c) => c.id),
        cs.length,
        cs.map((c) => c.ruc),
        o.tipo ?? "prueba.eco",
        o.cola ?? "sire",
        o.canal ?? "sire",
        o.prioridad ?? "interactivo",
        o.creadoPor ?? null,
        cuantos,
        o.desplazarMs ?? 0,
      ],
    );
    const ids = (r.rows as Array<{ id: string }>).map((f) => f.id);
    const orden = await this.admin.pool.query(
      "select id from job_registro where id = any($1::uuid[]) order by creado_en, id",
      [ids],
    );
    return (orden.rows as Array<{ id: string }>).map((f) => f.id);
  }

  /** Envejece `actualizado_en` (el reconciliador solo mira trabajos sin cambios en ≥ 30 s). */
  async envejecer(ids: string[], segundos = 31): Promise<void> {
    await this.admin.pool.query(
      "update job_registro set actualizado_en = now() - make_interval(secs => $2::int) where id = any($1::uuid[])",
      [ids, segundos],
    );
  }

  async fila(id: string): Promise<any | undefined> {
    return (
      await this.admin.pool.query("select * from job_registro where id = $1", [
        id,
      ])
    ).rows[0];
  }

  async estados(
    ids: string[],
  ): Promise<
    Map<string, { estado: string; motivo: string | null; intentos: number }>
  > {
    const r = await this.admin.pool.query(
      "select id, estado, motivo, intentos from job_registro where id = any($1::uuid[])",
      [ids],
    );
    return new Map(
      (r.rows as any[]).map((f) => [
        f.id as string,
        { estado: f.estado, motivo: f.motivo, intentos: Number(f.intentos) },
      ]),
    );
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
      c.release(true); // se destruye la conexión: no vuelve al pool con session_replication_role = replica
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ejecutor mínimo (hace de worker): marcas de tiempo y contadores de concurrencia propios de la prueba
// ---------------------------------------------------------------------------------------------------------------

export interface Marca {
  id: string;
  tenantId: string;
  ruc: string;
  tipo: string;
  cola: string;
  /** Date.now() al empezar la ejecución y justo antes de cerrar el trabajo en BD. */
  inicio: number;
  fin: number;
}

export interface OpcionesEjecutor {
  db: ContappDb;
  redis: Redis;
  reloj: Reloj;
  prefijo: string;
  /** Duración por defecto de cada trabajo. */
  duracionMs?: number;
  /** `espera_ruc_ms` con el que se libera el lock al terminar (D20); por defecto 0. */
  esperaRucMs?: number;
}

/**
 * Sigue el contrato del Ejecutor del plan: carga la fila en `withTenant`, exige `ejecutando` y el mismo tipo, toma
 * `ejec:{jobId}`, late, ejecuta SIN transacción abierta, cierra con `transicionar` y libera arriendos (el lock queda
 * `esperaRucMs`). `comportamiento` permite una duración o un fallo por trabajo.
 */
export class EjecutorMinimo {
  readonly marcas: Marca[] = [];
  readonly iniciados: string[] = [];
  /** Máximos de ejecuciones simultáneas vistos al empezar cada una (en memoria, independientes de Redis). */
  maxGlobal = 0;
  readonly maxPorTenant = new Map<string, number>();
  private readonly corriendo = new Map<string, { tenantId: string }>();
  comportamiento: (t: TrabajoFila) => Promise<void>;

  constructor(private readonly o: OpcionesEjecutor) {
    this.comportamiento = () => dormir(o.duracionMs ?? 20);
  }

  async ejecutar(payload: PayloadTrabajo): Promise<void> {
    const { db, redis, reloj, prefijo } = this.o;
    const k = crearClaves(prefijo);
    const fila = await db.withTenant({ tenantId: payload.tenantId }, (tx) =>
      leerTrabajo(tx, payload.jobId),
    );
    if (
      fila === null ||
      fila.estado !== "ejecutando" ||
      fila.tipo !== payload.tipo
    )
      return;
    if (!(await tomarEjecucion(redis, k, fila.id))) return;
    const detenerLatido = iniciarLatido(() =>
      renovarArriendos(redis, k, fila, reloj.ahora().getTime()),
    );

    this.corriendo.set(fila.id, { tenantId: fila.tenantId });
    this.iniciados.push(fila.id);
    this.maxGlobal = Math.max(this.maxGlobal, this.corriendo.size);
    const delTenant = [...this.corriendo.values()].filter(
      (c) => c.tenantId === fila.tenantId,
    ).length;
    this.maxPorTenant.set(
      fila.tenantId,
      Math.max(this.maxPorTenant.get(fila.tenantId) ?? 0, delTenant),
    );

    const inicio = Date.now();
    try {
      await this.comportamiento(fila);
    } finally {
      this.corriendo.delete(fila.id);
      detenerLatido();
    }
    this.marcas.push({
      id: fila.id,
      tenantId: fila.tenantId,
      ruc: fila.ruc,
      tipo: fila.tipo,
      cola: fila.cola,
      inicio,
      fin: Date.now(),
    });
    await db.withTenant({ tenantId: fila.tenantId }, (tx) =>
      transicionar(tx, fila.id, "ejecutando", "completado"),
    );
    await liberarArriendos(redis, k, fila, this.o.esperaRucMs ?? 0);
    await publicarEvento(
      redis,
      fila.tenantId,
      vistaDeFila(fila, {
        estado: "completado",
        motivo: null,
        terminadoEn: reloj.ahora(),
      }),
      { prefijo },
    );
  }

  /** Marcas de un RUC ordenadas por inicio. */
  deRuc(ruc: string): Marca[] {
    return this.marcas
      .filter((m) => m.ruc === ruc)
      .sort((a, b) => a.inicio - b.inicio);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Armado: despachador + reconciliador en bucle + BullMQ real + ejecutor mínimo
// ---------------------------------------------------------------------------------------------------------------

export function bucle(
  fn: () => Promise<unknown>,
  ms: number,
): { detener(): Promise<void> } {
  let activo = true;
  const p = (async () => {
    while (activo) {
      try {
        await fn();
      } catch {
        /* el despachador y el reconciliador no lanzan; por si acaso, el bucle sigue */
      }
      await dormir(ms);
    }
  })();
  return {
    detener: async () => {
      activo = false;
      await p;
    },
  };
}

/** Patrón outbox del backend (D3): `encolar` en `withTenant` con el rol backend y `publicar` después del commit. */
export async function encolarYPublicar(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  tenantId: string,
  e: EntradaEncolar,
): Promise<ResultadoEncolar> {
  const r = await backend.withTenant({ tenantId }, (tx) => encolar(tx, e));
  if (r.nuevo)
    await publicar(redis, [aPublicable(tenantId, r.trabajo, e.prioridad)], {
      prefijo,
    });
  return r;
}

/** Publica en Redis (después del commit, con `publicar`) trabajos ya insertados en BD. */
export async function anunciar(
  redis: Redis,
  prefijo: string,
  tenantId: string,
  ids: string[],
  cola = "sire",
): Promise<void> {
  const ahora = new Date();
  await publicar(
    redis,
    ids.map((id) => ({
      id,
      tenantId,
      cola,
      prioridad: "interactivo",
      creadoEn: ahora,
    })),
    { prefijo },
  );
}

export interface OpcionesArmado {
  prefijo: string;
  reloj?: Reloj;
  duracionMs?: number;
  esperaRucMs?: number;
  /** Pausa entre ciclos del despachador (por defecto 15 ms). */
  cicloMs?: number;
  /** Con un valor, también corre el reconciliador en bucle con esa pausa. */
  reconciliadorMs?: number;
  /** Si es false no arranca el bucle del despachador (la prueba llama a `ciclo()` a mano). */
  automatico?: boolean;
  concurrenciaBull?: number;
}

export interface Armado {
  db: ContappDb;
  redis: Redis;
  reloj: Reloj;
  despachador: Despachador;
  reconciliador: Reconciliador;
  ejecutor: EjecutorMinimo;
  detener(): Promise<void>;
}

export async function armar(o: OpcionesArmado): Promise<Armado> {
  const db = crearDbRol("contapp_worker", 6);
  const redis = conectarRedis();
  const reloj = o.reloj ?? { ahora: () => new Date() };
  const colas: ColasBull = crearColas({
    conexion: opcionesBull(),
    prefijo: o.prefijo,
  });
  const ejecutor = new EjecutorMinimo({
    db,
    redis,
    reloj,
    prefijo: o.prefijo,
    duracionMs: o.duracionMs,
    esperaRucMs: o.esperaRucMs,
  });
  const workers: WorkersBull = crearWorkers({
    conexion: opcionesBull(),
    prefijo: o.prefijo,
    colas: [{ cola: "sire", concurrencia: o.concurrenciaBull ?? 8 }],
    procesar: (_cola, payload) => ejecutor.ejecutar(payload),
  });
  const despachador = new Despachador({
    db,
    redis,
    reloj,
    prefijo: o.prefijo,
    agregarACola: colas.agregarACola,
  });
  const reconciliador = new Reconciliador({
    db,
    redis,
    reloj,
    prefijo: o.prefijo,
  });
  const bucles = [
    ...(o.automatico === false
      ? []
      : [bucle(() => despachador.ciclo(), o.cicloMs ?? 15)]),
    ...(o.reconciliadorMs === undefined
      ? []
      : [bucle(() => reconciliador.ciclo(), o.reconciliadorMs)]),
  ];
  return {
    db,
    redis,
    reloj,
    despachador,
    reconciliador,
    ejecutor,
    detener: async () => {
      await Promise.all(bucles.map((b) => b.detener()));
      // Un trabajo en vuelo que la prueba dejó sin terminar no debe colgar el cierre.
      await Promise.race([workers.cerrar(), dormir(8000)]);
      await colas.cerrar();
      redis.disconnect();
      await db.close();
    },
  };
}
