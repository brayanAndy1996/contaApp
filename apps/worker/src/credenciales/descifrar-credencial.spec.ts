import { inspect } from "node:util";
import { crearKeyWrapper, cifrarCredencial, CryptoError, KeyProviderError } from "@contapp/crypto";
import type { ContextoAad, Sobre, TipoCredencial } from "@contapp/crypto";
import { Secreto, crearKeyUnwrapper } from "@contapp/crypto/descifrado";
import type { KeyUnwrapper } from "@contapp/crypto/descifrado";
import { describe, expect, it, vi } from "vitest";
import {
  canario,
  crearDbFalso,
  ENV_MOCK,
  errorPg,
  filaPg,
  fugas,
  loggerEspia,
  rechazo,
  uuid,
  volcado,
  type FilaCredencialPg,
  type Resultado,
} from "../../test/soporte.js";
import { crearServicioCredenciales } from "./descifrar-credencial.js";

// Servicio del worker `descifrarCredencial(ctx, credencialId, motivo)` sin BD (db falso).
// Spec 003: CA-1, CA-5, CA-7, CA-8, CA-9. Contrato: plan.md (Contratos: worker; Decisiones: Descifrado y auditoria).
// Contrato que fijan estas pruebas para T12:
// - errores tipados con `codigo: string` y `reintentable: boolean` (no reintentable salvo proveedor/llave);
// - una fila de auditoria por intento (ok o fallido) con el resultado del enum en sus parametros;
// - `Secreto` nunca se entrega si falla la lectura, el descifrado, el registro de auditoria o el COMMIT.

const wrapper = crearKeyWrapper(ENV_MOCK);
const MOTIVO = "prueba:descifrado-1";

const TENANT_A = uuid();
const TENANT_B = uuid();

interface Caso {
  id: string;
  cliente: string;
  tipo: TipoCredencial;
  valor: Record<string, string>;
  sobre: Sobre;
  fila: FilaCredencialPg;
}

async function sembrar(
  tipo: TipoCredencial,
  valor: Record<string, string>,
  tenantId = TENANT_A,
): Promise<Caso> {
  const cliente = uuid();
  const ctx: ContextoAad = { tenantId, clienteId: cliente, tipo };
  const sobre = await cifrarCredencial(wrapper, ctx, valor as never);
  const id = uuid();
  return { id, cliente, tipo, valor, sobre, fila: filaPg(id, tenantId, cliente, tipo, sobre) };
}

/** Unwrapper `mock` real que ademas anota cada DEK desenvuelta (para buscarla despues en logs/errores). */
function unwrapperEspia(): { u: KeyUnwrapper; deks: Buffer[] } {
  const real = crearKeyUnwrapper(ENV_MOCK);
  const deks: Buffer[] = [];
  const u: KeyUnwrapper = {
    kekId: real.kekId,
    verificar: () => real.verificar(),
    async unwrap(dekEnvuelta, kekId) {
      const dek = await real.unwrap(dekEnvuelta, kekId);
      deks.push(Buffer.from(dek));
      return dek;
    },
  };
  return { u, deks };
}

const bit = (b: Buffer, i = 0): Buffer => {
  const c = Buffer.from(b);
  c[i] ^= 1;
  return c;
};

function armar(caso: Caso | null, o: { fallas?: Parameters<typeof crearDbFalso>[1]; unwrapper?: KeyUnwrapper } = {}) {
  const falso = crearDbFalso(caso ? caso.fila : null, o.fallas);
  const espia = unwrapperEspia();
  const log = loggerEspia();
  const servicio = crearServicioCredenciales({
    db: falso.db as never,
    unwrapper: o.unwrapper ?? espia.u,
    logger: log.logger as never,
  });
  return { servicio, falso, espia, log };
}

const tipado = (e: Error & { codigo?: string; reintentable?: boolean }, reintentable: boolean) => {
  expect(typeof e.codigo).toBe("string");
  expect(e.reintentable).toBe(reintentable);
};

