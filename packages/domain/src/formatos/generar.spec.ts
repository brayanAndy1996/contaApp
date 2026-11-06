// Spec 012 (T4, rojo): generarTxt, bloqueo por construcción y determinismo (D4-D6, D8, D14; CA-7, CA-9).
// Contrato fijado por la prueba:
//  - ArchivoNoPrevalidadoError lleva el ResultadoPrevalidacion en `.resultado`, sin bytes.
//  - Con filas aptas y formato oficial:false, sin `permitirProvisional` lanza FormatoProvisionalError.
//  - Línea del provisional (CRLF también en la última):
//    periodo|tipo|serie|numero|DD/MM/AAAA|tipoDoc|numDoc|razonSocial|moneda|TC(d.ddd o vacío)|
//    10 columnas en orden de COLUMNAS_COMPRA|total   (montos con Money.toString()).
//  - Orden: fecha, tipo, serie, número (numérico), documento; las excluidas se omiten (D14).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ArchivoNoPrevalidadoError,
  FormatoNoVigenteError,
  FormatoProvisionalError,
  FormatosError,
  RegistroFormatos,
  generarTxt,
  seleccionarFormato,
} from "../index";
import type { FilaReemplazo, ResultadoPrevalidacion } from "../index";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import {
  CABECERA,
  bytesLatin1,
  filaReemplazo,
  filasFixtureCorregidas,
  filasValidas,
  latin1,
  lineasCrlf,
} from "../../tests/ayudas/filas-reemplazo";

const PERMITIR = { permitirProvisional: true } as const;
const gen = (filas: readonly FilaReemplazo[], opciones: Parameters<typeof generarTxt>[2] = PERMITIR) =>
  generarTxt(filas, CABECERA, opciones);
const provisional = seleccionarFormato("compras", "202610");
const oficial = RegistroFormatos.desde([{ ...provisional, oficial: true, version: "1" }]);
const resultadoDe = (e: unknown) => (e as { resultado: ResultadoPrevalidacion }).resultado;

function capturar(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("CA-7 · bloqueo por construcción (D4)", () => {
  it("filas no aptas lanzan ArchivoNoPrevalidadoError con el resultado y sin bytes", () => {
    const mala = filaReemplazo({ biDg: "100.00", igvDg: "20.00" });
    const e = capturar(() => gen([mala]));
    expect(e).toBeInstanceOf(ArchivoNoPrevalidadoError);
    expect(e).toBeInstanceOf(FormatosError);
    expect(resultadoDe(e).apto).toBe(false);
    expect(resultadoDe(e).errores.map((x) => x.codigo)).toEqual(["IGV"]);
    expect("bytes" in (e as object)).toBe(false);
    expect((e as FormatosError).codigo).toMatch(/^[A-Z_]+$/);
    expect((e as Error).message).not.toContain("F001");
  });

  it("también con formato oficial (el bloqueo no depende de permitirProvisional)", () => {
    const mala = filaReemplazo({ biDg: "100.00", igvDg: "20.00" });
    expect(() => gen([mala], { registro: oficial })).toThrow(ArchivoNoPrevalidadoError);
  });

  it("sin filas, o con todas excluidas, no se genera un TXT vacío (D17)", () => {
    for (const filas of [[], [filaReemplazo(undefined, { estado: "excluida" })]]) {
      const e = capturar(() => gen(filas));
      expect(e).toBeInstanceOf(ArchivoNoPrevalidadoError);
      expect(resultadoDe(e).errores.map((x) => x.codigo)).toEqual(["SIN_FILAS"]);
    }
  });

  it("cada tipo de error bloquea: USD sin TC, duplicado, carácter prohibido, fecha posterior, RUC malo", () => {
    const malas: FilaReemplazo[][] = [
      [filaReemplazo(undefined, { moneda: "USD", tipoCambio: null })],
      [filaReemplazo(undefined, { id: "a" }), filaReemplazo(undefined, { id: "b" })],
      [filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "A|B" } })],
      [filaReemplazo(undefined, { fechaEmision: "2026-11-01" })],
      [filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070971" } })],
    ];
    for (const filas of malas) expect(() => gen(filas)).toThrow(ArchivoNoPrevalidadoError);
  });

  it("las filas excluidas no bloquean aunque estén rotas", () => {
    const rota = filaReemplazo({ biDg: "100.00", igvDg: "99.00" }, {
      id: "x",
      estado: "excluida",
      comprobante: { tipo: "01", serie: "", numero: "9" },
    });
    expect(() => gen([filaReemplazo(), rota])).not.toThrow();
  });

  it("una fila mutada después de prevalidar no se cuela: generarTxt vuelve a prevalidar", () => {
    const f = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ACME" } });
    expect(() => gen([f])).not.toThrow();
    (f.proveedor as { razonSocial?: string }).razonSocial = "A|B";
    expect(() => gen([f])).toThrow(ArchivoNoPrevalidadoError);
  });

  it("un getter que cambia de valor tras la primera lectura no se cuela en los bytes", () => {
    let lecturas = 0;
    const fila = { ...filaReemplazo() } as Record<string, unknown>;
    fila.proveedor = Object.defineProperty({ tipo: "6", numero: "20100070970" }, "razonSocial", {
      enumerable: true,
      get: () => (++lecturas === 1 ? "ACME SAC" : "MAL|MAL"),
    });
    const r = gen([fila as unknown as FilaReemplazo]);
    expect(lecturas).toBe(1);
    const texto = latin1(r.bytes);
    expect(texto).toContain("|ACME SAC|");
    expect(texto).not.toContain("MAL");
  });
});

