// Spec 026 (T4, rojo): repositorio de la prorrata usada ingresada por el contador, versionada (R-8, U-9; CA-6, CA-8, CA-10, D-4).
// Contra la BD real, con el backend (guardar y leer) y el worker (solo para sembrar declaraciones), más una `tx` falsa para la
// traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/prorrata/usada.ts`; llama a `prorrata_usada_guardar`):
//   guardarUsada(tx, {clienteId, periodo, porcentaje: "NN.NN" | null, version}) -> versión nueva (= version + 1)
//       `version` = última versión de ese periodo (0 si nunca se ingresó). `porcentaje` null deja el periodo «sin valor» (nueva versión).
//   leerUsada(tx, clienteId, periodo) -> UsadaFila | null   la de MAYOR versión (aunque su porcentaje sea null); null si nunca hubo;
//       la declarada del PDT NO se mezcla aquí (el dominio decide el origen: «declarada» gana a «ingresada»).
//   Errores (ProrrataRepoError.codigo): P0002 cliente ajeno o inexistente, 55000 archivado, CA409 versión distinta, CA413 el PDT
//       vigente del periodo ya trae la prorrata, 22023 argumento inválido, 42501 sin usuario.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardarUsada, leerUsada } from "./index";
import {
  abrirArnes,
  declaracion,
  falla,
  pruebasTraduccion,
  registrarComoWorker,
  type Arnes,
  type ClienteSembrado,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const HASTA = "202610";

const guardar = (
  c: ClienteSembrado,
  periodo: string,
  porcentaje: string | null,
  version: number,
  e = h.A,
) =>
  h.comoDueno(
    (tx) => guardarUsada(tx, { clienteId: c.id, periodo, porcentaje, version }),
    e,
  );

const usada = (c: ClienteSembrado, periodo: string, e = h.A) =>
  h.comoDueno((tx) => leerUsada(tx, c.id, periodo), e);

describe("guardar y leer la prorrata usada ingresada (CA-6)", () => {
  it("nunca ingresada: null", async () => {
    const c = await h.A.nuevoCliente();
    expect(await usada(c, HASTA)).toBeNull();
  });

  it("guardar con versión 0 devuelve 1 y deja el valor con autor y fecha", async () => {
    const c = await h.A.nuevoCliente();
    expect(await guardar(c, HASTA, "87.35", 0)).toBe(1);
    const u = await usada(c, HASTA);
    expect(u).toMatchObject({
      periodo: HASTA,
      version: 1,
      porcentaje: "87.35",
      autor: { id: h.A.dueno.id, nombre: h.A.dueno.nombre },
    });
    expect(u!.creadoEn).toBeInstanceOf(Date);
    expect(typeof u!.porcentaje).toBe("string");
  });

  it("los extremos 0.00 y 100.00 y los valores con 1 decimal o enteros se normalizan a «NN.NN»", async () => {
    const c = await h.A.nuevoCliente();
    expect(await guardar(c, "202601", "0.00", 0)).toBe(1);
    expect(await guardar(c, "202602", "100.00", 0)).toBe(1);
    expect(await guardar(c, "202603", "87.5", 0)).toBe(1);
    expect(await guardar(c, "202604", "5", 0)).toBe(1);
    expect((await usada(c, "202601"))!.porcentaje).toBe("0.00");
    expect((await usada(c, "202602"))!.porcentaje).toBe("100.00");
    expect((await usada(c, "202603"))!.porcentaje).toBe("87.50");
    expect((await usada(c, "202604"))!.porcentaje).toBe("5.00");
  });

  it("cada guardado es una versión nueva y la vigente es la mayor", async () => {
    const c = await h.A.nuevoCliente();
    expect(await guardar(c, HASTA, "80.00", 0)).toBe(1);
    expect(await guardar(c, HASTA, "81.00", 1)).toBe(2);
    expect(await guardar(c, HASTA, "82.00", 2)).toBe(3);
    expect(await usada(c, HASTA)).toMatchObject({
      version: 3,
      porcentaje: "82.00",
    });
  });

  it("guardar null deja el periodo sin valor pero cuenta como versión (la siguiente exige esa versión)", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, HASTA, "80.00", 0);
    expect(await guardar(c, HASTA, null, 1)).toBe(2);
    expect(await usada(c, HASTA)).toMatchObject({
      version: 2,
      porcentaje: null,
    });
    expect((await falla(guardar(c, HASTA, "70.00", 1))).codigo).toBe("CA409");
    expect(await guardar(c, HASTA, "70.00", 2)).toBe(3);
  });

  it("las versiones son por periodo y no se mezclan clientes ni estudios", async () => {
    const c1 = await h.A.nuevoCliente();
    const c2 = await h.A.nuevoCliente();
    const cb = await h.B.nuevoCliente();
    await guardar(c1, "202610", "10.00", 0);
    expect(await guardar(c1, "202609", "20.00", 0)).toBe(1);
    await guardar(cb, "202610", "30.00", 0, h.B);
    expect(await usada(c2, "202610")).toBeNull();
    expect(await usada(cb, "202610")).toBeNull(); // el cliente de B visto desde A
    expect(
      await h.comoDueno((tx) => leerUsada(tx, randomUUID(), "202610")),
    ).toBeNull();
    expect((await usada(cb, "202610", h.B))!.porcentaje).toBe("30.00");
  });
});

