/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 023 (T6, rojo): rutas de buzón, «Revisar ahora», lectura, apertura y descarga.
// Encima de `soporte-ventas.ts` (cola con Redis real, estudios rastreados, clientes con `sol` verificada). No es una prueba ni
// código de producción. Datos sintéticos (RUC válidos del soporte de clientes; ningún secreto real).
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 023, «BD»; el mismo de `tests/aislamiento/buzon-soporte.ts`, T4; lo crea T11):
//  - `buzon_estado_cliente(tenant_id, cliente_id, ultima_programada_en, ultima_solicitud_en, ultima_captura_en, sincronizado_en,
//    cursor_pendiente)` PK (tenant_id, cliente_id).
//  - `buzon_mensaje(id, tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, codigo_tipo, categoria, critico,
//    motivo_critico, version_catalogo, avisado, leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados,
//    contenido_ruta, contenido_bytes, contenido_obtenido_en)`.
//  - `buzon_adjunto(id, tenant_id, cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido, creado_en)`;
//    un adjunto omitido lleva `mime`, `tamano`, `sha256` y `ruta` en NULL.
//  - `ruta` y `contenido_ruta` = `buzon/{tenant}/{cliente}/{uuid}.{ext}` (CHECK).
// La siembra va por la conexión de migraciones con `session_replication_role = replica` (no pasa por RLS, grants ni triggers de
// aviso: así un crítico se siembra sin notificar); las CHECK siguen vigentes. Los archivos de storage se escriben directo bajo
// `STORAGE_DIR` (la lectura de la ruta la hace el backend con el puerto de storage).
import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { INestApplication, Type } from "@nestjs/common";
import { DiscoveryService, ModulesContainer, Reflector } from "@nestjs/core";
import { createDb } from "@contapp/db";
import * as shared from "@contapp/shared";
import { META_PERMISO } from "../src/modules/acceso/guards/decoradores.js";
import { rutasDe } from "./auditoria-rutas.js";
import type { Resp } from "./soporte.js";
import type { Actor, Estudio } from "./soporte-credenciales.js";
import { abrirBancoVentas, type BancoVentas } from "./soporte-ventas.js";
import {
  archivosBajo,
  prepararStorage,
  type StoragePrueba,
} from "./soporte-xml.js";

export type { Actor, Estudio };
export { archivosBajo };

/** Los programados quedan detrás de todo interactivo en la pista de Redis (`encolado.ts`: desplazamiento 1e13). */
export const DESPLAZAMIENTO_PROGRAMADO = 1e13;
export const MIN = 60_000;
export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");
export const rutaBuzon = (
  tenantId: string,
  clienteId: string,
  ext: string,
): string => `buzon/${tenantId}/${clienteId}/${randomUUID()}.${ext}`;

export interface OpcionesMensaje {
  id?: string;
  idSunat?: string;
  asunto?: string;
  remitente?: string;
  /** ISO con zona; por omisión hace 2 días. */
  fecha?: string;
  codigoTipo?: string | null;
  categoria?: string;
  critico?: boolean;
  motivo?: string | null;
  leido?: boolean;
  declarados?: number;
  /** Texto plano ya obtenido por el worker: se escribe en storage y llena `contenido_*`. */
  contenido?: string;
}
export interface MensajeSembrado {
  id: string;
  contenidoRuta: string | null;
}

export interface OpcionesAdjunto {
  idSunat?: string;
  nombre?: string;
  bytes?: Uint8Array;
  mime?: string;
  ext?: string;
  omitido?: "mime" | "tamano" | "tope_mensaje";
}
export interface AdjuntoSembrado {
  id: string;
  ruta: string | null;
  bytes: Uint8Array | null;
  sha256: string | null;
}

export interface OpcionesEstado {
  /** Cada instante es la antigüedad en minutos (`null` o ausente = sin valor). */
  programadaHace?: number | null;
  solicitudHace?: number | null;
  capturaHace?: number | null;
  sincronizadoHace?: number | null;
  cursor?: string | null;
}

