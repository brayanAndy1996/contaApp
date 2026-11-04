/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de 007b (T4): credenciales, importación, carreras de cupo y alta con
// consulta de RUC. Encima de `soporte-clientes.ts` (007a) y con Redis real (base 15, prefijo propio) para que la cola
// funcione. Solo usa el contrato público: HTTP, `crearApp` y las tablas. Las claves son CANARIOS sintéticos.
//
// `abrirSobreMock` abre un sobre guardado en BD con el par de PRUEBAS del fixture `mock` usando solo `node:crypto`: el
// backend no puede importar `@contapp/crypto/descifrado` (lint, spec 003 CA-4b) y la prueba tampoco lo necesita. Sirve
// para comprobar que el sobre lleva la AAD `v1|tenant|cliente|tipo` (copiado a otro cliente deja de abrirse).
import {
  constants,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crearClaves, type ClavesCola } from "@contapp/queue";
import request from "supertest";
import {
  abrirBancoClientes,
  rucValido,
  type Actor,
  type BancoClientes,
  type Estudio,
} from "./soporte-clientes.js";
import {
  conectarRedis,
  limpiarPrefijo,
  nuevoPrefijo,
  urlRedisPrueba,
  type RedisPrueba,
} from "./soporte-trabajos.js";
import { ipUnica } from "./soporte.js";

export type { Actor, BancoClientes, Estudio };
export { rucValido };

/* ---------------------------------- Canarios ---------------------------------- */
/** Valor sintético y único que hace de clave: si aparece donde no debe, la prueba lo delata. */
export const canario = (etiqueta: string): string => `CANARIO-${etiqueta}-${randomBytes(6).toString("hex")}`;

/** Devuelve los canarios que aparecen en alguno de los textos (vacío = ninguno). */
export function filtrados(canarios: string[], ...textos: unknown[]): string[] {
  const volcado = textos.map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join("\n");
  return canarios.filter((c) => volcado.includes(c));
}

/* ------------------------------ Sobre de credencial ------------------------------ */
const LLAVE_MOCK = createPrivateKey(
  readFileSync(new URL("../../../packages/crypto/fixtures/mock-kek/SOLO-PRUEBAS-kek-mock-private.pem", import.meta.url)),
);
export interface FilaSobre {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dek_envuelta: Buffer;
  kek_id: string;
}
/**
 * Abre el sobre con la AAD `v1|tenant|cliente|tipo`. Devuelve el JSON del secreto o `null` si la AAD no coincide, el
 * sobre está alterado o la llave no es la del mock (cualquier fallo de autenticación es lo mismo).
 */
export function abrirSobreMock(
  f: FilaSobre,
  ctx: { tenantId: string; clienteId: string; tipo: "sol" | "sire_api" },
): Record<string, string> | null {
  try {
    const dek = privateDecrypt(
      {
        key: LLAVE_MOCK,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        oaepLabel: Buffer.from(`contapp-kek|v1|${f.kek_id}`, "utf8"),
      },
      f.dek_envuelta,
    );
    const d = createDecipheriv("aes-256-gcm", dek, f.nonce, { authTagLength: 16 });
    d.setAAD(Buffer.from(`v1|${ctx.tenantId}|${ctx.clienteId}|${ctx.tipo}`, "utf8"));
    d.setAuthTag(f.tag);
    const plano = Buffer.concat([d.update(f.ciphertext), d.final()]);
    return JSON.parse(plano.toString("utf8")) as Record<string, string>;
  } catch {
    return null;
  }
}

/* ------------------------------ Peticiones binarias ------------------------------ */
export interface RespBin {
  /** 0 si la conexión se cortó antes de la respuesta (el servidor cerró el socket mientras se subía el cuerpo). */
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
  texto: string;
  json: any;
}
const jsonONulo = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/**
 * Petición autenticada como `a` con respuesta binaria y cuerpo crudo opcional (`application/octet-stream`). `h.pedir`
 * descarta los cuerpos que no son texto ni JSON; la plantilla `.xlsx` necesita los bytes.
 */