describe("CA-1: ida y vuelta por el servicio", () => {
  it("sol con unicode, '|' y emoji devuelve el par exacto", async () => {
    const valor = { usuario: "ñandú-日本-🔐", clave: "p@ss|wörd|✓" };
    const caso = await sembrar("sol", valor);
    const { servicio } = armar(caso);
    const s = await servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual(valor);
  });

  it("sire_api con campos de 256 B (ASCII y multibyte) devuelve el par exacto", async () => {
    for (const valor of [
      { clientId: "a".repeat(256), clientSecret: "b".repeat(256) },
      { clientId: "é".repeat(128), clientSecret: "日".repeat(85) + "x" },
    ]) {
      const caso = await sembrar("sire_api", valor);
      const { servicio } = armar(caso);
      const s = await servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO);
      expect(s.usar((v) => ({ ...v }))).toEqual(valor);
    }
  });

  it("el Secreto devuelto se redacta al serializarse (JSON, inspect, String)", async () => {
    const c = canario("redacta");
    const caso = await sembrar("sol", { usuario: `u-${c}`, clave: `k-${c}` });
    const { servicio } = armar(caso);
    const s = await servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO);
    expect(JSON.stringify(s)).toBe('"[REDACTADO]"');
    expect(inspect(s, { depth: 5, showHidden: true })).not.toContain(c);
    expect(String(s)).not.toContain(c);
    expect(JSON.stringify({ s })).not.toContain(c);
  });

  it("el tipo del AAD sale de la fila y no del llamador: un ctx con campos extra no cambia el resultado", async () => {
    const caso = await sembrar("sire_api", { clientId: "id", clientSecret: "sec" });
    const { servicio } = armar(caso);
    const ctxHostil = { tenantId: TENANT_A, tipo: "sol", clienteId: uuid() } as never;
    const s = await servicio.descifrarCredencial(ctxHostil, caso.id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual({ clientId: "id", clientSecret: "sec" });
  });
});

describe("CA-8: auditoria de cada descifrado", () => {
  it("un descifrado correcto deja una sola fila 'ok' con ids y motivo, sin el secreto", async () => {
    const c = canario("auditoria");
    const caso = await sembrar("sol", { usuario: `u-${c}`, clave: `k-${c}` });
    const { servicio, falso, espia } = armar(caso);
    await servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO);
    expect(falso.resultados()).toEqual([["ok"]]);
    const params = falso.auditorias[0]!;
    expect(params).toContain(caso.id);
    expect(params).toContain(MOTIVO);
    expect(fugas(falso.auditorias, [c, ...espia.deks])).toEqual([]);
    expect(fugas(falso.consultas, [c, ...espia.deks])).toEqual([]); // el plano no llega a la capa de BD
  });

  it("credencial inexistente: 'no_encontrada' auditada y error no reintentable", async () => {
    const { servicio, falso } = armar(null);
    const idAjeno = uuid();
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, idAjeno, MOTIVO));
    tipado(e, false);
    expect(falso.resultados()).toEqual([["no_encontrada"]]);
    expect(falso.auditorias[0]).toContain(idAjeno);
  });

  const alteraciones: Array<[string, (f: FilaCredencialPg) => FilaCredencialPg]> = [
    ["1 bit de ciphertext", (f) => ({ ...f, ciphertext: bit(f.ciphertext, 3) })],
    ["1 bit de nonce", (f) => ({ ...f, nonce: bit(f.nonce, 0) })],
    ["1 bit de tag", (f) => ({ ...f, tag: bit(f.tag, 15) })],
    ["1 bit de dek_envuelta", (f) => ({ ...f, dek_envuelta: bit(f.dek_envuelta, 100) })],
    ["otro cliente_id (sobre copiado a otro cliente)", (f) => ({ ...f, cliente_id: uuid() })],
    ["otro tipo (sobre copiado a otro tipo)", (f) => ({ ...f, tipo: f.tipo === "sol" ? "sire_api" : "sol" })],
  ];
  it.each(alteraciones)("fila alterada (%s): integridad auditada, error no reintentable, sin plano", async (_n, alterar) => {
    const c = canario("integridad");
    const caso = await sembrar("sol", { usuario: `u-${c}`, clave: `k-${c}` });
    const { servicio, falso, espia, log } = armar({ ...caso, fila: alterar(caso.fila) });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    tipado(e, false);
    expect(e).toBeInstanceOf(CryptoError);
    expect(falso.resultados()).toEqual([["integridad"]]);
    expect(fugas([e, log.llamadas, falso.auditorias], [c, ...espia.deks])).toEqual([]);
  });

  it("sobre sellado para el estudio B leido bajo ctx A: el AAD usa ctx.tenantId y falla por integridad", async () => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" }, TENANT_B);
    // La fila (maliciosa o por error) dice pertenecer a A, pero el sobre se sello con tenant B.
    const fila = { ...caso.fila, tenant_id: TENANT_A };
    const { servicio, falso } = armar({ ...caso, fila });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    tipado(e, false);
    expect(falso.resultados()).toEqual([["integridad"]]);
  });

  it("fila cuyo tenant_id no coincide con ctx.tenantId no se descifra (aunque el sobre sea valido para ctx)", async () => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" }, TENANT_A);
    const fila = { ...caso.fila, tenant_id: TENANT_B };
    const { servicio, falso } = armar({ ...caso, fila });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    tipado(e, false);
    const [[r]] = falso.resultados() as Resultado[][];
    expect(["integridad", "no_encontrada"]).toContain(r);
    expect(falso.resultados()).toHaveLength(1);
  });

  const malFormadas: Array<[string, (f: FilaCredencialPg) => FilaCredencialPg]> = [
    ["nonce de 8 B", (f) => ({ ...f, nonce: f.nonce.subarray(0, 8) })],
    ["tag truncado a 8 B", (f) => ({ ...f, tag: f.tag.subarray(0, 8) })],
    ["tag vacio", (f) => ({ ...f, tag: Buffer.alloc(0) })],
    ["version 2", (f) => ({ ...f, version: 2 })],
    ["kek_id mal formado", (f) => ({ ...f, kek_id: "MAL FORMADO" })],
  ];
  it.each(malFormadas)("sobre mal formado (%s): 'formato' auditado antes de tocar la llave", async (_n, alterar) => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const { servicio, falso, espia } = armar({ ...caso, fila: alterar(caso.fila) });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    tipado(e, false);
    expect(falso.resultados()).toEqual([["formato"]]);
    expect(espia.deks).toHaveLength(0); // la llave no se uso
  });

  it("si el registro de auditoria falla, el secreto no se entrega (aunque el descifrado fue correcto)", async () => {
    const c = canario("sin-auditoria");
    const caso = await sembrar("sol", { usuario: `u-${c}`, clave: `k-${c}` });
    const { servicio, falso, espia } = armar(caso, { fallas: { auditoria: errorPg("42501", `permission denied ${c}`) } });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    expect(e).toBeInstanceOf(Error);
    expect(falso.auditorias).toHaveLength(0);
    expect(fugas(e, [c, ...espia.deks])).toEqual([]);
  });

  it("si el COMMIT falla, el secreto no se entrega", async () => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const { servicio } = armar(caso, { fallas: { commit: new Error("commit fallido") } });
    await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
  });

  it("si la lectura de la BD falla, rechaza sin plano y sin detalle de pg", async () => {
    const c = canario("lectura");
    const caso = await sembrar("sol", { usuario: `u-${c}`, clave: `k-${c}` });
    const { servicio, espia } = armar(caso, { fallas: { lectura: errorPg("57P01", `fila (${c})`) } });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    expect(fugas(e, [c, ...espia.deks])).toEqual([]);
  });

  it.each([
    ["vacio", ""],
    ["con espacios", "motivo con espacios"],
    ["con '|'", "a|b"],
    ["de 121 caracteres", "m".repeat(121)],
    ["con salto de linea", "uno\ndos"],
  ])("motivo invalido (%s) se rechaza y no se entrega el secreto", async (_n, motivo) => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const { servicio, falso } = armar(caso);
    await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, motivo));
    expect(falso.resultados().flat()).not.toContain("ok");
  });

  it.each([
    ["no es UUID", "no-es-uuid"],
    ["vacio", ""],
  ])("credencialId invalido (%s) se rechaza antes de entregar nada", async (_n, id) => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const { servicio, falso } = armar(caso);
    await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, id, MOTIVO));
    expect(falso.resultados().flat()).not.toContain("ok");
  });
});

