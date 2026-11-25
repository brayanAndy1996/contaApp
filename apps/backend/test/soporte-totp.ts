/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de 029 (T3, rojo). Encima de `soporte.ts`, `soporte-acceso.ts` y `soporte-planes.ts`. Fuera de `src/`
// (no cuenta en la cobertura). Solo usa el contrato público: HTTP, `crearApp` y las tablas. No es código de producción.
//
// - RFC 6238 propio (SHA-1, 6 dígitos, 30 s): la prueba calcula los códigos desde el secreto del URI, sin importar nada del backend.
// - Reloj: `congelarReloj()` fija solo `Date` (el servidor corre en el mismo proceso) en la mitad de un paso de 30 s, a menos de 15 s del
//   reloj real; `avanzar(k)` mueve k pasos. Así el borde de ±1 paso no depende de cuándo corre la prueba. Las marcas de BD siguen con `now()`.
// - `TOTP_CLAVE` de prueba (D1): se fija antes de `crearApp` si el entorno no la trae.
// - Limpieza: las tablas nuevas tienen FK a `auth.usuario`/`usuario`; se borran antes de que el soporte base borre al usuario (sus
//   `delete` son de mejor esfuerzo y dejarían usuarios huérfanos). Si la tabla aún no existe, se ignora.
import { createHmac, randomBytes } from "node:crypto";
import { vi } from "vitest";
import { derivarCsrf } from "../src/modules/auth/sesion/csrf.js";
import { abrirBanco, type Banco } from "./soporte-acceso.js";
import { abrirBancoPlanes, type BancoPlanes } from "./soporte-planes.js";
import { abrirHarness, COOKIE, cookieSesion, type Harness, type Resp, type UsuarioPrueba } from "./soporte.js";

/** `TOTP_CLAVE=<versión>:<base64 32 B>` (plan: Entorno). Con la del entorno, si ya la trae. */
process.env.TOTP_CLAVE ??= `1:${randomBytes(32).toString("base64")}`;
export const TOTP_CLAVE_PRUEBA = process.env.TOTP_CLAVE;

export const PASO_S = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** XXXX-XXXX-XXXX, 60 bits en base32 (plan: Decisiones). */
export const FORMATO_CODIGO_RECUPERACION = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
/** Códigos del plan: 403 de la exigencia y 409 de desactivar. */
export const EXIGIDO = { codigo: "segundo_factor_requerido" } as const;

