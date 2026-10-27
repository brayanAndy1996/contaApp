import { crearKeyWrapper, cifrarCredencial, KeyProviderError } from "@contapp/crypto";
import type { Sobre, TipoCredencial } from "@contapp/crypto";
import { crearKeyUnwrapper } from "@contapp/crypto/descifrado";
import type { KeyUnwrapper } from "@contapp/crypto/descifrado";
import { estadoCredenciales } from "@contapp/db";
import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditoriasDe,
  crearDbAdmin,
  crearDbRol,
  guardar,
  limpiar,
  SEED,
} from "../../test/bd.js";
import { canario, ENV_MOCK, fugas, loggerEspia, rechazo, uuid, volcado } from "../../test/soporte.js";
import { crearServicioCredenciales } from "./descifrar-credencial.js";

// Integracion con BD real (spec 003: CA-1, CA-5, CA-7, CA-8, CA-9). `KEY_PROVIDER=mock`.
// Se guarda con `contapp_backend` + @contapp/crypto y se descifra con el servicio del worker (`contapp_worker`).
// Requiere las migraciones 0005/0006 de T10 y DATABASE_URL/MIGRATIONS_DATABASE_URL (falla si faltan).

const MOTIVO = "prueba:int-1";
const A = SEED.tenantA;
const B = SEED.tenantB;

let backend: ContappDb;
let worker: ContappDb;
let admin: ContappDb;
const clientes: string[] = [];
const credenciales: string[] = [];

const wrapper = crearKeyWrapper(ENV_MOCK);
const unwrapper = crearKeyUnwrapper(ENV_MOCK);

beforeAll(() => {
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  admin = crearDbAdmin();
});