describe("CA-9 · formato provisional y versiones (D5)", () => {
  it("sin permitirProvisional lanza FormatoProvisionalError, también con opciones vacías", () => {
    expect(() => generarTxt(filasValidas(2), CABECERA)).toThrow(FormatoProvisionalError);
    expect(() => generarTxt(filasValidas(2), CABECERA, {})).toThrow(FormatoProvisionalError);
    expect(() => generarTxt(filasValidas(2), CABECERA, { permitirProvisional: false })).toThrow(FormatoProvisionalError);
  });

  it("FormatoProvisionalError es un FormatosError con código estable y no devuelve bytes", () => {
    const e = capturar(() => generarTxt(filasValidas(1), CABECERA));
    expect(e).toBeInstanceOf(FormatosError);
    expect((e as FormatosError).codigo).toMatch(/^[A-Z_]+$/);
    expect("bytes" in (e as object)).toBe(false);
  });

  it("con permitirProvisional sale marcado provisional: true y nombra el formato", () => {
    const r = gen(filasValidas(2));
    expect(r.provisional).toBe(true);
    expect(r.formato).toEqual({ id: "RCE-REEMPLAZO", version: "0-provisional" });
    expect(r.bytes).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(r.bytes)).toBe(Uint8Array.prototype);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("un formato oficial genera sin permitirProvisional y sale provisional: false", () => {
    const r = gen(filasValidas(2), { registro: oficial });
    expect(r.provisional).toBe(false);
    expect(r.formato).toEqual({ id: "RCE-REEMPLAZO", version: "1" });
  });

  it("un periodo anterior a toda versión lanza FormatoNoVigenteError, antes que cualquier otra cosa", () => {
    expect(() => generarTxt(filasValidas(1), { ...CABECERA, periodo: "202512" }, PERMITIR)).toThrow(FormatoNoVigenteError);
  });

  it("con dos versiones, la elección sigue vigenteDesde", () => {
    const v1 = { ...provisional, oficial: true, version: "1", vigenteDesde: "202601" };
    const v2 = { ...provisional, oficial: true, version: "2", vigenteDesde: "202701" };
    const registro = RegistroFormatos.desde([v1, v2]);
    expect(generarTxt(filasValidas(1), CABECERA, { registro }).formato.version).toBe("1");
    const filas27 = [filaReemplazo(undefined, { fechaEmision: "2027-01-05" })];
    expect(generarTxt(filas27, { ...CABECERA, periodo: "202701" }, { registro }).formato.version).toBe("2");
  });

  it("los nombres salen del formato elegido", () => {
    const r = gen(filasValidas(1));
    expect(r.nombreTxt).toBe("CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt");
    expect(r.nombreZip).toBe("CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip");
  });
});

describe("contenido exacto del TXT provisional (D8, byte por byte)", () => {
  it("una fila PEN con ñ en la razón social, codificada en latin1 (ñ = 0xF1)", () => {
    const f = filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, {
      proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PEÑA SAC" },
    });
    const esperado =
      "202610|01|F001|123|05/10/2026|6|20100070970|PEÑA SAC|PEN||100.00|18.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|118.00\r\n";
    const r = gen([f]);
    expect(Array.from(r.bytes)).toEqual(bytesLatin1(esperado));
    expect(r.bytes).toContain(0xd1);
    expect(r.lineas).toBe(1);
  });

  it("una fila USD lleva el TC con 3 decimales; sin razón social el campo queda vacío", () => {
    const f = filaReemplazo({ biDg: "0.15", igvDg: "0.03" }, { moneda: "USD", tipoCambio: "3.3" });
    const esperado = "202610|01|F001|123|05/10/2026|6|20100070970||USD|3.300|0.15|0.03|0.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|0.18\r\n";
    expect(latin1(gen([f]).bytes)).toBe(esperado);
  });

  it("nota de crédito: los montos salen con su signo canónico", () => {
    const f = filaReemplazo({ biDg: "-100.00", igvDg: "-18.00" });
    expect(latin1(gen([f]).bytes)).toContain("|-100.00|-18.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|-118.00\r\n");
  });

  it("no recorta ni normaliza el texto: los espacios de la razón social se conservan", () => {
    const f = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "  ACME  SAC " } });
    expect(latin1(gen([f]).bytes)).toContain("|  ACME  SAC |PEN|");
  });

  it("los 10 montos salen en el orden de COLUMNAS_COMPRA y luego el total", () => {
    const f = filaReemplazo({
      biDg: "1.00", igvDg: "0.18", biDgng: "2.00", igvDgng: "0.36", biDng: "3.00", igvDng: "0.54",
      noGravado: "4.00", isc: "5.00", icbper: "0.50", otrosTributos: "6.00",
    });
    expect(latin1(gen([f]).bytes)).toContain("|PEN||1.00|0.18|2.00|0.36|3.00|0.54|4.00|5.00|0.50|6.00|22.58\r\n");
  });
});

