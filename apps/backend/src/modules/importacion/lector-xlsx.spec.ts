import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CABECERA,
  comprimir,
  DOCTYPE_LOLS,
  DOCTYPE_SIMPLE,
  DOCTYPE_XXE,
  filaDatos,
  partesXlsx,
  rucConPrefijo,
  xlsx,
  xlsxBomba,
  xlsxConDatos,
  xlsxConRuta,
  xlsxMilesDeEntradas,
} from "../../../test/soporte-importacion.js";
import { leerXlsx } from "./lector-xlsx.js";
import { LIMITES } from "./tipos.js";

const RUC1 = rucConPrefijo("20", 1);
const RUC2 = rucConPrefijo("10", 2);

// El contrato de rechazo: un ErrorArchivo con `codigo`, y como mensaje solo el código (nunca contenido de celdas).
function rechazo(fn: () => unknown): { codigo?: string; message?: string } {
  try {
    fn();
  } catch (e) {
    return e as { codigo?: string; message?: string };
  }
  return { codigo: "no_lanzo" };
}

describe("leerXlsx · archivo válido (CA-1)", () => {
  it("lee la primera hoja: número de fila de archivo y todas las columnas como texto", () => {
    const { filas } = leerXlsx(
      xlsxConDatos([
        {
          ruc: RUC1,
          razonSocial: "ACME S.A.C.",
          usuarioSol: "MIUSUARIO",
          claveSol: "claveSolCanario1",
          clientId: "cid-1",
          clientSecret: "secretoCanario1",
          responsable: "ana@estudio.pe",
        },
        { ruc: RUC2 },
      ]),
    );
    expect(filas).toHaveLength(2);
    expect(filas[0]).toEqual({
      n: 2,
      ruc: RUC1,
      razonSocial: "ACME S.A.C.",
      usuarioSol: "MIUSUARIO",
      claveSol: "claveSolCanario1",
      clientId: "cid-1",
      clientSecret: "secretoCanario1",
      responsable: "ana@estudio.pe",
      formulas: [],
    });
    expect(filas[1]).toMatchObject({
      n: 3,
      ruc: RUC2,
      razonSocial: "",
      claveSol: "",
      responsable: "",
    });
  });

  it("acepta la cabecera sin filas de datos (la plantilla intacta no crea nada)", () => {
    expect(leerXlsx(xlsxConDatos([])).filas).toEqual([]);
  });

  it("ubica las columnas por su cabecera aunque vengan en otro orden", () => {
    const orden = [6, 0, 3, 2, 1, 5, 4];
    const fila = filaDatos({
      ruc: RUC1,
      usuarioSol: "U",
      claveSol: "C",
      clientId: "I",
      clientSecret: "S",
      responsable: "r@e.pe",
    });
    const { filas } = leerXlsx(
      xlsx([
        orden.map((i) => CABECERA[i] as string),
        orden.map((i) => fila[i] as string),
      ]),
    );
    expect(filas[0]).toMatchObject({
      ruc: RUC1,
      usuarioSol: "U",
      claveSol: "C",
      clientId: "I",
      clientSecret: "S",
      responsable: "r@e.pe",
    });
  });

  it("lee celdas numéricas, cadenas en línea y compartidas; recorta los espacios del RUC pero no los de las claves", () => {
    const { filas } = leerXlsx(
      xlsx([
        [...CABECERA],
        [
          Number(RUC1),
          { en: "En línea SAC" },
          { en: "  USUARIO  " },
          " clave con espacios ",
          null,
          null,
          null,
        ],
        [`  ${RUC2}  `, null, null, null, null, null, null],
      ]),
    );
    expect(filas[0]).toMatchObject({
      ruc: RUC1,
      razonSocial: "En línea SAC",
      claveSol: " clave con espacios ",
    });
    expect(filas[1]).toMatchObject({ ruc: RUC2 });
  });

  it("un espacio interior del RUC se conserva (la validación lo rechaza después)", () => {
    const { filas } = leerXlsx(
      xlsxConDatos([{ ruc: `${RUC1.slice(0, 5)} ${RUC1.slice(5)}` }]),
    );
    expect(filas[0]?.ruc).toBe(`${RUC1.slice(0, 5)} ${RUC1.slice(5)}`);
  });

  it("decodifica las entidades XML normales (&amp; &lt;) sin confundirlas con entidades peligrosas", () => {
    const { filas } = leerXlsx(
      xlsxConDatos([{ ruc: RUC1, razonSocial: "A&B <Sur> S.A.C." }]),
    );
    expect(filas[0]?.razonSocial).toBe("A&B <Sur> S.A.C.");
  });

  it("lee solo la primera hoja", () => {
    const otra = rucConPrefijo("20", 99);
    const { filas } = leerXlsx(
      xlsxConDatos([{ ruc: RUC1 }], {
        hojasExtra: [[[...CABECERA], filaDatos({ ruc: otra })]],
      }),
    );
    expect(filas.map((f) => f.ruc)).toEqual([RUC1]);
  });

  it("omite las filas totalmente vacías sin cambiar la numeración de las demás", () => {
    const { filas } = leerXlsx(
      xlsx([
        [...CABECERA],
        filaDatos({ ruc: RUC1 }),
        filaDatos({}),
        filaDatos({ ruc: RUC2 }),
      ]),
    );
    expect(filas.map((f) => [f.n, f.ruc])).toEqual([
      [2, RUC1],
      [4, RUC2],
    ]);
  });

  it("no altera ni neutraliza el texto de las celdas (la validación decide qué es peligroso)", () => {
    const { filas } = leerXlsx(
      xlsxConDatos([
        {
          ruc: RUC1,
          razonSocial: '=HYPERLINK("http://x","clic")',
          claveSol: "=1+1",
          clientSecret: "-abc",
        },
      ]),
    );
    expect(filas[0]).toMatchObject({
      razonSocial: '=HYPERLINK("http://x","clic")',
      claveSol: "=1+1",
      clientSecret: "-abc",
      formulas: [],
    });
  });
});

