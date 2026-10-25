// Ronda adversarial 1b (spec 003, T14b), caja blanca sobre la rotación y el descifrado del worker con
// BD real de desarrollo (integracion: `pnpm --filter @contapp/worker test:int`, que carga ../../.env y ./.env; falla si faltan).
// Cada prueba afirma el comportamiento SEGURO esperado: si falla, es un hallazgo (tasks.md, T14b).
// Llaves `local` temporales (r1b-k1 retirada, r1b-k2 activa) o el fixture `mock`; nunca se imprimen.
import { cifrarCredencial, crearKeyWrapper, type Sobre, type TipoCredencial } from "@contapp/crypto";
import {
  Secreto,
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
  type KeyUnwrapper,
  type KeyWrapper,
} from "@contapp/crypto/descifrado";
import type { ContappDb } from "@contapp/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
} from "../test/bd.js";
import { ENV_MOCK, fugas, uuid, valorDe } from "../test/soporte.js";
import { crearServicioCredenciales } from "./credenciales/descifrar-credencial.js";
import { rotarKekTenant } from "./credenciales/rotar-kek.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const A = SEED.tenantA;
const KEKS = ["r1b-k1", "r1b-k2", "r1b-k3", "mock"];
const clientes: string[] = [];

let backend: ContappDb;
let worker: ContappDb;
let admin: ContappDb;
let dir: string;
let k1: ParLocal;
let k2: ParLocal;

const anteriorK1 = () => crearKeyUnwrapperAnterior({ kekId: "r1b-k1", rutaPrivada: k1.privada });
const activaK2 = () => crearKeyUnwrapper(envWorker(k2));
const iguales = (a: Buffer, b: Buffer) => Buffer.compare(a, b) === 0;

