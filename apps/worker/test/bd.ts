// Soporte de las pruebas de integracion del worker (spec 003, T7): conexiones por rol, limpieza con el
// rol administrativo, llaves `local` temporales y lecturas crudas para comparar columnas del sobre.
// Solo usa DATABASE_URL, MIGRATIONS_DATABASE_URL y @contapp/db; nunca imprime URLs ni llaves.
import { generateKeyPair } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Sobre, TipoCredencial } from "@contapp/crypto";
import { createDb, guardarSobre, SEED } from "@contapp/db";
import type { ContappDb } from "@contapp/db";

export { SEED };

export function crearDbRol(rolApp: "contapp_backend" | "contapp_worker"): ContappDb {
  return createDb({ rolApp, poolMax: 4 });
}

/** Conexion administrativa (MIGRATIONS_DATABASE_URL): solo para sembrar/limpiar y leer la auditoria. */
export function crearDbAdmin(): ContappDb {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de integracion");
  return createDb({ rolApp: "contapp_worker", url, poolMax: 2 });
}

export interface FilaAuditoria {
  tenant_id: string;
  credencial_id: string;
  cliente_id: string | null;
  tipo: string | null;
  motivo: string;
  resultado: string;
  created_at: Date;
}

export async function auditoriasDe(admin: ContappDb, credencialId: string): Promise<FilaAuditoria[]> {
  const r = await admin.pool.query(
    "select tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at from auditoria_descifrado where credencial_id = $1 order by created_at, id",
    [credencialId],
  );
  return r.rows as FilaAuditoria[];
}

/** Borra credenciales (por cliente o por kek_id) y su auditoria con el rol administrativo. */
export async function limpiar(
  admin: ContappDb,
  o: { clientes?: string[]; credenciales?: string[]; kekIds?: string[] } = {},
): Promise<void> {
  const clientes = o.clientes ?? [];
  const ids = o.credenciales ?? [];
  const keks = o.kekIds ?? [];
  await admin.pool.query(
    "delete from auditoria_descifrado where credencial_id = any($1::uuid[]) or cliente_id = any($2::uuid[]) or credencial_id in (select id from credencial where kek_id = any($3::text[]) or cliente_id = any($2::uuid[]))",
    [ids, clientes, keks],
  );
  await admin.pool.query("delete from credencial where cliente_id = any($1::uuid[]) or kek_id = any($2::text[])", [
    clientes,
    keks,
  ]);
}

/** Guarda el sobre con `contapp_backend` (la unica via de escritura de la app) y devuelve el id. */
export async function guardar(
  backend: ContappDb,
  tenantId: string,
  clienteId: string,
  tipo: TipoCredencial,
  sobre: Sobre,
): Promise<string> {
  const r = await backend.withTenant({ tenantId }, (tx) => guardarSobre(tx as never, { clienteId, tipo, sobre }));
  return r.id;
}

export interface FilaBruta {
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dek_envuelta: Buffer;
  kek_id: string;
  updated_at: Date;
}

/** Lee las columnas del sobre con `contapp_worker` (unico rol que puede), dentro de su tenant. */
export async function instantanea(worker: ContappDb, tenantId: string, ids: string[]): Promise<Map<string, FilaBruta>> {
  const r = await worker.withTenant({ tenantId }, (tx) =>
    tx.query(
      "select id, ciphertext, nonce, tag, dek_envuelta, kek_id, updated_at from credencial where id = any($1::uuid[]) order by id",
      [ids],
    ),
  );
  return new Map((r.rows as FilaBruta[]).map((f) => [f.id, f]));
}

// ---------- llaves `local` temporales (RSA 4096, tarda: generarlas una sola vez por archivo) ----------

export interface ParLocal {
  kekId: string;
  publica: string;
  privada: string;
}

export async function directorioTemporal(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "contapp-t7-"));
}

export async function borrarDirectorio(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function generarParLocal(dir: string, kekId: string): Promise<ParLocal> {
  const generar = promisify(generateKeyPair);
  const { publicKey, privateKey } = await generar("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publica = path.join(dir, `${kekId}-public.pem`);
  const privada = path.join(dir, `${kekId}-private.pem`);
  await writeFile(publica, publicKey, { mode: 0o644 });
  await writeFile(privada, privateKey, { mode: 0o600 });
  return { kekId, publica, privada };
}

/** Entorno del backend: solo la llave publica. */
export const envBackend = (p: ParLocal): Record<string, string> => ({
  KEY_PROVIDER: "local",
  KEK_ID: p.kekId,
  KEK_PUBLIC_KEY_PATH: p.publica,
  NODE_ENV: "test",
});

/** Entorno del worker: solo la privada activa (la publica se deriva de ella). */
export const envWorker = (p: ParLocal): Record<string, string> => ({
  KEY_PROVIDER: "local",
  KEK_ID: p.kekId,
  KEK_PRIVATE_KEY_PATH: p.privada,
  NODE_ENV: "test",
});