export interface OpcionesTrabajoVivo {
  prioridad?: "interactivo" | "programado";
  estado?: "en_cola" | "ejecutando";
  creadoPor?: string | null;
}

export interface BancoBuzon {
  v: BancoVentas;
  storage: StoragePrueba;
  estudio(): Promise<Estudio>;
  /** Cliente con `sol` y `sire_api` verificadas; `o` pisa la semilla (`responsable`, `colaboradores`, `archivado`, `sol`…). */
  cliente: BancoVentas["cliente"];
  llamar: BancoVentas["llamar"];
  bin: BancoVentas["bin"];
  /** Petición sin cookie ni CSRF (sin sesión). */
  sinSesion(metodo: "GET" | "POST", ruta: string): Promise<Resp>;
  sembrarMensaje(
    tenantId: string,
    clienteId: string,
    o?: OpcionesMensaje,
  ): Promise<MensajeSembrado>;
  sembrarAdjunto(
    tenantId: string,
    clienteId: string,
    mensajeId: string,
    o?: OpcionesAdjunto,
  ): Promise<AdjuntoSembrado>;
  sembrarEstado(
    tenantId: string,
    clienteId: string,
    o?: OpcionesEstado,
  ): Promise<void>;
  estado(clienteId: string): Promise<any | undefined>;
  /** Trabajos de un tipo del cliente, por SQL. */
  trabajos(clienteId: string, tipo: string): Promise<any[]>;
  /** Un `sol.buzon.revisar` vivo del cliente, con la clave de dedupe del catálogo y la pista en Redis. */
  sembrarRevisarVivo(
    tenantId: string,
    clienteId: string,
    o?: OpcionesTrabajoVivo,
  ): Promise<string>;
  /** `n` trabajos `sol.buzon.revisar` programados en cola, de un cliente, con claves distintas y pista en Redis. */
  sembrarProgramadosEnCola(
    tenantId: string,
    clienteId: string,
    n: number,
  ): Promise<string[]>;
  /** Lleva el trabajo a un estado terminal por SQL; `motivo` (p. ej. `credencial_invalida`) solo tiene sentido con `error`. */
  terminar(
    trabajoId: string,
    estado?: "completado" | "error" | "cancelado",
    motivo?: string | null,
  ): Promise<void>;
  /** Puntaje de la pista de Redis del trabajo en la cola `sol` (`null` si no está). */
  puntaje(tenantId: string, trabajoId: string): Promise<number | null>;
  auditoria(tenantId: string, accion: string): Promise<any[]>;
  /** Todas las filas de auditoría del estudio (para buscar canarios). */
  auditoriaTodas(tenantId: string): Promise<any[]>;
  cerrar(): Promise<void>;
}

const claveRevisar = (clienteId: string): Buffer =>
  createHash("sha256")
    .update(JSON.stringify(["sol.buzon.revisar", clienteId, {}]), "utf8")
    .digest();

