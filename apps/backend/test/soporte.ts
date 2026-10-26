/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de 004 (T7). Fuera de `src/` para que no cuente en la
// cobertura ni en el build. Solo usa el contrato público: `crearApp`, HTTP y las tablas `auth.*`
// (con la conexión de migraciones, como dicta el plan para mover marcas de tiempo y leer hashes).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { createDb, SEED, type ContappDb } from "@contapp/db";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import request from "supertest";
import { expect, vi } from "vitest";
import {
  crearApp,
  type CorreoApp,
  type HasherApp,
  type MensajeCorreoApp,
} from "../src/app.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

export const ORIGEN = process.env.APP_ORIGIN ?? "http://localhost:3000";
export const COOKIE = "__Host-contapp_sid";
export const PWD = "Contrasena-prueba-004-ñ";

/* ---------------- Semilla (T9 agrega uSin y la contraseña de desarrollo) ---------------- */
export interface SeedAuth {
  tenantA: string;
  tenantB: string;
  uA: string;
  uB: string;
  uAB: string;
  uSin: string;
  contrasenaDesarrollo: string;
  usuarios: { id: string; email: string; nombre: string }[];
  tenants: { id: string; nombre: string }[];
}
export function seedAuth(): SeedAuth {
  const s = SEED as unknown as Partial<SeedAuth>;
  if (!s.uSin || typeof s.contrasenaDesarrollo !== "string") {
    throw new Error(
      "el SEED de @contapp/db aun no define uSin ni contrasenaDesarrollo (T9 de la spec 004)",
    );
  }
  return s as SeedAuth;
}
export const correoSeed = (id: string): string => {
  const u = seedAuth().usuarios.find((x) => x.id === id);
  if (!u) throw new Error("usuario de seed inexistente");
  return u.email;
};
export const nombreTenant = (id: string): string => {
  const t = seedAuth().tenants.find((x) => x.id === id);
  if (!t) throw new Error("tenant de seed inexistente");
  return t.nombre;
};

/* ---------------- Utilidades ---------------- */
export const sha256 = (v: string | Buffer): Buffer => createHash("sha256").update(v).digest();
export const normalizar = (c: string): string => c.trim().toLowerCase().normalize("NFC");
export const claveCorreo = (c: string): Buffer => sha256(normalizar(c));
/** El token viaja como base64url de 32 B; la BD guarda SHA-256 (de los bytes o de la cadena: ambas valen). */
export const hashesPosibles = (valorCookie: string): Buffer[] => [
  sha256(Buffer.from(valorCookie, "base64url")),
  sha256(valorCookie),
];
export const esHashDe = (fila: Buffer, valorCookie: string): boolean =>
  hashesPosibles(valorCookie).some((h) => h.equals(fila));

let contadorIp = 0;
export function ipUnica(): string {
  contadorIp += 1;
  const r = randomBytes(2);
  return `10.${(contadorIp >> 8) & 255}.${r[0] ?? 1}.${(r[1] ?? 1) % 250 + 1}`;
}
export const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const mediana = (xs: number[]): number => {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)] ?? 0;
};

/* ---------------- Correo en memoria (se inyecta con crearApp) ---------------- */
export class CorreoMemoria implements CorreoApp {
  enviados: MensajeCorreoApp[] = [];
  intentos = 0;
  retenido = false;
  fallar: Error | null = null;
  alEnviar: ((m: MensajeCorreoApp) => Promise<void>) | null = null;
  private pendientes: (() => void)[] = [];

  async enviar(m: MensajeCorreoApp): Promise<void> {
    this.intentos += 1;
    if (this.retenido) await new Promise<void>((r) => this.pendientes.push(r));
    if (this.alEnviar) await this.alEnviar(m);
    if (this.fallar) throw this.fallar;
    this.enviados.push(m);
  }
  liberar(): void {
    this.retenido = false;
    for (const r of this.pendientes.splice(0)) r();
  }
  para(correo: string): MensajeCorreoApp[] {
    return this.enviados.filter((m) => m.para.trim().toLowerCase() === correo.toLowerCase());
  }
  /** Espera (sondeo) a que haya al menos `n` mensajes para `correo`. */
  async esperar(correo: string, n = 1, ms = 3000): Promise<MensajeCorreoApp[]> {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      if (this.para(correo).length >= n) break;
      await pausa(25);
    }
    return this.para(correo);
  }
  /** Token de recuperación del enlace `#t=…` del último correo a `correo`. */
  tokenDe(correo: string): string {
    const ms = this.para(correo);
    const texto = ms[ms.length - 1]?.texto ?? "";
    const m = /#t=([A-Za-z0-9_-]+)/.exec(texto);
    if (!m?.[1]) throw new Error("el correo de recuperación no trae el enlace con #t=");
    return m[1];
  }
}

