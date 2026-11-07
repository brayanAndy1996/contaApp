// Spec 014 · T16. Aceptar la sugerencia guardada de una compra (D-4, D-15, DU-6, DU-22).
import { describe, expect, it } from "vitest";
import { aceptarSugerenciaGuardada } from "./aceptar";
import { crearEvaluarCompras, type CompraEvaluable, type HallazgoJson } from "./evaluar";
import type { EntradaAceptar } from "./aceptar";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const CONOCIDO = [{ tipo: "6", numero: "20100070970" }];
const compra = (montos: Partial<typeof CERO>, o: Partial<CompraEvaluable> = {}): CompraEvaluable => ({
  docTipo: "6",
  docNumero: "20100070970",
  tipoDoc: "01",
  serie: "F001",
  numero: "1040",
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, ...montos },
  ...o,
});
const hallazgoDe = (c: CompraEvaluable, regla: string, conocidos = CONOCIDO): HallazgoJson | undefined =>
  crearEvaluarCompras(conocidos)(c).find((h) => h.regla === regla);
const entrada = (c: CompraEvaluable, h: HallazgoJson | undefined, o: Partial<EntradaAceptar> = {}): EntradaAceptar => ({
  compra: c,
  hallazgo: h,
  proveedoresConocidos: CONOCIDO,
  confirmar: true,
  dato: undefined,
  enMasa: false,
  ...o,
});

const SAN_JUAN = compra({ biDg: "770.00", total: "770.00" });
const MIXTA = compra({ biDg: "21.48", igvDg: "1.61", total: "23.09" }, { numero: "2056" });

