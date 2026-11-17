// Spec 021 · T1. crearEvaluarCompras con `proveedoresConRegla` (D-7) y `reglasApagadas` (RF-089, P-6). Rojo (T7).
import { describe, expect, it } from "vitest";
import { cambiarDestino, MontosComprobante } from "../comprobante/index";
import type { Destino } from "../comprobante/index";
import { detalleMixta } from "../../tests/ayudas/ubl";
import { planificarHistorial } from "../reglas/r-his";
import type { CodigoReglaMotor } from "../reglas/index";
import { crearEvaluarCompras, type CompraEvaluable } from "./evaluar";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const PROV = { tipo: "6", numero: "20100070970" };
const compra = (o: Partial<CompraEvaluable> = {}): CompraEvaluable => ({
  docTipo: PROV.tipo,
  docNumero: PROV.numero,
  tipoDoc: "01",
  serie: "F001",
  numero: "1040",
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, biDg: "100.00", igvDg: "18.00", total: "118.00" },
  ...o,
});
const SAN_JUAN = { ...CERO, biDg: "770.00", total: "770.00" };
const MIXTA = { ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" };
const reglasDe = (e: ReturnType<typeof crearEvaluarCompras>, c: CompraEvaluable) => e(c).map((h) => h.regla);
const opciones = (o: { reglasApagadas?: readonly CodigoReglaMotor[]; proveedoresConRegla?: { tipo: string; numero: string }[] }) => ({
  xmlSimuladoEnReglas: false,
  ...o,
});

describe("proveedoresConRegla: un proveedor con regla deja de ser R-NEW (D-7)", () => {
  it("control: sin historial ni regla, la fila es R-NEW", () => {
    expect(reglasDe(crearEvaluarCompras([]), compra())).toContain("R-NEW");
  });

  it("con regla aprendida del proveedor no sale R-NEW, aunque no esté en el historial", () => {
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [PROV] }));
    expect(reglasDe(e, compra())).not.toContain("R-NEW");
  });

  it("el documento de la regla se normaliza (espacios y minúsculas)", () => {
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [{ tipo: "6", numero: " 2010 0070970 " }] }));
    expect(reglasDe(e, compra())).not.toContain("R-NEW");
    const f = crearEvaluarCompras([], opciones({ proveedoresConRegla: [{ tipo: "1", numero: "ab-12" }] }));
    expect(reglasDe(f, compra({ docTipo: "1", docNumero: "AB-12" }))).not.toContain("R-NEW");
  });

  it("solo ese proveedor: otro sigue siendo R-NEW", () => {
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [PROV] }));
    expect(reglasDe(e, compra({ docNumero: "20999999999" }))).toContain("R-NEW");
    expect(reglasDe(e, compra({ docTipo: "1", docNumero: PROV.numero }))).toContain("R-NEW");
  });

  it("suma al historial, no lo reemplaza", () => {
    const e = crearEvaluarCompras([{ tipo: "6", numero: "20555555555" }], opciones({ proveedoresConRegla: [PROV] }));
    expect(reglasDe(e, compra({ docNumero: "20555555555" }))).not.toContain("R-NEW");
    expect(reglasDe(e, compra())).not.toContain("R-NEW");
  });

  it("un documento de la regla fuera de gramática se omite sin dejar la evaluación sin hallazgos", () => {
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [{ tipo: "66", numero: "con|barra" }, PROV] }));
    expect(reglasDe(e, compra())).not.toContain("R-NEW");
    expect(reglasDe(e, compra({ docNumero: "20999999999" }))).toContain("R-NEW");
  });

  it("una lista vacía de proveedores con regla equivale a no pasarla", () => {
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [] }));
    expect(reglasDe(e, compra())).toContain("R-NEW");
  });
});

