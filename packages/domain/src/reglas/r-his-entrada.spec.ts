// R-HIS (021, T15): entradas inválidas y bordes de planificarHistorial. Falla cerrado (EntradaReglasInvalidaError, sin
// resultados parciales) ante forma inválida; un documento fuera de gramática no es error, solo no coincide con nada.
import { describe, expect, it } from "vitest";
import { fila, montos } from "../../tests/ayudas/filas-motor";
import { EntradaReglasInvalidaError } from "./errores";
import { planificarHistorial } from "./r-his";
import type { FilaEvaluable, ReglaAprendidaEvaluable } from "./index";

const PROVEEDOR = { tipo: "6", numero: "20100000001" };
const regla = (over: Record<string, unknown> = {}): ReglaAprendidaEvaluable =>
  ({ id: "regla-1", proveedor: { ...PROVEEDOR }, destino: "DNG", ...over }) as unknown as ReglaAprendidaEvaluable;
const gravada = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
const filaValida = (over: Partial<FilaEvaluable> = {}) => fila({ montos: gravada(), ...over });
const ACTIVA = { rHisActiva: true };
const plan = (filas: unknown, reglas: unknown, op: unknown = ACTIVA) =>
  planificarHistorial(filas as FilaEvaluable[], reglas as ReglaAprendidaEvaluable[], op as { rHisActiva: boolean });

describe("planificarHistorial: opciones inválidas", () => {
  it.each([
    ["rHisActiva ausente", {}],
    ["rHisActiva no booleano (string)", { rHisActiva: "true" }],
    ["rHisActiva no booleano (1)", { rHisActiva: 1 }],
    ["rHisActiva null", { rHisActiva: null }],
    ["clave extra", { rHisActiva: true, otra: 1 }],
    ["null", null],
    ["arreglo", []],
  ])("%s lanza EntradaReglasInvalidaError", (_n, op) => {
    expect(() => plan([filaValida()], [regla()], op)).toThrow(EntradaReglasInvalidaError);
  });

  it("opciones inválidas fallan aunque no haya filas ni reglas", () => {
    expect(() => plan([], [], { rHisActiva: "si" })).toThrow(EntradaReglasInvalidaError);
  });
});

describe("planificarHistorial: reglas inválidas", () => {
  it.each([
    ["id vacío", { id: "" }],
    ["id no string", { id: 7 }],
    ["destino fuera de catálogo", { destino: "XX" }],
    ["destino no string", { destino: 1 }],
    ["clave extra", { extra: true }],
    ["sin proveedor", { proveedor: undefined }],
    ["proveedor null", { proveedor: null }],
    ["proveedor con tipo numérico", { proveedor: { tipo: 6, numero: "20100000001" } }],
    ["proveedor con numero numérico", { proveedor: { tipo: "6", numero: 20100000001 } }],
    ["proveedor con clave extra", { proveedor: { ...PROVEEDOR, x: "1" } }],
  ])("%s lanza EntradaReglasInvalidaError", (_n, over) => {
    expect(() => plan([filaValida()], [regla(over)])).toThrow(EntradaReglasInvalidaError);
  });

  it("una regla que no es objeto lanza", () => {
    expect(() => plan([filaValida()], [null])).toThrow(EntradaReglasInvalidaError);
    expect(() => plan([filaValida()], ["regla"])).toThrow(EntradaReglasInvalidaError);
  });

  it("reglas que no es un arreglo lanza", () => {
    expect(() => plan([filaValida()], {})).toThrow(EntradaReglasInvalidaError);
    expect(() => plan([filaValida()], undefined)).toThrow(EntradaReglasInvalidaError);
  });

  it("una regla inválida invalida todo el lote aunque otra sea buena (sin resultados parciales)", () => {
    expect(() => plan([filaValida()], [regla(), regla({ id: "" , proveedor: { tipo: "6", numero: "20999999999" } })])).toThrow(
      EntradaReglasInvalidaError,
    );
  });
});

describe("planificarHistorial: documento de la regla fuera de gramática (no es error, no se aplica)", () => {
  it.each([
    ["tipo con más de un carácter", { tipo: "66", numero: "20100000001" }],
    ["tipo en minúscula", { tipo: "a", numero: "20100000001" }],
    ["numero vacío", { tipo: "6", numero: "" }],
    ["numero con símbolos", { tipo: "6", numero: "2010*000001" }],
    ["numero de más de 15 caracteres", { tipo: "6", numero: "1234567890123456" }],
    ["numero de más de 64 caracteres", { tipo: "6", numero: "1".repeat(65) }],
    ["tipo de más de 64 caracteres", { tipo: "6".repeat(65), numero: "20100000001" }],
  ])("%s: la regla no se aplica y no lanza", (_n, proveedor) => {
    expect(plan([filaValida()], [regla({ proveedor })])).toEqual([]);
  });

  it("la regla fuera de gramática se ignora y otra válida sigue aplicando", () => {
    const r = plan([filaValida()], [regla({ id: "mala", proveedor: { tipo: "6", numero: "x".repeat(65) } }), regla({ id: "buena" })]);
    expect(r.map((p) => p.reglaId)).toEqual(["buena"]);
  });
});

