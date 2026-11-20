// Spec 008 (T3, rojo): repos de `sistema.*` y `auth.purgar` (D16, D18, CA-12, CA-13) sin BD. Se llaman con la tx de withSistema.
import { describe, expect, it } from "vitest";
import { TrabajosRepoError } from "./errores";
import { errorPg, txFalso } from "./soporte-prueba";
import {
  estudiosBuzon,
  estudiosConTrabajos,
  estudiosIds,
  purgarAuth,
  renovarCiclo,
  soltarCiclo,
  tomarCiclo,
} from "./sistema";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";

describe("estudiosIds", () => {
  it("devuelve solo los uuid (la primera columna de cada fila), en el orden recibido", async () => {
    const { tx, llamadas } = txFalso({
      rows: [{ estudios_ids: U1 }, { estudios_ids: U2 }],
    });
    expect(await estudiosIds(tx)).toEqual([U1, U2]);
    expect(llamadas[0]!.texto).toMatch(/sistema\.estudios_ids\(\)/);
  });

  it("funciona sea cual sea el nombre de la columna que devuelva la funcion", async () => {
    expect(await estudiosIds(txFalso({ rows: [{ id: U1 }] }).tx)).toEqual([U1]);
  });

  it("sin estudios devuelve []", async () => {
    expect(await estudiosIds(txFalso({ rows: [] }).tx)).toEqual([]);
  });

  it("un error de pg (sin permiso, funcion ausente) sale como TrabajosRepoError con el SQLSTATE", async () => {
    const e = await estudiosIds(txFalso(errorPg("42501")).tx).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("42501");
  });
});

describe("estudiosConTrabajos", () => {
  it("llama a sistema.estudios_con_trabajos con los estados y la antiguedad como parametros y devuelve los uuid", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ x: U2 }] });
    expect(
      await estudiosConTrabajos(tx, ["en_cola", "ejecutando"], 300),
    ).toEqual([U2]);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/sistema\.estudios_con_trabajos/);
    expect(texto).not.toContain("en_cola");
    expect(valores).toContainEqual(["en_cola", "ejecutando"]);
    expect(valores).toContain(300);
  });

  it("sin coincidencias devuelve []", async () => {
    expect(
      await estudiosConTrabajos(txFalso({ rows: [] }).tx, ["error"], 0),
    ).toEqual([]);
  });

  it("un error de pg sale como TrabajosRepoError", async () => {
    const e = await estudiosConTrabajos(
      txFalso(errorPg("42883")).tx,
      ["en_cola"],
      1,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
  });
});

describe("purgarAuth", () => {
  const RET = { sesionDias: 30, tokenDias: 7, intentoDias: 90, limiteDias: 1 };

  it("llama a auth.purgar con las cuatro retenciones como parametros y devuelve los conteos como numeros", async () => {
    const { tx, llamadas } = txFalso({
      rows: [{ sesiones: 3, tokens: "2", intentos: 1, limites: 0 }],
    });
    expect(await purgarAuth(tx, RET)).toEqual({
      sesiones: 3,
      tokens: 2,
      intentos: 1,
      limites: 0,
    });
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/auth\.purgar/);
    expect(valores).toHaveLength(4);
    const planos = valores.map(String).join("|");
    expect(planos).toMatch(/30/);
    expect(planos).toMatch(/90/);
  });

  it("un error de pg (retencion < 1 dia, sin permiso) sale como TrabajosRepoError con el SQLSTATE", async () => {
    const e = await purgarAuth(txFalso(errorPg("22023")).tx, {
      ...RET,
      sesionDias: 0,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("22023");
  });
});

// Spec 023 (D-5): candado del ciclo del programador de buzones y estudios con suscripcion vigente. Sin BD.
describe("estudiosBuzon", () => {
  it("devuelve tenantId como texto y frecuenciaMin como numero (pg puede entregar el entero como string)", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        { tenant_id: U1, frecuencia_min: "15" },
        { tenant_id: U2, frecuencia_min: 60 },
      ],
    });
    expect(await estudiosBuzon(tx)).toEqual([
      { tenantId: U1, frecuenciaMin: 15 },
      { tenantId: U2, frecuenciaMin: 60 },
    ]);
    expect(llamadas[0]!.texto).toMatch(/sistema\.estudios_buzon\(\)/);
  });

  it("sin estudios vigentes devuelve []", async () => {
    expect(await estudiosBuzon(txFalso({ rows: [] }).tx)).toEqual([]);
  });

  it("un error de pg sale como TrabajosRepoError con el SQLSTATE", async () => {
    const e = await estudiosBuzon(txFalso(errorPg("42501")).tx).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("42501");
  });
});

