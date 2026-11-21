import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clasificarError } from "../errores.js";
import type { FilaPropuestaSire, TokenSire } from "../puertos.js";
import { generarFilasComprasVolumen, MockSireApiClient } from "./sire-api-client.mock.js";

// Spec 025 · T2 (rojo). Registro presentado de compras por el puerto (plan 025, Contratos: sunat; D-2, U-1, U-5; CA-1, CA-13).
// Contrato fijado por estas pruebas:
//  - `SireApiClient.descargarRegistroPresentado(token, {ruc, periodo}) -> {libro: "compras", periodo, filas: FilaPropuestaSire[]}`.
//    Sin `libro` en la solicitud: el registro presentado es solo de compras.
//  - Mock (`dirFixtures`): `{ruc}-registro-compras-{periodo}.json` (`{filas: [...]}`); si no existe, `generico-registro-compras.json`
//    con el periodo pedido y las fechas de ese mes (mismo día, sin pasar del fin de mes). Archivos distintos de los de la propuesta.
//  - `{ruc}-registro-sin-datos.json` = lista JSON de periodos AAAAMM sin registro (["202601", ...]): esos periodos dan `ErrorDatos`.
//  - Centinelas del último dígito del RUC: 7 transitorio, 8 datos, 9 credencial. Token vacío = `ErrorCredencial`.
//    RUC o periodo inválidos = `ErrorDatos` sin tocar el disco ni quedar en el historial. El historial no guarda el token.
//  - El tope de tamaño del archivo del registro admite 5.000 compras (CA-13: > 1 MiB); un archivo ilegible o sin `filas` = `ErrorDatos`.
const RUC = "20700000002";
const CANARIO = "CANARIO-TOKEN-xyz";
const TOKEN: TokenSire = { token: CANARIO, expiraEn: new Date("2026-11-21T16:00:00Z") };

interface Registro {
  libro: string;
  periodo: string;
  filas: Array<Partial<FilaPropuestaSire>>;
}
type ConRegistro = {
  descargarRegistroPresentado(token: TokenSire, solicitud: { ruc: string; periodo: string }): Promise<Registro>;
};
// El método aún no existe: se llama a través de este tipo para que el archivo compile y falle en ejecución con «no implementado».
const registro = (mock: MockSireApiClient, ruc: string, periodo: string, token: TokenSire = TOKEN): Promise<Registro> => {
  const m = mock as unknown as Partial<ConRegistro>;
  if (typeof m.descargarRegistroPresentado !== "function") {
    return Promise.reject(new Error("no implementado: MockSireApiClient.descargarRegistroPresentado"));
  }
  return m.descargarRegistroPresentado(token, { ruc, periodo });
};
const clase = async (p: Promise<unknown>) => {
  const r = await p.then(
    () => "sin error",
    (e: unknown) => (e instanceof Error && e.message.startsWith("no implementado") ? e.message : clasificarError(e).clase),
  );
  return r;
};

const dirTemporal = mkdtempSync(join(tmpdir(), "sire-registro-"));
afterAll(() => rmSync(dirTemporal, { recursive: true, force: true }));
let n = 0;
const dirCon = (archivos: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(dirTemporal, `caso${(n += 1)}-`));
  for (const [nombre, contenido] of Object.entries(archivos)) {
    writeFileSync(join(dir, nombre), typeof contenido === "string" ? contenido : JSON.stringify(contenido));
  }
  return dir;
};
const fila = (o: Partial<FilaPropuestaSire> = {}): Partial<FilaPropuestaSire> => ({
  tipo: "01",
  serie: "F001",
  numero: "100",
  rucContraparte: "20100070970",
  razonSocialContraparte: "PROVEEDOR SAC",
  fechaEmision: "2026-10-15",
  moneda: "PEN",
  biDg: "100.00",
  igvDg: "18.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...o,
});
const mockCon = (archivos: Record<string, unknown>) => new MockSireApiClient({ dirFixtures: dirCon(archivos) });