/* ---------------- Hasher espía con Argon2id real en el piso (D1) ---------------- */
export interface HasherEspia extends HasherApp {
  reales: number;
  ficticias: number;
  calculos: number;
  rehash: number;
  /** Si está definido, `verificar` lanza lo que devuelva (prueba de no fuga, CA-10). */
  fallaVerificar: ((plano: string, phc: string) => Error) | null;
  marca(): { reales: number; ficticias: number; calculos: number };
}
const PISO = { memoria: 19456, iteraciones: 2, paralelismo: 1 };
const params = () => ({
  memoryCost: Math.max(Number(process.env.ARGON2_MEMORIA_KIB) || 0, PISO.memoria),
  timeCost: Math.max(Number(process.env.ARGON2_ITERACIONES) || 0, PISO.iteraciones),
  parallelism: Math.max(Number(process.env.ARGON2_PARALELISMO) || 0, PISO.paralelismo),
  outputLen: 32,
  algorithm: 2 as never, // Argon2id (el const enum no compila con isolatedModules)
});
export async function crearHasherEspia(): Promise<HasherEspia> {
  const ficticio = await argonHash(`ficticio-${randomUUID()}`, params());
  const h: HasherEspia = {
    reales: 0,
    ficticias: 0,
    calculos: 0,
    rehash: 0,
    fallaVerificar: null,
    hashFicticio: ficticio,
    calcular: async (plano) => {
      h.calculos += 1;
      return argonHash(plano, params());
    },
    verificar: async (phc, plano) => {
      if (phc === ficticio) h.ficticias += 1;
      else h.reales += 1;
      if (h.fallaVerificar) throw h.fallaVerificar(plano, phc);
      try {
        return await argonVerify(phc, plano);
      } catch {
        return false;
      }
    },
    necesitaRehash: (phc) => {
      h.rehash += 1;
      const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
      if (!m) return true;
      const p = params();
      return Number(m[1]) < p.memoryCost || Number(m[2]) < p.timeCost || Number(m[3]) < p.parallelism;
    },
    marca: () => ({ reales: h.reales, ficticias: h.ficticias, calculos: h.calculos }),
  };
  return h;
}
/** Hash PHC con parámetros viejos (bajo el piso) para probar la re-calculación (CA-4). */
export const hashViejo = (plano: string): Promise<string> =>
  argonHash(plano, { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32, algorithm: 2 as never });

/* ---------------- Respuestas ---------------- */
export interface Resp {
  status: number;
  body: any;
  text: string;
  headers: Record<string, string | string[] | undefined>;
  setCookies: string[];
  ms: number;
}
export interface CookieSet {
  nombre: string;
  valor: string;
  atributos: string[];
  cruda: string;
}
export function analizarSetCookie(cruda: string): CookieSet {
  const [par = "", ...resto] = cruda.split(";").map((s) => s.trim());
  const i = par.indexOf("=");
  return { nombre: par.slice(0, i), valor: par.slice(i + 1), atributos: resto, cruda };
}
export const atributo = (c: CookieSet, nombre: string): string | undefined =>
  c.atributos.find((a) => a.toLowerCase().split("=")[0] === nombre.toLowerCase());
export const maxAge = (c: CookieSet): number => {
  const a = atributo(c, "max-age");
  return a ? Number(a.split("=")[1]) : Number.NaN;
};
/** Cookie de sesión emitida en la respuesta (o undefined). */
export const cookieSesion = (r: Resp): CookieSet | undefined =>
  r.setCookies.map(analizarSetCookie).find((c) => c.nombre === COOKIE);
/** Cabeceras comparables entre ramas: todas menos `date`. */
export const sinFecha = (h: Resp["headers"]): Record<string, unknown> => {
  const { date: _fecha, ...resto } = h;
  void _fecha;
  return resto;
};
export const forma = (r: Resp) => ({ status: r.status, body: r.body, headers: sinFecha(r.headers) });

