import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CABECERA,
  csv,
  filaDatos,
  rucConPrefijo,
} from "../../../test/soporte-importacion.js";
import { leerCsv } from "./lector-csv.js";
import { LIMITES } from "./tipos.js";

const RUC1 = rucConPrefijo("20", 1);
const RUC2 = rucConPrefijo("10", 2);
const DATOS = [
  filaDatos({
    ruc: RUC1,
    razonSocial: "ACME S.A.C.",
    usuarioSol: "USU",
    claveSol: "claveCsvCanario",
    clientId: "cid",
    clientSecret: "secretoCsvCanario",
    responsable: "ana@estudio.pe",
  }),
  filaDatos({ ruc: RUC2 }),
];

function rechazo(fn: () => unknown): { codigo?: string; message?: string } {
  try {
    fn();
  } catch (e) {
    return e as { codigo?: string; message?: string };
  }
  return { codigo: "no_lanzo" };
}

describe("leerCsv · archivo válido (CA-1)", () => {
  it.each([
    [",", false, "\r\n"],
    [";", false, "\r\n"],
    [",", true, "\n"],
    [";", true, "\r\n"],
  ] as const)("separador %s, BOM=%s, fin de línea %j", (sep, bom, eol) => {
    const { filas } = leerCsv(
      csv([[...CABECERA], ...DATOS], { sep, bom, eol }),
    );
    expect(filas).toHaveLength(2);
    expect(filas[0]).toEqual({
      n: 2,
      ruc: RUC1,
      razonSocial: "ACME S.A.C.",
      usuarioSol: "USU",
      claveSol: "claveCsvCanario",
      clientId: "cid",
      clientSecret: "secretoCsvCanario",
      responsable: "ana@estudio.pe",
      formulas: [],
    });
    expect(filas[1]).toMatchObject({ n: 3, ruc: RUC2, razonSocial: "" });
  });

  it("la cabecera con BOM y tildes («Razón social») se reconoce", () => {
    expect(() =>
      leerCsv(csv([[...CABECERA], DATOS[0] as string[]], { bom: true })),
    ).not.toThrow();
  });

  it("campos entre comillas con el separador, comillas dobles y saltos de línea", () => {
    const razon = 'ACME, "El Mejor"; S.A.C.\nSucursal';
    const { filas } = leerCsv(
      csv([[...CABECERA], filaDatos({ ruc: RUC1, razonSocial: razon })]),
    );
    expect(filas[0]?.razonSocial).toBe(razon);
  });

  it("solo la cabecera -> sin filas; una fila corta se completa con vacíos; recorta el RUC pero no las claves", () => {
    expect(leerCsv(csv([[...CABECERA]])).filas).toEqual([]);
    const corta = leerCsv(
      strToU8(`${CABECERA.join(",")}\n${RUC1}\n  ${RUC2}  ,,,  clave  ,,,\n`),
    );
    expect(corta.filas[0]).toMatchObject({
      n: 2,
      ruc: RUC1,
      claveSol: "",
      responsable: "",
    });
    expect(corta.filas[1]).toMatchObject({
      n: 3,
      ruc: RUC2,
      claveSol: "  clave  ",
    });
  });

  it("omite las líneas vacías sin cambiar la numeración", () => {
    const { filas } = leerCsv(
      strToU8(
        `${CABECERA.join(",")}\n${RUC1},,,,,,\n,,,,,,\n${RUC2},,,,,,\n\n`,
      ),
    );
    expect(filas.map((f) => [f.n, f.ruc])).toEqual([
      [2, RUC1],
      [4, RUC2],
    ]);
  });

  it("no altera ni neutraliza el texto (=, +, -, @ al inicio), ni marca fórmulas", () => {
    const { filas } = leerCsv(
      csv([
        [...CABECERA],
        filaDatos({
          ruc: RUC1,
          razonSocial: '=HYPERLINK("x")',
          claveSol: "@clave",
          clientSecret: "-abc",
        }),
      ]),
    );
    expect(filas[0]).toMatchObject({
      razonSocial: '=HYPERLINK("x")',
      claveSol: "@clave",
      clientSecret: "-abc",
      formulas: [],
    });
  });
});

describe("leerCsv · rechazo del archivo completo (CA-2)", () => {
  it("cabecera sin una columna obligatoria -> columnas_faltantes", () => {
    const sinSecret = CABECERA.filter((c) => c !== "client_secret");
    expect(
      rechazo(() => leerCsv(csv([[...sinSecret], [RUC1, "", "", "", "", ""]])))
        .codigo,
    ).toBe("columnas_faltantes");
  });

  it("1.000 filas pasan; 1.001 -> demasiadas_filas", () => {
    const filas = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        filaDatos({ ruc: rucConPrefijo("20", i + 1) }),
      );
    expect(
      leerCsv(csv([[...CABECERA], ...filas(LIMITES.maxFilas)])).filas,
    ).toHaveLength(LIMITES.maxFilas);
    expect(
      rechazo(() =>
        leerCsv(csv([[...CABECERA], ...filas(LIMITES.maxFilas + 1)])),
      ).codigo,
    ).toBe("demasiadas_filas");
  });

  it("más de 2 MB -> archivo_demasiado_grande", () => {
    const grande = strToU8(
      `${CABECERA.join(",")}\n${"a".repeat(LIMITES.maxBytes)}\n`,
    );
    expect(rechazo(() => leerCsv(grande)).codigo).toBe(
      "archivo_demasiado_grande",
    );
  });

  it("vacío, solo espacios y binario con bytes NUL -> archivo_invalido", () => {
    expect(rechazo(() => leerCsv(new Uint8Array(0))).codigo).toBe(
      "archivo_invalido",
    );
    expect(rechazo(() => leerCsv(strToU8("   \n  \n"))).codigo).toBe(
      "archivo_invalido",
    );
    expect(
      rechazo(() =>
        leerCsv(
          Uint8Array.from([
            0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0xff, 0xfe,
          ]),
        ),
      ).codigo,
    ).toBe("archivo_invalido");
  });

  it("el mensaje del error no contiene datos de celdas", () => {
    const e = rechazo(() =>
      leerCsv(strToU8(`RUC,Otra\n${RUC1},canarioClaveCsv\n`)),
    );
    expect(e.codigo).toBe("columnas_faltantes");
    expect(e.message).toBe("columnas_faltantes");
  });
});