describe("registro presentado: archivo propio por RUC y periodo", () => {
  it("devuelve las filas del archivo, con libro «compras» y el periodo pedido", async () => {
    const filas = [fila({ numero: "1" }), fila({ numero: "2", rucContraparte: "20100070988" })];
    const mock = mockCon({ [`${RUC}-registro-compras-202610.json`]: { libro: "compras", periodo: "202610", filas } });
    const r = await registro(mock, RUC, "202610");
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe("202610");
    expect(r.filas).toEqual(filas);
  });

  it("cada periodo lee su archivo; las fechas del archivo propio no se reescriben", async () => {
    const mock = mockCon({
      [`${RUC}-registro-compras-202610.json`]: { filas: [fila({ numero: "10", fechaEmision: "2026-10-31" })] },
      [`${RUC}-registro-compras-202609.json`]: { filas: [fila({ numero: "9", fechaEmision: "2026-09-30" }), fila({ numero: "91", fechaEmision: "2026-09-02" })] },
    });
    const oct = await registro(mock, RUC, "202610");
    const sep = await registro(mock, RUC, "202609");
    expect(oct.filas.map((f) => f.numero)).toEqual(["10"]);
    expect(oct.filas[0]?.fechaEmision).toBe("2026-10-31");
    expect(sep.filas.map((f) => f.numero)).toEqual(["9", "91"]);
    expect(sep.periodo).toBe("202609");
  });

  it("el archivo propio gana al genérico", async () => {
    const mock = mockCon({
      [`${RUC}-registro-compras-202610.json`]: { filas: [fila({ numero: "propio" })] },
      "generico-registro-compras.json": { filas: [fila({ numero: "generico" })] },
    });
    expect((await registro(mock, RUC, "202610")).filas.map((f) => f.numero)).toEqual(["propio"]);
  });

  it("no lee los archivos de la propuesta (`{ruc}-compras-{periodo}.json` ni `generico-compras.json`)", async () => {
    const mock = mockCon({
      [`${RUC}-compras-202610.json`]: { filas: [fila({ numero: "propuesta" })] },
      "generico-compras.json": { filas: [fila({ numero: "propuesta-generica" })] },
    });
    expect(await clase(registro(mock, RUC, "202610"))).toBe("datos");
  });

  it("la propuesta tampoco lee los archivos del registro", async () => {
    const mock = mockCon({
      [`${RUC}-registro-compras-202610.json`]: { filas: [fila({ numero: "registro" })] },
      "generico-registro-compras.json": { filas: [fila({ numero: "registro-generico" })] },
    });
    const e = await mock.descargarPropuesta(TOKEN, { ruc: RUC, periodo: "202610", libro: "compras" }).catch((x: unknown) => x);
    expect(clasificarError(e).clase).toBe("datos");
  });

  it("mutar la respuesta no altera la siguiente", async () => {
    const mock = mockCon({ [`${RUC}-registro-compras-202610.json`]: { filas: [fila({ numero: "1" }), fila({ numero: "2" })] } });
    const a = await registro(mock, RUC, "202610");
    a.filas.length = 0;
    expect((await registro(mock, RUC, "202610")).filas).toHaveLength(2);
  });
});