describe("aceptarSugerenciaGuardada · con confirmación (re-evalúa con 011)", () => {
  it("R-ISC de San Juan: BI DG 0.00 e ISC 770.00", () => {
    const r = aceptarSugerenciaGuardada(entrada(SAN_JUAN, hallazgoDe(SAN_JUAN, "R-ISC")));
    expect(r).toMatchObject({ ok: true, excluir: false, clasifica: false });
    if (r.ok) expect(r.montos).toMatchObject({ biDg: "0.00", isc: "770.00", total: "770.00" });
  });

  it("sin confirmar no aplica nada: requiere_confirmacion", () => {
    const r = aceptarSugerenciaGuardada(entrada(SAN_JUAN, hallazgoDe(SAN_JUAN, "R-ISC"), { confirmar: false }));
    expect(r).toEqual({ ok: false, rechazo: "requiere_confirmacion" });
  });

  it("R-MIX sin XML pide el gravado; con 8.97 deja 8.97 en DG y 12.51 en no gravado", () => {
    const h = hallazgoDe(MIXTA, "R-MIX");
    expect(aceptarSugerenciaGuardada(entrada(MIXTA, h))).toEqual({ ok: false, rechazo: "requiere_dato", dato: "gravado" });
    const r = aceptarSugerenciaGuardada(entrada(MIXTA, h, { dato: { gravado: "8.97" } }));
    expect(r.ok && r.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", noGravado: "12.51", total: "23.09" });
  });

  it("R-MIX con un gravado fuera del rango pide el dato otra vez", () => {
    const r = aceptarSugerenciaGuardada(entrada(MIXTA, hallazgoDe(MIXTA, "R-MIX"), { dato: { gravado: "20.00" } }));
    expect(r).toEqual({ ok: false, rechazo: "requiere_dato", dato: "gravado" });
  });

  it("R-NEW pide el destino y, con él, clasifica", () => {
    const c = compra({ biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const h = hallazgoDe(c, "R-NEW", []);
    expect(aceptarSugerenciaGuardada(entrada(c, h, { proveedoresConocidos: [] }))).toEqual({ ok: false, rechazo: "requiere_dato", dato: "destino" });
    const r = aceptarSugerenciaGuardada(entrada(c, h, { proveedoresConocidos: [], dato: { destino: "DNG" } }));
    expect(r).toMatchObject({ ok: true, clasifica: true });
    if (r.ok) expect(r.montos).toMatchObject({ biDng: "100.00", igvDng: "18.00", biDg: "0.00" });
  });

  it("la fila cambió después de evaluarse: revisar_de_nuevo", () => {
    const h = hallazgoDe(SAN_JUAN, "R-ISC");
    const otra = compra({ biDg: "800.00", total: "800.00" });
    expect(aceptarSugerenciaGuardada(entrada(otra, h))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("sin hallazgo guardado: revisar_de_nuevo", () => {
    expect(aceptarSugerenciaGuardada(entrada(SAN_JUAN, undefined))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("un hallazgo guardado ilegible no lanza: revisar_de_nuevo", () => {
    const h: HallazgoJson = { regla: "R-ISC", sugerencia: { tipo: "mover", origen: "xx", destino: "isc", monto: "1.00" }, lecturas: {}, requiereConfirmacion: true };
    expect(aceptarSugerenciaGuardada(entrada(SAN_JUAN, h))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("en masa, lo que pide confirmación es no_masiva", () => {
    expect(aceptarSugerenciaGuardada(entrada(SAN_JUAN, hallazgoDe(SAN_JUAN, "R-ISC"), { enMasa: true }))).toEqual({ ok: false, rechazo: "no_masiva" });
  });
});

describe("aceptarSugerenciaGuardada · respaldada por el XML (DU-22)", () => {
  const iscXml: HallazgoJson = {
    regla: "R-ISC",
    sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "500.00" },
    lecturas: { biDg: "500.00", igvDg: "0.00" },
    requiereConfirmacion: false,
  };
  const FILA = compra({ biDg: "500.00", total: "500.00" });

  it("se aplica sin confirmar, contrastada con la fila actual, también en masa", () => {
    for (const enMasa of [false, true]) {
      const r = aceptarSugerenciaGuardada(entrada(FILA, iscXml, { confirmar: false, enMasa }));
      expect(r.ok && r.montos).toMatchObject({ biDg: "0.00", isc: "500.00", total: "500.00" });
    }
  });

  it("si la fila ya no es la que leyó la regla: revisar_de_nuevo", () => {
    const cambiada = compra({ biDg: "600.00", total: "600.00" });
    expect(aceptarSugerenciaGuardada(entrada(cambiada, iscXml, { enMasa: true }))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });

  it("R-RED respaldada ajusta el total", () => {
    const f = compra({ biDg: "100.00", igvDg: "18.00", total: "118.01" });
    const red: HallazgoJson = {
      regla: "R-RED",
      sugerencia: { tipo: "ajustar", valores: { total: "118.00" } },
      lecturas: { ...f.montos },
      requiereConfirmacion: false,
    };
    const r = aceptarSugerenciaGuardada(entrada(f, red, { enMasa: true }));
    expect(r.ok && r.montos.total).toBe("118.00");
  });

  it("R-MIX con monto exacto separa sin pedir dato", () => {
    const mix: HallazgoJson = {
      regla: "R-MIX",
      sugerencia: { tipo: "separar", columnaBi: "biDg", min: "8.97", max: "8.98", estimado: "8.97", exacto: "8.97" },
      lecturas: { biDg: "21.48", igvDg: "1.61" },
      requiereConfirmacion: false,
    };
    const r = aceptarSugerenciaGuardada(entrada(MIXTA, mix, { enMasa: true }));
    expect(r.ok && r.montos).toMatchObject({ biDg: "8.97", noGravado: "12.51" });
  });

  it("R-GP respaldada excluye la fila", () => {
    const gp: HallazgoJson = { regla: "R-GP", sugerencia: { tipo: "excluir", palabra: "zapatillas", categoria: "calzado" }, lecturas: {}, requiereConfirmacion: false };
    expect(aceptarSugerenciaGuardada(entrada(FILA, gp, { confirmar: false }))).toMatchObject({ ok: true, excluir: true });
  });

  it("una sugerencia del tipo que no es de su regla es ilegible: revisar_de_nuevo", () => {
    const mala: HallazgoJson = { ...iscXml, sugerencia: { tipo: "clasificar" } };
    expect(aceptarSugerenciaGuardada(entrada(FILA, mala))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });
});

describe("aceptarSugerenciaGuardada · casos de borde", () => {
  const h = (regla: string, sugerencia: unknown, o: Partial<HallazgoJson> = {}): HallazgoJson => ({ regla, sugerencia, lecturas: {}, requiereConfirmacion: false, ...o });
  const FILA = compra({ biDg: "500.00", total: "500.00" });
  const REVISAR = { ok: false, rechazo: "revisar_de_nuevo" };

  it("lo guardado que no se puede leer no lanza: revisar_de_nuevo", () => {
    for (const mala of [
      h("R-ISC", "texto"),
      h("R-ISC", { tipo: "mover", origen: "biDg", destino: "isc", monto: 5 }),
      h("R-GP", { tipo: "excluir", palabra: 1, categoria: "x" }),
      h("R-ISC", { tipo: "mover", origen: "biDg", destino: "isc", monto: "5.00" }, { lecturas: { biDg: "500.00", noEsColumna: "1.00" } }),
    ]) {
      expect(aceptarSugerenciaGuardada(entrada(FILA, mala))).toEqual(REVISAR);
    }
  });

  it("una sugerencia nula (solo aviso) no se acepta", () => {
    expect(aceptarSugerenciaGuardada(entrada(FILA, h("R-RED", null, { requiereConfirmacion: true })))).toEqual(REVISAR);
  });

  it("un movimiento que la fila ya no admite (monto mayor que el saldo) es revisar_de_nuevo", () => {
    const grande = h("R-ISC", { tipo: "mover", origen: "biDg", destino: "isc", monto: "900.00" }, { lecturas: { biDg: "500.00" } });
    expect(aceptarSugerenciaGuardada(entrada(FILA, grande))).toEqual(REVISAR);
  });

  it("un dato de otra regla se ignora al confirmar (R-ISC con un gravado de sobra)", () => {
    const r = aceptarSugerenciaGuardada(entrada(SAN_JUAN, hallazgoDe(SAN_JUAN, "R-ISC"), { dato: { gravado: "1.00" } }));
    expect(r).toMatchObject({ ok: true });
  });

  it("R-MIX respaldada: un gravado fuera del rango y distinto del exacto pide el dato otra vez", () => {
    const mix = h("R-MIX", { tipo: "separar", columnaBi: "biDg", min: "8.97", max: "8.98", estimado: "8.97", exacto: "8.97" }, { lecturas: { biDg: "21.48", igvDg: "1.61" } });
    expect(aceptarSugerenciaGuardada(entrada(MIXTA, mix, { dato: { gravado: "20.00" } }))).toEqual({ ok: false, rechazo: "requiere_dato", dato: "gravado" });
    expect(aceptarSugerenciaGuardada(entrada(MIXTA, mix, { dato: { gravado: "8.98" } }))).toMatchObject({ ok: true });
  });

  it("R-RED respaldada puede ajustar una columna además del total", () => {
    const f = compra({ biDg: "100.00", igvDg: "18.00", total: "118.01" });
    const red = h("R-RED", { tipo: "ajustar", valores: { biDg: "100.01", total: "118.01" } }, { lecturas: { ...f.montos } });
    const r = aceptarSugerenciaGuardada(entrada(f, red));
    expect(r.ok && r.montos).toMatchObject({ biDg: "100.01", igvDg: "18.00", total: "118.01" });
  });

  it("R-NEW respaldada clasifica con el destino y rechaza uno inventado", () => {
    const nuevo = h("R-NEW", { tipo: "clasificar" });
    const c = compra({ biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(aceptarSugerenciaGuardada(entrada(c, nuevo))).toEqual({ ok: false, rechazo: "requiere_dato", dato: "destino" });
    expect(aceptarSugerenciaGuardada(entrada(c, nuevo, { dato: { destino: "XX" as never } }))).toEqual({ ok: false, rechazo: "requiere_dato", dato: "destino" });
    expect(aceptarSugerenciaGuardada(entrada(c, nuevo, { dato: { destino: "DGNG" } }))).toMatchObject({ ok: true, clasifica: true });
  });

  it("un defecto de programa (historial nulo) se propaga y no se disfraza de rechazo", () => {
    const e = entrada(SAN_JUAN, hallazgoDe(SAN_JUAN, "R-ISC"), { proveedoresConocidos: null as never });
    expect(() => aceptarSugerenciaGuardada(e)).toThrow(TypeError);
  });
});
