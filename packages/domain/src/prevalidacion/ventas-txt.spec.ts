// Spec 012b (T1, rojo): `generarTxt` de ventas con el RVIE provisional (D2, D12; CA-10, CA-15). Contrato (T7):
//  - `generarTxt(filas, cabecera de ventas, { permitirProvisional: true })`: una línea por venta no excluida, ordenada por
//    fecha, tipo, serie y número (D6); campos del formato RVIE en su orden, separador `|`, fin de línea CRLF, latin1.
//  - Fecha DD/MM/AAAA; montos con escala (2 decimales); tipo de cambio con 3 decimales solo en USD; el consumidor final
//    va con tipo de documento vacío y documento «-»; nombres CONTAPP-PROVISIONAL-{ruc}-{periodo}-RVIE.{txt,zip}.
//  - Sin permitirProvisional lanza FormatoProvisionalError; una fila con error, ArchivoNoPrevalidadoError; una excluida
//    no se prevalida ni sale en el TXT.
import { describe, expect, it } from "vitest";
import { ArchivoNoPrevalidadoError, FormatoProvisionalError, generarTxt } from "../index";
import type { FilaReemplazoVenta } from "../index";
import { lineasCrlf } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, comoExcluida, filaVenta, filasFixtureVentas, ventaNum } from "../../tests/ayudas/filas-venta";

const PROV = { permitirProvisional: true } as const;
const gen = (filas: FilaReemplazoVenta[]) => generarTxt(filas, CABECERA_VENTAS, PROV);

describe("generarTxt de ventas · líneas", () => {
  const consumidor = filaVenta(); // B001-290, 2026-10-03, consumidor final
  const factura = ventaNum("01", "F001", "10", {
    fechaEmision: "2026-10-01",
    contraparte: { tipo: "6", numero: "20700000011" },
    montos: { baseGravada: "200.00", igv: "36.00" },
  });
  const nc = ventaNum("07", "F001", "1", {
    fechaEmision: "2026-10-12",
    contraparte: { tipo: "6", numero: "20700000011" },
    montos: { baseGravada: "-50.00", igv: "-9.00" },
  });
  const usd = ventaNum("01", "F002", "1", {
    fechaEmision: "2026-10-20",
    moneda: "USD",
    tipoCambio: "3.300",
    contraparte: { tipo: "6", numero: "20700000045" },
    montos: { baseGravada: "200.00", igv: "36.00" },
  });

  it("una línea por venta, en orden de fecha y con los campos del RVIE: factura, boleta al consumidor final, NC y USD", () => {
    const r = gen([usd, nc, consumidor, factura]);
    expect(lineasCrlf(r.bytes)).toEqual([
      "202610|01|F001|10|01/10/2026|6|20700000011|PEN||200.00|36.00|0.00|0.00|0.00|0.00|0.00|236.00",
      "202610|03|B001|290|03/10/2026||-|PEN||100.00|18.00|0.00|0.00|0.00|0.00|0.00|118.00",
      "202610|07|F001|1|12/10/2026|6|20700000011|PEN||-50.00|-9.00|0.00|0.00|0.00|0.00|0.00|-59.00",
      "202610|01|F002|1|20/10/2026|6|20700000045|USD|3.300|200.00|36.00|0.00|0.00|0.00|0.00|0.00|236.00",
    ]);
    expect(r.lineas).toBe(4);
  });

  it("el TXT termina en CRLF y está en latin1 (cada byte es un carácter)", () => {
    const r = gen([consumidor]);
    const bytes = Array.from(r.bytes);
    expect(bytes.slice(-2)).toEqual([0x0d, 0x0a]);
    expect(bytes.every((b) => b < 0x80)).toBe(true);
  });

  it("el número se ordena como número (B001-9 antes que B001-10) y el id desempata", () => {
    const m = (n: string) => ventaNum("03", "B001", n, { fechaEmision: "2026-10-03" });
    const r = gen([m("10"), m("9"), m("100")]);
    expect(lineasCrlf(r.bytes).map((l) => l.split("|")[3])).toEqual(["9", "10", "100"]);
  });

  it("el resultado trae el nombre RVIE provisional, provisional = true, el formato y las líneas", () => {
    const r = gen([consumidor]);
    expect(r.nombreTxt).toBe("CONTAPP-PROVISIONAL-20700000002-202610-RVIE.txt");
    expect(r.nombreZip).toBe("CONTAPP-PROVISIONAL-20700000002-202610-RVIE.zip");
    expect(r.provisional).toBe(true);
    expect(r.formato).toEqual({ id: "RVIE-REEMPLAZO", version: "0-provisional" });
    expect(r.lineas).toBe(1);
  });

  it("es determinista: el orden de entrada no cambia los bytes", () => {
    const a = gen([usd, nc, consumidor, factura]);
    const b = gen([factura, consumidor, nc, usd]);
    expect(Array.from(b.bytes)).toEqual(Array.from(a.bytes));
  });

  it("el fixture de ventas sin la USD sin tipo de cambio (excluida) genera 10 líneas", () => {
    const filas = filasFixtureVentas().map((f) => (f.id === "01-F002-2" ? comoExcluida(f) : f));
    const r = gen(filas);
    expect(r.lineas).toBe(10);
    expect(lineasCrlf(r.bytes).some((l) => l.includes("|F002|2|"))).toBe(false);
  });
});

describe("generarTxt de ventas · excluidas y errores (D12)", () => {
  const ok = filaVenta({ id: "ok", comprobante: { tipo: "03", serie: "B001", numero: "1" } });
  const descuadrada = filaVenta({ id: "desc", comprobante: { tipo: "03", serie: "B001", numero: "2" }, montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
  const usdSinTc = ventaNum("01", "F002", "2", { moneda: "USD", montos: { baseGravada: "100.00", igv: "18.00" } });

  it("una descuadrada y una USD sin tipo de cambio excluidas no se prevalidan ni salen en el TXT", () => {
    const r = gen([ok, comoExcluida(descuadrada), comoExcluida(usdSinTc)]);
    expect(r.lineas).toBe(1);
    expect(lineasCrlf(r.bytes)).toHaveLength(1);
    expect(lineasCrlf(r.bytes)[0]).toContain("|B001|1|");
  });

  it("sin excluirlas, la descuadrada impide generar: ArchivoNoPrevalidadoError y ningún byte", () => {
    expect(gen([ok]).lineas).toBe(1);
    expect(() => gen([ok, descuadrada])).toThrow(ArchivoNoPrevalidadoError);
  });

  it("todas excluidas: no hay archivo (SIN_FILAS)", () => {
    expect(gen([ok]).lineas).toBe(1);
    expect(() => gen([comoExcluida(ok)])).toThrow(ArchivoNoPrevalidadoError);
  });

  it("sin permitirProvisional no se genera ventas (el formato es no oficial)", () => {
    expect(gen([ok]).lineas).toBe(1);
    expect(() => generarTxt([ok], CABECERA_VENTAS)).toThrow(FormatoProvisionalError);
    expect(() => generarTxt([ok], CABECERA_VENTAS, { permitirProvisional: false })).toThrow(FormatoProvisionalError);
  });
});