export interface Peticion {
  metodo?: "GET" | "POST";
  ruta: string;
  cuerpo?: unknown;
  /** Cuerpo JSON ya serializado (para probar tamaños o JSON roto). */
  crudo?: string;
  /** Valor de la cabecera `Cookie` completa (p. ej. `__Host-contapp_sid=abc`). */
  cookie?: string | null;
  csrf?: string | null;
  estudio?: string | null;
  /** Por defecto `ORIGEN` en POST; `null` lo omite. */
  origen?: string | null;
  secFetchSite?: string;
  /** Por defecto una IP distinta por petición (vía `X-Forwarded-For` desde loopback); `null` la omite. */
  ip?: string | null;
  cabeceras?: Record<string, string>;
}

export interface UsuarioPrueba {
  id: string;
  correo: string;
  contrasena: string;
}
export interface SesionPrueba {
  cookie: string;
  valor: string;
  csrf: string;
  estudioActivo: { id: string; nombre: string } | null;
  login: Resp;
}

export interface Harness {
  app: INestApplication;
  correo: CorreoMemoria;
  hasher: HasherEspia;
  /** Backend real de la BD (rol contapp_backend): para `withUsuario`/`withTenant` desde un `Correo` de prueba. */
  dbBackend: ContappDb;
  pedir(p: Peticion): Promise<Resp>;
  sql<T = any>(texto: string, valores?: unknown[]): Promise<T[]>;
  crearUsuario(o?: { estudios?: string[]; contrasena?: string; hash?: string }): Promise<UsuarioPrueba>;
  correoInexistente(): string;
  login(correo: string, contrasena: string, extra?: Partial<Peticion>): Promise<Resp>;
  entrar(u: { correo: string; contrasena: string }, extra?: Partial<Peticion>): Promise<SesionPrueba>;
  sesiones(usuarioId: string): Promise<any[]>;
  /** Mueve marcas de tiempo (conexión de migraciones; el plan lo prevé). */
  reiniciarIntentos(correo: string): Promise<void>;
  cerrar(): Promise<void>;
}

