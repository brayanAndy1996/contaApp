// Utilidades compartidas por las pruebas de @contapp/crypto (T5). No es código de producción.
import { generateKeyPair } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { ContextoAad, KeyWrapper, TipoCredencial } from "./index";

export const TENANT_A = "0192f0c1-7a3b-7c4d-8e5f-1a2b3c4d5e6f";
export const TENANT_B = "0192f0c1-7a3b-7c4d-8e5f-aaaaaaaaaaaa";
export const CLIENTE_1 = "0192f0c2-1111-7222-8333-444455556666";
export const CLIENTE_2 = "0192f0c2-9999-7888-8777-666655554444";

export const CANARIO_USUARIO = "CANARIO-USR-7f3a9c41";
export const CANARIO_CLAVE = "CANARIO-CLAVE-91bd2e07";
export const VALOR_SOL = { usuario: CANARIO_USUARIO, clave: CANARIO_CLAVE };
export const VALOR_SIRE = {
  clientId: "CANARIO-CID-5c2e8a13",
  clientSecret: "CANARIO-CSEC-e04b77d9",
};

export function ctxSol(
  o: Partial<ContextoAad> = {},
): ContextoAad & { tipo: "sol" } {
  return {
    tenantId: TENANT_A,
    clienteId: CLIENTE_1,
    ...o,
    tipo: "sol",
  } as ContextoAad & { tipo: "sol" };
}

export function ctxSire(
  o: Partial<ContextoAad> = {},
): ContextoAad & { tipo: "sire_api" } {
  return {
    tenantId: TENANT_A,
    clienteId: CLIENTE_1,
    ...o,
    tipo: "sire_api",
  } as ContextoAad & { tipo: "sire_api" };
}

export function ctxTipo(tipo: TipoCredencial, o: Partial<ContextoAad> = {}) {
  return { tenantId: TENANT_A, clienteId: CLIENTE_1, ...o, tipo };
}

/** Invierte 1 bit de una copia del búfer. */
export function voltearBit(buf: Buffer, byte: number, bit: number): Buffer {
  const copia = Buffer.from(buf);
  const i = byte < 0 ? copia.length + byte : byte;
  copia[i] = (copia[i] ?? 0) ^ (1 << bit);
  return copia;
}

/** Ejecuta fn (síncrona o asíncrona) y devuelve el error lanzado; falla si no lanza. */
export async function capturarError(
  fn: () => unknown | Promise<unknown>,
): Promise<Error> {
  let error: unknown;
  let lanzo = false;
  try {
    await fn();
  } catch (e) {
    lanzo = true;
    error = e;
  }
  expect(lanzo, "se esperaba un error y no se lanzó ninguno").toBe(true);
  return error as Error;
}

export async function esperarFalla<E extends Error>(
  fn: () => unknown | Promise<unknown>,
  Clase: new (...args: never[]) => E,
): Promise<E> {
  const error = await capturarError(fn);
  expect(error).toBeInstanceOf(Clase);
  return error as E;
}

/** KeyWrapper falso que registra cada DEK (hex) y devuelve 512 B como RSA-4096. */
export function wrapperEspia(kekId = "mock") {
  const deks: string[] = [];
  const wrapper: KeyWrapper = {
    kekId,
    async wrap(dek) {
      deks.push(Buffer.from(dek).toString("hex"));
      const salida = Buffer.alloc(512);
      Buffer.from(dek).copy(salida);
      return salida;
    },
    async verificar() {},
  };
  return { wrapper, deks };
}

const generar = promisify(generateKeyPair);

export interface ParLocal {
  rutaPublica: string;
  rutaPrivada: string;
  publicaPem: string;
  privadaPem: string;
}

export async function crearDirTemporal(): Promise<string> {
  return mkdtemp(join(tmpdir(), "contapp-crypto-"));
}

export async function borrarDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Genera un par RSA en `dir` (privada con modo 0600). */
export async function generarParRsa(
  dir: string,
  nombre: string,
  bits = 4096,
): Promise<ParLocal> {
  const { publicKey, privateKey } = await generar("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const rutaPublica = join(dir, `${nombre}-public.pem`);
  const rutaPrivada = join(dir, `${nombre}-private.pem`);
  await writeFile(rutaPublica, publicKey, { mode: 0o644 });
  await writeFile(rutaPrivada, privateKey, { mode: 0o600 });
  return {
    rutaPublica,
    rutaPrivada,
    publicaPem: publicKey,
    privadaPem: privateKey,
  };
}

/** Todas las formas en que un valor binario o de texto podría filtrarse a un texto. */
export function huellasDeFuga(valor: string | Buffer): string[] {
  const b = Buffer.isBuffer(valor) ? valor : Buffer.from(valor, "utf8");
  const formas = [
    b.toString("hex"),
    b.toString("base64"),
    b.toString("base64url"),
    [...b].map((x) => x.toString(16).padStart(2, "0")).join(" "),
    [...b].join(","),
  ];
  if (!Buffer.isBuffer(valor)) formas.push(valor);
  return formas;
}
