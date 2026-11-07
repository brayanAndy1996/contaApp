// Spec 013 (T3, rojo): LAYOUT_VENTAS_PROVISIONAL y validarFilaVenta(cruda) (D3, D6, D14b; CA-1, CA-3, CA-10).
// Contrato que fija la prueba (T9, `packages/domain/src/ventas/index.ts`):
//   LAYOUT_VENTAS_PROVISIONAL: { id: string, version: "0-provisional", oficial: false, columnas: { nombre, obligatoria }[] },
//     congelado. Los nombres de columna son los campos de `FilaVentaSire` (plan: Puertos). Mientras no haya anexo de SUNAT el
//     servicio no importa con este layout en producción (D6); eso lo decide el servicio, no este módulo.
//   validarFilaVenta(cruda: unknown): { ok: true, fila: FilaVentaValida, cuadra: boolean } | { ok: false, errores: { campo, codigo }[] }
//     - nunca lanza: una celda mal formada, un valor no cadena o un objeto raro dan `ok: false`;
//     - `errores` lista TODOS los campos con problema (no solo el primero), sin repetir campo; `codigo` es un código en
//       MAYÚSCULAS_Y_GUION_BAJO, nunca el valor de la celda ni un mensaje libre;
//     - `fila` trae cadenas: los montos en su forma canónica de 2 decimales ("118.00"); no se corrige nada;
//     - `cuadra` = total === Σ de las siete columnas con tolerancia 0.00 (010 `verificarCuadre`). Una fila legible pero
//       descuadrada es `ok: true, cuadra: false` (D3: se guarda tal cual y se marca; el servicio de agregar la rechaza con 400).
import { describe, expect, it } from "vitest";
import { LAYOUT_VENTAS_PROVISIONAL, validarFilaVenta } from "./index";

const buena = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tipo: "03",
  serie: "B001",
  numero: "290",
  docContraparte: "-",
  fechaEmision: "2026-10-03",
  moneda: "PEN",
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...extra,
});
const sin = (campo: string): Record<string, unknown> => {
  const copia = buena();
  delete copia[campo];
  return copia;
};
const camposConError = (cruda: unknown): string[] => {
  const r = validarFilaVenta(cruda);
  if (r.ok) return [];
  return [...new Set(r.errores.map((e) => e.campo))].sort();
};
const MONTOS = ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"];

