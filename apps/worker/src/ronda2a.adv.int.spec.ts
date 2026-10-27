// Ronda adversarial 2a (spec 003, T16a), caja blanca con BD real de desarrollo (integracion:
// `pnpm --filter @contapp/worker test:int`, que carga ../../.env y ./.env; falla si faltan). Reintenta por
// otra vía los hallazgos F2, F3 y F6 de la ronda 1 ya corregidos. Cada prueba afirma el comportamiento
// SEGURO esperado: si falla, es un hallazgo (tasks.md, T16a). Llaves `local` temporales (r2a-k1 retirada,
// r2a-k2 activa) o el fixture `mock`; nunca se imprimen.
import { cifrarCredencial, crearKeyWrapper, type Sobre } from "@contapp/crypto";
import {
  Secreto,
  SecretoDestruidoError,
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
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

// Revisión T16a (opus): la versión anterior llamaba a reemplazarDekEnvuelta SIN kekAnterior, cosa que la
// rotación nunca hace (rotar-kek.ts siempre pasa `desde`); el parámetro es opcional a propósito (T15 · F3,
// contrato de tests/aislamiento). Era un falso positivo. Ahora ataca F3 por la vía real y con concurrencia
// verdadera: el backend tiene la fila bloqueada (UPDATE sin confirmar) mientras corre el CAS de la rotación.
describe("T16a · F3 por otra vía: UPDATE concurrente del backend con la fila bloqueada durante el CAS", () => {
  it("la rotación espera el bloqueo y, tras el COMMIT del backend, no pisa su kek_id (re-evalúa el CAS)", async () => {
    const x = await sembrarK1();
    let liberar!: () => void;
    const bloqueo = new Promise<void>((r) => (liberar = r));
    let marcarBloqueada!: () => void;
    const bloqueada = new Promise<void>((r) => (marcarBloqueada = r));
    let txBackend: Promise<unknown> | undefined;
    let llamadas = 0;
    // Llamada 1 = listar; llamada 2 = transacción del CAS. Antes de la 2, el backend abre su transacción,
    // re-etiqueta la fila y la mantiene bloqueada; la confirma 300 ms después (con el CAS ya esperando).
    const db: Pick<ContappDb, "withTenant"> = {
      withTenant: async (ctx, fn) => {
        llamadas += 1;
        if (llamadas === 2) {
          txBackend = backend.withTenant({ tenantId: A }, async (tx) => {
            await tx.query("update credencial set kek_id = $2, updated_at = now() where id = $1", [x.id, "r2a-k3"]);
            marcarBloqueada();
            await bloqueo;
          });
          await bloqueada;
          setTimeout(liberar, 300);
        }
        return worker.withTenant(ctx, fn);
      },
    };
    const res = await rotarKekTenantDetalle({ db, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "r2a-k1" });
    await txBackend;
    const fila = (await instantanea(worker, A, [x.id])).get(x.id)!;
    expect(fila.kek_id, "la rotación pisó el kek_id escrito por el backend en paralelo").toBe("r2a-k3");
    expect(Buffer.compare(fila.dek_envuelta, x.sobre.dekEnvuelta)).toBe(0);
    expect(res).toEqual({ reenvueltas: 0, omitidas: 1, corruptas: [] });
  });
});

// Revisión T16a (opus): la versión anterior exigía que un logger con rechazo ASÍNCRONO impidiera entregar el
// Secreto. Era un falso positivo: `LoggerCredenciales.log` es síncrono (`void`) y, si no lanza, el Secreto se
// ENTREGA a su dueño (el llamador), que es lo contrario de F6 ("ni se entrega ni se destruye"). El rechazo
// sin manejar es un defecto del logger, no una fuga. Ahora ataca F6 por otra vía síncrona: `log` es un
// getter que lanza un valor que no es Error, y se comprueba que el Secreto quedó realmente inservible.
describe("T16a · F6 por otra vía: logger cuyo acceso a `log` lanza un valor que no es Error", () => {
  it("el Secreto no se entrega y queda destruido de verdad (usar() lanza SecretoDestruidoError)", async () => {
    const x = await sembrar(crearKeyWrapper(ENV_MOCK));
    const destruir = vi.spyOn(Secreto.prototype, "destruir");
    const logger = {
      get log(): () => void {
        const valor: unknown = "logger caído (no es Error)";
        throw valor;
      },
      warn: () => undefined,
    };
    const servicio = crearServicioCredenciales({ db: worker, unwrapper: crearKeyUnwrapper(ENV_MOCK), logger });
    let secreto: Secreto | undefined;
    let error: unknown;
    try {
      secreto = await servicio.descifrarCredencial({ tenantId: A }, x.id, "r2a:logger-getter");
    } catch (e) {
      error = e;
    }
    const instancias = destruir.mock.contexts as Secreto[];
    secreto?.destruir();
    expect(secreto, "el Secreto se entregó aunque el logger falló").toBeUndefined();
    expect(error).toBe("logger caído (no es Error)");
    expect(instancias.length, "el Secreto quedó vivo sin dueño tras el fallo del logger").toBeGreaterThan(0);
    for (const s of instancias) {
      expect(() => s.usar(() => undefined)).toThrow(SecretoDestruidoError);
    }
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