describe("registro presentado: genérico con el periodo y las fechas del mes", () => {
  const generico = {
    "generico-registro-compras.json": {
      libro: "compras",
      periodo: "202610",
      filas: [fila({ numero: "1", fechaEmision: "2026-10-05" }), fila({ numero: "2", fechaEmision: "2026-10-31" }), fila({ numero: "3", fechaEmision: "2026-10-15", rucContraparte: "20100070988" })],
    },
  };

  it("sin archivo propio devuelve el genérico con el periodo pedido y cada fecha en ese mes (mismo día)", async () => {
    const r = await registro(mockCon(generico), "20100000001", "202606");
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe("202606");
    expect(r.filas.map((f) => f.fechaEmision)).toEqual(["2026-06-05", "2026-06-30", "2026-06-15"]);
    expect(r.filas.map((f) => f.numero)).toEqual(["1", "2", "3"]);
  });
  it("no pasa del fin de mes (febrero, año no bisiesto y bisiesto)", async () => {
    const mock = mockCon(generico);
    expect((await registro(mock, "20100000001", "202602")).filas[1]?.fechaEmision).toBe("2026-02-28");
    expect((await registro(mock, "20100000001", "202402")).filas[1]?.fechaEmision).toBe("2024-02-29");
  });
  it("es determinista y no depende del RUC (las filas no llevan el del contribuyente)", async () => {
    const mock = mockCon(generico);
    const a = await registro(mock, "20100000001", "202608");
    expect(await registro(mock, "20100000001", "202608")).toEqual(a);
    expect((await registro(mock, "20100000002", "202608")).filas).toEqual(a.filas);
  });
  it("sin genérico ni archivo propio es ErrorDatos", async () => {
    expect(await clase(registro(mockCon({}), "20100000001", "202610"))).toBe("datos");
  });
  it("con los fixtures del repo existe un genérico con filas y cada una cae en el mes pedido", async () => {
    const r = await registro(new MockSireApiClient(), "20100000001", "202607");
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe("202607");
    expect(r.filas.length).toBeGreaterThan(0);
    for (const f of r.filas) expect(f.fechaEmision).toMatch(/^2026-07-\d{2}$/);
  });
});

describe("registro presentado: periodos «sin datos» (`{ruc}-registro-sin-datos.json`)", () => {
  const archivos = (sinDatos: unknown) => ({
    [`${RUC}-registro-sin-datos.json`]: sinDatos,
    "generico-registro-compras.json": { filas: [fila()] },
  });

  it("un periodo de la lista da ErrorDatos y los demás siguen respondiendo", async () => {
    const mock = mockCon(archivos(["202608", "202606"]));
    expect(await clase(registro(mock, RUC, "202608"))).toBe("datos");
    expect(await clase(registro(mock, RUC, "202606"))).toBe("datos");
    expect(await clase(registro(mock, RUC, "202609"))).toBe("sin error");
    expect(await clase(registro(mock, RUC, "202607"))).toBe("sin error");
  });
  it("la lista es de ese RUC: otro contribuyente no se ve afectado", async () => {
    const mock = mockCon(archivos(["202608"]));
    expect(await clase(registro(mock, "20100000001", "202608"))).toBe("sin error");
  });
  it("gana al archivo genérico y también al propio del periodo", async () => {
    const mock = mockCon({ ...archivos(["202610"]), [`${RUC}-registro-compras-202610.json`]: { filas: [fila()] } });
    expect(await clase(registro(mock, RUC, "202610"))).toBe("datos");
  });
  it("lista vacía: ningún periodo queda sin datos", async () => {
    expect(await clase(registro(mockCon(archivos([])), RUC, "202610"))).toBe("sin error");
  });
  it("una lista ilegible es ErrorDatos sin filtrar su contenido", async () => {
    const mock = mockCon(archivos("CANARIO-CONTENIDO {no json"));
    const e = await registro(mock, RUC, "202610").then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).not.toBeNull();
    expect(clasificarError(e).clase).toBe("datos");
    expect(JSON.stringify(e) + String((e as Error).stack)).not.toContain("CANARIO-CONTENIDO");
  });
});

describe("registro presentado: fallas", () => {
  const mock = () => mockCon({ "generico-registro-compras.json": { filas: [fila()] } });

  it("centinelas por último dígito del RUC: 7 transitorio, 8 datos, 9 credencial", async () => {
    const m = mock();
    expect(await clase(registro(m, "20100000007", "202610"))).toBe("transitorio");
    expect(await clase(registro(m, "20100000008", "202610"))).toBe("datos");
    expect(await clase(registro(m, "20100000009", "202610"))).toBe("credencial");
  });
  it("un token vacío es ErrorCredencial", async () => {
    expect(await clase(registro(mock(), RUC, "202610", { ...TOKEN, token: "" }))).toBe("credencial");
  });
  it("un token que no es texto es ErrorCredencial", async () => {
    expect(await clase(registro(mock(), RUC, "202610", { ...TOKEN, token: undefined as never }))).toBe("credencial");
  });
  it("un archivo que no es JSON, sin `filas` o con `filas` que no es lista es ErrorDatos, sin filtrar su contenido", async () => {
    for (const contenido of ["CANARIO-CONTENIDO {no json", "{}", "null", '{"filas":"no"}']) {
      const m = mockCon({ [`${RUC}-registro-compras-202610.json`]: contenido });
      const e = await registro(m, RUC, "202610").then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, contenido).not.toBeNull();
      expect(clasificarError(e).clase, contenido).toBe("datos");
      expect(JSON.stringify(e) + String((e as Error).stack)).not.toContain("CANARIO");
    }
  });
});

