// Spec 012b (T1, rojo): `canonHuella` (P-2, D4, D12). Contrato que fija la prueba (T7):
//  - `canonHuella({ cabecera, formato, original, vigente }) → string`: texto canónico versionado «h1» (la huella es
//    sha256Hex del texto, fuera del dominio). Determinista y sin depender del orden de entrada (las filas van por id).
//  - Cambia con cualquier dato que vaya al TXT o al resumen: cabecera, formato (id y versión), cada fila de las dos
//    listas con su id, estado y todos sus campos y montos, y las listas mismas. Excluir o restaurar una venta lo cambia
//    (y restaurar vuelve al texto de antes).
//  - NO cambia con lo que no afecta al archivo: avisos (p. ej. `xml` de una compra), ni con el orden de entrada.
//  - Libro y filas deben coincidir (cabecera de ventas con filas de compras, o al revés, lanza).
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, canonHuella } from "../index";
import type { EntradaCanonHuella, FilaReemplazo, FilaReemplazoVenta } from "../index";
import { CABECERA, filaReemplazo, filasFixture, filasFixtureCorregidas, montosDe, xmlDe } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, comoExcluida, filaVenta, filasFixtureVentas, montosVenta, ventaNum } from "../../tests/ayudas/filas-venta";

const FORMATO_RCE = { id: "RCE-REEMPLAZO", version: "0-provisional", oficial: false };
const FORMATO_RVIE = { id: "RVIE-REEMPLAZO", version: "0-provisional", oficial: false };

const compras = (over: Partial<EntradaCanonHuella> = {}): EntradaCanonHuella => ({
  cabecera: CABECERA,
  formato: FORMATO_RCE,
  original: filasFixture(),
  vigente: filasFixtureCorregidas(),
  ...over,
});
const ventas = (over: Partial<EntradaCanonHuella> = {}): EntradaCanonHuella => ({
  cabecera: CABECERA_VENTAS,
  formato: FORMATO_RVIE,
  original: filasFixtureVentas().filter((f) => f.id !== "01-F002-2"),
  vigente: filasFixtureVentas().filter((f) => f.id !== "01-F002-2"),
  ...over,
});

const canon = (e: EntradaCanonHuella): string => canonHuella(e);

describe("canonHuella · forma y determinismo", () => {
  it("es un texto «h1» no vacío, igual en dos llamadas y sin mutar la entrada", () => {
    const e = compras();
    const copia = JSON.stringify(e.vigente);
    const c = canon(e);
    expect(typeof c).toBe("string");
    expect(c).toMatch(/^h1/);
    expect(c.length).toBeGreaterThan(0);
    expect(canon(compras())).toBe(c);
    expect(JSON.stringify(e.vigente)).toBe(copia);
  });

  it("no depende del orden de entrada de las filas (compras y ventas)", () => {
    const base = compras();
    const invertida = compras({ original: [...(base.original as FilaReemplazo[])].reverse(), vigente: [...(base.vigente as FilaReemplazo[])].reverse() });
    expect(canon(invertida)).toBe(canon(base));
    const v = ventas();
    const vInv = ventas({ original: [...(v.original as FilaReemplazoVenta[])].reverse(), vigente: [...(v.vigente as FilaReemplazoVenta[])].reverse() });
    expect(canon(vInv)).toBe(canon(v));
  });

  it("no cambia con los avisos: el `xml` de una compra (que solo alimenta R-ISC, R-NEW y R-GP) no entra", () => {
    const sin = canon(compras());
    const vig = filasFixtureCorregidas().map((f) =>
      f.id === "F001-3064" ? { ...f, xml: xmlDe({ gravado: "100.00", igv: "18.00", icbper: "1.50", total: "119.50" }) } : f,
    );
    expect(canon(compras({ vigente: vig }))).toBe(sin);
  });

  it("ventas y compras no comparten texto", () => {
    expect(canon(ventas())).not.toBe(canon(compras()));
  });

  it("libro y filas deben coincidir: cabecera de ventas con filas de compras, o de compras con filas de ventas, lanza", () => {
    expect(() => canon(compras())).not.toThrow();
    expect(() => canon(compras({ cabecera: CABECERA_VENTAS }))).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => canon(ventas({ cabecera: CABECERA }))).toThrow(EntradaPrevalidacionInvalidaError);
  });
});