describe("CA-7: proveedor de llaves caido (worker)", () => {
  const caidas: Array<[string, () => Error]> = [
    ["KeyProviderError", () => new (KeyProviderError as unknown as new () => Error)()],
  ];
  it.each(caidas)("%s: error reintentable, 'llave' auditado, la credencial no se marca invalida", async (_n, crear) => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const caido: KeyUnwrapper = {
      kekId: "mock",
      unwrap: () => Promise.reject(crear()),
      verificar: () => Promise.reject(crear()),
    };
    const { servicio, falso } = armar(caso, { unwrapper: caido });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    tipado(e, true);
    expect(falso.resultados()).toEqual([["llave"]]);
    expect(falso.modificaciones()).toEqual([]); // ningun UPDATE/DELETE: nada se marca
  });

  it("kek_id desconocido para el proveedor activo: falla cerrado, reintentable, 'llave'", async () => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const fila = { ...caso.fila, kek_id: "k-retirada" };
    const { servicio, falso, espia } = armar({ ...caso, fila });
    const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    tipado(e, true);
    expect(falso.resultados()).toEqual([["llave"]]);
    expect(espia.deks).toHaveLength(0);
  });

  it("un fallo del proveedor no se degrada a otro: el servicio no abre ningun unwrapper propio", async () => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const intentos: string[] = [];
    const caido: KeyUnwrapper = {
      kekId: "mock",
      unwrap: () => {
        intentos.push("unwrap");
        return Promise.reject(new (KeyProviderError as unknown as new () => Error)());
      },
      verificar: () => Promise.resolve(),
    };
    const { servicio } = armar(caso, { unwrapper: caido });
    await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    expect(intentos).toEqual(["unwrap"]); // una sola llamada: sin reintento interno ni fallback
  });
});