export async function abrirBancoBuzon(): Promise<BancoBuzon> {
  // El módulo de storage lee `STORAGE`/`STORAGE_DIR` al construirse: se fijan antes de abrir la app.
  const storage = prepararStorage();
  let v: BancoVentas;
  try {
    v = await abrirBancoVentas();
  } catch (e) {
    storage.restaurar();
    throw e;
  }
  const sql = v.b.sql;
  const tenants: string[] = [];
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url)
    throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de buzón");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });

  type Cliente = {
    query(texto: string, valores?: unknown[]): Promise<{ rows: any[] }>;
  };
  async function conReplica<T>(
    fn: (c: Cliente) => Promise<T>,
  ): Promise<T | undefined> {
    const c = await admin.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      return await fn(c);
    } catch (e) {
      // Rojo (T6): mientras T11 no cree las tablas de buzón, sembrar no es posible y la prueba debe fallar en la RUTA (404), no aquí.
      // Con las tablas creadas este camino no existe: cualquier otro error, o este con las tablas ya migradas, se propaga.
      if ((e as { code?: string }).code === "42P01") return undefined;
      throw e;
    } finally {
      c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
    }
  }
  const escribir = (ruta: string, bytes: Uint8Array): void => {
    const destino = join(storage.dir, ruta);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, bytes);
  };
  const hace = (min: number | null | undefined): number | null =>
    min === null || min === undefined ? null : min;

  return {
    v,
    storage,
    estudio: async () => {
      const e = await v.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    cliente: v.cliente,
    llamar: v.llamar,
    bin: v.bin,
    sinSesion: (metodo, ruta) => v.b.c.p.b.h.pedir({ metodo, ruta }),
    sembrarMensaje: async (tenantId, clienteId, o = {}) => {
      const critico = o.critico ?? false;
      const contenidoRuta =
        o.contenido === undefined
          ? null
          : rutaBuzon(tenantId, clienteId, "txt");
      const contenido =
        o.contenido === undefined ? null : Buffer.from(o.contenido, "utf8");
      if (contenidoRuta !== null && contenido !== null)
        escribir(contenidoRuta, contenido);
      const id = o.id ?? randomUUID();
      await conReplica((c) =>
        c.query(
          `insert into buzon_mensaje
             (id, tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, codigo_tipo, categoria, critico, motivo_critico,
              version_catalogo, avisado, leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados,
              contenido_ruta, contenido_bytes, contenido_obtenido_en)
           values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now() - interval '2 days'), $8, $9, $10, $11, 1, false,
                   $12, now(), now(), $13, $14::text, $15::int, case when $14::text is null then null else now() end)`,
          [
            id,
            tenantId,
            clienteId,
            o.idSunat ?? `M-${randomUUID().slice(0, 12)}`,
            o.asunto ?? "Asunto de prueba",
            o.remitente ?? "SUNAT",
            o.fecha ?? null,
            o.codigoTipo ?? null,
            o.categoria ?? (critico ? "coactiva" : "otro"),
            critico,
            o.motivo === undefined ? (critico ? "codigo" : null) : o.motivo,
            o.leido ?? false,
            o.declarados ?? 0,
            contenidoRuta,
            contenido === null ? null : contenido.length,
          ],
        ),
      );
      return { id, contenidoRuta };
    },
    sembrarAdjunto: async (tenantId, clienteId, mensajeId, o = {}) => {
      const id = randomUUID();
      const omitido = o.omitido ?? null;
      if (omitido !== null) {
        await conReplica((c) =>
          c.query(
            `insert into buzon_adjunto (id, tenant_id, cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido, creado_en)
             values ($1, $2, $3, $4, $5, $6, null, null, null, null, $7, now())`,
            [
              id,
              tenantId,
              clienteId,
              mensajeId,
              o.idSunat ?? `A-${randomUUID().slice(0, 12)}`,
              o.nombre ?? "omitido.bin",
              omitido,
            ],
          ),
        );
        return { id, ruta: null, bytes: null, sha256: null };
      }
      const bytes =
        o.bytes ??
        Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
      const ruta = rutaBuzon(tenantId, clienteId, o.ext ?? "pdf");
      escribir(ruta, bytes);
      const sha = sha256Hex(bytes);
      await conReplica((c) =>
        c.query(
          `insert into buzon_adjunto (id, tenant_id, cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido, creado_en)
           values ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'hex'), $10, null, now())`,
          [
            id,
            tenantId,
            clienteId,
            mensajeId,
            o.idSunat ?? `A-${randomUUID().slice(0, 12)}`,
            o.nombre ?? "resolucion.pdf",
            o.mime ?? "application/pdf",
            bytes.length,
            sha,
            ruta,
          ],
        ),
      );
      return { id, ruta, bytes, sha256: sha };
    },
    sembrarEstado: async (tenantId, clienteId, o = {}) => {
      const f = (m: number | null | undefined) => hace(m);
      await conReplica((c) =>
        c.query(
          `insert into buzon_estado_cliente
             (tenant_id, cliente_id, ultima_programada_en, ultima_solicitud_en, ultima_captura_en, sincronizado_en, cursor_pendiente)
           values ($1, $2, now() - ($3::float8 * interval '1 minute'), now() - ($4::float8 * interval '1 minute'),
                   now() - ($5::float8 * interval '1 minute'), now() - ($6::float8 * interval '1 minute'), $7)
           on conflict (tenant_id, cliente_id) do update set
             ultima_programada_en = excluded.ultima_programada_en, ultima_solicitud_en = excluded.ultima_solicitud_en,
             ultima_captura_en = excluded.ultima_captura_en, sincronizado_en = excluded.sincronizado_en,
             cursor_pendiente = excluded.cursor_pendiente`,
          [
            tenantId,
            clienteId,
            f(o.programadaHace),
            f(o.solicitudHace),
            f(o.capturaHace),
            f(o.sincronizadoHace),
            o.cursor ?? null,
          ],
        ),
      );
    },
    estado: async (clienteId) => {
      try {
        return (
          await sql(
            "select * from buzon_estado_cliente where cliente_id = $1",
            [clienteId],
          )
        )[0];
      } catch (e) {
        if ((e as { code?: string }).code === "42P01") return undefined; // rojo: sin tablas de buzón (T11)
        throw e;
      }
    },
    trabajos: (clienteId, tipo) =>
      sql(
        "select * from job_registro where cliente_id = $1 and tipo = $2 order by creado_en, id",
        [clienteId, tipo],
      ),
    sembrarRevisarVivo: async (tenantId, clienteId, o = {}) => {
      const prioridad = o.prioridad ?? "programado";
      const estado = o.estado ?? "en_cola";
      const r = await sql(
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe,
                                   creado_por, max_intentos)
         select $1, c.id, c.ruc, 'sol.buzon.revisar', 'sol', 'sol', $3, $4, '{}'::jsonb, $5, $6, 4 from cliente c where c.id = $2
         returning id, creado_en`,
        [
          tenantId,
          clienteId,
          prioridad,
          estado,
          claveRevisar(clienteId),
          o.creadoPor ?? null,
        ],
      );
      const id = r[0].id as string;
      if (estado === "ejecutando") {
        await sql("update job_registro set iniciado_en = now() where id = $1", [
          id,
        ]);
      } else {
        const base = new Date(r[0].creado_en).getTime();
        await v.b.redis.zadd(
          v.b.claves.pend("sol", tenantId),
          (prioridad === "programado" ? DESPLAZAMIENTO_PROGRAMADO : 0) + base,
          id,
        );
        await v.b.redis.sadd(v.b.claves.tenants("sol"), tenantId);
      }
      return id;
    },
    sembrarProgramadosEnCola: async (tenantId, clienteId, n) => {
      const filas = await sql(
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, parametros, clave_dedupe, max_intentos)
         select $1, c.id, c.ruc, 'sol.buzon.revisar', 'sol', 'sol', 'programado', '{}'::jsonb,
                sha256(convert_to('relleno-' || g::text || '-' || gen_random_uuid()::text, 'UTF8')), 4
           from generate_series(1, $3::int) g, cliente c where c.id = $2
         returning id, creado_en`,
        [tenantId, clienteId, n],
      );
      const pipe = v.b.redis.pipeline();
      for (const f of filas) {
        pipe.zadd(
          v.b.claves.pend("sol", tenantId),
          DESPLAZAMIENTO_PROGRAMADO + new Date(f.creado_en).getTime(),
          f.id,
        );
      }
      pipe.sadd(v.b.claves.tenants("sol"), tenantId);
      await pipe.exec();
      return filas.map((f: any) => f.id as string);
    },
    terminar: async (trabajoId, estado = "completado", motivo = null) => {
      await sql(
        `update job_registro set estado = $2, motivo = $3, iniciado_en = coalesce(iniciado_en, now()), terminado_en = now(), actualizado_en = now()
          where id = $1`,
        [trabajoId, estado, motivo],
      );
    },
    puntaje: async (tenantId, trabajoId) => {
      const p = await v.b.redis.zscore(
        v.b.claves.pend("sol", tenantId),
        trabajoId,
      );
      return p === null ? null : Number(p);
    },
    auditoria: (tenantId, accion) =>
      sql(
        `select accion, actor_tipo, usuario_id, trabajo_id, cliente_id, entidad, entidad_id, datos
           from auditoria where tenant_id = $1 and accion = $2 order by ocurrida_en, id`,
        [tenantId, accion],
      ),
    auditoriaTodas: (tenantId) =>
      sql(
        "select accion, actor_tipo, usuario_id, cliente_id, entidad, entidad_id, datos from auditoria where tenant_id = $1",
        [tenantId],
      ),
    cerrar: async () => {
      try {
        if (tenants.length > 0) {
          await conReplica(async (c) => {
            // Un DELETE estático por tabla, de la hija a la madre; sin la tabla (rojo) no hay nada que limpiar.
            for (const texto of [
              "delete from buzon_adjunto where tenant_id = any($1::uuid[])",
              "delete from buzon_mensaje where tenant_id = any($1::uuid[])",
              "delete from buzon_estado_cliente where tenant_id = any($1::uuid[])",
            ]) {
              await c.query(texto, [tenants]).catch(() => undefined);
            }
          });
        }
        await v.cerrar();
      } finally {
        await admin.close();
        storage.restaurar();
      }
    },
  };
}

