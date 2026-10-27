import { crearKeyWrapper, cifrarCredencial } from "@contapp/crypto";
import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  borrarDirectorio,
  crearDbAdmin,
  crearDbRol,
  directorioTemporal,
  envBackend,
  envWorker,
  generarParLocal,
  guardar,
  instantanea,
  limpiar,
  SEED,
  type ParLocal,
} from "../../test/bd.js";
import { uuid } from "../../test/soporte.js";
import { CODIGO_CORRUPTAS, main } from "./kek-rotar.js";

// T15 · F2 (decisión del usuario, opción A): una credencial corrupta no detiene `kek:rotar`; las demás
// se rotan, la corrupta queda en `desde`, su id se informa y el código de salida es CODIGO_CORRUPTAS.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const A = SEED.tenantA;
const B = SEED.tenantB;
const KEKS = ["f2c-k1", "f2c-k2"];

let backend: ContappDb;
let worker: ContappDb;
let admin: ContappDb;
let dir: string;
let k1: ParLocal;
let k2: ParLocal;
const clientes: string[] = [];

beforeAll(async () => {
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  admin = crearDbAdmin();
  dir = await directorioTemporal();
  [k1, k2] = await Promise.all([generarParLocal(dir, KEKS[0]!), generarParLocal(dir, KEKS[1]!)]);
  await limpiar(admin, { kekIds: KEKS });
});

beforeEach(async () => {
  await limpiar(admin, { kekIds: KEKS, clientes });
});

afterAll(async () => {
  await limpiar(admin, { kekIds: KEKS, clientes }).catch(() => undefined);
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
  if (dir) await borrarDirectorio(dir);
});

async function sembrar(tenantId: string, corrupta = false): Promise<string> {
  const clienteId = uuid();
  clientes.push(clienteId);
  const sobre = await cifrarCredencial(crearKeyWrapper(envBackend(k1)), { tenantId, clienteId, tipo: "sol" }, {
    usuario: "u",
    clave: "c",
  });
  if (corrupta) {
    const d = Buffer.from(sobre.dekEnvuelta);
    d[100] = (d[100] ?? 0) ^ 0x01;
    return guardar(backend, tenantId, clienteId, "sol", { ...sobre, dekEnvuelta: d });
  }
  return guardar(backend, tenantId, clienteId, "sol", sobre);
}

async function correr(tenants: string[], privada = k1.privada) {
  const salida: string[] = [];
  const errores: string[] = [];
  const codigo = await main(
    ["--desde", KEKS[0]!, "--privada-anterior", privada, ...tenants.flatMap((t) => ["--tenant", t])],
    envWorker(k2),
    { db: worker, escribir: (l) => salida.push(l), escribirError: (l) => errores.push(l) },
  );
  return { codigo, salida: salida.join("\n"), errores: errores.join("\n") };
}

describe("kek:rotar con credenciales corruptas (T15 · F2)", () => {
  it("rota las sanas de todos los estudios, deja la corrupta en `desde`, informa su id y sale con CODIGO_CORRUPTAS", async () => {
    const sana = await sembrar(A);
    const corrupta = await sembrar(A, true);
    const deB = await sembrar(B);
    const r = await correr([A, B]);

    expect(CODIGO_CORRUPTAS).toBe(3);
    expect(r.codigo).toBe(CODIGO_CORRUPTAS);
    expect(r.salida).toContain(`estudio ${A}: reenvueltas 1, omitidas 1, corruptas 1`);
    expect(r.salida).toContain(`estudio ${B}: reenvueltas 1, omitidas 0, corruptas 0`);
    expect(r.salida).toContain("total: reenvueltas 2, omitidas 1, corruptas 1");
    expect(r.errores).toContain(corrupta);
    expect(r.errores).not.toContain(sana);
    expect(r.errores).toContain("[corruptas]");
    expect(r.errores).toMatch(/anterior sigue siendo necesaria/);
    for (const texto of [r.salida, r.errores]) {
      expect(texto).not.toContain("-----BEGIN");
      expect(texto).not.toContain(k1.privada);
      expect(texto).not.toMatch(/[A-Za-z0-9+/=_]{40,}/);
    }

    expect((await instantanea(worker, A, [sana])).get(sana)!.kek_id).toBe(KEKS[1]);
    expect((await instantanea(worker, B, [deB])).get(deB)!.kek_id).toBe(KEKS[1]);
    expect((await instantanea(worker, A, [corrupta])).get(corrupta)!.kek_id).toBe(KEKS[0]);

    // La siguiente corrida (con una credencial nueva en `desde`) sigue alertando mientras la corrupta exista.
    const nueva = await sembrar(A);
    const r2 = await correr([A]);
    expect(r2.codigo).toBe(CODIGO_CORRUPTAS);
    expect(r2.salida).toContain(`estudio ${A}: reenvueltas 1, omitidas 1, corruptas 1`);
    expect((await instantanea(worker, A, [nueva])).get(nueva)!.kek_id).toBe(KEKS[1]);
  });

  it("si solo quedan corruptas no se distingue de una llave equivocada: falla cerrado con 1 y avisa que la anterior sigue necesaria", async () => {
    const corrupta = await sembrar(A, true);
    const r = await correr([A]);
    expect(r.codigo).toBe(1);
    expect(r.errores).toContain("[anterior_no_abre]");
    expect(r.errores).toMatch(/anterior sigue siendo necesaria/);
    expect((await instantanea(worker, A, [corrupta])).get(corrupta)!.kek_id).toBe(KEKS[0]);
  });

  it("si ninguna fila abre con la llave anterior (llave equivocada) falla cerrado con 1, sin listar corruptas ni escribir", async () => {
    const x = await sembrar(A);
    const y = await sembrar(A);
    const antes = await instantanea(worker, A, [x, y]);
    const r = await correr([A], k2.privada);
    expect(r.codigo).toBe(1);
    expect(r.errores).toContain("[anterior_no_abre]");
    expect(r.errores).not.toContain(x);
    expect(r.errores).not.toContain(y);
    const despues = await instantanea(worker, A, [x, y]);
    for (const id of [x, y]) {
      expect(despues.get(id)!.kek_id).toBe(KEKS[0]);
      expect(Buffer.compare(despues.get(id)!.dek_envuelta, antes.get(id)!.dek_envuelta)).toBe(0);
    }
  });
});