describe("tomarCiclo", () => {
  const INSTANTE = "2026-11-20T10:00:00.000Z";
  const filaCiclo = (ahora: unknown) => ({
    ahora,
    intervalo_min: "5",
    reserva_interactiva: "2",
    lote_estudio: 10,
  });

  it("con la fila devuelta toma el ciclo: dueno como parametro y numeros normalizados", async () => {
    const reloj = new Date(INSTANTE);
    const { tx, llamadas } = txFalso({ rows: [filaCiclo(reloj)] });
    const c = await tomarCiclo(tx, "worker-1");
    expect(c).toEqual({
      ahora: reloj,
      intervaloMin: 5,
      reservaInteractiva: 2,
      loteEstudio: 10,
    });
    expect(c!.ahora).toBe(reloj);
    expect(llamadas[0]!.texto).toMatch(/sistema\.buzon_ciclo_tomar/);
    expect(llamadas[0]!.valores).toEqual(["worker-1"]);
  });

  it("si otro tiene el ciclo o aun no toca (sin fila) devuelve null", async () => {
    expect(await tomarCiclo(txFalso({ rows: [] }).tx, "worker-1")).toBeNull();
  });

  it("ahora como string ISO sale como Date con el mismo instante", async () => {
    const c = await tomarCiclo(
      txFalso({ rows: [filaCiclo(INSTANTE)] }).tx,
      "worker-1",
    );
    expect(c!.ahora).toBeInstanceOf(Date);
    expect(c!.ahora.getTime()).toBe(Date.parse(INSTANTE));
  });

  it.each([
    ["2026-11-20 05:00:00-05", "2026-11-20T10:00:00.000Z"],
    ["2026-11-20 05:00:00.123456-05", "2026-11-20T10:00:00.123Z"],
    ["2026-11-20 12:30:00+02:30", "2026-11-20T10:00:00.000Z"],
  ])(
    "ahora como texto de pg con desfase (%s) sale como Date con el mismo instante",
    async (texto, esperado) => {
      const c = await tomarCiclo(
        txFalso({ rows: [filaCiclo(texto)] }).tx,
        "worker-1",
      );
      expect(c!.ahora).toBeInstanceOf(Date);
      expect(c!.ahora.toISOString()).toBe(esperado);
    },
  );

  it("un error de pg sale como TrabajosRepoError", async () => {
    const e = await tomarCiclo(txFalso(errorPg("42883")).tx, "w").catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TrabajosRepoError);
  });
});

describe("renovarCiclo", () => {
  it("true cuando la funcion devuelve true (sea cual sea el nombre de la columna)", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ buzon_ciclo_renovar: true }] });
    expect(await renovarCiclo(tx, "worker-1")).toBe(true);
    expect(llamadas[0]!.texto).toMatch(/sistema\.buzon_ciclo_renovar/);
    expect(llamadas[0]!.valores).toEqual(["worker-1"]);
  });

  it("false cuando perdio el candado (la funcion devuelve false)", async () => {
    expect(
      await renovarCiclo(txFalso({ rows: [{ r: false }] }).tx, "worker-1"),
    ).toBe(false);
  });

  it("false cuando no hay fila", async () => {
    expect(await renovarCiclo(txFalso({ rows: [] }).tx, "worker-1")).toBe(
      false,
    );
  });

  it("un valor que no es booleano true no cuenta como renovado", async () => {
    expect(
      await renovarCiclo(txFalso({ rows: [{ r: "t" }] }).tx, "worker-1"),
    ).toBe(false);
  });
});

describe("soltarCiclo", () => {
  it("llama a sistema.buzon_ciclo_soltar con el dueno como parametro", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await expect(soltarCiclo(tx, "worker-1")).resolves.toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(/sistema\.buzon_ciclo_soltar/);
    expect(llamadas[0]!.valores).toEqual(["worker-1"]);
  });

  it("un error de pg sale como TrabajosRepoError", async () => {
    const e = await soltarCiclo(txFalso(errorPg("42501")).tx, "w").catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TrabajosRepoError);
  });
});
