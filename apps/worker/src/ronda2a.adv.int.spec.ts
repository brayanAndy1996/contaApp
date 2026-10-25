// Ronda adversarial 2a (spec 003, T16a), caja blanca con BD real de desarrollo (integracion:
// `pnpm --filter @contapp/worker test:int`, que carga ../../.env y ./.env; falla si faltan). Reintenta por
// otra vía los hallazgos F2, F3 y F6 de la ronda 1 ya corregidos. Cada prueba afirma el comportamiento
// SEGURO esperado: si falla, es un hallazgo (tasks.md, T16a). Llaves `local` temporales (r2a-k1 retirada,
// r2a-k2 activa) o el fixture `mock`; nunca se imprimen.
import { cifrarCredencial, crearKeyWrapper, type Sobre } from "@contapp/crypto";
import { Secreto, crearKeyUnwrapper, crearKeyUnwrapperAnterior } from "@contapp/crypto/descifrado";
import { reemplazarDekEnvuelta, type ContappDb } from "@contapp/db";
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
import { ENV_MOCK, uuid, valorDe } from "../test/soporte.js";
import { crearServicioCredenciales } from "./credenciales/descifrar-credencial.js";
import { rotarKekTenantDetalle } from "./credenciales/rotar-kek.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const A = SEED.tenantA;
const KEKS = ["r2a-k1", "r2a-k2", "r2a-k3"];
const clientes: string[] = [];

let backend: ContappDb;
let worker: ContappDb;
let admin: ContappDb;
let dir: string;
let k1: ParLocal;
let k2: ParLocal;

const anteriorK1 = () => crearKeyUnwrapperAnterior({ kekId: "r2a-k1", rutaPrivada: k1.privada });
const activaK2 = () => crearKeyUnwrapper(envWorker(k2));

beforeAll(async () => {
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  admin = crearDbAdmin();
  dir = await directorioTemporal();
  [k1, k2] = await Promise.all([generarParLocal(dir, "r2a-k1"), generarParLocal(dir, "r2a-k2")]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await limpiar(admin, { clientes, kekIds: KEKS });
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

/** Cifra y guarda una credencial `sol` del estudio A con `w` (el backend), alterando el sobre si se pide. */
async function sembrar(
  w: ReturnType<typeof crearKeyWrapper>,
  alterar: (s: Sobre) => Sobre = (s) => s,
): Promise<Sembrada> {
  const clienteId = uuid();
  clientes.push(clienteId);
  const tipo = "sol" as const;
  const sobre = alterar(
    await cifrarCredencial(w, { tenantId: A, clienteId, tipo }, valorDe(tipo, uuid().slice(0, 8))),
  );
  const id = await guardar(backend, A, clienteId, tipo, sobre);
  return { id, clienteId, sobre };
}

const sembrarK1 = (alterar?: (s: Sobre) => Sobre) => sembrar(crearKeyWrapper(envBackend(k1)), alterar);

/** Corrompe un bit de la DEK envuelta: la fila deja de abrir con la KEK anterior. */
const corromper = (s: Sobre): Sobre => {
  const d = Buffer.from(s.dekEnvuelta);
  d[100] = (d[100] ?? 0) ^ 0x01;
  return { ...s, dekEnvuelta: d };
};

describe("T16a · F3 por otra vía: CAS de reemplazarDekEnvuelta sin kekAnterior", () => {
  it("sin kekAnterior, la rotación no pisa un kek_id que el backend escribió tras la lectura", async () => {
    const x = await sembrarK1();
    // El backend re-etiqueta la fila (kek_id) después de que el worker la leyera con dek_envuelta vigente.
    await backend.withTenant({ tenantId: A }, (tx) =>
      tx.query("update credencial set kek_id = $2, updated_at = now() where id = $1", [x.id, "r2a-k3"]),
    );
    // El contrato de tests/aislamiento/credencial.spec.ts llama sin kekAnterior: el CAS solo compara dek_envuelta.
    const aplicado = await worker.withTenant({ tenantId: A }, (tx) =>
      reemplazarDekEnvuelta(tx, {
        id: x.id,
        dekAnterior: x.sobre.dekEnvuelta,
        dekNueva: Buffer.alloc(512, 7),
        kekNuevo: "r2a-k2",
      }),
    );
    const fila = (await instantanea(worker, A, [x.id])).get(x.id)!;
    expect(aplicado, "el CAS sin kekAnterior aceptó pisar una fila re-etiquetada por el backend").toBe(false);
    expect(fila.kek_id, "la rotación pisó el kek_id escrito por el backend").toBe("r2a-k3");
  });
});

describe("T16a · F6 por otra vía: logger que rechaza de forma asíncrona tras el COMMIT", () => {
  it("el Secreto no se entrega sin destruirse cuando el logger falla de forma asíncrona", async () => {
    const x = await sembrar(crearKeyWrapper(ENV_MOCK));
    const destruir = vi.spyOn(Secreto.prototype, "destruir");
    const servicio = crearServicioCredenciales({
      db: worker,
      unwrapper: crearKeyUnwrapper(ENV_MOCK),
      logger: {
        log: () => {
          // Rechazo asíncrono: no lanza en la llamada. Se marca como manejado en la propia prueba para no
          // contaminar la ejecución; el servicio debería esperarlo o tratarlo como el fallo síncrono de F6.
          const rechazo = Promise.reject(new Error("logger caído (asíncrono)"));
          rechazo.catch(() => undefined);
          return rechazo as unknown as void;
        },
        warn: () => undefined,
      },
    });
    let secreto: Secreto | undefined;
    let error: unknown;
    try {
      secreto = await servicio.descifrarCredencial({ tenantId: A }, x.id, "r2a:logger-asincrono");
    } catch (e) {
      error = e;
    }
    // Se mira antes de la limpieza de la prueba, que también llama a destruir().
    const destruidoPorServicio = destruir.mock.calls.length > 0;
    secreto?.destruir();
    expect(error, "el Secreto se entregó aunque el logger falló de forma asíncrona").toBeInstanceOf(Error);
    expect(destruidoPorServicio, "el Secreto quedó vivo sin dueño tras el fallo del logger").toBe(true);
  });
});

describe("T16a · F2 por otra vía: más filas corruptas que el lote", () => {
  it("con lote 1 y dos filas corruptas, las sanas se rotan igual y las corruptas se reportan por id", async () => {
    const c1 = await sembrarK1(corromper);
    const c2 = await sembrarK1(corromper);
    const h1 = await sembrarK1();
    const h2 = await sembrarK1();
    const res = await rotarKekTenantDetalle({
      db: worker,
      anterior: anteriorK1(),
      activa: activaK2(),
      tenantId: A,
      desde: "r2a-k1",
      lote: 1,
    });
    const filas = await instantanea(worker, A, [c1.id, c2.id, h1.id, h2.id]);
    expect(
      [filas.get(h1.id)!.kek_id, filas.get(h2.id)!.kek_id],
      "filas sanas sin rotar detrás de las corruptas",
    ).toEqual(["r2a-k2", "r2a-k2"]);
    expect([filas.get(c1.id)!.kek_id, filas.get(c2.id)!.kek_id]).toEqual(["r2a-k1", "r2a-k1"]);
    expect(res.reenvueltas).toBe(2);
    expect(res.omitidas).toBe(2);
    expect(new Set(res.corruptas)).toEqual(new Set([c1.id, c2.id]));
  });
});