describe("CA-2 · una línea por fila no excluida, y D14 (excluidas omitidas)", () => {
  it("el fixture corregido da 5 líneas, todas con CRLF, y lineas = 5", () => {
    const r = gen(filasFixtureCorregidas());
    expect(r.lineas).toBe(5);
    expect(lineasCrlf(r.bytes)).toHaveLength(5);
  });

  it("las excluidas no aparecen en el TXT ni cuentan en lineas", () => {
    const filas = [...filasValidas(3), filaReemplazo(undefined, { id: "x", estado: "excluida", comprobante: { tipo: "01", serie: "F999", numero: "99" } })];
    const r = gen(filas);
    expect(r.lineas).toBe(3);
    expect(latin1(r.bytes)).not.toContain("F999");
  });

  it("con un formato que incluye excluidas, sí van (incluyeExcluidas = true)", () => {
    const registro = RegistroFormatos.desde([{ ...provisional, oficial: true, version: "1", incluyeExcluidas: true }]);
    const filas = [...filasValidas(3), filaReemplazo(undefined, { id: "x", estado: "excluida", comprobante: { tipo: "01", serie: "F999", numero: "99" } })];
    const r = gen(filas, { registro });
    expect(r.lineas).toBe(4);
    expect(latin1(r.bytes)).toContain("F999");
  });

  it("agregadas y modificadas van como cualquier otra", () => {
    const filas = [
      filaReemplazo(undefined, { id: "a", estado: "original", comprobante: { tipo: "01", serie: "F001", numero: "1" } }),
      filaReemplazo(undefined, { id: "b", estado: "modificada", comprobante: { tipo: "01", serie: "F001", numero: "2" } }),
      filaReemplazo(undefined, { id: "c", estado: "agregada", comprobante: { tipo: "01", serie: "F001", numero: "3" } }),
    ];
    expect(gen(filas).lineas).toBe(3);
  });
});