export async function abrirHarness(): Promise<Harness> {
  const correo = new CorreoMemoria();
  const hasher = await crearHasherEspia();
  const app = await crearApp({ correo, hasher });
  await app.listen(0, "127.0.0.1");
  const direccion = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${direccion.port}`;

  const urlAdmin = process.env.MIGRATIONS_DATABASE_URL;
  if (!urlAdmin) throw new Error("falta MIGRATIONS_DATABASE_URL (conexión de migraciones) para las pruebas");
  const admin = createDb({ rolApp: "contapp_backend", url: urlAdmin, poolMax: 3 });
  const dbBackend = createDb({ rolApp: "contapp_backend", poolMax: 3 });

  const usuarios: string[] = [];
  const claves: Buffer[] = [];

  const sql: Harness["sql"] = async (texto, valores) => (await admin.pool.query(texto, valores)).rows;

  const pedir: Harness["pedir"] = async (p) => {
    const metodo = p.metodo ?? (p.cuerpo !== undefined || p.crudo !== undefined ? "POST" : "GET");
    const cliente = request(base);
    const t = metodo === "GET" ? cliente.get(p.ruta) : cliente.post(p.ruta);
    t.ok(() => true);
    const ip = p.ip === undefined ? ipUnica() : p.ip;
    if (ip) t.set("X-Forwarded-For", ip);
    const origen = p.origen === undefined ? (metodo === "POST" ? ORIGEN : null) : p.origen;
    if (origen !== null) t.set("Origin", origen);
    if (p.secFetchSite) t.set("Sec-Fetch-Site", p.secFetchSite);
    if (p.cookie) t.set("Cookie", p.cookie);
    if (p.csrf) t.set("X-CSRF-Token", p.csrf);
    if (p.estudio) t.set("X-Estudio", p.estudio);
    for (const [k, v] of Object.entries(p.cabeceras ?? {})) t.set(k, v);
    if (p.crudo !== undefined) t.set("Content-Type", "application/json").send(p.crudo);
    else if (p.cuerpo !== undefined) t.send(p.cuerpo as object);
    const t0 = performance.now();
    const res = await t;
    const ms = performance.now() - t0;
    const sc = res.headers["set-cookie"] as unknown as string[] | string | undefined;
    const setCookies = ([] as string[]).concat(sc ?? []);
    const r: Resp = {
      status: res.status,
      body: res.body && Object.keys(res.body).length > 0 ? res.body : (safeJson(res.text) ?? {}),
      text: res.text ?? "",
      headers: res.headers as Resp["headers"],
      setCookies,
      ms,
    };
    // CA-10: ninguna respuesta incluye un hash de contraseña.
    expect(`${r.text}\n${JSON.stringify(r.headers)}`).not.toMatch(/\$argon2/);
    return r;
  };

  const crearUsuario: Harness["crearUsuario"] = async (o = {}) => {
    const id = randomUUID();
    const correoU = `u${randomBytes(6).toString("hex")}@t004.contapp.test`;
    const contrasena = o.contrasena ?? PWD;
    const phc = o.hash ?? (await argonHash(contrasena, params()));
    await sql("insert into usuario (id, email, nombre) values ($1, $2, $3)", [id, correoU, "Usuario de prueba 004"]);
    await sql("insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) values ($1, $2, now())", [id, phc]);
    for (const t of o.estudios ?? []) {
      await sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')", [t, id]);
    }
    usuarios.push(id);
    claves.push(claveCorreo(correoU));
    return { id, correo: correoU, contrasena };
  };

  const login: Harness["login"] = (c, contrasena, extra = {}) =>
    pedir({ ruta: "/auth/login", cuerpo: { correo: c, contrasena }, ...extra });

  const entrar: Harness["entrar"] = async (u, extra = {}) => {
    const l = await login(u.correo, u.contrasena, extra);
    if (l.status !== 200) throw new Error(`login de prueba fallido: HTTP ${l.status} ${JSON.stringify(l.body)}`);
    const c = cookieSesion(l);
    if (!c) throw new Error("login de prueba sin cookie de sesión");
    const cookie = `${COOKIE}=${c.valor}`;
    const s = await pedir({ ruta: "/auth/sesion", cookie });
    if (s.status !== 200) throw new Error(`GET /auth/sesion fallido: HTTP ${s.status}`);
    return { cookie, valor: c.valor, csrf: s.body.csrf, estudioActivo: s.body.estudioActivo, login: l };
  };

  return {
    app,
    correo,
    hasher,
    dbBackend,
    pedir,
    sql,
    crearUsuario,
    correoInexistente: () => {
      const c = `nadie${randomBytes(6).toString("hex")}@t004.contapp.test`;
      claves.push(claveCorreo(c));
      return c;
    },
    login,
    entrar,
    sesiones: (usuarioId) =>
      sql("select * from auth.sesion where usuario_id = $1 order by creada_en, id", [usuarioId]),
    reiniciarIntentos: async (c) => {
      await sql("delete from auth.intento_login where clave = $1", [claveCorreo(c)]);
    },
    cerrar: async () => {
      correo.liberar();
      for (const id of usuarios) {
        await sql("delete from auth.sesion where usuario_id = $1", [id]).catch(() => undefined);
        await sql("delete from auth.token_recuperacion where usuario_id = $1", [id]).catch(() => undefined);
        await sql("delete from auth.usuario_contrasena where usuario_id = $1", [id]).catch(() => undefined);
        await sql("delete from membresia where usuario_id = $1", [id]).catch(() => undefined);
        await sql("delete from usuario where id = $1", [id]).catch(() => undefined);
      }
      for (const k of claves) {
        await sql("delete from auth.intento_login where clave = $1", [k]).catch(() => undefined);
      }
      await app.close();
      await admin.close();
      await dbBackend.close();
    },
  };
}

function safeJson(t: string | undefined): unknown {
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Captura stdout y stderr (donde escribe el logger de Nest y `console`) mientras corre `fn`. */
export async function capturarLogs<T>(fn: () => Promise<T>): Promise<{ resultado: T; logs: string }> {
  const trozos: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sustituto = (chunk: unknown): boolean => {
    trozos.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  };
  process.stdout.write = sustituto as typeof process.stdout.write;
  process.stderr.write = sustituto as typeof process.stderr.write;
  try {
    const resultado = await fn();
    return { resultado, logs: trozos.join("") };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