afterAll(async () => {
  await limpiar(admin, { clientes, credenciales }).catch(() => undefined);
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

async function sembrar(tenantId: string, tipo: TipoCredencial, valor: Record<string, string>, modificar?: (s: Sobre) => Sobre) {
  const clienteId = uuid();
  clientes.push(clienteId);
  const sobre = await cifrarCredencial(wrapper, { tenantId, clienteId, tipo }, valor as never);
  const id = await guardar(backend, tenantId, clienteId, tipo, modificar ? modificar(sobre) : sobre);
  credenciales.push(id);
  return { id, clienteId, sobre };
}

function servicio(o: { db?: unknown; unwrapper?: KeyUnwrapper } = {}) {
  const log = loggerEspia();
  const s = crearServicioCredenciales({
    db: (o.db ?? worker) as never,
    unwrapper: o.unwrapper ?? unwrapper,
    logger: log.logger as never,
  });
  return { ...s, log };
}

const bit = (b: Buffer, i = 0): Buffer => {
  const c = Buffer.from(b);
  c[i] ^= 1;
  return c;
};

describe("CA-1: guardar con el backend y descifrar con el worker", () => {
  it("sol (con unicode) devuelve el par exacto", async () => {
    const valor = { usuario: "usuario-ñandú", clave: "clave|日本|🔐" };
    const { id } = await sembrar(A, "sol", valor);
    const { descifrarCredencial } = servicio();
    const s = await descifrarCredencial({ tenantId: A }, id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual(valor);
  });

  it("sire_api con campos de la longitud maxima devuelve el par exacto", async () => {
    const valor = { clientId: "i".repeat(256), clientSecret: "s".repeat(256) };
    const { id } = await sembrar(A, "sire_api", valor);
    const s = await servicio().descifrarCredencial({ tenantId: A }, id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual(valor);
  });

  it("guardar de nuevo la misma (cliente, tipo) reemplaza el sobre y el servicio devuelve el nuevo", async () => {
    const { id, clienteId } = await sembrar(A, "sol", { usuario: "viejo", clave: "viejo" });
    const nuevo = await cifrarCredencial(wrapper, { tenantId: A, clienteId, tipo: "sol" }, { usuario: "nuevo", clave: "nuevo" });
    const id2 = await guardar(backend, A, clienteId, "sol", nuevo);
    expect(id2).toBe(id);
    const s = await servicio().descifrarCredencial({ tenantId: A }, id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual({ usuario: "nuevo", clave: "nuevo" });
  });
});

describe("CA-5: aislamiento entre estudios", () => {
  it("con withTenant(A) el worker no descifra la credencial de B (no_encontrada, auditada en A) y es simetrico", async () => {
    const deA = await sembrar(A, "sol", { usuario: "ua", clave: "ka" });
    const deB = await sembrar(B, "sol", { usuario: "ub", clave: "kb" });
    const { descifrarCredencial } = servicio();

    // control: cada estudio descifra la suya
    expect((await descifrarCredencial({ tenantId: A }, deA.id, MOTIVO)).usar((v) => ({ ...v }))).toEqual({ usuario: "ua", clave: "ka" });
    expect((await descifrarCredencial({ tenantId: B }, deB.id, MOTIVO)).usar((v) => ({ ...v }))).toEqual({ usuario: "ub", clave: "kb" });

    const eAB = await rechazo(() => descifrarCredencial({ tenantId: A }, deB.id, MOTIVO));
    expect(eAB.reintentable).toBe(false);
    const eBA = await rechazo(() => descifrarCredencial({ tenantId: B }, deA.id, MOTIVO));
    expect(eBA.reintentable).toBe(false);

    const intentoDeAsobreB = (await auditoriasDe(admin, deB.id)).filter((f) => f.resultado !== "ok");
    expect(intentoDeAsobreB).toHaveLength(1);
    expect(intentoDeAsobreB[0]!.tenant_id).toBe(A);
    expect(intentoDeAsobreB[0]!.resultado).toBe("no_encontrada");
    const intentoDeBsobreA = (await auditoriasDe(admin, deA.id)).filter((f) => f.resultado !== "ok");
    expect(intentoDeBsobreA).toHaveLength(1);
    expect(intentoDeBsobreA[0]!.tenant_id).toBe(B);
    expect(intentoDeBsobreA[0]!.resultado).toBe("no_encontrada");
  });

  it("un id inexistente tambien es no_encontrada (no revela si existe en otro estudio)", async () => {
    const inexistente = uuid();
    credenciales.push(inexistente); // para limpiar su auditoria
    const e = await rechazo(() => servicio().descifrarCredencial({ tenantId: A }, inexistente, MOTIVO));
    expect(e.reintentable).toBe(false);
    const filas = await auditoriasDe(admin, inexistente);
    expect(filas.map((f) => f.resultado)).toEqual(["no_encontrada"]);
  });
});

describe("CA-8: auditoria en BD", () => {
  it("un descifrado ok deja una fila con tenant, cliente, tipo, motivo, resultado y fecha, sin el secreto", async () => {
    const c = canario("aud-ok");
    const { id, clienteId } = await sembrar(A, "sire_api", { clientId: `id-${c}`, clientSecret: `sec-${c}` });
    await servicio().descifrarCredencial({ tenantId: A }, id, MOTIVO);
    const filas = await auditoriasDe(admin, id);
    expect(filas).toHaveLength(1);
    const f = filas[0]!;
    expect(f).toMatchObject({ tenant_id: A, credencial_id: id, cliente_id: clienteId, tipo: "sire_api", motivo: MOTIVO, resultado: "ok" });
    expect(f.created_at).toBeInstanceOf(Date);
    expect(JSON.stringify(filas)).not.toContain(c);
  });

  it("cada intento (ok y fallidos) deja su propia fila", async () => {
    const { id } = await sembrar(A, "sol", { usuario: "u", clave: "k" });
    const s = servicio();
    await s.descifrarCredencial({ tenantId: A }, id, MOTIVO);
    await s.descifrarCredencial({ tenantId: A }, id, MOTIVO);
    await rechazo(() => s.descifrarCredencial({ tenantId: B }, id, MOTIVO));
    const filas = await auditoriasDe(admin, id);
    expect(filas.map((f) => f.resultado).sort()).toEqual(["no_encontrada", "ok", "ok"]);
  });

  it("un sobre manipulado en BD falla por integridad y queda auditado como 'integridad'", async () => {
    const { id } = await sembrar(A, "sol", { usuario: "u", clave: "k" }, (s) => ({ ...s, ciphertext: bit(s.ciphertext) }));
    const e = await rechazo(() => servicio().descifrarCredencial({ tenantId: A }, id, MOTIVO));
    expect(e.reintentable).toBe(false);
    expect((await auditoriasDe(admin, id)).map((f) => f.resultado)).toEqual(["integridad"]);
  });

  it("un sobre con kek_id desconocido para el proveedor falla cerrado y queda auditado como 'llave'", async () => {
    const { id } = await sembrar(A, "sol", { usuario: "u", clave: "k" }, (s) => ({ ...s, kekId: "k-retirada" }));
    const e = await rechazo(() => servicio().descifrarCredencial({ tenantId: A }, id, MOTIVO));
    expect(e.reintentable).toBe(true);
    expect((await auditoriasDe(admin, id)).map((f) => f.resultado)).toEqual(["llave"]);
  });

  it("si el INSERT de auditoria falla dentro de la transaccion, el secreto no se entrega y no queda fila", async () => {
    const { id } = await sembrar(A, "sol", { usuario: "u", clave: "k" });
    const dbRota = {
      withTenant: (ctx: { tenantId: string }, fn: (tx: unknown) => Promise<unknown>) =>
        worker.withTenant(ctx, (tx) =>
          fn({
            query: (text: string, values?: unknown[]) =>
              /auditoria_descifrado/i.test(text)
                ? Promise.reject(Object.assign(new Error("permission denied for table auditoria_descifrado"), { code: "42501" }))
                : tx.query(text, values),
            orm: tx.orm,
          }),
        ),
    };
    await rechazo(() => servicio({ db: dbRota }).descifrarCredencial({ tenantId: A }, id, MOTIVO));
    expect(await auditoriasDe(admin, id)).toHaveLength(0);
  });
});

describe("CA-7: proveedor de llaves caido", () => {
  it("el worker devuelve un error reintentable, audita 'llave' y no cambia la credencial", async () => {
    const { id, clienteId } = await sembrar(A, "sol", { usuario: "u", clave: "k" });
    const estado = () => backend.withTenant({ tenantId: A }, (tx) => estadoCredenciales(tx as never, clienteId));
    const antes = JSON.stringify(await estado());
    const caido: KeyUnwrapper = {
      kekId: "mock",
      unwrap: () => Promise.reject(new (KeyProviderError as unknown as new () => Error)()),
      verificar: () => Promise.reject(new (KeyProviderError as unknown as new () => Error)()),
    };
    const e = await rechazo(() => servicio({ unwrapper: caido }).descifrarCredencial({ tenantId: A }, id, MOTIVO));
    expect(e.reintentable).toBe(true);
    expect((await auditoriasDe(admin, id)).map((f) => f.resultado)).toEqual(["llave"]);
    expect(JSON.stringify(await estado())).toBe(antes);
    // al volver el proveedor, la misma credencial se descifra sin reparaciones
    const s = await servicio().descifrarCredencial({ tenantId: A }, id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual({ usuario: "u", clave: "k" });
  });
});

describe("CA-9: sin fugas con BD real", () => {
  it("el canario no aparece en logs, errores, auditoria ni en las columnas guardadas", async () => {
    const c = canario("int-fugas");
    const valor = { usuario: `u-${c}`, clave: `k-${c}` };
    const ok = await sembrar(A, "sol", valor);
    const malo = await sembrar(A, "sol", valor, (s) => ({ ...s, tag: bit(s.tag, 5) }));
    const real = crearKeyUnwrapper(ENV_MOCK);
    const deks: Buffer[] = [];
    const espia: KeyUnwrapper = {
      kekId: real.kekId,
      verificar: () => real.verificar(),
      async unwrap(d, k) {
        const dek = await real.unwrap(d, k);
        deks.push(Buffer.from(dek));
        return dek;
      },
    };
    const s = servicio({ unwrapper: espia });
    const secreto = await s.descifrarCredencial({ tenantId: A }, ok.id, MOTIVO);
    const e1 = await rechazo(() => s.descifrarCredencial({ tenantId: A }, malo.id, MOTIVO));
    const e2 = await rechazo(() => s.descifrarCredencial({ tenantId: B }, ok.id, MOTIVO));
    const secretos = [c, valor.usuario, valor.clave, ...deks];
    expect(fugas([e1, e2, s.log.llamadas, secreto], secretos)).toEqual([]);
    expect(volcado(s.log.llamadas)).not.toContain('"type":"Buffer"');
    const filas = [...(await auditoriasDe(admin, ok.id)), ...(await auditoriasDe(admin, malo.id))];
    expect(fugas(filas, secretos)).toEqual([]);
    // el plano nunca llega a la capa de BD: ninguna columna del sobre lo contiene
    const r = await admin.pool.query(
      "select count(*)::int as n from credencial where cliente_id = any($1::uuid[]) and (position(convert_to($2, 'UTF8') in ciphertext) > 0 or position(convert_to($2, 'UTF8') in dek_envuelta) > 0)",
      [[ok.clienteId, malo.clienteId], c],
    );
    expect(r.rows[0].n).toBe(0);
  });
});
