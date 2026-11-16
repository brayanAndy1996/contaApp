// Spec 021 · T25a (H-T25-1): aceptar una sugerencia guardada de una regla que el estudio apagó después responde
// `revisar_de_nuevo`, con o sin XML y con o sin confirmación. La re-evaluación recibe `reglasApagadas` (RF-089).
import { describe, expect, it } from "vitest";
import { aceptarSugerenciaGuardada } from "./aceptar";
import type { EntradaAceptar } from "./aceptar";
import { crearEvaluarCompras } from "./evaluar";
import type { CompraEvaluable, HallazgoJson } from "./evaluar";

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
const REVISAR = { ok: false, rechazo: "revisar_de_nuevo" } as const;

const SAN_JUAN = compra({ biDg: "770.00", total: "770.00" });
const MIXTA = compra({ biDg: "21.48", igvDg: "1.61", total: "23.09" }, { numero: "2056" });
const NUEVO = compra({ biDg: "100.00", igvDg: "18.00", total: "118.00" });
const RED = compra({ biDg: "100.00", igvDg: "18.00", total: "118.01" }, { numero: "3001" });

describe("aceptar con la regla apagada por el estudio (H-T25-1): revisar_de_nuevo", () => {
  it("R-ISC sin XML: encendida se acepta (control) y apagada es revisar_de_nuevo", () => {
    const h = hallazgoDe(SAN_JUAN, "R-ISC");
    expect(aceptarSugerenciaGuardada(entrada(SAN_JUAN, h, { reglasApagadas: [] }))).toMatchObject({ ok: true });
    expect(aceptarSugerenciaGuardada(entrada(SAN_JUAN, h, { reglasApagadas: ["R-ISC"] }))).toEqual(REVISAR);
  });

  it("R-MIX sin XML (con el gravado confirmado): apagada es revisar_de_nuevo", () => {
    const h = hallazgoDe(MIXTA, "R-MIX");
    const dato = { gravado: "8.97" };
    expect(aceptarSugerenciaGuardada(entrada(MIXTA, h, { dato, reglasApagadas: [] }))).toMatchObject({ ok: true });
    expect(aceptarSugerenciaGuardada(entrada(MIXTA, h, { dato, reglasApagadas: ["R-MIX"] }))).toEqual(REVISAR);
  });

  it("R-RED sin XML: apagada es revisar_de_nuevo", () => {
    const h = hallazgoDe(RED, "R-RED");
    expect(h).toBeDefined(); // control de la prueba: la fila sí produce R-RED
    expect(aceptarSugerenciaGuardada(entrada(RED, h, { reglasApagadas: [] }))).toMatchObject({ ok: true });
    expect(aceptarSugerenciaGuardada(entrada(RED, h, { reglasApagadas: ["R-RED"] }))).toEqual(REVISAR);
  });

  it("R-NEW sin XML (con el destino): apagada es revisar_de_nuevo", () => {
    const h = hallazgoDe(NUEVO, "R-NEW", []);
    const base = { proveedoresConocidos: [], dato: { destino: "DNG" } } as const;
    expect(aceptarSugerenciaGuardada(entrada(NUEVO, h, { ...base, reglasApagadas: [] }))).toMatchObject({ ok: true, clasifica: true });
    expect(aceptarSugerenciaGuardada(entrada(NUEVO, h, { ...base, reglasApagadas: ["R-NEW"] }))).toEqual(REVISAR);
  });

  it("apagar otra regla no afecta a esta", () => {
    const h = hallazgoDe(SAN_JUAN, "R-ISC");
    expect(aceptarSugerenciaGuardada(entrada(SAN_JUAN, h, { reglasApagadas: ["R-MIX", "R-NEW", "R-HIS"] }))).toMatchObject({ ok: true });
  });

  it("lo respaldado por el XML (sin confirmación) también: apagada es revisar_de_nuevo, en masa incluida", () => {
    const m = { biDg: "500.00", igvDg: "0.00" };
    const respaldado: HallazgoJson = {
      regla: "R-ISC",
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "500.00" },
      lecturas: m,
      requiereConfirmacion: false,
    };
    const c = compra({ biDg: "500.00", total: "500.00" });
    for (const enMasa of [false, true]) {
      expect(aceptarSugerenciaGuardada(entrada(c, respaldado, { enMasa, reglasApagadas: [] }))).toMatchObject({ ok: true });
      expect(aceptarSugerenciaGuardada(entrada(c, respaldado, { enMasa, reglasApagadas: ["R-ISC"] }))).toEqual(REVISAR);
    }
  });
});