describe("canonHuella · compras: cambia con cualquier campo del TXT o del resumen", () => {
  const base = (): string => canon(compras());
  const vigenteCon = (mod: (f: FilaReemplazo) => FilaReemplazo, id = "F001-3064"): EntradaCanonHuella =>
    compras({ vigente: filasFixtureCorregidas().map((f) => (f.id === id ? mod(f) : f)) });

  it("la cabecera: RUC declarante y periodo", () => {
    expect(canon(compras({ cabecera: { ...CABECERA, rucDeclarante: "20700000010" } }))).not.toBe(base());
    expect(canon(compras({ cabecera: { ...CABECERA, periodo: "202611" } }))).not.toBe(base());
  });

  it("el formato: id y versión", () => {
    expect(canon(compras({ formato: { ...FORMATO_RCE, version: "2" } }))).not.toBe(base());
    expect(canon(compras({ formato: { ...FORMATO_RCE, id: "RCE-OTRO" } }))).not.toBe(base());
  });

  it.each([
    ["tipo de comprobante", (f: FilaReemplazo) => ({ ...f, comprobante: { ...f.comprobante, tipo: "03" } })],
    ["serie", (f: FilaReemplazo) => ({ ...f, comprobante: { ...f.comprobante, serie: "F002" } })],
    ["número", (f: FilaReemplazo) => ({ ...f, comprobante: { ...f.comprobante, numero: "3065" } })],
    ["tipo de documento del proveedor", (f: FilaReemplazo) => ({ ...f, proveedor: { ...f.proveedor, tipo: "1" } })],
    ["número de documento del proveedor", (f: FilaReemplazo) => ({ ...f, proveedor: { ...f.proveedor, numero: "20700000045" } })],
    ["razón social", (f: FilaReemplazo) => ({ ...f, proveedor: { ...f.proveedor, razonSocial: "OTRA SAC" } })],
    ["fecha de emisión", (f: FilaReemplazo) => ({ ...f, fechaEmision: "2026-10-09" })],
    ["un monto (BI DG)", (f: FilaReemplazo) => ({ ...f, montos: montosDe("PEN", { biDg: "100.01", igvDg: "18.00", icbper: "1.50" }) })],
    ["un monto movido de columna (IGV a DGNG)", (f: FilaReemplazo) => ({ ...f, montos: montosDe("PEN", { biDgng: "100.00", igvDgng: "18.00", icbper: "1.50" }) })],
    ["el ICBPER", (f: FilaReemplazo) => ({ ...f, montos: montosDe("PEN", { biDg: "100.00", igvDg: "18.00", icbper: "0.50" }) })],
    ["el estado de la fila", (f: FilaReemplazo) => ({ ...f, estado: "modificada" as const })],
    ["excluirla", (f: FilaReemplazo) => ({ ...f, estado: "excluida" as const })],
  ] as const)("la fila vigente: %s", (_nombre, mod) => {
    expect(canon(vigenteCon(mod))).not.toBe(base());
  });

  it("la moneda y el tipo de cambio de una USD", () => {
    const cambiaTc = vigenteCon((f) => ({ ...f, tipoCambio: "3.301" }), "F001-4062");
    expect(canon(cambiaTc)).not.toBe(base());
    const aPen = vigenteCon((f) => ({ ...f, montos: montosDe("PEN", { biDg: "0.15", igvDg: "0.03" }), tipoCambio: null }), "F001-4062");
    expect(canon(aPen)).not.toBe(base());
  });

  it("agregar una fila a la vigente, o quitar una de las dos listas", () => {
    const extra = filaReemplazo(undefined, { id: "nueva", estado: "agregada", comprobante: { tipo: "01", serie: "F001", numero: "9990" } });
    expect(canon(compras({ vigente: [...filasFixtureCorregidas(), extra] }))).not.toBe(base());
    expect(canon(compras({ original: filasFixture().slice(1), vigente: filasFixtureCorregidas().slice(1) }))).not.toBe(base());
  });

  it("el id de la fila (en las dos listas)", () => {
    const renombra = (f: FilaReemplazo): FilaReemplazo => (f.id === "F001-3064" ? { ...f, id: "F001-3064-b" } : f);
    expect(canon(compras({ original: filasFixture().map(renombra), vigente: filasFixtureCorregidas().map(renombra) }))).not.toBe(base());
  });

  it("la lista original (alimenta el resumen): cambiar un monto de la original aunque el vigente no cambie", () => {
    const orig = filasFixture().map((f) => (f.id === "F001-2056" ? { ...f, montos: montosDe("PEN", { biDg: "21.48", igvDg: "1.62" }) } : f));
    expect(canon(compras({ original: orig }))).not.toBe(base());
  });

  it("dos entradas distintas no colisionan por concatenación: mover un carácter de la serie al número", () => {
    const a = vigenteCon((f) => ({ ...f, comprobante: { tipo: "01", serie: "F00", numero: "13064" } }));
    const b = vigenteCon((f) => ({ ...f, comprobante: { tipo: "01", serie: "F001", numero: "3064" } }));
    expect(canon(a)).not.toBe(canon(b));
  });
});