describe("LAYOUT_VENTAS_PROVISIONAL (D6, P-4)", () => {
  it("es provisional y versionado: oficial false, versión 0-provisional, con id", () => {
    expect(LAYOUT_VENTAS_PROVISIONAL.oficial).toBe(false);
    expect(LAYOUT_VENTAS_PROVISIONAL.version).toBe("0-provisional");
    expect(typeof LAYOUT_VENTAS_PROVISIONAL.id).toBe("string");
    expect(LAYOUT_VENTAS_PROVISIONAL.id.length).toBeGreaterThan(0);
  });

  it("las columnas son los campos de FilaVentaSire; el documento de la contraparte acompaña a la fila", () => {
    const nombres = LAYOUT_VENTAS_PROVISIONAL.columnas.map((c) => c.nombre);
    for (const n of ["tipo", "serie", "numero", "docContraparte", "fechaEmision", "moneda", ...MONTOS]) {
      expect(nombres, n).toContain(n);
    }
    expect(nombres).toContain("tipoDocContraparte");
    expect(nombres).toContain("tipoCambio");
    expect(new Set(nombres).size, "sin columnas repetidas").toBe(nombres.length);
  });

  it("son obligatorias las de siempre; el tipo de cambio y el tipo de documento no (consumidor final, PEN)", () => {
    const por = Object.fromEntries(LAYOUT_VENTAS_PROVISIONAL.columnas.map((c) => [c.nombre, c.obligatoria]));
    for (const n of ["tipo", "serie", "numero", "docContraparte", "fechaEmision", "moneda", ...MONTOS]) expect(por[n], n).toBe(true);
    expect(por.tipoCambio).toBe(false);
    expect(por.tipoDocContraparte).toBe(false);
  });

  it("está congelado: no se puede cambiar `oficial` ni agregar columnas", () => {
    expect(Object.isFrozen(LAYOUT_VENTAS_PROVISIONAL)).toBe(true);
    expect(Object.isFrozen(LAYOUT_VENTAS_PROVISIONAL.columnas)).toBe(true);
    expect(() => {
      (LAYOUT_VENTAS_PROVISIONAL as { oficial: boolean }).oficial = true;
    }).toThrow(TypeError);
    expect(() => {
      (LAYOUT_VENTAS_PROVISIONAL.columnas as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(LAYOUT_VENTAS_PROVISIONAL.oficial).toBe(false);
  });
});

describe("validarFilaVenta · una fila buena", () => {
  it("B001-290 (100.00 + 18.00 = 118.00) es válida y cuadra", () => {
    const r = validarFilaVenta(buena());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cuadra).toBe(true);
    expect(r.fila).toMatchObject({
      tipo: "03",
      serie: "B001",
      numero: "290",
      docContraparte: "-",
      fechaEmision: "2026-10-03",
      moneda: "PEN",
      baseGravada: "100.00",
      igv: "18.00",
      total: "118.00",
    });
  });

  it("con documento (RUC, tipo 6), USD con tipo de cambio y montos en cadena", () => {
    const r = validarFilaVenta(
      buena({ tipo: "01", serie: "F002", numero: "1", tipoDocContraparte: "6", docContraparte: "20700000011", moneda: "USD", tipoCambio: "3.300", baseGravada: "200.00", igv: "36.00", total: "236.00" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cuadra).toBe(true);
      expect(r.fila).toMatchObject({ tipoDocContraparte: "6", docContraparte: "20700000011", moneda: "USD", tipoCambio: "3.300" });
    }
  });

  it("USD sin tipo de cambio es válida (se informará aparte en el resumen, D11)", () => {
    const r = validarFilaVenta(buena({ moneda: "USD" }));
    expect(r.ok).toBe(true);
  });

  it("la nota de crédito con montos negativos es válida y cuadra", () => {
    const r = validarFilaVenta(buena({ tipo: "07", serie: "F001", numero: "1", baseGravada: "-50.00", igv: "-9.00", total: "-59.00" }));
    expect(r.ok && r.cuadra).toBe(true);
  });

  it("solo exonerada (cliente de la Amazonía): 150.00 cuadra con total 150.00", () => {
    const r = validarFilaVenta(buena({ tipo: "01", serie: "F001", numero: "12", baseGravada: "0.00", igv: "0.00", exonerada: "150.00", total: "150.00" }));
    expect(r.ok && r.cuadra).toBe(true);
  });

  it("los montos extremos de NUMERIC(14,2) entran: 999999999999.99 y -999999999999.99", () => {
    expect(validarFilaVenta(buena({ baseGravada: "999999999999.99", igv: "0.00", total: "999999999999.99" })).ok).toBe(true);
    expect(validarFilaVenta(buena({ baseGravada: "-999999999999.99", igv: "0.00", total: "-999999999999.99" })).ok).toBe(true);
  });

  it("el número puede traer ceros a la izquierda (se conserva tal cual; la clave los quita)", () => {
    const r = validarFilaVenta(buena({ numero: "00290" }));
    expect(r.ok && r.fila.numero).toBe("00290");
  });
});

describe("validarFilaVenta · cuadre exacto, tolerancia 0.00 (D3, D9)", () => {
  it("total 119.00 con 100.00 + 18.00: legible pero NO cuadra (ok true, cuadra false)", () => {
    const r = validarFilaVenta(buena({ total: "119.00" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cuadra).toBe(false);
      expect(r.fila.total, "no se corrige").toBe("119.00");
    }
  });

  it("un centavo de diferencia ya descuadra, hacia arriba o hacia abajo", () => {
    expect(validarFilaVenta(buena({ total: "118.01" }))).toMatchObject({ ok: true, cuadra: false });
    expect(validarFilaVenta(buena({ total: "117.99" }))).toMatchObject({ ok: true, cuadra: false });
  });

  it("suma las siete columnas: ISC, ICBPER, inafecta y otros entran en el cuadre", () => {
    const m = { baseGravada: "100.00", igv: "18.00", exonerada: "10.00", inafecta: "5.00", isc: "2.00", icbper: "0.50", otros: "1.25" };
    expect(validarFilaVenta(buena({ ...m, total: "136.75" }))).toMatchObject({ ok: true, cuadra: true });
    expect(validarFilaVenta(buena({ ...m, total: "136.74" }))).toMatchObject({ ok: true, cuadra: false });
  });

  it("el cuadre es en la moneda del comprobante (USD sin convertir)", () => {
    expect(validarFilaVenta(buena({ moneda: "USD", tipoCambio: "3.300", total: "118.00" }))).toMatchObject({ ok: true, cuadra: true });
  });
});

describe("validarFilaVenta · tipo, serie y número", () => {
  it("tipo de 2 caracteres: «1», «001», vacío y no cadenas fallan en `tipo`", () => {
    for (const malo of ["1", "001", ""]) expect(camposConError(buena({ tipo: malo })), `«${malo}»`).toEqual(["tipo"]);
  });

  it("serie de 4 alfanuméricos: «B01», «B0011», vacío y símbolos fallan en `serie`", () => {
    for (const malo of ["B01", "B0011", "", "B-01", "B 01", "B0|1"]) expect(camposConError(buena({ serie: malo })), `«${malo}»`).toEqual(["serie"]);
  });

  it("número: vacío, de más de 20 caracteres o con separador `|` fallan en `numero`", () => {
    for (const malo of ["", "1".repeat(21), "12|3"]) expect(camposConError(buena({ numero: malo })), `«${malo}»`).toEqual(["numero"]);
    expect(validarFilaVenta(buena({ numero: "1".repeat(20) })).ok).toBe(true);
  });
});

describe("validarFilaVenta · fecha real, moneda y tipo de cambio", () => {
  it("la fecha es AAAA-MM-DD y real: 30 de febrero, mes 13, año bisiesto y formatos ajenos", () => {
    for (const mala of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-10-32", "2026-10-5", "2026/10/05", "05/10/2026", "20261005", "", "ayer"]) {
      expect(camposConError(buena({ fechaEmision: mala })), `«${mala}»`).toEqual(["fechaEmision"]);
    }
    expect(validarFilaVenta(buena({ fechaEmision: "2028-02-29" })).ok, "2028 es bisiesto").toBe(true);
    expect(camposConError(buena({ fechaEmision: "2026-02-29" })), "2026 no lo es").toEqual(["fechaEmision"]);
  });

  it("la moneda es PEN o USD, en mayúsculas", () => {
    for (const mala of ["EUR", "pen", "usd", "", "S/"]) expect(camposConError(buena({ moneda: mala })), `«${mala}»`).toEqual(["moneda"]);
  });

  it("el tipo de cambio solo vale en USD: en PEN con valor falla en `tipoCambio`; vacío o ausente no", () => {
    expect(camposConError(buena({ moneda: "PEN", tipoCambio: "3.300" }))).toEqual(["tipoCambio"]);
    expect(validarFilaVenta(buena({ moneda: "PEN", tipoCambio: "" })).ok).toBe(true);
    expect(validarFilaVenta(buena({ moneda: "PEN", tipoCambio: null })).ok).toBe(true);
    expect(validarFilaVenta(buena({ moneda: "PEN" })).ok).toBe(true);
  });

  it("en USD el tipo de cambio debe ser válido (010: hasta 4 enteros y 3 decimales, mayor que cero)", () => {
    for (const malo of ["0", "0.000", "-3.3", "3.3456", "abc", "10000", "3,300"]) {
      expect(camposConError(buena({ moneda: "USD", tipoCambio: malo })), `«${malo}»`).toEqual(["tipoCambio"]);
    }
    for (const bueno of ["3.3", "3.300", "1", "9999.999"]) expect(validarFilaVenta(buena({ moneda: "USD", tipoCambio: bueno })).ok, bueno).toBe(true);
  });
});

describe("validarFilaVenta · montos como cadenas decimales (D9, CA-5)", () => {
  it("más de 2 decimales falla en esa columna (100.001, 0.005)", () => {
    for (const c of MONTOS) {
      expect(camposConError(buena({ [c]: "100.001" })), `${c} con 3 decimales`).toContain(c);
      expect(camposConError(buena({ [c]: "0.005" })), `${c} con 0.005`).toContain(c);
    }
  });

  it("fuera de NUMERIC(14,2): 1 000 000 000 000.00 y su negativo fallan", () => {
    expect(camposConError(buena({ baseGravada: "1000000000000.00", total: "1000000000000.00" }))).toContain("baseGravada");
    expect(camposConError(buena({ igv: "-1000000000000.00" }))).toContain("igv");
  });

  it("no son montos: vacío, texto, notación científica, coma decimal, miles, espacios y fórmulas", () => {
    for (const malo of ["", "abc", "1e3", "1,5", "1,000.00", " 1.00", "1.00 ", "=SUMA(A1)", "+1.00", ".5", "5.", "NaN", "Infinity", "0x10"]) {
      expect(camposConError(buena({ baseGravada: malo })), `«${malo}»`).toContain("baseGravada");
    }
  });

  it("un monto que no es cadena (número, null, objeto) falla: el dinero nunca entra como number", () => {
    for (const malo of [100, 118.0, null, undefined, {}, [], true]) {
      expect(camposConError(buena({ total: malo })), String(malo)).toContain("total");
    }
  });

  it("una columna ausente falla en esa columna", () => {
    for (const c of MONTOS) expect(camposConError(sin(c)), c).toContain(c);
  });

  it("un total ilegible hace la fila inválida; no se informa como «descuadrada»", () => {
    const r = validarFilaVenta(buena({ total: "abc" }));
    expect(r.ok).toBe(false);
  });
});

describe("validarFilaVenta · documento de la contraparte", () => {
  it("el documento no puede faltar ni estar vacío (consumidor final es «-»)", () => {
    expect(camposConError(sin("docContraparte"))).toEqual(["docContraparte"]);
    expect(camposConError(buena({ docContraparte: "" }))).toEqual(["docContraparte"]);
    expect(validarFilaVenta(buena({ docContraparte: "-" })).ok).toBe(true);
  });

  it("el tipo de documento es opcional", () => {
    expect(validarFilaVenta(sin("tipoDocContraparte")).ok).toBe(true);
    expect(validarFilaVenta(buena({ tipoDocContraparte: "6", docContraparte: "20700000011" })).ok).toBe(true);
  });
});

describe("validarFilaVenta · varios errores, filas raras y seguridad", () => {
  it("informa todos los campos con error a la vez, sin repetirlos", () => {
    expect(camposConError(buena({ tipo: "9", serie: "X", fechaEmision: "2026-02-30", moneda: "EUR", baseGravada: "1.234" }))).toEqual(
      ["baseGravada", "fechaEmision", "moneda", "serie", "tipo"].sort(),
    );
    const r = validarFilaVenta(buena({ tipo: "9", moneda: "EUR" }));
    if (!r.ok) {
      const campos = r.errores.map((e) => e.campo);
      expect(new Set(campos).size).toBe(campos.length);
    }
  });

  it("cada error trae `campo` y un `codigo` en mayúsculas; nunca el valor de la celda", () => {
    const secreto = "=cmd|' /C calc'!A0";
    const r = validarFilaVenta(buena({ numero: secreto, docContraparte: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.length).toBeGreaterThan(0);
    for (const e of r.errores) {
      expect(e.codigo).toMatch(/^[A-Z][A-Z_]*$/);
      expect(typeof e.campo).toBe("string");
    }
    expect(JSON.stringify(r)).not.toContain("calc");
    expect(JSON.stringify(r)).not.toContain("cmd");
  });

  it("una celda con fórmula (=, +, -, @) en el número o el documento se rechaza o se conserva como texto inerte, nunca se evalúa", () => {
    for (const celda of ["=1+1", "@SUM(A1)", "+cmd"]) {
      const r = validarFilaVenta(buena({ numero: celda }));
      if (r.ok) expect(r.fila.numero).toBe(celda);
      else expect(r.errores.map((e) => e.campo)).toContain("numero");
    }
  });

  it("entradas que no son una fila no lanzan: null, undefined, cadena, número, arreglo y objeto vacío dan ok:false", () => {
    for (const rara of [null, undefined, "fila", 42, [], [buena()], {}]) {
      expect(() => validarFilaVenta(rara)).not.toThrow();
      expect(validarFilaVenta(rara).ok, String(rara)).toBe(false);
    }
  });

  it("las claves desconocidas, __proto__ y las heredadas no se cuelan en la fila validada", () => {
    const sucia = JSON.parse(
      '{"tipo":"03","serie":"B001","numero":"290","docContraparte":"-","fechaEmision":"2026-10-03","moneda":"PEN","baseGravada":"100.00","igv":"18.00","exonerada":"0.00","inafecta":"0.00","isc":"0.00","icbper":"0.00","otros":"0.00","total":"118.00","extra":"x","__proto__":{"total":"1.00"}}',
    ) as unknown;
    const r = validarFilaVenta(sucia);
    if (r.ok) {
      expect(Object.keys(r.fila)).not.toContain("extra");
      expect(r.fila.total).toBe("118.00");
    }
    const proto = Object.prototype as Record<string, unknown>;
    proto.total = "999.00";
    try {
      expect(camposConError(sin("total")), "un `total` heredado de Object.prototype no cuenta").toContain("total");
    } finally {
      delete proto.total;
    }
  });

  it("no muta la entrada (congelada) y es determinista", () => {
    const cruda = Object.freeze(buena({ total: "119.00" }));
    const a = validarFilaVenta(cruda);
    const b = validarFilaVenta(cruda);
    expect(a).toEqual(b);
    expect(cruda.total).toBe("119.00");
  });
});