describe("registro presentado: entrada inválida (ErrorDatos antes de tocar el disco)", () => {
  const invalidas: Array<[string, string, unknown]> = [
    ["RUC corto", "2070000000", "202610"],
    ["RUC con letras", "2070000000A", "202610"],
    ["RUC con ruta", "../../etc/passwd", "202610"],
    ["RUC vacío", "", "202610"],
    ["periodo con guion", RUC, "2026-10"],
    ["periodo mes 13", RUC, "202613"],
    ["periodo mes 00", RUC, "202600"],
    ["periodo con ruta", RUC, "../../1"],
    ["periodo vacío", RUC, ""],
    ["periodo numérico", RUC, 202610],
    ["periodo nulo", RUC, null],
  ];

  it.each(invalidas)("%s", async (_n, ruc, periodo) => {
    // Directorio inexistente: si tocara el disco con una clave válida daría igualmente ErrorDatos; por eso se comprueba además
    // que la llamada no queda en el historial (se rechazó antes).
    const mock = new MockSireApiClient({ dirFixtures: join(dirTemporal, "no-existe") });
    expect(await clase(registro(mock, ruc, periodo as string))).toBe("datos");
    expect(mock.registro()).toHaveLength(0);
  });
});

describe("registro presentado: historial de llamadas sin token", () => {
  it("cuenta las llamadas, las anota por RUC y periodo y no guarda el token", async () => {
    const mock = mockCon({ "generico-registro-compras.json": { filas: [fila()] } });
    await registro(mock, RUC, "202610");
    await registro(mock, RUC, "202609");
    await registro(mock, "20100000001", "202610");
    expect(mock.llamadas).toBe(3);
    expect(mock.llamadasDe(RUC)).toBe(2);
    expect(mock.registro().filter((r) => r.ruc === RUC).map((r) => r.periodo)).toEqual(["202610", "202609"]);
    expect(JSON.stringify(mock.registro())).not.toContain(CANARIO);
    expect(JSON.stringify(mock)).not.toContain(CANARIO);
  });
  it("las llamadas fallidas con RUC y periodo válidos también quedan anotadas, sin token", async () => {
    const mock = mockCon({ "generico-registro-compras.json": { filas: [fila()] } });
    await registro(mock, "20100000009", "202610").catch(() => undefined);
    expect(mock.registro().some((r) => r.ruc === "20100000009" && r.periodo === "202610")).toBe(true);
    expect(JSON.stringify(mock.registro())).not.toContain(CANARIO);
  });
});

describe("registro presentado: volumen de CA-13 (12 periodos × 5.000 compras)", () => {
  it("un archivo de 5.000 compras (más de 1 MiB) se lee completo: el tope del mock no lo corta", async () => {
    const filas = generarFilasComprasVolumen(5_000, "202610");
    const dir = dirCon({ [`${RUC}-registro-compras-202610.json`]: { libro: "compras", periodo: "202610", filas } });
    expect(JSON.stringify(filas).length).toBeGreaterThan(1_048_576);
    const r = await registro(new MockSireApiClient({ dirFixtures: dir }), RUC, "202610");
    expect(r.filas).toHaveLength(5_000);
    expect(r.filas[0]?.biDg).toBe(filas[0]?.biDg);
  });
});