describe("leerXlsx · fórmulas (CA-2)", () => {
  it("marca las columnas con una fórmula real <f> sin evaluarla ni lanzar", () => {
    const { filas } = leerXlsx(
      xlsx([
        [...CABECERA],
        [
          RUC1,
          { f: 'HYPERLINK("http://x","a")', v: "a" },
          "U",
          { f: "1+1", v: "2" },
          null,
          null,
          null,
        ],
        filaDatos({ ruc: RUC2 }),
      ]),
    );
    expect(filas[0]?.formulas.sort()).toEqual(["claveSol", "razonSocial"]);
    expect(filas[1]?.formulas).toEqual([]);
  });
});

describe("leerXlsx · rechazo del archivo completo (CA-2)", () => {
  it("cabecera sin una columna obligatoria -> columnas_faltantes", () => {
    const sinClave = CABECERA.filter((c) => c !== "Clave SOL");
    expect(
      rechazo(() => leerXlsx(xlsx([[...sinClave], [RUC1, "", "", "", "", ""]])))
        .codigo,
    ).toBe("columnas_faltantes");
    const sinRuc = CABECERA.filter((c) => c !== "RUC");
    expect(rechazo(() => leerXlsx(xlsx([[...sinRuc]]))).codigo).toBe(
      "columnas_faltantes",
    );
  });

  it("1.000 filas pasan; 1.001 -> demasiadas_filas", () => {
    const datos = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ruc: rucConPrefijo("20", i + 1),
      }));
    expect(leerXlsx(xlsxConDatos(datos(LIMITES.maxFilas))).filas).toHaveLength(
      LIMITES.maxFilas,
    );
    expect(
      rechazo(() => leerXlsx(xlsxConDatos(datos(LIMITES.maxFilas + 1)))).codigo,
    ).toBe("demasiadas_filas");
  });

  it("más de 2 MB -> archivo_demasiado_grande, antes de intentar abrirlo", () => {
    expect(
      rechazo(() => leerXlsx(new Uint8Array(LIMITES.maxBytes + 1))).codigo,
    ).toBe("archivo_demasiado_grande");
  });

  it("vacío, no-zip y zip sin libro de cálculo -> archivo_invalido", () => {
    expect(rechazo(() => leerXlsx(new Uint8Array(0))).codigo).toBe(
      "archivo_invalido",
    );
    expect(rechazo(() => leerXlsx(strToU8("esto no es un zip"))).codigo).toBe(
      "archivo_invalido",
    );
    expect(
      rechazo(() => leerXlsx(comprimir({ "hola.txt": strToU8("hola") })))
        .codigo,
    ).toBe("archivo_invalido");
    const truncado = xlsxConDatos([{ ruc: RUC1 }]);
    expect(
      rechazo(() =>
        leerXlsx(truncado.subarray(0, Math.floor(truncado.length / 2))),
      ).codigo,
    ).toBe("archivo_invalido");
  });

  it("el mensaje del error no contiene datos de celdas", () => {
    const e = rechazo(() =>
      leerXlsx(
        xlsxConDatos([{ ruc: RUC1, claveSol: "canarioClaveXlsx" }], {
          doctypeHoja: DOCTYPE_SIMPLE,
        }),
      ),
    );
    expect(e.codigo).toBe("archivo_invalido");
    expect(e.message).toBe("archivo_invalido");
  });
});