/* ---------------- RFC 6238 ---------------- */
export function base32Decode(texto: string): Buffer {
  const limpio = texto.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let acc = 0;
  const salida: number[] = [];
  for (const c of limpio) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("base32 inválido en la prueba");
    acc = (acc << 5) | i;
    bits += 5;
    if (bits >= 8) {
      salida.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(salida);
}

/** Código de 6 dígitos del paso que contiene `ms` (más `desfase` pasos). */
export function codigoTotp(secretoB32: string, ms: number, desfase = 0): string {
  const paso = Math.floor(ms / 1000 / PASO_S) + desfase;
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const h = createHmac("sha1", base32Decode(secretoB32)).update(contador).digest();
  const o = h[h.length - 1]! & 0x0f;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** Secreto base32 del URI `otpauth://` (y los parámetros que declara). */
export function parametrosUri(uri: string): { secreto: string; digits: string | null; period: string | null; algorithm: string | null; protocolo: string; tipo: string } {
  const u = new URL(uri);
  return {
    protocolo: u.protocol,
    tipo: u.host,
    secreto: u.searchParams.get("secret") ?? "",
    digits: u.searchParams.get("digits"),
    period: u.searchParams.get("period"),
    algorithm: u.searchParams.get("algorithm"),
  };
}
export const secretoDeUri = (uri: string): string => parametrosUri(uri).secreto;

/** Un código de 6 dígitos que NO es válido en ningún paso cercano al instante dado (para los intentos erróneos). */
export function codigoErroneo(secretoB32: string, ms: number): string {
  const validos = new Set([-3, -2, -1, 0, 1, 2, 3].map((d) => codigoTotp(secretoB32, ms, d)));
  for (let i = 0; i < 1000; i++) {
    const c = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    if (!validos.has(c)) return c;
  }
  throw new Error("no se pudo generar un código erróneo");
}

/* ---------------- Reloj inyectado ---------------- */
export interface Reloj {
  /** Instante actual del servidor y de la prueba (ms). */
  ahora(): number;
  /** Mueve `pasos` pasos de 30 s (puede ser negativo). */
  avanzar(pasos: number): void;
  /** Código del paso actual (más `desfase` pasos). */
  codigo(secreto: string, desfase?: number): string;
  liberar(): void;
}
export function congelarReloj(): Reloj {
  const real = Date.now();
  let t = Math.floor(real / (PASO_S * 1000)) * PASO_S * 1000 + (PASO_S * 1000) / 2; // mitad de paso: ±15 s del real
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
  return {
    ahora: () => t,
    avanzar: (pasos) => {
      t += pasos * PASO_S * 1000;
      vi.setSystemTime(t);
    },
    codigo: (secreto, desfase = 0) => codigoTotp(secreto, t, desfase),
    liberar: () => {
      vi.useRealTimers();
    },
  };
}

/* ---------------- Limpieza de las tablas nuevas ---------------- */
function rastrear(h: Harness): void {
  const ids = new Set<string>();
  const crear = h.crearUsuario.bind(h);
  h.crearUsuario = async (o) => {
    const u = await crear(o);
    ids.add(u.id);
    return u;
  };
  (h as any).purgarTotp = async () => {
    for (const tabla of ["auth.cuenta_evento", "auth.totp_recuperacion", "auth.totp"]) {
      await h.sql(`delete from ${tabla} where usuario_id = any($1::uuid[])`, [[...ids]]).catch(() => undefined);
    }
  };
}
const purgar = (h: Harness): Promise<void> => (h as any).purgarTotp();

export async function abrirHarnessTotp(): Promise<Harness> {
  const h = await abrirHarness();
  rastrear(h);
  const cerrar = h.cerrar.bind(h);
  h.cerrar = async () => {
    await purgar(h);
    await cerrar();
  };
  return h;
}
export async function abrirBancoTotp(): Promise<Banco> {
  const b = await abrirBanco();
  rastrear(b.h);
  const cerrar = b.cerrar.bind(b);
  b.cerrar = async () => {
    await purgar(b.h);
    await cerrar();
  };
  return b;
}
export async function abrirPlanesTotp(): Promise<BancoPlanes> {
  const p = await abrirBancoPlanes();
  rastrear(p.b.h);
  const cerrar = p.cerrar.bind(p);
  p.cerrar = async () => {
    await purgar(p.b.h);
    await cerrar();
  };
  return p;
}

/* ---------------- Flujos ---------------- */
export interface SesionTotp {
  cookie: string;
  valor: string;
  csrf: string;
}
export interface CuentaTotp extends SesionTotp {
  secreto: string;
  uri: string;
  codigos: string[];
  /** Respuestas de los pasos, por si la prueba las inspecciona. */
  respuestas: { enrolar: Resp; confirmar: Resp };
}

const cookieDe = (valor: string): string => `${COOKIE}=${valor}`;

/** Lee `GET /auth/sesion` con la cookie y devuelve la sesión con su CSRF. */
export async function sesionDeCookie(h: Harness, valor: string): Promise<SesionTotp> {
  const cookie = cookieDe(valor);
  const s = await h.pedir({ ruta: "/auth/sesion", cookie });
  if (s.status !== 200) throw new Error(`GET /auth/sesion de prueba: HTTP ${s.status} ${JSON.stringify(s.body)}`);
  return { cookie, valor, csrf: s.body.csrf };
}

/** Login sin TOTP: sesión `sin_factor` con su CSRF. */
export async function entrarSinTotp(h: Harness, u: { correo: string; contrasena: string }): Promise<SesionTotp> {
  const l = await h.login(u.correo, u.contrasena);
  const c = cookieSesion(l);
  if (l.status !== 200 || !c) throw new Error(`login de prueba: HTTP ${l.status} ${JSON.stringify(l.body)}`);
  return sesionDeCookie(h, c.valor);
}

/**
 * Enrola y confirma con el reloj dado (el paso actual queda como `ultimo_paso`): devuelve la sesión `verificado` rotada, el secreto,
 * el URI y los códigos de recuperación.
 */
export async function activarTotp(h: Harness, u: { correo: string; contrasena: string }, reloj?: Reloj): Promise<CuentaTotp> {
  const s = await entrarSinTotp(h, u);
  const enrolar = await h.pedir({ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: u.contrasena }, cookie: s.cookie, csrf: s.csrf });
  if (enrolar.status !== 200) throw new Error(`enrolar de prueba: HTTP ${enrolar.status} ${JSON.stringify(enrolar.body)}`);
  const uri = enrolar.body.uri as string;
  const secreto = secretoDeUri(uri);
  const codigo = reloj ? reloj.codigo(secreto) : codigoTotp(secreto, Date.now());
  const confirmar = await h.pedir({ ruta: "/auth/totp/confirmar", cuerpo: { codigo }, cookie: s.cookie, csrf: s.csrf });
  const c = cookieSesion(confirmar);
  if (confirmar.status !== 200 || !c) throw new Error(`confirmar de prueba: HTTP ${confirmar.status} ${JSON.stringify(confirmar.body)}`);
  const nueva = await sesionDeCookie(h, c.valor);
  return { ...nueva, secreto, uri, codigos: confirmar.body.codigosRecuperacion as string[], respuestas: { enrolar, confirmar } };
}

/** Login con TOTP activo: la sesión `pendiente` (su CSRF se deriva del token, como el servidor; `GET /auth/sesion` no la sirve). */
export async function loginPendiente(h: Harness, u: { correo: string; contrasena: string }, extra: Record<string, unknown> = {}): Promise<SesionTotp & { r: Resp }> {
  const r = await h.login(u.correo, u.contrasena, extra);
  const c = cookieSesion(r);
  if (r.status !== 200 || !c) throw new Error(`login con TOTP de prueba: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: cookieDe(c.valor), valor: c.valor, csrf: derivarCsrf(c.valor), r };
}

export const verificar = (h: Harness, p: { cookie: string; csrf: string }, cuerpo: unknown, extra: Record<string, unknown> = {}): Promise<Resp> =>
  h.pedir({ ruta: "/auth/2fa/verificar", cuerpo, cookie: p.cookie, csrf: p.csrf, ...extra });

/** Login en dos pasos con el código del paso siguiente (cada llamada avanza un paso: el anterior ya quedó usado). */
export async function entrarConTotp(h: Harness, u: { correo: string; contrasena: string }, secreto: string, reloj: Reloj): Promise<SesionTotp & { verificar: Resp }> {
  const p = await loginPendiente(h, u);
  reloj.avanzar(1);
  const v = await verificar(h, p, { codigo: reloj.codigo(secreto) });
  const c = cookieSesion(v);
  if (v.status !== 200 || !c) throw new Error(`verificar de prueba: HTTP ${v.status} ${JSON.stringify(v.body)}`);
  return { ...(await sesionDeCookie(h, c.valor)), verificar: v };
}

/** Elige el estudio activo (rota la sesión) y devuelve la nueva. */
export async function elegirEstudio(h: Harness, s: SesionTotp, tenantId: string): Promise<SesionTotp & { r: Resp }> {
  const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId }, cookie: s.cookie, csrf: s.csrf });
  const c = cookieSesion(r);
  if (r.status !== 200 || !c) throw new Error(`elegir estudio de prueba: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return { ...(await sesionDeCookie(h, c.valor)), r };
}

/** Filas de `auth.totp` del usuario (conexión de migraciones). */
export const filaTotp = async (h: Harness, usuarioId: string): Promise<any | undefined> =>
  (await h.sql("select * from auth.totp where usuario_id = $1", [usuarioId]))[0];
export const eventos = (h: Harness, usuarioId: string): Promise<{ tipo: string }[]> =>
  h.sql("select tipo from auth.cuenta_evento where usuario_id = $1 order by creado_en, id", [usuarioId]);
/** Sesiones del usuario con su factor y motivo de revocación. */
export const sesionesDe = (h: Harness, usuarioId: string): Promise<any[]> =>
  h.sql("select id, factor, motivo, revocada_en, tenant_activo, creada_en, expira_absoluta, dispositivo, host(ip_red) as ip_host, ip_red::text as ip_red from auth.sesion where usuario_id = $1 order by creada_en, id", [usuarioId]);
export const contadorFallos = async (h: Harness, claveCorreo: Buffer): Promise<{ fallos: number; bloqueado_hasta: Date | null } | undefined> =>
  (await h.sql("select fallos, bloqueado_hasta from auth.intento_login where clave = $1", [claveCorreo]))[0];

/** Usuario de prueba no es el único dato: texto de todo lo observable de una respuesta (cuerpo y cabeceras). */
export const visible = (r: Resp): string => `${r.text}\n${JSON.stringify(r.headers)}`;
export type { UsuarioPrueba };
