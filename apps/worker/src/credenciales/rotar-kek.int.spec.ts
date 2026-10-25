import { readFileSync } from "node:fs";
import { crearKeyWrapper, cifrarCredencial, CryptoError, KeyProviderError } from "@contapp/crypto";
import type { Sobre, TipoCredencial } from "@contapp/crypto";
import { crearKeyUnwrapper, crearKeyUnwrapperAnterior } from "@contapp/crypto/descifrado";
import type { KeyUnwrapper } from "@contapp/crypto/descifrado";
import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditoriasDe,
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
  type FilaBruta,
  type ParLocal,
} from "../../test/bd.js";
import { fugas, loggerEspia, rechazo, uuid, valorDe } from "../../test/soporte.js";
import { crearServicioCredenciales } from "./descifrar-credencial.js";
import { rotarKekTenant } from "./rotar-kek.js";

// Rotacion de KEK con BD real y llaves `local` temporales k1 (retirada) y k2 (activa). Spec 003, CA-6, CA-7, CA-9.
// Contrato para T12:
// - `rotarKekTenant({ db, anterior, activa, tenantId, desde, lote })` resuelve `{ reenvueltas, omitidas }` (solo esas claves);
// - cambia solo `dek_envuelta` y `kek_id` (y `updated_at`); un lote confirmado queda aunque el siguiente falle;
// - un fallo del proveedor rechaza con un error reintentable (`reintentable: true`) y revierte solo el lote en curso;
// - `UPDATE ... WHERE id AND kek_id = desde AND dek_envuelta = <leida>`: si el backend escribio entre medias, gana
//   el backend y la fila se cuenta como `omitidas`;
// - `desde` debe ser igual a `anterior.kekId` y distinto de `activa.kekId`.
// Requiere las migraciones 0005/0006 de T10 y DATABASE_URL/MIGRATIONS_DATABASE_URL (falla si faltan).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const A = SEED.tenantA;
const B = SEED.tenantB;
const MOTIVO = "prueba:rotacion";

let backend: ContappDb;
let worker: ContappDb;
let admin: ContappDb;
let dir: string;
let k1: ParLocal;
let k2: ParLocal;
let envenenar: string[] = []; // trozos de las llaves privadas que no deben aparecer en errores
const clientes: string[] = [];

const envolverK1 = () => crearKeyWrapper(envBackend(k1));
const envolverK2 = () => crearKeyWrapper(envBackend(k2));
const activaK2 = () => crearKeyUnwrapper(envWorker(k2));
const anteriorK1 = () => crearKeyUnwrapperAnterior({ kekId: "k1", rutaPrivada: k1.privada });