describe("reglasApagadas en crearEvaluarCompras (RF-089)", () => {
  it("control: San Juan sin apagadas trae R-ISC; la mixta, R-MIX; el proveedor nuevo, R-NEW", () => {
    const e = crearEvaluarCompras([PROV]);
    expect(reglasDe(e, compra({ montos: SAN_JUAN }))).toContain("R-ISC");
    expect(reglasDe(e, compra({ montos: MIXTA }))).toContain("R-MIX");
    expect(reglasDe(crearEvaluarCompras([]), compra())).toContain("R-NEW");
  });

  it("R-ISC apagado: San Juan no la trae y R-MIX sigue", () => {
    const e = crearEvaluarCompras([PROV], opciones({ reglasApagadas: ["R-ISC"] }));
    expect(reglasDe(e, compra({ montos: SAN_JUAN }))).not.toContain("R-ISC");
    expect(reglasDe(e, compra({ montos: MIXTA }))).toContain("R-MIX");
  });

  it("R-MIX apagado: la mixta no la trae y R-ISC sigue", () => {
    const e = crearEvaluarCompras([PROV], opciones({ reglasApagadas: ["R-MIX"] }));
    expect(reglasDe(e, compra({ montos: MIXTA }))).not.toContain("R-MIX");
    expect(reglasDe(e, compra({ montos: SAN_JUAN }))).toContain("R-ISC");
  });

  it("R-NEW apagado: el proveedor sin historial no es R-NEW", () => {
    const e = crearEvaluarCompras([], opciones({ reglasApagadas: ["R-NEW"] }));
    expect(reglasDe(e, compra())).not.toContain("R-NEW");
  });

  it("R-RED apagado: el descuadre de un centavo no sale", () => {
    const m = { ...CERO, biDg: "100.00", igvDg: "18.00", total: "118.01" };
    expect(reglasDe(crearEvaluarCompras([PROV]), compra({ montos: m }))).toContain("R-RED");
    expect(reglasDe(crearEvaluarCompras([PROV], opciones({ reglasApagadas: ["R-RED"] })), compra({ montos: m }))).not.toContain("R-RED");
  });

  it("R-GP apagado: la zapatilla (XML subido) no sale y R-GP encendido sí", () => {
    const zapatilla: CompraEvaluable = {
      ...compra({ docNumero: "20700000070", numero: "5070" }),
      montos: { ...CERO, biDg: "150.00", igvDg: "27.00", total: "177.00" },
    };
    const detalle = detalleMixta({
      identidad: { ...detalleMixta().identidad, serie: "F001", numero: "5070", emisor: { ruc: "20700000070", razonSocial: "PRUEBA PROVEEDOR CALZADO S.A.C." } },
      totales: { gravado: "150.00", igv: "27.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otros: "0.00", total: "177.00" },
      items: [{ descripcion: "Par de zapatillas deportivas de prueba (PRUEBA)", cantidad: "1", unidad: "NIU", precioUnitario: "150.00", valor: "150.00", afectacion: "gravado", igv: "27.00", isc: "0.00", icbper: "0.00" }],
    });
    const conXml: CompraEvaluable = { ...zapatilla, xml: { origen: "subido", detalle } };
    const conocidos = [{ tipo: "6", numero: "20700000070" }];
    expect(reglasDe(crearEvaluarCompras(conocidos), conXml)).toContain("R-GP");
    expect(reglasDe(crearEvaluarCompras(conocidos, opciones({ reglasApagadas: ["R-GP"] })), conXml)).not.toContain("R-GP");
  });

  it("R-HIS apagado es válido y no cambia las reglas de 011", () => {
    const e = crearEvaluarCompras([PROV], opciones({ reglasApagadas: ["R-HIS"] }));
    expect(reglasDe(e, compra({ montos: SAN_JUAN }))).toEqual(reglasDe(crearEvaluarCompras([PROV]), compra({ montos: SAN_JUAN })));
  });

  it("todas apagadas: sin hallazgos", () => {
    const e = crearEvaluarCompras([], opciones({ reglasApagadas: ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"] }));
    expect(e(compra({ montos: SAN_JUAN }))).toEqual([]);
  });
});

// CA-11 (P-6): la versión `historial` se evalúa con las mismas reglas que la clasificada a mano en el destino.
describe("P-6 · evaluar la versión movida por R-HIS (CA-11)", () => {
  const movida = (montos: typeof CERO, destino: Destino) => {
    const original = MontosComprobante.desde("PEN", montos);
    const filas = [{ id: "f1", proveedor: { ...PROV }, comprobante: { tipo: "01", serie: "F001", numero: "1040" }, montos: original }];
    const plan = planificarHistorial(filas, [{ id: "r1", proveedor: { ...PROV }, destino }], { rHisActiva: true });
    expect(plan).toHaveLength(1);
    return plan[0]!.montos;
  };
  const aCadenas = (m: MontosComprobante): CompraEvaluable["montos"] => ({
    biDg: m.obtener("biDg").toString(),
    igvDg: m.obtener("igvDg").toString(),
    biDgng: m.obtener("biDgng").toString(),
    igvDgng: m.obtener("igvDgng").toString(),
    biDng: m.obtener("biDng").toString(),
    igvDng: m.obtener("igvDng").toString(),
    noGravado: m.obtener("noGravado").toString(),
    isc: m.obtener("isc").toString(),
    icbper: m.obtener("icbper").toString(),
    otrosTributos: m.obtener("otrosTributos").toString(),
    total: m.total.toString(),
  });
  const ORIGEN_DNG = (m: typeof SAN_JUAN) => ({ ...CERO, biDng: m.biDg, igvDng: m.igvDg, total: m.total });

  it("San Juan 770.00 movida de DNG a DG: R-ISC con los mismos montos que la fila clasificada a mano en DG, sin R-NEW", () => {
    const m = movida(ORIGEN_DNG(SAN_JUAN), "DG");
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [PROV] }));
    const deHistorial = e(compra({ clasificada: true, montos: aCadenas(m) }));
    const aMano = crearEvaluarCompras([PROV])(compra({ clasificada: true, montos: SAN_JUAN }));
    expect(deHistorial.map((h) => h.regla)).toEqual(["R-ISC"]);
    expect(deHistorial).toEqual(aMano);
    expect(deHistorial[0]!.sugerencia).toMatchObject({ tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" });
  });

  it("la mixta 21.48 / 1.61 movida de DNG a DG: R-MIX con las mismas lecturas que a mano", () => {
    const m = movida(ORIGEN_DNG(MIXTA), "DG");
    const e = crearEvaluarCompras([], opciones({ proveedoresConRegla: [PROV] }));
    const deHistorial = e(compra({ clasificada: true, montos: aCadenas(m) }));
    const aMano = crearEvaluarCompras([PROV])(compra({ clasificada: true, montos: MIXTA }));
    expect(deHistorial.map((h) => h.regla)).toEqual(["R-MIX"]);
    expect(deHistorial).toEqual(aMano);
  });

  it("los montos movidos coinciden con cambiarDestino(…, destino) de 010", () => {
    const original = MontosComprobante.desde("PEN", ORIGEN_DNG(SAN_JUAN));
    expect(aCadenas(movida(ORIGEN_DNG(SAN_JUAN), "DG"))).toEqual(aCadenas(cambiarDestino(original, "DG").montos));
  });
});