describe("canonHuella · ventas: cambia con cualquier campo y con excluir o restaurar (D12, P-2)", () => {
  const base = (): string => canon(ventas());
  const vigenteCon = (mod: (f: FilaReemplazoVenta) => FilaReemplazoVenta, id = "03-B001-290"): EntradaCanonHuella => {
    const v = ventas();
    return ventas({ vigente: (v.vigente as FilaReemplazoVenta[]).map((f) => (f.id === id ? mod(f) : f)) });
  };

  it.each(["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"] as const)("el monto %s", (columna) => {
    const mod = (f: FilaReemplazoVenta): FilaReemplazoVenta => {
      const m = { ...f.montos };
      m[columna] = m[columna].sumar(montosVenta("PEN", { baseGravada: "0.01" }).baseGravada);
      return { ...f, montos: m };
    };
    expect(canon(vigenteCon(mod))).not.toBe(base());
  });

  it.each([
    ["tipo de comprobante", (f: FilaReemplazoVenta) => ({ ...f, comprobante: { ...f.comprobante, tipo: "01" } })],
    ["serie", (f: FilaReemplazoVenta) => ({ ...f, comprobante: { ...f.comprobante, serie: "B002" } })],
    ["número", (f: FilaReemplazoVenta) => ({ ...f, comprobante: { ...f.comprobante, numero: "293" } })],
    ["tipo de documento de la contraparte", (f: FilaReemplazoVenta) => ({ ...f, contraparte: { tipo: "1", numero: "-" } })],
    ["documento de la contraparte", (f: FilaReemplazoVenta) => ({ ...f, contraparte: { numero: "12345678" } })],
    ["fecha de emisión", (f: FilaReemplazoVenta) => ({ ...f, fechaEmision: "2026-10-04" })],
  ] as const)("la fila vigente: %s", (_nombre, mod) => {
    expect(canon(vigenteCon(mod))).not.toBe(base());
  });

  it("el tipo de cambio de una venta USD", () => {
    const usd = ventaNum("01", "F002", "1", { moneda: "USD", tipoCambio: "3.300", montos: { baseGravada: "200.00", igv: "36.00" } });
    const a = canon(ventas({ original: [usd], vigente: [usd] }));
    const b = canon(ventas({ original: [usd], vigente: [{ ...usd, tipoCambio: "3.301" }] }));
    expect(b).not.toBe(a);
  });

  it("excluir una venta cambia el texto y restaurarla vuelve exactamente al de antes", () => {
    const v = ventas();
    const lista = v.vigente as FilaReemplazoVenta[];
    const excluida = lista.map((f) => (f.id === "01-F001-11" ? comoExcluida(f) : f));
    const conExclusion = canon(ventas({ vigente: excluida }));
    expect(conExclusion).not.toBe(base());
    const restaurada = excluida.map((f) => (f.id === "01-F001-11" ? { ...f, estado: "original" as const } : f));
    expect(canon(ventas({ vigente: restaurada }))).toBe(base());
  });

  it("excluir dos ventas distintas da textos distintos entre sí", () => {
    const lista = ventas().vigente as FilaReemplazoVenta[];
    const sin = (id: string) => canon(ventas({ vigente: lista.map((f) => (f.id === id ? comoExcluida(f) : f)) }));
    expect(sin("01-F001-10")).not.toBe(sin("01-F001-11"));
  });

  it("agregar una venta a la vigente, quitar una de las dos listas o renombrar una (en las dos)", () => {
    const v = ventas();
    const original = v.original as FilaReemplazoVenta[];
    const vigente = v.vigente as FilaReemplazoVenta[];
    const extra = filaVenta({ id: "nueva", estado: "agregada", comprobante: { tipo: "03", serie: "B001", numero: "291" } });
    expect(canon(ventas({ vigente: [...vigente, extra] }))).not.toBe(base());
    expect(canon(ventas({ original: original.slice(1), vigente: vigente.slice(1) }))).not.toBe(base());
    const renombra = (f: FilaReemplazoVenta): FilaReemplazoVenta => (f.id === "03-B001-290" ? { ...f, id: "otro-id" } : f);
    expect(canon(ventas({ original: original.map(renombra), vigente: vigente.map(renombra) }))).not.toBe(base());
  });

  it("cambiar un monto de la original aunque la vigente no cambie (alimenta el resumen)", () => {
    const original = (ventas().original as FilaReemplazoVenta[]).map((f) =>
      f.id === "01-F001-11" ? { ...f, montos: montosVenta("PEN", { baseGravada: "300.00", igv: "54.00", otros: "1.00" }) } : f,
    );
    expect(canon(ventas({ original }))).not.toBe(base());
  });

  it("pasar una venta de original a agregada (sale de la original y entra agregada en la vigente)", () => {
    const v = ventas();
    const original = (v.original as FilaReemplazoVenta[]).filter((f) => f.id !== "03-B001-290");
    const vigente = (v.vigente as FilaReemplazoVenta[]).map((f) => (f.id === "03-B001-290" ? { ...f, estado: "agregada" as const } : f));
    expect(canon(ventas({ original, vigente }))).not.toBe(base());
  });
});