describe("planificarHistorial: dos reglas del mismo proveedor son ambiguas (falla cerrado)", () => {
  it("misma clave literal: ninguna se aplica", () => {
    expect(plan([filaValida()], [regla({ id: "r1" }), regla({ id: "r2", destino: "DGNG" })])).toEqual([]);
  });

  it("misma clave tras normalizar (espacios y minúsculas): ninguna se aplica", () => {
    const filas = [filaValida({ proveedor: { tipo: "1", numero: "AB-123" } })];
    const reglas = [
      regla({ id: "r1", proveedor: { tipo: "1", numero: "AB-123" } }),
      regla({ id: "r2", proveedor: { tipo: "1", numero: " ab -123 " } }),
    ];
    expect(plan(filas, reglas)).toEqual([]);
  });

  it("tres reglas del mismo proveedor: sigue sin aplicarse ninguna", () => {
    expect(plan([filaValida()], [regla({ id: "r1" }), regla({ id: "r2" }), regla({ id: "r3" })])).toEqual([]);
  });

  it("la ambigüedad de un proveedor no afecta al de otro", () => {
    const otro = { tipo: "6", numero: "20999999999" };
    const filas = [filaValida({ id: "a" }), filaValida({ id: "b", proveedor: otro })];
    const r = plan(filas, [regla({ id: "r1" }), regla({ id: "r2" }), regla({ id: "r3", proveedor: otro })]);
    expect(r.map((p) => [p.filaId, p.reglaId])).toEqual([["b", "r3"]]);
  });
});

describe("planificarHistorial: filas inválidas", () => {
  it.each([
    ["id vacío", { id: "" }],
    ["id no string", { id: 3 }],
    ["montos que no son MontosComprobante", { montos: { total: "118.00" } }],
    ["montos null", { montos: null }],
    ["montos con moneda desconocida", { montos: { moneda: "EUR" } }],
    ["montos que imitan la forma de la marca", { montos: { moneda: "PEN", sumar: () => undefined } }],
    ["proveedor con tipo no string", { proveedor: { tipo: 6, numero: "20100000001" } }],
    ["proveedor con numero no string", { proveedor: { tipo: "6", numero: null } }],
    ["proveedor con clave extra", { proveedor: { ...PROVEEDOR, x: "1" } }],
    ["clave desconocida en la fila", { desconocida: 1 }],
  ])("%s lanza EntradaReglasInvalidaError", (_n, over) => {
    expect(() => plan([{ ...filaValida(), ...over }], [regla()])).toThrow(EntradaReglasInvalidaError);
  });

  it("fila sin montos o sin proveedor (requeridos) lanza", () => {
    const { montos: _m, ...sinMontos } = filaValida();
    const { proveedor: _p, ...sinProveedor } = filaValida();
    expect(() => plan([sinMontos], [regla()])).toThrow(EntradaReglasInvalidaError);
    expect(() => plan([sinProveedor], [regla()])).toThrow(EntradaReglasInvalidaError);
  });

  it("filas que no es un arreglo, o con elementos no objeto, lanza", () => {
    expect(() => plan({}, [regla()])).toThrow(EntradaReglasInvalidaError);
    expect(() => plan(null, [regla()])).toThrow(EntradaReglasInvalidaError);
    expect(() => plan([null], [regla()])).toThrow(EntradaReglasInvalidaError);
  });

  it("una fila inválida invalida el lote aunque otra sea buena (sin resultados parciales)", () => {
    expect(() => plan([filaValida({ id: "a" }), { ...filaValida({ id: "b" }), montos: null }], [regla()])).toThrow(
      EntradaReglasInvalidaError,
    );
  });

  it("con R-HIS apagado la entrada se valida igual: una fila inválida sigue lanzando", () => {
    expect(() => plan([{ ...filaValida(), id: "" }], [regla()], { rHisActiva: false })).toThrow(EntradaReglasInvalidaError);
    expect(() => plan([filaValida()], [regla({ destino: "XX" })], { rHisActiva: false })).toThrow(EntradaReglasInvalidaError);
  });
});

describe("planificarHistorial: documento de la fila fuera de gramática (no es error, no se mueve)", () => {
  it.each([
    ["numero con símbolos", { tipo: "6", numero: "2010*000001" }],
    ["numero vacío", { tipo: "6", numero: "" }],
    ["tipo vacío", { tipo: "", numero: "20100000001" }],
    ["numero de más de 15 caracteres", { tipo: "6", numero: "1234567890123456" }],
    ["numero de más de 64 caracteres", { tipo: "6", numero: "1".repeat(65) }],
    ["tipo de más de 64 caracteres", { tipo: "6".repeat(65), numero: "20100000001" }],
  ])("%s: no se mueve y no lanza", (_n, proveedor) => {
    expect(plan([filaValida({ proveedor })], [regla()])).toEqual([]);
  });

  it("una fila rara no detiene a las demás (D-4)", () => {
    const filas = [filaValida({ id: "rara", proveedor: { tipo: "6", numero: "x".repeat(65) } }), filaValida({ id: "ok" })];
    expect(plan(filas, [regla()]).map((p) => p.filaId)).toEqual(["ok"]);
  });
});