export async function pedirBin(
  h: { app: { getHttpServer(): any } },
  a: { cookie: string; csrf: string; tenantId: string },
  metodo: "GET" | "POST",
  ruta: string,
  cuerpo?: Uint8Array,
): Promise<RespBin> {
  const dir = h.app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${dir.port}`;
  const t = metodo === "GET" ? request(base).get(ruta) : request(base).post(ruta);
  t.set("X-Forwarded-For", ipUnica())
    .set("Cookie", a.cookie)
    .set("X-CSRF-Token", a.csrf)
    .set("X-Estudio", a.tenantId)
    .ok(() => true)
    .buffer(true)
    .parse((res, cb) => {
      const trozos: Buffer[] = [];
      res.on("data", (c: Buffer) => trozos.push(c));
      res.on("end", () => cb(null, Buffer.concat(trozos)));
    });
  if (metodo === "POST") t.set("Origin", process.env.APP_ORIGIN ?? "http://localhost:3000");
  if (cuerpo !== undefined) t.set("Content-Type", "application/octet-stream").send(Buffer.from(cuerpo));
  try {
    const res = await t;
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
    const texto = bytes.toString("utf8");
    return { status: res.status, headers: res.headers, bytes, texto, json: jsonONulo(texto) };
  } catch (e) {
    const codigo = (e as { code?: string }).code;
    if (codigo === "EPIPE" || codigo === "ECONNRESET") {
      return { status: 0, headers: {}, bytes: Buffer.alloc(0), texto: "", json: null };
    }
    throw e;
  }
}

/* ------------------------------- Archivos en disco ------------------------------- */
/** Nombres de lo que hay hoy en el directorio temporal del sistema (instantánea para detectar archivos nuevos). */
export function instantaneaTmp(): Set<string> {
  try {
    return new Set(readdirSync(tmpdir()));
  } catch {
    return new Set();
  }
}
/**
 * Archivos del directorio temporal que no estaban en `antes` y cuyo contenido incluye alguno de los `canarios`
 * (los nuevos que no se pueden leer se ignoran: las pruebas no escriben ahí). Vacío = el archivo no quedó en disco.
 */
export function archivosNuevosConCanario(antes: Set<string>, canarios: string[]): string[] {
  const hallados: string[] = [];
  const revisar = (ruta: string, profundidad: number): void => {
    let st;
    try {
      st = statSync(ruta);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (profundidad > 3) return;
      for (const n of readdirSync(ruta)) revisar(join(ruta, n), profundidad + 1);
    } else if (st.isFile() && st.size < 8 * 1024 * 1024) {
      let contenido: Buffer;
      try {
        contenido = readFileSync(ruta);
      } catch {
        return;
      }
      if (canarios.some((c) => contenido.includes(c))) hallados.push(ruta);
    }
  };
  for (const n of readdirSync(tmpdir())) if (!antes.has(n)) revisar(join(tmpdir(), n), 0);
  return hallados;
}

/* ----------------------------------- Banco ----------------------------------- */
export interface BancoCola {
  c: BancoClientes;
  redis: RedisPrueba;
  prefijo: string;
  claves: ClavesCola;
  sql: BancoClientes["p"]["sql"];
  /** Estudio de plan corporativo (sin límite práctico) con Dueño con sesión. */
  estudio(): Promise<Estudio>;
  /** Estudio con un plan propio de `maxRucs` RUC y su Dueño con sesión. */
  estudioCon(maxRucs: number): Promise<Estudio>;
  /** Trabajos de cola `xml` pendientes (`en_cola` o `ejecutando`) del estudio. */
  pendientesXml(tenantId: string): Promise<number>;
  /** Siembra `n` trabajos `cliente.consultar_ruc` pendientes del estudio sobre `clienteId` (por SQL, sin Redis). */
  sembrarPendientesXml(tenantId: string, clienteId: string, n: number): Promise<void>;
  /** Trabajos del tipo (por SQL), con el RUC del cliente. */
  trabajos(tenantId: string, tipo: string): Promise<any[]>;
  /** Credenciales (por SQL, con el sobre) de un cliente. */
  credenciales(clienteId: string): Promise<any[]>;
  cerrar(): Promise<void>;
}

/**
 * Banco de 007a con cola: `redisApp` es la URL de Redis que recibe la app (por defecto la real de pruebas, base 15;
 * `URL_REDIS_CAIDO` para Redis caído).
 */
export async function abrirBancoCola(o: { redisApp?: string } = {}): Promise<BancoCola> {
  const prefijo = nuevoPrefijo();
  const redis = conectarRedis();
  const c = await abrirBancoClientes({ redis: { url: o.redisApp ?? urlRedisPrueba(), prefijo } });
  const sql = c.p.sql;
  const tenants: string[] = [];

  return {
    c,
    redis,
    prefijo,
    claves: crearClaves(prefijo),
    sql,
    estudio: async () => {
      const e = await c.p.b.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    estudioCon: async (maxRucs) => {
      const e = await c.estudioCon(maxRucs);
      tenants.push(e.tenantId);
      return e;
    },
    pendientesXml: async (tenantId) =>
      Number(
        (
          await sql(
            "select count(*)::int n from job_registro where tenant_id = $1 and cola = 'xml' and estado in ('en_cola', 'ejecutando')",
            [tenantId],
          )
        )[0].n,
      ),
    sembrarPendientesXml: async (tenantId, clienteId, n) => {
      await sql(
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, parametros, clave_dedupe, max_intentos)
         select $1, $2, c.ruc, 'cliente.consultar_ruc', 'xml', 'ninguno', 'programado', '{}'::jsonb,
                sha256(convert_to('relleno-' || g::text || '-' || gen_random_uuid()::text, 'UTF8')), 3
           from generate_series(1, $3::int) g, cliente c where c.id = $2`,
        [tenantId, clienteId, n],
      );
    },
    trabajos: (tenantId, tipo) =>
      sql(
        `select j.*, c.ruc as ruc_cliente from job_registro j join cliente c on c.id = j.cliente_id
          where j.tenant_id = $1 and j.tipo = $2 order by j.creado_en, j.id`,
        [tenantId, tipo],
      ),
    credenciales: (clienteId) => sql("select * from credencial where cliente_id = $1 order by tipo", [clienteId]),
    cerrar: async () => {
      if (tenants.length > 0) {
        // job_registro y credencial referencian cliente: se borran antes que la limpieza de 005/006/007a.
        await sql("delete from job_registro where tenant_id = any($1::uuid[])", [tenants]).catch(() => undefined);
        await sql("delete from credencial where tenant_id = any($1::uuid[])", [tenants]).catch(() => undefined);
      }
      await limpiarPrefijo(redis, prefijo).catch(() => undefined);
      try {
        await c.cerrar();
      } finally {
        redis.disconnect();
      }
    },
  };
}
