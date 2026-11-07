// Spec 013 (T3, rojo): formato RVIE provisional de ventas y `Libro` con "ventas" (D13; CA-12; plan: `provisional-rve.ts`,
// `tipos.ts`, `registro.ts`). Es solo la DEFINICIÓN del formato: `prevalidar` y `generarTxt` no cambian (P-8, 012b los
// generaliza), así que aquí nada genera un TXT de ventas. Las pruebas de 012 (compras) siguen como están.
// Contrato que fija la prueba (T10):
//   - `Libro` = "compras" | "ventas"; `RegistroFormatos.desde` acepta definiciones de `ventas`;
//   - `REGISTRO_FORMATOS` trae, además del RCE, un formato de ventas `oficial: false`, versión "0-provisional", con id que
//     empieza por «RVIE», seleccionable con `seleccionarFormato("ventas", periodo)`;
//   - sus campos incluyen los de una venta (periodo, comprobante, fecha, moneda, tipo de cambio y los ocho montos de D14b);
//   - su nombre de archivo es inconfundible con uno oficial (CONTAPP-PROVISIONAL-…) y pasa `validarNombreArchivo`.
import { describe, expect, it } from "vitest";
import {
  FormatoNoVigenteError,
  REGISTRO_FORMATOS,
  RegistroFormatos,
  generarTxt,
  seleccionarFormato,
  validarNombreArchivo,
} from "../index";
import type { FormatoTxt, Libro } from "../index";
import { formatoDePrueba } from "../../tests/ayudas/formatos";
import { CABECERA, filasValidas } from "../../tests/ayudas/filas-reemplazo";

const rve = (periodo = "202610"): FormatoTxt => seleccionarFormato("ventas", periodo);
const MONTOS = ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"];

describe("Libro incluye «ventas»", () => {
  it("el tipo admite «ventas» (se comprueba al compilar) y el registro acepta una definición de ese libro", () => {
    const libro: Libro = "ventas";
    expect(libro).toBe("ventas");
    expect(() => RegistroFormatos.desde([formatoDePrueba({ libro: "ventas", id: "VENTAS-PRUEBA" })])).not.toThrow();
  });

  it("un registro con un formato de cada libro (misma vigencia) elige cada uno por su libro", () => {
    const reg = RegistroFormatos.desde([
      formatoDePrueba({ libro: "compras", id: "C", version: "1" }),
      formatoDePrueba({ libro: "ventas", id: "V", version: "1" }),
    ]);
    expect(seleccionarFormato("compras", "202610", reg).id).toBe("C");
    expect(seleccionarFormato("ventas", "202610", reg).id).toBe("V");
  });

  it("un libro sin formatos sigue siendo FormatoNoVigenteError: el de ventas no responde por compras", () => {
    const soloVentas = RegistroFormatos.desde([formatoDePrueba({ libro: "ventas", id: "V" })]);
    expect(() => seleccionarFormato("compras", "202610", soloVentas)).toThrow(FormatoNoVigenteError);
    expect(seleccionarFormato("ventas", "202610", soloVentas).libro).toBe("ventas");
  });

  it("libros inexistentes siguen rechazados", () => {
    expect(() => RegistroFormatos.desde([formatoDePrueba({ libro: "diario" as Libro })])).toThrow();
  });
});

describe("formato RVIE provisional · identidad y registro", () => {
  it("lo acepta el registro por defecto: libro ventas, no oficial, versión 0-provisional", () => {
    const f = rve();
    expect(f.libro).toBe("ventas");
    expect(f.oficial).toBe(false);
    expect(f.version).toBe("0-provisional");
    expect(f.id).toMatch(/^RVIE/);
    expect(f.vigenteDesde).toMatch(/^[0-9]{6}$/);
    expect(f.vigenteDesde <= "202610").toBe(true);
  });

  it("todos los periodos desde su vigencia lo eligen, y es el único de ventas", () => {
    const f = rve();
    for (const p of ["202610", "202612", "203001", "209912"]) expect(seleccionarFormato("ventas", p, REGISTRO_FORMATOS)).toBe(f);
  });

  it("antes de su vigencia no hay formato de ventas (FormatoNoVigenteError)", () => {
    expect(() => seleccionarFormato("ventas", "200001")).toThrow(FormatoNoVigenteError);
  });

  it("el RCE de compras no cambia: mismo id, versión, vigencia y no oficial", () => {
    const c = seleccionarFormato("compras", "202610");
    expect(c.id).toBe("RCE-REEMPLAZO");
    expect(c.version).toBe("0-provisional");
    expect(c.vigenteDesde).toBe("202601");
    expect(c.oficial).toBe(false);
    expect(rve().id).not.toBe(c.id);
  });

  it("se puede volver a registrar tal como está (la definición pasa su propia validación)", () => {
    expect(() => RegistroFormatos.desde([seleccionarFormato("compras", "202610"), rve()])).not.toThrow();
  });

  it("está congelado: formato, campos y cada campo; no se puede marcar como oficial", () => {
    const f = rve();
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.campos)).toBe(true);
    expect(f.campos.every((c) => Object.isFrozen(c))).toBe(true);
    expect(() => {
      (f as { oficial: boolean }).oficial = true;
    }).toThrow(TypeError);
    expect(rve().oficial).toBe(false);
  });
});