/** Texto percent-decodificado del `filename*=UTF-8''…` de un `Content-Disposition` (o `null` si no hay). */
export function nombreDeDisposicion(valor: unknown): string | null {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(String(valor ?? ""));
  if (m === null) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

// --- Esquemas de `@contapp/shared/buzon` ----------------------------------------------------------------------------
// Se leen por nombre en tiempo de ejecución: mientras `shared` no se haya reconstruido (T9), la prueba falla con este mensaje y
// no rompe la carga del archivo.
type Esquema = { safeParse(v: unknown): { success: boolean; error?: unknown } };
function esquema(nombre: string): Esquema {
  const e = (shared as unknown as Record<string, Esquema | undefined>)[nombre];
  if (!e) throw new Error(`@contapp/shared aún no exporta ${nombre} (T9)`);
  return e;
}
/** `true` si `valor` cumple el esquema `nombre` de `@contapp/shared`. */
export const cumple = (nombre: string, valor: unknown): boolean =>
  esquema(nombre).safeParse(valor).success;
/** Códigos de `CODIGOS_ERROR_BUZON` (T2). */
export const codigosErrorBuzon = (): readonly string[] =>
  ((shared as unknown as Record<string, unknown>).CODIGOS_ERROR_BUZON as
    readonly string[] | undefined) ?? [];

// --- Rutas registradas y su permiso ---------------------------------------------------------------------------------
export interface RutaConPermiso {
  metodo: string;
  ruta: string;
  permiso: string | null;
}
/** Las rutas de los controladores registrados que cuelgan de `/buzon`, con el permiso que declaran. */
export function rutasDeBuzon(app: INestApplication): RutaConPermiso[] {
  const reflector = app.get(Reflector);
  const clases = new DiscoveryService(app.get(ModulesContainer))
    .getControllers()
    .map((w) => w.metatype)
    .filter((m): m is Type => typeof m === "function");
  const salida: RutaConPermiso[] = [];
  for (const clase of clases) {
    for (const r of rutasDe([clase], reflector)) {
      if (!/\/buzon(\/|$)/.test(r.ruta)) continue;
      const proto = clase.prototype as Record<string, unknown>;
      const permiso = reflector.getAllAndOverride<unknown>(META_PERMISO, [
        proto[r.handler] as (...a: unknown[]) => unknown,
        clase,
      ]);
      salida.push({
        metodo: r.metodo,
        ruta: r.ruta,
        permiso: typeof permiso === "string" ? permiso : null,
      });
    }
  }
  return salida;
}
