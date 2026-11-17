// Spec 021 (defecto previo de 014/016): aceptar con confirmación re-evalúa la fila CON el XML vigente de la compra. R-GP exige XML
// (011, CA-12); sin él la re-evaluación no reproducía el hallazgo y la aceptación siempre daba `revisar_de_nuevo`.
import { describe, expect, it } from "vitest";
import { detalleMixta } from "../../tests/ayudas/ubl";
import type { DetalleXml } from "../ubl/index";
import { aceptarSugerenciaGuardada } from "./aceptar";
import type { EntradaAceptar } from "./aceptar";
import { crearEvaluarCompras } from "./evaluar";
import type { CompraEvaluable, HallazgoJson } from "./evaluar";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const ZAPATILLA: CompraEvaluable = {
  docTipo: "6",
  docNumero: "20700000070",
  tipoDoc: "01",
  serie: "F001",
  numero: "5070",
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, biDg: "150.00", igvDg: "27.00", total: "177.00" },
};
const CONOCIDOS = [{ tipo: "6", numero: "20700000070" }];

const detalleCon = (descripcion: string): DetalleXml =>
  detalleMixta({
    identidad: { ...detalleMixta().identidad, serie: "F001", numero: "5070", emisor: { ruc: "20700000070", razonSocial: "PRUEBA PROVEEDOR CALZADO S.A.C." } },
    totales: { gravado: "150.00", igv: "27.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otros: "0.00", total: "177.00" },
    items: [{ descripcion, cantidad: "1", unidad: "NIU", precioUnitario: "150.00", valor: "150.00", afectacion: "gravado", igv: "27.00", isc: "0.00", icbper: "0.00" }],
  });
const ZAPATILLAS = detalleCon("Par de zapatillas deportivas de prueba (PRUEBA)");
const SIN_PALABRA = detalleCon("Servicio de limpieza de oficinas (PRUEBA)");

const conXml = (origen: "simulado" | "real" | "subido", detalle: DetalleXml): CompraEvaluable => ({ ...ZAPATILLA, xml: { origen, detalle } });
const gpDe = (c: CompraEvaluable, opciones = { xmlSimuladoEnReglas: false }): HallazgoJson | undefined =>
  crearEvaluarCompras(CONOCIDOS, opciones)(c).find((h) => h.regla === "R-GP");
const entrada = (compra: CompraEvaluable, hallazgo: HallazgoJson | undefined, o: Partial<EntradaAceptar> = {}): EntradaAceptar => ({
  compra,
  hallazgo,
  proveedoresConocidos: CONOCIDOS,
  confirmar: true,
  dato: undefined,
  enMasa: false,
  ...o,
});

describe("aceptar R-GP con confirmación: la re-evaluación usa el XML vigente de la compra", () => {
  it("con el XML subido de la zapatilla se acepta: excluye la fila y deja los montos", () => {
    const c = conXml("subido", ZAPATILLAS);
    const gp = gpDe(c)!;
    expect(gp.requiereConfirmacion).toBe(true); // control: el hallazgo guardado existe y pide confirmación
    const r = aceptarSugerenciaGuardada(entrada(c, gp));
    expect(r).toMatchObject({ ok: true, excluir: true, clasifica: false });
    if (r.ok) expect(r.montos).toMatchObject({ biDg: "150.00", igvDg: "27.00", total: "177.00" });
  });

  it("con el XML real también", () => {
    const c = conXml("real", ZAPATILLAS);
    expect(aceptarSugerenciaGuardada(entrada(c, gpDe(c)))).toMatchObject({ ok: true, excluir: true });
  });

  it("sin XML sigue siendo revisar_de_nuevo (el hallazgo guardado no se puede reproducir)", () => {
    const gp = gpDe(conXml("subido", ZAPATILLAS))!;
    expect(aceptarSugerenciaGuardada(entrada(ZAPATILLA, gp))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
    expect(aceptarSugerenciaGuardada(entrada({ ...ZAPATILLA, xml: null }, gp))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("si el XML cambió y ya no trae la palabra, el hallazgo queda obsoleto: revisar_de_nuevo", () => {
    const gp = gpDe(conXml("subido", ZAPATILLAS))!;
    expect(aceptarSugerenciaGuardada(entrada(conXml("subido", SIN_PALABRA), gp))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("si el XML cambió a otra palabra del diccionario, tampoco se aplica (la sugerencia guardada es otra)", () => {
    const gp = gpDe(conXml("subido", ZAPATILLAS))!;
    const otra = detalleCon("Paquete de pañales para bebé (PRUEBA)");
    const c = conXml("subido", otra);
    const hoy = gpDe(c);
    // Si la palabra nueva también es del diccionario la sugerencia difiere; si no, ya no hay hallazgo: en ambos casos no se aplica.
    expect(hoy === undefined || JSON.stringify(hoy.sugerencia) !== JSON.stringify(gp.sugerencia)).toBe(true);
    expect(aceptarSugerenciaGuardada(entrada(c, gp))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("XML simulado: solo entra en la re-evaluación si la bandera P-4 está activa, igual que en la evaluación", () => {
    const c = conXml("simulado", ZAPATILLAS);
    const gp = gpDe(c, { xmlSimuladoEnReglas: true })!;
    expect(gpDe(c)).toBeUndefined(); // control: sin la bandera la evaluación no ve el XML simulado
    expect(aceptarSugerenciaGuardada(entrada(c, gp))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
    expect(aceptarSugerenciaGuardada(entrada(c, gp, { xmlSimuladoEnReglas: true }))).toMatchObject({ ok: true, excluir: true });
  });

  it("sin confirmar sigue pidiendo confirmación", () => {
    const c = conXml("subido", ZAPATILLAS);
    expect(aceptarSugerenciaGuardada(entrada(c, gpDe(c), { confirmar: false }))).toEqual({ ok: false, rechazo: "requiere_confirmacion" });
  });
});
