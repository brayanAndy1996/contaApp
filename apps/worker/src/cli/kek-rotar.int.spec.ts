import { crearKeyWrapper, cifrarCredencial } from "@contapp/crypto";
import type { TipoCredencial } from "@contapp/crypto";
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
import { main } from "./kek-rotar.js";

// `kek:rotar` con BD real y llaves `local` temporales (spec 003, CA-6). Contrato de `main` en kek-rotar.spec.ts.
// Requiere las migraciones 0005/0006 de T10 y DATABASE_URL/MIGRATIONS_DATABASE_URL (falla si faltan).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const A = SEED.tenantA;
const B = SEED.tenantB;

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
  [k1, k2] = await Promise.all([generarParLocal(dir, "k1"), generarParLocal(dir, "k2")]);
  await limpiar(admin, { kekIds: ["k1", "k2"] });
});

beforeEach(async () => {
  await limpiar(admin, { kekIds: ["k1", "k2"], clientes });
});

afterAll(async () => {
  await limpiar(admin, { kekIds: ["k1", "k2"], clientes }).catch(() => undefined);
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
  if (dir) await borrarDirectorio(dir);
});

async function sembrarK1(tenantId: string, n: number): Promise<string[]> {
  const w = crearKeyWrapper(envBackend(k1));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const clienteId = uuid();
    clientes.push(clienteId);
    const tipo: TipoCredencial = "sol";
    const sobre = await cifrarCredencial(w, { tenantId, clienteId, tipo }, { usuario: `u${i}`, clave: `k${i}` });
    ids.push(await guardar(backend, tenantId, clienteId, tipo, sobre));
  }
  return ids;
}

async function correr(argv: string[], envExtra: Record<string, string | undefined> = {}) {
  const salida: string[] = [];
  const codigo = await main(argv, { ...envWorker(k2), ...envExtra }, {
    db: worker,
    escribir: (l) => salida.push(l),
    escribirError: (l) => salida.push(l),
  });
  return { codigo, salida: salida.join("\n") };
}

const args = (tenants: string[], o: { desde?: string; privada?: string } = {}) => [
  "--desde",
  o.desde ?? "k1",
  "--privada-anterior",
  o.privada ?? k1.privada,
  ...tenants.flatMap((t) => ["--tenant", t]),
];

/** Quita UUID y nombres de KEK para buscar solo los numeros (conteos). */
const sinIds = (salida: string) =>
  salida.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").replace(/k\d+/g, "");

/** La salida solo trae conteos: sin llaves, rutas de llaves ni bloques largos de base64. */
function soloConteos(salida: string) {
  expect(salida).not.toContain("-----BEGIN");
  expect(salida).not.toContain(k1.privada);
  expect(salida).not.toContain(k2.privada);
  expect(salida).not.toMatch(/[A-Za-z0-9+/=_-]{40,}/);
  expect(salida).not.toMatch(/\n\s+at\s/);
}

describe("kek:rotar con BD real", () => {
  it("rota un estudio, imprime solo conteos y devuelve 0; la segunda corrida informa 0 cambios", async () => {
    const ids = await sembrarK1(A, 2);
    const r1 = await correr(args([A]));
    expect(r1.codigo).toBe(0);
    expect(sinIds(r1.salida)).toMatch(/\b2\b/); // 2 re-envueltas
    soloConteos(r1.salida);
    const tras = await instantanea(worker, A, ids);
    for (const id of ids) expect(tras.get(id)!.kek_id).toBe("k2");

    const r2 = await correr(args([A]));
    expect(r2.codigo).toBe(0);
    expect(sinIds(r2.salida)).not.toMatch(/\b[1-9]\d*\b/); // 0 re-envueltas y 0 omitidas
    soloConteos(r2.salida);
  });

  it("acepta varios --tenant (uno por estudio) y rota cada uno con su propio contexto", async () => {
    const deA = await sembrarK1(A, 2);
    const deB = await sembrarK1(B, 1);
    const r = await correr(args([A, B]));
    expect(r.codigo).toBe(0);
    expect(sinIds(r.salida)).toMatch(/\b2\b/);
    expect(sinIds(r.salida)).toMatch(/\b1\b/);
    soloConteos(r.salida);
    for (const id of deA) expect((await instantanea(worker, A, [id])).get(id)!.kek_id).toBe("k2");
    for (const id of deB) expect((await instantanea(worker, B, [id])).get(id)!.kek_id).toBe("k2");
  });

  it("`desde` igual a la KEK activa: error y ninguna fila cambia", async () => {
    const ids = await sembrarK1(A, 1);
    const antes = await instantanea(worker, A, ids);
    const r = await correr(args([A], { desde: "k2", privada: k2.privada }));
    expect(r.codigo).not.toBe(0);
    soloConteos(r.salida);
    const despues = await instantanea(worker, A, ids);
    expect(despues.get(ids[0]!)!.kek_id).toBe("k1");
    expect(Buffer.compare(despues.get(ids[0]!)!.dek_envuelta, antes.get(ids[0]!)!.dek_envuelta)).toBe(0);
  });

  it("llave anterior equivocada o inexistente: error sin material de llave y ninguna fila cambia", async () => {
    const ids = await sembrarK1(A, 2);
    const antes = await instantanea(worker, A, ids);
    for (const privada of [k2.privada, `${dir}/no-existe.pem`]) {
      const r = await correr(args([A], { privada }));
      expect(r.codigo).not.toBe(0);
      expect(r.salida).not.toContain("-----BEGIN");
      expect(r.salida).not.toMatch(/\n\s+at\s/);
    }
    const despues = await instantanea(worker, A, ids);
    for (const id of ids) {
      expect(despues.get(id)!.kek_id).toBe("k1");
      expect(Buffer.compare(despues.get(id)!.dek_envuelta, antes.get(id)!.dek_envuelta)).toBe(0);
    }
  });
});