describe("D6 · orden de líneas y determinismo", () => {
  const f = (id: string, over: Partial<FilaReemplazo> = {}) => filaReemplazo(undefined, { id, ...over });
  const numeroDe = (linea: string) => linea.split("|")[3];

  it("ordena por fecha de emisión, tipo, serie y número como número (9 < 10 < 100)", () => {
    const filas = [
      f("a", { comprobante: { tipo: "01", serie: "F001", numero: "100" } }),
      f("b", { comprobante: { tipo: "01", serie: "F001", numero: "9" } }),
      f("c", { comprobante: { tipo: "01", serie: "F001", numero: "10" } }),
      f("d", { comprobante: { tipo: "01", serie: "F001", numero: "5" }, fechaEmision: "2026-10-01" }),
      f("e", { comprobante: { tipo: "01", serie: "B001", numero: "50" } }),
      f("g", { comprobante: { tipo: "03", serie: "B001", numero: "1" } }),
    ];
    const lineas = lineasCrlf(gen(filas).bytes);
    expect(lineas.map((l) => `${l.split("|")[1]}-${l.split("|")[2]}-${numeroDe(l)}`)).toEqual([
      "01-F001-5", // 2026-10-01 es la fecha más antigua
      "01-B001-50",
      "01-F001-9",
      "01-F001-10",
      "01-F001-100",
      "03-B001-1",
    ]);
  });

  it("a igual comprobante salvo el documento del proveedor, ordena por documento", () => {
    const filas = [
      f("a", { proveedor: { tipo: "6", numero: "20700000070" } }),
      f("b", { proveedor: { tipo: "6", numero: "20100070970" } }),
      f("c", { proveedor: { tipo: "6", numero: "20700000011" } }),
    ];
    const docs = lineasCrlf(gen(filas).bytes).map((l) => l.split("|")[6]);
    expect(docs).toEqual(["20100070970", "20700000011", "20700000070"]);
  });

  it("dos llamadas con las mismas filas dan los mismos bytes, nombres y líneas", () => {
    const filas = filasFixtureCorregidas();
    const a = gen(filas);
    const b = gen(filas);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
    expect([a.nombreTxt, a.nombreZip, a.lineas]).toEqual([b.nombreTxt, b.nombreZip, b.lineas]);
  });

  it("propiedad: cualquier permutación de las filas da exactamente los mismos bytes", () => {
    const filas = filasFixtureCorregidas();
    const ref = Array.from(gen(filas).bytes);
    fc.assert(
      fc.property(fc.shuffledSubarray(filas, { minLength: filas.length, maxLength: filas.length }), (perm) => {
        expect(Array.from(gen(perm).bytes)).toEqual(ref);
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });

  it("la entrada no se muta: ni el arreglo ni las filas cambian de orden o contenido", () => {
    const filas = [f("b", { comprobante: { tipo: "01", serie: "F001", numero: "2" } }), f("a")];
    const ids = filas.map((x) => x.id);
    gen(filas);
    expect(filas.map((x) => x.id)).toEqual(ids);
  });
});