describe("leerXlsx · bomba de descompresión y zip hostil (CA-2)", () => {
  const T0 = 20 * 1024 * 1024;

  it("una entrada que declara poco y expande más de 20 MB -> archivo_invalido, sin demora desmedida", () => {
    const zip = xlsxBomba(T0 + 5 * 1024 * 1024, true);
    expect(zip.length).toBeLessThan(LIMITES.maxBytes); // pasa el tope de 2 MB: la defensa tiene que ser la de descompresión
    const t = Date.now();
    expect(rechazo(() => leerXlsx(zip)).codigo).toBe("archivo_invalido");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("la misma bomba declarando el tamaño real también se rechaza", () => {
    expect(
      rechazo(() => leerXlsx(xlsxBomba(T0 + 5 * 1024 * 1024, false))).codigo,
    ).toBe("archivo_invalido");
  });

  it("miles de entradas -> archivo_invalido", () => {
    expect(rechazo(() => leerXlsx(xlsxMilesDeEntradas(5000))).codigo).toBe(
      "archivo_invalido",
    );
  });

  it.each([
    "../evil.xml",
    "xl/../../evil.xml",
    "/etc/evil.xml",
    "xl\\..\\evil.xml",
  ])("ruta peligrosa %s -> archivo_invalido", (ruta) => {
    expect(rechazo(() => leerXlsx(xlsxConRuta(ruta))).codigo).toBe(
      "archivo_invalido",
    );
  });
});

describe("leerXlsx · XXE, DOCTYPE y entidades (CA-2)", () => {
  it.each([
    ["entidad externa en la hoja", { doctypeHoja: DOCTYPE_XXE }],
    [
      "entidad externa en las cadenas compartidas",
      { doctypeCadenas: DOCTYPE_XXE },
    ],
    ["DOCTYPE simple", { doctypeHoja: DOCTYPE_SIMPLE }],
    ["expansión exponencial de entidades", { doctypeCadenas: DOCTYPE_LOLS }],
  ])("%s -> archivo_invalido", (_nombre, opc) => {
    const e = rechazo(() =>
      leerXlsx(xlsxConDatos([{ ruc: RUC1, razonSocial: "ACME" }], opc)),
    );
    expect(e.codigo).toBe("archivo_invalido");
  });

  it("la referencia a la entidad externa se rechaza sin expandirse a /etc/passwd", () => {
    const partes = partesXlsx(
      [[...CABECERA], filaDatos({ ruc: RUC1, razonSocial: "MARCA" })],
      { doctypeCadenas: DOCTYPE_XXE },
    );
    const cadenas = new TextDecoder()
      .decode(partes["xl/sharedStrings.xml"])
      .replace("MARCA", "&xxe;");
    partes["xl/sharedStrings.xml"] = strToU8(cadenas);
    const e = rechazo(() => leerXlsx(comprimir(partes)));
    expect(e.codigo).toBe("archivo_invalido");
    expect(e.message).not.toContain("root:");
  });
});