beforeAll(async () => {
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  admin = crearDbAdmin();
  dir = await directorioTemporal();
  [k1, k2] = await Promise.all([generarParLocal(dir, "k1"), generarParLocal(dir, "k2")]);
  envenenar = [k1, k2].flatMap((p) =>
    readFileSync(p.privada, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.length > 20 && !l.startsWith("-----"))
      .slice(0, 3),
  );
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

interface Sembrada {
  id: string;
  clienteId: string;
  tipo: TipoCredencial;
  valor: Record<string, string>;
  sobre: Sobre;
}

async function sembrarK1(tenantId: string, tipos: TipoCredencial[]): Promise<Sembrada[]> {
  const w = envolverK1();
  const salida: Sembrada[] = [];
  for (const tipo of tipos) {
    const clienteId = uuid();
    clientes.push(clienteId);
    const valor = valorDe(tipo, uuid().slice(0, 8)) as Record<string, string>;
    const sobre = await cifrarCredencial(w, { tenantId, clienteId, tipo }, valor as never);
    expect(sobre.kekId).toBe("k1");
    const id = await guardar(backend, tenantId, clienteId, tipo, sobre);
    salida.push({ id, clienteId, tipo, valor, sobre });
  }
  return salida;
}

const ids = (xs: Sembrada[]) => xs.map((x) => x.id);

/** Unwrapper anterior que anota las DEK y puede fallar o intervenir en una llamada concreta. */
function anteriorEspia(o: { fallaEn?: number; antes?: (dekEnvuelta: Buffer, n: number) => Promise<void> } = {}) {
  const real = anteriorK1();
  const deks: Buffer[] = [];
  let n = 0;
  const u: KeyUnwrapper = {
    kekId: real.kekId,
    verificar: () => real.verificar(),
    async unwrap(dekEnvuelta, kekId) {
      n += 1;
      await o.antes?.(dekEnvuelta, n);
      if (o.fallaEn === n) throw new (KeyProviderError as unknown as new () => Error)();
      const dek = await real.unwrap(dekEnvuelta, kekId);
      deks.push(Buffer.from(dek));
      return dek;
    },
  };
  return { u, deks, llamadas: () => n };
}

async function secretoDe(tenantId: string, id: string, unwrapper: KeyUnwrapper = activaK2()) {
  const { descifrarCredencial } = crearServicioCredenciales({
    db: worker as never,
    unwrapper,
    logger: loggerEspia().logger as never,
  });
  return (await descifrarCredencial({ tenantId }, id, MOTIVO)).usar((v) => ({ ...v }));
}

const iguales = (a: Buffer, b: Buffer) => Buffer.compare(a, b) === 0;
function soloCambiaLaDek(antes: FilaBruta, despues: FilaBruta) {
  expect(iguales(antes.ciphertext, despues.ciphertext)).toBe(true);
  expect(iguales(antes.nonce, despues.nonce)).toBe(true);
  expect(iguales(antes.tag, despues.tag)).toBe(true);
  expect(iguales(antes.dek_envuelta, despues.dek_envuelta)).toBe(false);
  expect(antes.kek_id).toBe("k1");
  expect(despues.kek_id).toBe("k2");
}

describe("CA-6: rotacion k1 -> k2", () => {
  it("re-envuelve solo dek_envuelta y kek_id; el descifrado con k2 devuelve los secretos originales; no toca a otros estudios", async () => {
    const delA = await sembrarK1(A, ["sol", "sol", "sire_api"]);
    const [deB] = await sembrarK1(B, ["sol"]);
    const antes = await instantanea(worker, A, ids(delA));
    const antesB = await instantanea(worker, B, [deB!.id]);

    const res = await rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k1", lote: 2 });
    expect(Object.keys(res).sort()).toEqual(["omitidas", "reenvueltas"]);
    expect(res).toEqual({ reenvueltas: 3, omitidas: 0 });

    const despues = await instantanea(worker, A, ids(delA));
    for (const x of delA) soloCambiaLaDek(antes.get(x.id)!, despues.get(x.id)!);
    for (const x of delA) expect(await secretoDe(A, x.id)).toEqual(x.valor);

    const despuesB = await instantanea(worker, B, [deB!.id]);
    expect(despuesB.get(deB!.id)!.kek_id).toBe("k1");
    expect(iguales(despuesB.get(deB!.id)!.dek_envuelta, antesB.get(deB!.id)!.dek_envuelta)).toBe(true);
  });

  it("es idempotente: la segunda corrida no cambia nada", async () => {
    const delA = await sembrarK1(A, ["sol", "sire_api"]);
    await rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k1", lote: 10 });
    const tras1 = await instantanea(worker, A, ids(delA));
    const res = await rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k1" });
    expect(res).toEqual({ reenvueltas: 0, omitidas: 0 });
    const tras2 = await instantanea(worker, A, ids(delA));
    for (const x of delA) {
      const a = tras1.get(x.id)!;
      const b = tras2.get(x.id)!;
      expect(iguales(a.dek_envuelta, b.dek_envuelta)).toBe(true);
      expect(a.kek_id).toBe(b.kek_id);
    }
  });

  it("se interrumpe por proveedor caido a mitad: el lote confirmado queda, el resto sigue en k1, y se reanuda", async () => {
    const delA = await sembrarK1(A, ["sol", "sol", "sire_api"]);
    const antes = await instantanea(worker, A, ids(delA));

    const fallando = anteriorEspia({ fallaEn: 2 });
    const e = await rechazo(() =>
      rotarKekTenant({ db: worker as never, anterior: fallando.u, activa: activaK2(), tenantId: A, desde: "k1", lote: 1 }),
    );
    expect(e).toBeInstanceOf(CryptoError);
    expect(e.reintentable).toBe(true);
    expect(fugas(e, [...fallando.deks, ...envenenar])).toEqual([]);

    const medio = await instantanea(worker, A, ids(delA));
    const enK2 = delA.filter((x) => medio.get(x.id)!.kek_id === "k2");
    const enK1 = delA.filter((x) => medio.get(x.id)!.kek_id === "k1");
    expect(enK2).toHaveLength(1); // el lote 1 se confirmo
    expect(enK1).toHaveLength(2); // el lote en curso se revirtio; nada a medias
    for (const x of enK1) expect(iguales(medio.get(x.id)!.dek_envuelta, antes.get(x.id)!.dek_envuelta)).toBe(true);
    for (const x of enK2) soloCambiaLaDek(antes.get(x.id)!, medio.get(x.id)!);

    const sano = anteriorEspia();
    const res = await rotarKekTenant({ db: worker as never, anterior: sano.u, activa: activaK2(), tenantId: A, desde: "k1", lote: 1 });
    expect(res).toEqual({ reenvueltas: 2, omitidas: 0 });
    const fin = await instantanea(worker, A, ids(delA));
    for (const x of delA) {
      expect(fin.get(x.id)!.kek_id).toBe("k2");
      expect(await secretoDe(A, x.id)).toEqual(x.valor);
    }
    expect(await rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k1" })).toEqual({
      reenvueltas: 0,
      omitidas: 0,
    });
  });

  it("un UPDATE del backend entre la lectura y el CAS gana: la fila se omite y el secreto nuevo sobrevive", async () => {
    const delA = await sembrarK1(A, ["sol", "sol"]);
    const nuevoValor = { usuario: "nuevo-del-backend", clave: "nueva-clave" };
    let pisada: { id: string; sobre: Sobre } | undefined;

    const intervenido = anteriorEspia({
      antes: async (dekEnvuelta, n) => {
        if (n !== 1) return;
        const victima = delA.find((x) => iguales(x.sobre.dekEnvuelta, dekEnvuelta));
        expect(victima).toBeDefined();
        const sobre = await cifrarCredencial(envolverK1(), { tenantId: A, clienteId: victima!.clienteId, tipo: "sol" }, nuevoValor);
        await guardar(backend, A, victima!.clienteId, "sol", sobre); // commit en otra conexion
        pisada = { id: victima!.id, sobre };
      },
    });
    const res = await rotarKekTenant({ db: worker as never, anterior: intervenido.u, activa: activaK2(), tenantId: A, desde: "k1", lote: 2 });
    expect(pisada).toBeDefined();
    expect(res).toEqual({ reenvueltas: 1, omitidas: 1 });

    const fila = (await instantanea(worker, A, [pisada!.id])).get(pisada!.id)!;
    expect(fila.kek_id).toBe("k1");
    expect(iguales(fila.dek_envuelta, pisada!.sobre.dekEnvuelta)).toBe(true);
    expect(iguales(fila.ciphertext, pisada!.sobre.ciphertext)).toBe(true);

    // la siguiente corrida la rota y el secreto que queda es el del backend, no el viejo
    expect(await rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k1" })).toEqual({
      reenvueltas: 1,
      omitidas: 0,
    });
    expect(await secretoDe(A, pisada!.id)).toEqual(nuevoValor);
  });

  it("los cifrados nuevos usan k2 y el worker (k2 activa) los descifra", async () => {
    const clienteId = uuid();
    clientes.push(clienteId);
    const valor = { clientId: "id-nuevo", clientSecret: "sec-nuevo" };
    const sobre = await cifrarCredencial(envolverK2(), { tenantId: A, clienteId, tipo: "sire_api" }, valor);
    expect(sobre.kekId).toBe("k2");
    const id = await guardar(backend, A, clienteId, "sire_api", sobre);
    expect((await instantanea(worker, A, [id])).get(id)!.kek_id).toBe("k2");
    expect(await secretoDe(A, id)).toEqual(valor);
  });

  it("antes de rotar, un sobre con k1 falla cerrado con k2 activa (reintentable, 'llave'); despues de rotar se descifra", async () => {
    const [x] = await sembrarK1(A, ["sol"]);
    const e = await rechazo(() => secretoDe(A, x!.id));
    expect(e.reintentable).toBe(true);
    expect((await auditoriasDe(admin, x!.id)).map((f) => f.resultado)).toEqual(["llave"]);
    await rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k1" });
    expect(await secretoDe(A, x!.id)).toEqual(x!.valor);
  });
});