describe("CA-9: sin fugas en logs ni errores", () => {
  it("con un canario, el logger, los errores y los parametros a la BD no lo contienen ni la DEK", async () => {
    const c = canario("fugas");
    const valor = { usuario: `u-${c}`, clave: `k-${c}` };
    const caso = await sembrar("sol", valor);
    const log = loggerEspia();
    const falso = crearDbFalso(caso.fila);
    const espia = unwrapperEspia();
    const servicio = crearServicioCredenciales({
      db: falso.db as never,
      unwrapper: espia.u,
      logger: log.logger as never,
    });
    const errores: Error[] = [];
    const ctx = { tenantId: TENANT_A };
    const s = await servicio.descifrarCredencial(ctx, caso.id, MOTIVO);
    expect(s.usar((v) => ({ ...v }))).toEqual(valor);
    // y tres fallos: no encontrada, motivo invalido, integridad
    errores.push(await rechazo(() => servicio.descifrarCredencial(ctx, uuid(), MOTIVO)));
    errores.push(await rechazo(() => servicio.descifrarCredencial(ctx, caso.id, "motivo invalido!")));
    const alterada = crearDbFalso({ ...caso.fila, tag: bit(caso.fila.tag) });
    const servicio2 = crearServicioCredenciales({
      db: alterada.db as never,
      unwrapper: espia.u,
      logger: log.logger as never,
    });
    errores.push(await rechazo(() => servicio2.descifrarCredencial(ctx, caso.id, MOTIVO)));

    const secretos = [valor.usuario, valor.clave, c, ...espia.deks];
    expect(fugas(log.llamadas, secretos)).toEqual([]);
    expect(volcado(log.llamadas)).not.toContain('"type":"Buffer"');
    for (const e of errores) expect(fugas(e, secretos)).toEqual([]);
    expect(fugas(falso.consultas, secretos)).toEqual([]);
    expect(fugas(alterada.consultas, secretos)).toEqual([]);
    expect(fugas(s, secretos)).toEqual([]);
  });

  it("el logger recibe solo ids, codigo y resultado: nunca el sobre ni sus campos", async () => {
    const caso = await sembrar("sol", { usuario: "u", clave: "k" });
    const { servicio, log } = armar({ ...caso, fila: { ...caso.fila, tag: bit(caso.fila.tag) } });
    await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
    const texto = volcado(log.llamadas);
    for (const b of [caso.sobre.ciphertext, caso.sobre.nonce, caso.sobre.tag, caso.sobre.dekEnvuelta]) {
      expect(fugas(texto, [b])).toEqual([]);
    }
  });

  it("un error de pg con el canario en `detail` al registrar la auditoria o leer el sobre no se propaga en message, stack, cause, JSON ni inspect", async () => {
    const c = canario("pg");
    const caso = await sembrar("sol", { usuario: `u-${c}`, clave: `k-${c}` });
    for (const donde of ["auditoria", "lectura"] as const) {
      const { servicio, espia, log } = armar(caso, { fallas: { [donde]: errorPg("22001", `valor (${c})`) } });
      const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
      expect(fugas([e, log.llamadas], [c, ...espia.deks])).toEqual([]);
    }
  });
});

// T15 · F6: un logger que falla tras el COMMIT no deja el Secreto vivo sin dueño.
describe("logger caído tras descifrar", () => {
  it("logger.log lanza: el servicio rechaza y el Secreto descifrado queda destruido", async () => {
    const caso = await sembrar("sol", { usuario: "u-logger", clave: "k-logger" });
    const falso = crearDbFalso(caso.fila);
    const destruir = vi.spyOn(Secreto.prototype, "destruir");
    try {
      const servicio = crearServicioCredenciales({
        db: falso.db as never,
        unwrapper: crearKeyUnwrapper(ENV_MOCK),
        logger: {
          log: () => {
            throw new Error("logger caído");
          },
          warn: () => undefined,
        },
      });
      const e = await rechazo(() => servicio.descifrarCredencial({ tenantId: TENANT_A }, caso.id, MOTIVO));
      expect(e.message).toBe("logger caído");
      expect(destruir).toHaveBeenCalledTimes(1);
    } finally {
      destruir.mockRestore();
    }
  });
});