beforeAll(async () => {
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  admin = crearDbAdmin();
  dir = await directorioTemporal();
  [k1, k2] = await Promise.all([generarParLocal(dir, "r1b-k1"), generarParLocal(dir, "r1b-k2")]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await limpiar(admin, { clientes, kekIds: KEKS.filter((k) => k !== "mock") });
});

afterAll(async () => {
  await limpiar(admin, { clientes }).catch(() => undefined);
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
  if (dir) await borrarDirectorio(dir);
});

interface Sembrada {
  id: string;
  clienteId: string;
  sobre: Sobre;
}

async function sembrar(
  w: KeyWrapper,
  tipo: TipoCredencial = "sol",
  alterar: (s: Sobre) => Sobre = (s) => s,
): Promise<Sembrada> {
  const clienteId = uuid();
  clientes.push(clienteId);
  const sobre = alterar(await cifrarCredencial(w, { tenantId: A, clienteId, tipo }, valorDe(tipo, uuid().slice(0, 8)) as never));
  const id = await guardar(backend, A, clienteId, tipo, sobre);
  return { id, clienteId, sobre };
}

const sembrarK1 = (alterar?: (s: Sobre) => Sobre) =>
  sembrar(crearKeyWrapper(envBackend(k1)), "sol", alterar);

/** withTenant del worker que ejecuta `accion` justo antes de su llamada número `n`. */
function dbIntervenido(n: number, accion: () => Promise<void>): Pick<ContappDb, "withTenant"> {
  let llamadas = 0;
  return {
    withTenant: async (ctx, fn) => {
      llamadas += 1;
      if (llamadas === n) await accion();
      return worker.withTenant(ctx, fn);
    },
  };
}

describe("T14b · CAS de la rotación", () => {
  it("un UPDATE del backend que cambia solo kek_id entre la lectura y el CAS no queda pisado (CAS con kek_id = desde)", async () => {
    const x = await sembrarK1();
    // Llamada 1 = listar el lote; llamada 2 = transacción del CAS. Antes de la 2, el backend escribe.
    const db = dbIntervenido(2, async () => {
      await backend.withTenant({ tenantId: A }, (tx) =>
        tx.query("update credencial set kek_id = $2, updated_at = now() where id = $1", [x.id, "r1b-k3"]),
      );
    });
    const res = await rotarKekTenant({ db, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "r1b-k1" });
    const fila = (await instantanea(worker, A, [x.id])).get(x.id)!;
    expect(fila.kek_id, "la rotación pisó el kek_id escrito por el backend").toBe("r1b-k3");
    expect(iguales(fila.dek_envuelta, x.sobre.dekEnvuelta)).toBe(true);
    expect(res).toEqual({ reenvueltas: 0, omitidas: 1 });
  });
});

describe("T14b · una fila corrupta durante la rotación", () => {
  it("una sola dek_envuelta alterada no bloquea la rotación del resto del estudio (la KEK retirada se puede jubilar)", async () => {
    const sana1 = await sembrarK1();
    const corrupta = await sembrarK1((s) => {
      const d = Buffer.from(s.dekEnvuelta);
      d[100] = (d[100] ?? 0) ^ 0x01;
      return { ...s, dekEnvuelta: d };
    });
    const sana2 = await sembrarK1();
    let error: unknown;
    let res: unknown;
    try {
      res = await rotarKekTenant({ db: worker, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "r1b-k1", lote: 10 });
    } catch (e) {
      error = e;
    }
    const filas = await instantanea(worker, A, [sana1.id, corrupta.id, sana2.id]);
    // Seguro: las sanas pasan a k2; la corrupta queda intacta en k1 y se reporta como omitida.
    expect(
      [filas.get(sana1.id)!.kek_id, filas.get(sana2.id)!.kek_id],
      `rotación abortada por una fila corrupta (${(error as { codigo?: string } | undefined)?.codigo ?? "sin error"})`,
    ).toEqual(["r1b-k2", "r1b-k2"]);
    expect(filas.get(corrupta.id)!.kek_id).toBe("r1b-k1");
    expect(res).toEqual({ reenvueltas: 2, omitidas: 1 });
  });
});

describe("T14b · errores de pg con valores en la rotación", () => {
  it("un CHECK violado en el CAS (dek_envuelta > 1024 B) no filtra la DEK ni bytes de la fila y revierte el lote", async () => {
    const x = await sembrarK1();
    const y = await sembrarK1();
    const deks: Buffer[] = [];
    const real = activaK2();
    // Activa defectuosa: envuelve bien en apariencia pero devuelve 1100 B que contienen la DEK en claro.
    let ultima = Buffer.alloc(0);
    const defectuosa: KeyUnwrapper & KeyWrapper = {
      kekId: real.kekId,
      verificar: () => real.verificar(),
      async wrap(dek) {
        ultima = Buffer.from(dek);
        deks.push(Buffer.from(dek));
        return Buffer.concat([dek, Buffer.alloc(1100 - dek.length, 0x41)]);
      },
      async unwrap() {
        return Buffer.from(ultima);
      },
    };
    let error: unknown;
    try {
      await rotarKekTenant({ db: worker, anterior: anteriorK1(), activa: defectuosa, tenantId: A, desde: "r1b-k1", lote: 10 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(deks.length).toBeGreaterThan(0);
    expect(fugas(error, deks)).toEqual([]);
    expect(fugas(error, [x.sobre.ciphertext, x.sobre.dekEnvuelta, y.sobre.ciphertext])).toEqual([]);
    const filas = await instantanea(worker, A, [x.id, y.id]);
    for (const s of [x, y]) {
      expect(filas.get(s.id)!.kek_id).toBe("r1b-k1");
      expect(iguales(filas.get(s.id)!.dek_envuelta, s.sobre.dekEnvuelta)).toBe(true);
    }
  });
});

describe("T14b · fallo tras descifrar y auditar", () => {
  it("si el logger falla después del COMMIT, el Secreto se entrega o se destruye (no queda vivo sin dueño)", async () => {
    const x = await sembrar(crearKeyWrapper(ENV_MOCK), "sol");
    const destruir = vi.spyOn(Secreto.prototype, "destruir");
    const servicio = crearServicioCredenciales({
      db: worker,
      unwrapper: crearKeyUnwrapper(ENV_MOCK),
      logger: {
        log: () => {
          throw new Error("logger caído");
        },
        warn: () => undefined,
      },
    });
    let secreto: Secreto | undefined;
    let error: unknown;
    try {
      secreto = await servicio.descifrarCredencial({ tenantId: A }, x.id, "r1b:logger");
    } catch (e) {
      error = e;
    }
    if (secreto !== undefined) {
      secreto.destruir();
      return;
    }
    // El rechazo viene del logger tras un descifrado correcto (no de un fallo de descifrado).
    expect((error as Error).message).toBe("logger caído");
    expect(destruir, "el Secreto descifrado quedó en memoria sin entregarse ni destruirse").toHaveBeenCalled();
  });
});