describe("CA-6/CA-7: kek_id desconocido o retirado falla cerrado", () => {
  it("un sobre con un kek_id que nadie conoce no se descifra ni se rota", async () => {
    const [x] = await sembrarK1(A, ["sol"]);
    const ajeno = { ...x!.sobre, kekId: "k9" };
    await guardar(backend, A, x!.clienteId, "sol", ajeno);
    const e = await rechazo(() => secretoDe(A, x!.id));
    expect(e.reintentable).toBe(true);
    // rotar `desde: k9` con la llave de k1 como anterior: `desde` no coincide con anterior.kekId
    await rechazo(() =>
      rotarKekTenant({ db: worker as never, anterior: anteriorK1(), activa: activaK2(), tenantId: A, desde: "k9" }),
    );
    const fila = (await instantanea(worker, A, [x!.id])).get(x!.id)!;
    expect(fila.kek_id).toBe("k9");
    expect(iguales(fila.dek_envuelta, ajeno.dekEnvuelta)).toBe(true);
  });

  it("con la llave privada equivocada como `anterior` la rotacion falla y no cambia ninguna fila ni filtra la llave", async () => {
    const delA = await sembrarK1(A, ["sol", "sire_api"]);
    const antes = await instantanea(worker, A, ids(delA));
    const equivocada = crearKeyUnwrapperAnterior({ kekId: "k1", rutaPrivada: k2.privada });
    const e = await rechazo(() =>
      rotarKekTenant({ db: worker as never, anterior: equivocada, activa: activaK2(), tenantId: A, desde: "k1", lote: 1 }),
    );
    expect(e).toBeInstanceOf(Error);
    expect(fugas(e, envenenar)).toEqual([]);
    const despues = await instantanea(worker, A, ids(delA));
    for (const x of delA) {
      expect(despues.get(x.id)!.kek_id).toBe("k1");
      expect(iguales(despues.get(x.id)!.dek_envuelta, antes.get(x.id)!.dek_envuelta)).toBe(true);
    }
  });

  it("`desde` igual a la KEK activa se rechaza y no cambia nada", async () => {
    const delA = await sembrarK1(A, ["sol"]);
    const antes = await instantanea(worker, A, ids(delA));
    const anteriorComoActiva = crearKeyUnwrapperAnterior({ kekId: "k2", rutaPrivada: k2.privada });
    await rechazo(() =>
      rotarKekTenant({ db: worker as never, anterior: anteriorComoActiva, activa: activaK2(), tenantId: A, desde: "k2" }),
    );
    const despues = await instantanea(worker, A, ids(delA));
    expect(iguales(despues.get(delA[0]!.id)!.dek_envuelta, antes.get(delA[0]!.id)!.dek_envuelta)).toBe(true);
  });
});
