/* eslint-disable @typescript-eslint/no-explicit-any -- Redis, filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP y SSE de 008 (T6). Encima de `soporte-acceso.ts` (005): estudios y miembros
// por rol, más Redis real (base 15, prefijo aleatorio por banco), trabajos sembrados con `encolar` de
// `@contapp/queue` (el mismo que usa el `Encolador`) y un cliente SSE sobre `node:http`.
//
// Contrato que fijan las pruebas para `crearApp` (T11): la opción `redis: { url?: string; prefijo?: string }`
// (sin ella, `REDIS_URL` del entorno y el prefijo `contapp:`). Con Redis caído `crearApp` NO falla: la app
// arranca, las lecturas de BD responden y encolar no espera a Redis.
//
// Fuera de `src/` para que no cuente en la cobertura ni en el build. T6 agrega `ioredis` (6.0.0, la misma versión
// que `packages/queue`) a las dependencias del backend: el suscriptor de eventos de T11 también la necesita.
import { randomBytes } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import { Redis } from "ioredis";
import {
  aPublicable,
  crearClaves,
  encolar,
  publicar,
  publicarEvento,
  type ClavesCola,
  type EntradaEncolar,
} from "@contapp/queue";
import type {
  EstadoTrabajo,
  MotivoTrabajo,
  Prioridad,
  TrabajoVista,
} from "@contapp/shared";
import { abrirBanco, type Banco, type Estudio } from "./soporte-acceso.js";
import { ipUnica, type Harness } from "./soporte.js";

/* ---------------------------------- Redis ---------------------------------- */
/** Cliente de `ioredis`. */
export type RedisPrueba = Redis;

/** `REDIS_URL` del entorno con la base 15 (plan 008: Sin variables de entorno nuevas). Nunca se imprime. */
export function urlRedisPrueba(): string {
  const u = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  u.pathname = "/15";
  return u.toString();
}
/** Puerto cerrado: simula Redis caído. */
export const URL_REDIS_CAIDO = "redis://127.0.0.1:1/15";

export const nuevoPrefijo = (): string =>
  `t008b-${randomBytes(4).toString("hex")}:`;
export const conectarRedis = (url: string = urlRedisPrueba()): RedisPrueba =>
  new Redis(url, { maxRetriesPerRequest: 2 });

/** Borra solo las claves del prefijo de la prueba. */
export async function limpiarPrefijo(
  redis: RedisPrueba,
  prefijo: string,
): Promise<void> {
  const claves: string[] = await redis.keys(`${prefijo}*`);
  if (claves.length > 0) await redis.del(...claves);
}

/** Espera (sondeo) a que alguien esté suscrito al canal de eventos del estudio. */
export async function esperarSuscripcion(
  redis: RedisPrueba,
  prefijo: string,
  tenantId: string,
  ms = 3000,
): Promise<void> {
  const canal = crearClaves(prefijo).eventos(tenantId);
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const r = (await redis.pubsub("NUMSUB", canal)) as [
      string,
      number | string,
    ];
    if (Number(r[1]) >= 1) return;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error("nadie se suscribió al canal de eventos del estudio");
}

/** Publica un evento válido (vista pública) en el canal del estudio, como lo hace el worker. */
export const emitir = (
  redis: RedisPrueba,
  prefijo: string,
  tenantId: string,
  vista: TrabajoVista,
) => publicarEvento(redis, tenantId, vista, { prefijo });
/** Publica texto tal cual (mensajes sucios o con campos de más). */
export const emitirCrudo = (
  redis: RedisPrueba,
  prefijo: string,
  tenantId: string,
  texto: string,
) => redis.publish(crearClaves(prefijo).eventos(tenantId), texto);
export const vistaCon = (
  t: TrabajoVista,
  cambio: Partial<TrabajoVista>,
): TrabajoVista => ({ ...t, ...cambio });

