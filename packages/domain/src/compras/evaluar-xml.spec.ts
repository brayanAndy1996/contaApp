// Spec 016 · T2 (rojo). `crearEvaluarCompras` con XML (plan, Contratos: Dominio): `CompraEvaluable.xml?: { origen, detalle }` y
// `crearEvaluarCompras(conocidos, { xmlSimuladoEnReglas })`. La fila evaluada lleva `xml: aResumenXml(detalle)` si el origen no
// es `simulado` o la bandera está activa (D-7, P-4). CA-6, CA-7, CA-9, CA-16 y el R-GP de la zapatilla (CA-5).
import { describe, expect, it } from "vitest";
import { detalleMixta, detalleSanJuan } from "../../tests/ayudas/ubl";
import type { DetalleXml } from "../ubl/index";
import { aceptarSugerenciaGuardada } from "./aceptar";
import type { EntradaAceptar } from "./aceptar";
import { crearEvaluarCompras } from "./evaluar";
import type { CompraEvaluable, HallazgoJson } from "./evaluar";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
type Origen = "simulado" | "real" | "subido";

const MIXTA_SIN_XML: CompraEvaluable = {
  docTipo: "6",
  docNumero: "20700000045",
  tipoDoc: "01",
  serie: "F001",
  numero: "2056",
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" },
};
const SAN_JUAN_SIN_XML: CompraEvaluable = {
  ...MIXTA_SIN_XML,
  docNumero: "20700000011",
  numero: "1040",
  montos: { ...CERO, biDg: "770.00", total: "770.00" },
};
const ZAPATILLA_SIN_XML: CompraEvaluable = {
  ...MIXTA_SIN_XML,
  docNumero: "20700000070",
  serie: "F001",
  numero: "5070",
  montos: { ...CERO, biDg: "150.00", igvDg: "27.00", total: "177.00" },
};

const conocidos = (c: CompraEvaluable) => [{ tipo: c.docTipo, numero: c.docNumero }];
const conXml = (c: CompraEvaluable, origen: Origen, detalle: DetalleXml): CompraEvaluable => ({ ...c, xml: { origen, detalle } });
const evaluar = (c: CompraEvaluable, opciones?: { xmlSimuladoEnReglas: boolean }): HallazgoJson[] =>
  crearEvaluarCompras(conocidos(c), opciones)(c);
const regla = (hs: HallazgoJson[], codigo: string): HallazgoJson | undefined => hs.find((h) => h.regla === codigo);

describe("CA-6 · R-MIX de F001-2056 con el XML (mixta 21.48 / 1.61 → 8.97 + 12.51)", () => {
  it("sin XML el estimado es 8.94 (rango 8.92–8.97) y pide confirmación; con el XML el exacto es 8.97 sin confirmación", () => {
    const sin = regla(evaluar(MIXTA_SIN_XML), "R-MIX")!;
    expect(sin.sugerencia).toMatchObject({ tipo: "separar", columnaBi: "biDg", min: "8.92", max: "8.97", estimado: "8.94", exacto: null });
    expect(sin.requiereConfirmacion).toBe(true);

    const con = regla(evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta())), "R-MIX")!;
    expect(con.sugerencia).toMatchObject({ tipo: "separar", columnaBi: "biDg", estimado: "8.94", exacto: "8.97" });
    expect(con.requiereConfirmacion).toBe(false);
  });

  it("con origen «real» pasa lo mismo", () => {
    const con = regla(evaluar(conXml(MIXTA_SIN_XML, "real", detalleMixta())), "R-MIX")!;
    expect(con.sugerencia).toMatchObject({ exacto: "8.97" });
    expect(con.requiereConfirmacion).toBe(false);
  });

  it("la masiva de 014 la acepta: deja 8.97 en DG y 12.51 en no gravado, sin dato ni confirmación", () => {
    const c = conXml(MIXTA_SIN_XML, "subido", detalleMixta());
    const entrada: EntradaAceptar = {
      compra: c,
      hallazgo: regla(evaluar(c), "R-MIX"),
      proveedoresConocidos: conocidos(c),
      confirmar: false,
      dato: undefined,
      enMasa: true,
    };
    const r = aceptarSugerenciaGuardada(entrada);
    expect(r.ok && r.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", noGravado: "12.51", total: "23.09" });
  });

  it("evaluar con XML no deja estado: la misma compra sin XML vuelve a dar el estimado", () => {
    const evaluador = crearEvaluarCompras(conocidos(MIXTA_SIN_XML));
    expect(regla(evaluador(conXml(MIXTA_SIN_XML, "subido", detalleMixta())), "R-MIX")!.requiereConfirmacion).toBe(false);
    expect(regla(evaluador(MIXTA_SIN_XML), "R-MIX")!.requiereConfirmacion).toBe(true);
  });
});