describe("formato RVIE provisional · campos (D14b)", () => {
  const por = (n: string) => rve().campos.find((c) => c.nombre === n);

  it("trae el periodo, el comprobante, la fecha, la moneda, el tipo de cambio y los ocho montos", () => {
    const nombres = rve().campos.map((c) => c.nombre);
    for (const n of ["periodo", "tipoComprobante", "serie", "numero", "fechaEmision", "moneda", "tipoCambio", ...MONTOS]) {
      expect(nombres, n).toContain(n);
    }
    expect(new Set(nombres).size, "sin campos repetidos").toBe(nombres.length);
  });

  it("los ocho montos son de tipo `monto`, obligatorios y de 16 caracteres (NUMERIC(14,2) con signo)", () => {
    for (const m of MONTOS) expect(por(m), m).toMatchObject({ tipo: "monto", obligatorio: true, longitudMax: 16 });
  });

  it("la fecha es de tipo `fecha` y el tipo de cambio, `tc` opcional de 8 (obligatorio solo en USD, 012 D23)", () => {
    expect(por("fechaEmision")).toMatchObject({ tipo: "fecha", obligatorio: true });
    expect(por("tipoCambio")).toMatchObject({ tipo: "tc", obligatorio: false, longitudMax: 8 });
  });

  it("tipo de comprobante de 2, serie de 4 y número de hasta 8 dígitos, con patrón", () => {
    expect(por("tipoComprobante")).toMatchObject({ longitudMax: 2, obligatorio: true });
    expect(por("serie")).toMatchObject({ longitudMax: 4, obligatorio: true });
    expect(por("numero")).toMatchObject({ longitudMax: 8, obligatorio: true });
    expect(por("serie")!.patron!.test("B001")).toBe(true);
    expect(por("serie")!.patron!.test("B0011")).toBe(false);
    expect(por("numero")!.patron!.test("291")).toBe(true);
    expect(por("numero")!.patron!.test("29A")).toBe(false);
  });

  it("a lo más un campo `ruc`, el del documento de la contraparte: ningún otro campo de texto lo declara (D13)", () => {
    const rucs = rve().campos.filter((c) => c.tipo === "ruc");
    expect(rucs.length).toBeLessThanOrEqual(1);
    for (const c of rve().campos) {
      if (["serie", "numero", "tipoComprobante", "razonSocial", "periodo", "moneda"].includes(c.nombre)) expect(c.tipo, c.nombre).not.toBe("ruc");
    }
  });
});

describe("formato RVIE provisional · nombre de archivo", () => {
  const nombre = (ruc = "20700000002", periodo = "202610") => rve().nombre({ ruc, periodo });

  it("empieza por CONTAPP-PROVISIONAL, lleva el RUC y el periodo y no se confunde con el de compras", () => {
    const n = nombre();
    expect(n.nombreTxt).toMatch(/^CONTAPP-PROVISIONAL-20700000002-202610-[A-Z]+\.txt$/);
    expect(n.nombreZip).toBe(n.nombreTxt.replace(/\.txt$/, ".zip"));
    const c = seleccionarFormato("compras", "202610").nombre({ ruc: "20700000002", periodo: "202610" });
    expect(n.nombreTxt).not.toBe(c.nombreTxt);
    expect(n.nombreZip).not.toBe(c.nombreZip);
  });

  it("pasa validarNombreArchivo (gramática de los formatos del registro) y es puro y congelado", () => {
    const n = nombre();
    expect(validarNombreArchivo(n.nombreTxt)).toBe(true);
    expect(validarNombreArchivo(n.nombreZip)).toBe(true);
    expect(nombre()).toEqual(n);
    expect(Object.isFrozen(n)).toBe(true);
  });

  it("componentes malos lanzan, como en compras (RUC de 11 dígitos y periodo AAAAMM)", () => {
    expect(() => nombre("2070000000", "202610")).toThrow();
    expect(() => nombre("20700000002", "202613")).toThrow();
    expect(() => nombre("../../etc/passwd", "202610")).toThrow();
  });

  it("las gramáticas de compras siguen valiendo y un nombre ajeno sigue sin valer", () => {
    expect(validarNombreArchivo("CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt")).toBe(true);
    expect(validarNombreArchivo("LE20700000002202610000000000000.txt")).toBe(false);
  });
});

describe("formato RVIE provisional · no genera nada en 013 (P-8)", () => {
  it("generarTxt con libro «ventas» y sin permitirProvisional no produce bytes (lanza)", () => {
    expect(() => generarTxt(filasValidas(2), { ...CABECERA, libro: "ventas" })).toThrow();
    expect(() => generarTxt(filasValidas(2), { ...CABECERA, libro: "ventas" }, {})).toThrow();
  });

  it("el formato es `oficial: false`: en producción solo se genera con permitirProvisional, que el servicio nunca activa", () => {
    expect(rve().oficial).toBe(false);
  });
});