/** Suscriptor aparte (no es el de la app) para observar lo que se publica en `eventos:{tenantId}`. */
export interface Observador {
  mensajes: any[];
  esperar(pred: (m: any) => boolean, ms?: number): Promise<any | null>;
  cerrar(): void;
}
export async function observarEventos(
  prefijo: string,
  tenantId: string,
): Promise<Observador> {
  const sub = conectarRedis();
  const mensajes: any[] = [];
  const avisos: (() => void)[] = [];
  sub.on("message", (_canal: string, texto: string) => {
    try {
      mensajes.push(JSON.parse(texto));
    } catch {
      mensajes.push({ crudo: texto });
    }
    for (const a of avisos.splice(0)) a();
  });
  await sub.subscribe(crearClaves(prefijo).eventos(tenantId));
  return {
    mensajes,
    async esperar(pred, ms = 2500) {
      const fin = Date.now() + ms;
      let desde = 0;
      for (;;) {
        for (; desde < mensajes.length; desde++)
          if (pred(mensajes[desde])) return mensajes[desde];
        const resto = fin - Date.now();
        if (resto <= 0) return null;
        await new Promise<void>((r) => {
          const t = setTimeout(r, resto);
          avisos.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
    cerrar: () => sub.disconnect(),
  };
}

/* ------------------------------- Trabajos sembrados ------------------------------- */
export interface SemillaTrabajo {
  creadoPor?: string | null;
  prioridad?: Prioridad;
  /** Por defecto `prueba.eco` (cola y canal `sire`). */
  tipo?: string;
  /** Texto libre en los parámetros (para canarios). */
  rango?: string;
  /** Estado final (por defecto `en_cola`); se fija por SQL con la conexión de migraciones. */
  estado?: EstadoTrabajo;
  motivo?: MotivoTrabajo | null;
  intentos?: number;
  resultado?: unknown;
}
export interface DestinoRedis {
  redis: RedisPrueba;
  prefijo: string;
}

let contadorN = Math.floor(Math.random() * 900_000);

/** Vista pública (sin posición) de una fila, leída con la conexión de migraciones. */
export async function leerVista(
  h: Pick<Harness, "sql">,
  id: string,
): Promise<TrabajoVista> {
  const f = (
    await h.sql(
      `select id, tipo, cliente_id, estado, intentos, motivo, creado_en, iniciado_en, terminado_en, creado_por
         from job_registro where id = $1`,
      [id],
    )
  )[0];
  if (!f) throw new Error("trabajo sembrado inexistente");
  const iso = (d: unknown) =>
    d === null || d === undefined ? null : new Date(d as Date).toISOString();
  return {
    id: f.id,
    tipo: f.tipo,
    clienteId: f.cliente_id,
    estado: f.estado,
    posicion: null,
    intentos: Number(f.intentos),
    motivo: f.motivo ?? null,
    creadoEn: iso(f.creado_en) as string,
    iniciadoEn: iso(f.iniciado_en),
    terminadoEn: iso(f.terminado_en),
    creadoPor: f.creado_por ? { usuarioId: f.creado_por } : null,
  };
}

/**
 * Encola con `encolar` de `@contapp/queue` dentro de un `withTenant` propio (una transacción por trabajo: cada uno
 * con su `creado_en`) y, si hay `destino`, publica la pista en Redis después del commit. Con otro `estado`, la fila
 * se lleva a ese estado por SQL. Devuelve la vista leída de la BD.
 */
export async function sembrarTrabajo(
  h: Pick<Harness, "dbBackend" | "sql">,
  tenantId: string,
  clienteId: string,
  s: SemillaTrabajo = {},
  destino?: DestinoRedis,
): Promise<TrabajoVista> {
  contadorN = (contadorN + 1) % 1_000_000;
  const entrada: EntradaEncolar = {
    tipo: s.tipo ?? "prueba.eco",
    clienteId,
    parametros: {
      n: contadorN,
      ...(s.rango === undefined ? {} : { rango: s.rango }),
    },
    prioridad: s.prioridad ?? "interactivo",
    creadoPor: s.creadoPor ?? null,
  };
  const { trabajo } = await h.dbBackend.withTenant({ tenantId }, (tx) =>
    encolar(tx, entrada),
  );
  if (destino)
    await publicar(
      destino.redis,
      [aPublicable(tenantId, trabajo, entrada.prioridad)],
      { prefijo: destino.prefijo },
    );
  const estado = s.estado ?? "en_cola";
  if (
    estado !== "en_cola" ||
    s.motivo !== undefined ||
    s.intentos !== undefined ||
    s.resultado !== undefined
  ) {
    await h.sql(
      `update job_registro set estado = $2, motivo = $3, intentos = coalesce($4::smallint, intentos),
              resultado = $5::jsonb,
              iniciado_en = case when $2 <> 'en_cola' then now() end,
              terminado_en = case when $2 in ('completado', 'error', 'cancelado') then now() end,
              actualizado_en = now()
        where id = $1`,
      [
        trabajo.id,
        estado,
        s.motivo ?? null,
        s.intentos ?? null,
        s.resultado === undefined ? null : JSON.stringify(s.resultado),
      ],
    );
  }
  return leerVista(h, trabajo.id);
}

/* ----------------------------------- Banco ----------------------------------- */
export interface BancoTrabajos extends Banco {
  prefijo: string;
  /** Conexión de aserciones a la base 15 (siempre al Redis real, aunque la app apunte a uno caído). */
  redis: RedisPrueba;
  claves: ClavesCola;
  sembrar(
    tenantId: string,
    clienteId: string,
    s?: SemillaTrabajo,
  ): Promise<TrabajoVista>;
  /** Fila actual del trabajo (conexión de migraciones). */
  fila(id: string): Promise<any | undefined>;
  /** Registra un estudio creado fuera de `estudio()` para limpiar sus trabajos. */
  rastrearEstudio(tenantId: string): void;
}

/**
 * Banco de 005 más Redis. `redisApp` es la URL de Redis que recibe la app (por defecto la real de pruebas;
 * `URL_REDIS_CAIDO` para el caso de Redis caído).
 */
export async function abrirBancoTrabajos(
  o: { redisApp?: string } = {},
): Promise<BancoTrabajos> {
  const prefijo = nuevoPrefijo();
  const redis = conectarRedis();
  const b = await abrirBanco(undefined, {
    redis: { url: o.redisApp ?? urlRedisPrueba(), prefijo },
  });
  const tenants: string[] = [];
  const destino: DestinoRedis = { redis, prefijo };
  const estudioBase = b.estudio;
  const cerrarBase = b.cerrar;
  return {
    ...b,
    prefijo,
    redis,
    claves: crearClaves(prefijo),
    estudio: async (): Promise<Estudio> => {
      const e = await estudioBase();
      tenants.push(e.tenantId);
      return e;
    },
    rastrearEstudio: (t) => {
      tenants.push(t);
    },
    sembrar: (tenantId, clienteId, s = {}) =>
      sembrarTrabajo(b.h, tenantId, clienteId, s, destino),
    fila: async (id) =>
      (await b.sql("select * from job_registro where id = $1", [id]))[0],
    cerrar: async () => {
      cerrarSseAbiertos();
      // job_registro referencia cliente y membresía: sus filas se borran antes que la limpieza de 005.
      await b
        .sql("delete from job_registro where tenant_id = any($1::uuid[])", [
          tenants,
        ])
        .catch(() => undefined);
      await limpiarPrefijo(redis, prefijo).catch(() => undefined);
      try {
        await cerrarBase();
      } finally {
        redis.disconnect();
      }
    },
  };
}

/* ------------------------------------ SSE ------------------------------------ */
export interface EventoSse {
  evento: string;
  datos: string;
  json: any;
  /** Marca de tiempo (ms) de la llegada. */
  t: number;
}
export interface ClienteSse {
  status: number;
  headers: IncomingHttpHeaders;
  /** Cuerpo JSON cuando la respuesta no es el stream (401, 409, 429...). */
  cuerpo: any;
  eventos: EventoSse[];
  comentarios: string[];
  /** Marca de tiempo (ms) de cada comentario de `comentarios` (latidos). */
  tComentarios: number[];
  /** Marca de tiempo (ms) en que llegaron las cabeceras. */
  abiertoEn: number;
  /** Todo lo recibido, tal cual (para buscar canarios). */
  texto: string;
  cerrado: boolean;
  esperar(
    pred: (e: EventoSse) => boolean,
    ms?: number,
  ): Promise<EventoSse | null>;
  esperarCierre(ms: number): Promise<boolean>;
  cerrar(): void;
}

const abiertos = new Set<ClienteSse>();
export function cerrarSseAbiertos(): void {
  for (const s of [...abiertos]) s.cerrar();
  abiertos.clear();
}

/**
 * Abre `GET /trabajos/stream` con `node:http` (supertest no sirve para respuestas sin fin). Resuelve al recibir las
 * cabeceras; si no llegan en 5 s, rechaza. Parsea los marcos SSE (`event:`, `data:`, comentarios `:`).
 */
export function abrirSse(
  h: Pick<Harness, "app">,
  a: { cookie?: string | null; estudio?: string | null },
): Promise<ClienteSse> {
  const { port } = h.app.getHttpServer().address() as { port: number };
  const cabeceras: Record<string, string> = {
    Accept: "text/event-stream",
    "X-Forwarded-For": ipUnica(),
  };
  if (a.cookie) cabeceras.Cookie = a.cookie;
  if (a.estudio) cabeceras["X-Estudio"] = a.estudio;

  const avisos: (() => void)[] = [];
  const avisar = () => {
    for (const f of avisos.splice(0)) f();
  };
  const s: ClienteSse = {
    status: 0,
    headers: {},
    cuerpo: null,
    eventos: [],
    comentarios: [],
    tComentarios: [],
    abiertoEn: 0,
    texto: "",
    cerrado: false,
    async esperar(pred, ms = 2500) {
      const fin = Date.now() + ms;
      let desde = 0;
      for (;;) {
        for (; desde < s.eventos.length; desde++)
          if (pred(s.eventos[desde]!)) return s.eventos[desde]!;
        const resto = fin - Date.now();
        if (resto <= 0 || s.cerrado) return null;
        await new Promise<void>((r) => {
          const t = setTimeout(r, resto);
          avisos.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
    async esperarCierre(ms) {
      const fin = Date.now() + ms;
      while (!s.cerrado) {
        const resto = fin - Date.now();
        if (resto <= 0) return false;
        await new Promise<void>((r) => {
          const t = setTimeout(r, resto);
          avisos.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
      return true;
    },
    cerrar: () => undefined,
  };

  return new Promise<ClienteSse>((resolver, rechazar) => {
    let pendiente = "";
    let recibido = false;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/trabajos/stream",
      method: "GET",
      headers: cabeceras,
    });
    s.cerrar = () => {
      req.destroy();
      s.cerrado = true;
      abiertos.delete(s);
      avisar();
    };
    const limite = setTimeout(() => {
      req.destroy();
      rechazar(new Error("el stream no respondió cabeceras en 5 s"));
    }, 5000);
    req.on("error", (e) => {
      clearTimeout(limite);
      s.cerrado = true;
      abiertos.delete(s);
      avisar();
      if (!recibido) rechazar(e);
    });
    req.on("response", (res) => {
      clearTimeout(limite);
      recibido = true;
      s.status = res.statusCode ?? 0;
      s.headers = res.headers;
      s.abiertoEn = Date.now();
      abiertos.add(s);
      res.setEncoding("utf8");
      res.on("data", (trozo: string) => {
        s.texto += trozo;
        pendiente += trozo;
        let i: number;
        while ((i = pendiente.indexOf("\n\n")) >= 0) {
          const marco = pendiente.slice(0, i);
          pendiente = pendiente.slice(i + 2);
          let evento = "message";
          const datos: string[] = [];
          for (const linea of marco.split("\n")) {
            if (linea.startsWith(":")) {
              s.comentarios.push(linea);
              s.tComentarios.push(Date.now());
            } else if (linea.startsWith("event:"))
              evento = linea.slice(6).trim();
            else if (linea.startsWith("data:"))
              datos.push(linea.slice(5).replace(/^ /, ""));
          }
          if (datos.length > 0) {
            const texto = datos.join("\n");
            let json: any;
            try {
              json = JSON.parse(texto);
            } catch {
              json = undefined;
            }
            s.eventos.push({ evento, datos: texto, json, t: Date.now() });
          }
        }
        avisar();
      });
      const fin = () => {
        s.cerrado = true;
        abiertos.delete(s);
        if (s.status !== 200) {
          try {
            s.cuerpo = JSON.parse(s.texto);
          } catch {
            s.cuerpo = {};
          }
        }
        avisar();
      };
      res.on("end", fin);
      res.on("close", fin);
      res.on("error", fin);
      // Las respuestas que no son el stream (401, 409, 429) terminan solas: esperar su cuerpo antes de resolver.
      if (s.status !== 200) res.on("end", () => resolver(s));
      else resolver(s);
    });
    req.end();
  });
}

/** Predicados para `esperar`. */
export const esEventoDe = (clienteId: string) => (e: EventoSse) =>
  e.json?.clienteId === clienteId;
export const esEventoId = (id: string) => (e: EventoSse) => e.json?.id === id;