describe("CA-7 · R-ISC de F001-1040 (San Juan) respaldada por el XML", () => {
  it("sugiere mover 770.00 de DG a ISC sin pedir confirmación", () => {
    const sin = regla(evaluar(SAN_JUAN_SIN_XML), "R-ISC")!;
    expect(sin.requiereConfirmacion).toBe(true);

    const con = regla(evaluar(conXml(SAN_JUAN_SIN_XML, "subido", detalleSanJuan())), "R-ISC")!;
    expect(con.sugerencia).toEqual({ tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" });
    expect(con.requiereConfirmacion).toBe(false);
  });

  it("aceptarla deja BI DG 0.00 e ISC 770.00", () => {
    const c = conXml(SAN_JUAN_SIN_XML, "subido", detalleSanJuan());
    const r = aceptarSugerenciaGuardada({
      compra: c,
      hallazgo: regla(evaluar(c), "R-ISC"),
      proveedoresConocidos: conocidos(c),
      confirmar: false,
      dato: undefined,
      enMasa: true,
    });
    expect(r.ok && r.montos).toMatchObject({ biDg: "0.00", isc: "770.00", total: "770.00" });
  });
});

describe("CA-5 · R-GP de la zapatilla sale de la glosa del XML", () => {
  it("sin XML no hay R-GP; con la glosa del XML sugiere excluir (pide confirmación)", () => {
    expect(regla(evaluar(ZAPATILLA_SIN_XML), "R-GP")).toBeUndefined();
    const detalle = detalleMixta({
      identidad: { ...detalleMixta().identidad, serie: "F001", numero: "5070", emisor: { ruc: "20700000070", razonSocial: "PRUEBA PROVEEDOR CALZADO S.A.C." } },
      totales: { gravado: "150.00", igv: "27.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otros: "0.00", total: "177.00" },
      items: [{ descripcion: "Par de zapatillas deportivas de prueba (PRUEBA)", cantidad: "1", unidad: "NIU", precioUnitario: "150.00", valor: "150.00", afectacion: "gravado", igv: "27.00", isc: "0.00", icbper: "0.00" }],
    });
    const gp = regla(evaluar(conXml(ZAPATILLA_SIN_XML, "subido", detalle)), "R-GP")!;
    expect(gp.sugerencia).toMatchObject({ tipo: "excluir", palabra: "zapatilla" });
    expect(gp.requiereConfirmacion).toBe(true);
  });
});

describe("CA-9 · moneda: el XML solo respalda a una fila de su misma moneda", () => {
  const exactoMix = (hs: HallazgoJson[]): unknown => (regla(hs, "R-MIX")?.sugerencia as { exacto?: string | null } | undefined)?.exacto;

  it("una compra PEN con un XML en USD no recibe sugerencias del XML", () => {
    expect(exactoMix(evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta())))).toBe("8.97"); // control: mismo XML en PEN
    const enUsd = evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta({ moneda: "USD" })));
    expect(exactoMix(enUsd)).toBeNull();
    expect(regla(enUsd, "R-MIX")!.requiereConfirmacion).toBe(true);
    expect(enUsd).toEqual(evaluar(MIXTA_SIN_XML));
  });

  it("una compra USD con un XML USD se compara sin convertir", () => {
    const usd: CompraEvaluable = { ...MIXTA_SIN_XML, moneda: "USD" };
    const hs = evaluar(conXml(usd, "subido", detalleMixta({ moneda: "USD" })));
    expect(exactoMix(hs)).toBe("8.97");
    expect(regla(hs, "R-MIX")!.requiereConfirmacion).toBe(false);
  });

  it("un XML con currencyID mezclado (monedaUnica = false) tampoco respalda nada", () => {
    expect(exactoMix(evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta())))).toBe("8.97"); // control
    const mezclado = evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta({ monedaUnica: false })));
    expect(mezclado).toEqual(evaluar(MIXTA_SIN_XML));
  });

  it("un XML de otro comprobante (ajeno) no respalda nada", () => {
    const ajeno = detalleMixta({ identidad: { ...detalleMixta().identidad, numero: "9999" } });
    expect(exactoMix(evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta())))).toBe("8.97"); // control
    expect(evaluar(conXml(MIXTA_SIN_XML, "subido", ajeno))).toEqual(evaluar(MIXTA_SIN_XML));
  });
});

describe("CA-16 · XML simulado: solo entra en las reglas con la bandera (D-7, P-4)", () => {
  const sinXml = evaluar(MIXTA_SIN_XML);
  const simulada = conXml(MIXTA_SIN_XML, "simulado", detalleMixta());

  it("sin la bandera (u omitida) se evalúa como sin XML", () => {
    const encendida = evaluar(simulada, { xmlSimuladoEnReglas: true });
    expect(regla(encendida, "R-MIX")!.requiereConfirmacion).toBe(false); // control: con la bandera sí entra
    expect(evaluar(simulada)).toEqual(sinXml);
    expect(evaluar(simulada, { xmlSimuladoEnReglas: false })).toEqual(sinXml);
  });

  it("con la bandera encendida entra como cualquier otro XML", () => {
    const hs = evaluar(simulada, { xmlSimuladoEnReglas: true });
    expect(regla(hs, "R-MIX")!.sugerencia).toMatchObject({ exacto: "8.97" });
    expect(hs).toEqual(evaluar(conXml(MIXTA_SIN_XML, "subido", detalleMixta())));
  });

  it("la bandera no afecta a los XML «real» ni «subido»: siempre entran", () => {
    for (const origen of ["real", "subido"] as const) {
      const c = conXml(MIXTA_SIN_XML, origen, detalleMixta());
      expect(regla(evaluar(c, { xmlSimuladoEnReglas: false }), "R-MIX")!.requiereConfirmacion).toBe(false);
      expect(evaluar(c, { xmlSimuladoEnReglas: true })).toEqual(evaluar(c, { xmlSimuladoEnReglas: false }));
    }
  });
});