describe("compare-and-set por versión (mes_cambiado)", () => {
  it("versión vieja, adelantada o 0 con valor vigente: CA409 y nada cambia", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, HASTA, "80.00", 0);
    await guardar(c, HASTA, "81.00", 1);
    for (const version of [0, 1, 3, 99]) {
      expect((await falla(guardar(c, HASTA, "99.00", version))).codigo).toBe(
        "CA409",
      );
    }
    expect(await usada(c, HASTA)).toMatchObject({
      version: 2,
      porcentaje: "81.00",
    });
  });

  it("versión 1 cuando nunca se ingresó: CA409", async () => {
    const c = await h.A.nuevoCliente();
    expect((await falla(guardar(c, HASTA, "80.00", 1))).codigo).toBe("CA409");
    expect(await usada(c, HASTA)).toBeNull();
  });
});

describe("el PDT ya trae la prorrata usada (CA-6: prorrata_declarada)", () => {
  it("con una declaración vigente que la trae: CA413 y no escribe", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion(HASTA, { prorrataUsada: "87.34" })],
    });
    expect((await falla(guardar(c, HASTA, "87.35", 0))).codigo).toBe("CA413");
    expect(await usada(c, HASTA)).toBeNull();
  });

  it("con una declaración que no la trae (null) se guarda", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion(HASTA, { prorrataUsada: null })],
    });
    expect(await guardar(c, HASTA, "87.35", 0)).toBe(1);
  });

  it("una prorrata declarada en 0.00 también cuenta como que la trae", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion(HASTA, { prorrataUsada: "0.00" })],
    });
    expect((await falla(guardar(c, HASTA, "50.00", 0))).codigo).toBe("CA413");
  });

  it("sin declaración en ese periodo, o con la declaración en otro periodo: se guarda", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202609", { prorrataUsada: "90.00" })],
    });
    expect(await guardar(c, HASTA, "87.35", 0)).toBe(1);
  });

  it("manda la presentación vigente (mayor número de orden): original con prorrata y rectificatoria sin ella → se guarda", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion(HASTA, { numeroOrden: "2", prorrataUsada: "87.34" }),
        declaracion(HASTA, {
          numeroOrden: "10",
          tipo: "rectificatoria",
          prorrataUsada: null,
        }),
      ],
    });
    expect(await guardar(c, HASTA, "87.35", 0)).toBe(1);
  });

  it("manda la presentación vigente: original sin prorrata y rectificatoria con ella → CA413", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion(HASTA, { numeroOrden: "9", prorrataUsada: null }),
        declaracion(HASTA, {
          numeroOrden: "10",
          tipo: "rectificatoria",
          prorrataUsada: "87.34",
        }),
      ],
    });
    expect((await falla(guardar(c, HASTA, "87.35", 0))).codigo).toBe("CA413");
  });

  it("si una declaración llega después, lo ingresado queda en la BD (el dominio decide que gana la declarada)", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, HASTA, "87.35", 0);
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion(HASTA, { prorrataUsada: "87.34" })],
    });
    expect(await usada(c, HASTA)).toMatchObject({
      version: 1,
      porcentaje: "87.35",
    });
    expect((await falla(guardar(c, HASTA, "87.36", 1))).codigo).toBe("CA413");
  });
});

describe("errores traducidos con el SQLSTATE", () => {
  it("cliente de otro estudio o inexistente: P0002", async () => {
    const cb = await h.B.nuevoCliente();
    expect((await falla(guardar(cb, HASTA, "80.00", 0))).codigo).toBe("P0002");
    expect(
      (
        await falla(
          guardar({ id: randomUUID(), ruc: "30000000000" }, HASTA, "80.00", 0),
        )
      ).codigo,
    ).toBe("P0002");
    expect(await usada(cb, HASTA, h.B)).toBeNull();
  });

  it("cliente archivado: 55000", async () => {
    expect(
      (await falla(guardar(h.A.archivado, HASTA, "80.00", 0))).codigo,
    ).toBe("55000");
    expect(await usada(h.A.archivado, HASTA)).toBeNull();
  });

  it("sin usuario en el contexto: 42501; el worker tampoco puede: 42501", async () => {
    const c = await h.A.nuevoCliente();
    const sin = await falla(
      h.sinUsuario((tx) =>
        guardarUsada(tx, {
          clienteId: c.id,
          periodo: HASTA,
          porcentaje: "80.00",
          version: 0,
        }),
      ),
    );
    expect(sin.codigo).toBe("42501");
    const w = await falla(
      h.comoWorker((tx) =>
        guardarUsada(tx, {
          clienteId: c.id,
          periodo: HASTA,
          porcentaje: "80.00",
          version: 0,
        }),
      ),
    );
    expect(w.codigo).toBe("42501");
    expect(await usada(c, HASTA)).toBeNull();
  });

  it.each([
    ["100.01", "100.01"],
    ["negativo", "-0.01"],
    ["mil", "1000.00"],
    ["no numérico", "abc"],
  ])("porcentaje %s: se rechaza sin escribir", async (_nombre, porcentaje) => {
    const c = await h.A.nuevoCliente();
    const e = await falla(guardar(c, HASTA, porcentaje, 0));
    // 22023 de la función; 23514/22003/22P02 si la validación la hace el CHECK o el tipo NUMERIC(5,2).
    expect(["22023", "23514", "22003", "22P02"]).toContain(e.codigo);
    expect(await usada(c, HASTA)).toBeNull();
  });

  it("periodo con formato inválido: se rechaza sin escribir", async () => {
    const c = await h.A.nuevoCliente();
    const e = await falla(guardar(c, "202613", "80.00", 0));
    expect(["22023", "23514"]).toContain(e.codigo);
  });
});

const CLIENTE = "01990000-0000-7000-8000-000000000001";
pruebasTraduccion([
  [
    "guardarUsada",
    (tx) =>
      guardarUsada(tx, {
        clienteId: CLIENTE,
        periodo: HASTA,
        porcentaje: "87.35",
        version: 0,
      }),
  ],
  ["leerUsada", (tx) => leerUsada(tx, CLIENTE, HASTA)],
]);
