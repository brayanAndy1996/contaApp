// Spec 014 · T1 (rojo). Qué sugerencias se aceptan en masa (D-15, DU-6; CA-18).
// Contrato fijado por estas pruebas (plan 014, Contratos: Dominio), en packages/domain/src/compras/masivas.ts,
// exportado por compras/index.ts:
//   sugerenciaEsMasiva(hallazgo: Hallazgo): boolean
// Es masiva la sugerencia que no pide confirmación ni dato: `requiereConfirmacion = false` y `dato = null` y
// con sugerencia (un aviso sin sugerencia nunca). Con las reglas de 011 eso es:
//   R-ISC respaldada por el XML → sí;   R-ISC sin XML → no (pide confirmación).
//   R-MIX con monto exacto del XML → sí; R-MIX sin monto exacto → no (pide el dato «gravado»).
//   R-RED respaldada por el XML (o por origenUsd) → sí.
//   R-NEW → no (pide el dato «destino»);  R-GP → no (pide confirmación).
// Los hallazgos se obtienen con evaluarReglas de 011, no se arman a mano. No muta el hallazgo.
// Fuera de estas pruebas queda una ambigüedad de la spec (ver it.todo de R-RED sin respaldo).
import { describe, expect, it } from "vitest";
import { MontosComprobante } from "../comprobante/index";
import { evaluarReglas } from "../reglas/index";
import type { CodigoRegla, Hallazgo } from "../reglas/index";
import { ctxBase, de, fila, unico, xmlDe } from "../../tests/ayudas/filas";
import { sugerenciaEsMasiva } from "./index";

const hallazgos = (f: ReturnType<typeof fila>, conocido = true): readonly Hallazgo[] =>
  evaluarReglas([f], ctxBase(conocido ? {} : { proveedoresConocidos: [] })).hallazgos;
const una = (f: ReturnType<typeof fila>, regla: CodigoRegla, conocido = true): Hallazgo => unico(hallazgos(f, conocido), regla);

const SAN_JUAN = { biDg: "770.00", igvDg: "0.00" };
const MIXTA = { biDg: "21.48", igvDg: "1.61" };

describe("sugerenciaEsMasiva: R-ISC", () => {
  it("sin XML (San Juan): no, pide confirmación", () => {
    const h = una(fila(SAN_JUAN), "R-ISC");
    expect(h.requiereConfirmacion).toBe(true);
    expect(sugerenciaEsMasiva(h)).toBe(false);
  });

  it("respaldada por el XML (ISC 770.00): sí", () => {
    const h = una(fila(SAN_JUAN, { xml: xmlDe({ isc: "770.00" }) }), "R-ISC");
    expect(h.requiereConfirmacion).toBe(false);
    expect(sugerenciaEsMasiva(h)).toBe(true);
  });
});

describe("sugerenciaEsMasiva: R-MIX", () => {
  it("sin monto exacto (mixta sin XML): no, pide el dato gravado", () => {
    const h = una(fila(MIXTA), "R-MIX");
    expect(h.dato).toBe("gravado");
    expect(sugerenciaEsMasiva(h)).toBe(false);
  });

  it("con monto exacto del XML (gravado 8.97): sí", () => {
    const h = una(fila(MIXTA, { xml: xmlDe({ gravado: "8.97", igv: "1.61", noGravado: "12.51" }) }), "R-MIX");
    expect(h.dato).toBeNull();
    expect(h.requiereConfirmacion).toBe(false);
    expect(sugerenciaEsMasiva(h)).toBe(true);
  });
});

describe("sugerenciaEsMasiva: R-RED, R-NEW y R-GP", () => {
  it("R-RED respaldada por el XML (total 118.01 frente al 118.00 del XML): sí", () => {
    const descuadrada = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
    const h = una(fila({}, { montos: descuadrada, xml: xmlDe({ gravado: "100.00", igv: "18.00", total: "118.00" }) }), "R-RED");
    expect(h.requiereConfirmacion).toBe(false);
    expect(sugerenciaEsMasiva(h)).toBe(true);
  });

  it("R-NEW (proveedor nuevo): no, pide el dato destino", () => {
    const h = una(fila({ biDg: "100.00", igvDg: "18.00" }), "R-NEW", false);
    expect(h.dato).toBe("destino");
    expect(sugerenciaEsMasiva(h)).toBe(false);
  });

  it("R-GP (zapatillas): no, pide confirmación", () => {
    const h = una(fila({ biDg: "100.00", igvDg: "18.00" }, { xml: xmlDe({ glosas: ["ZAPATILLAS URBANAS T-42"] }) }), "R-GP");
    expect(sugerenciaEsMasiva(h)).toBe(false);
  });

  it.todo("R-RED sin respaldo (diferencia 0.01, requiereConfirmacion = true): ¿masiva? La spec D-15 dice «R-RED» y a la vez «requiereConfirmacion = false»; requiere decisión del usuario");
});

describe("sugerenciaEsMasiva: robustez", () => {
  it("un aviso sin sugerencia nunca es masivo", () => {
    const base = una(fila(SAN_JUAN, { xml: xmlDe({ isc: "770.00" }) }), "R-ISC");
    const aviso: Hallazgo = { ...base, sugerencia: null };
    expect(sugerenciaEsMasiva(aviso)).toBe(false);
  });

  it("todo hallazgo que pide confirmación o dato es no masivo, sea cual sea la regla", () => {
    const todos: Hallazgo[] = [
      ...hallazgos(fila(SAN_JUAN)),
      ...hallazgos(fila(MIXTA)),
      ...hallazgos(fila({ biDg: "100.00", igvDg: "18.00" }), false),
      ...hallazgos(fila({ biDg: "100.00", igvDg: "18.00" }, { xml: xmlDe({ glosas: ["ZAPATILLAS"] }) })),
    ];
    expect(todos.length).toBeGreaterThanOrEqual(4);
    for (const h of todos) {
      if (h.requiereConfirmacion || h.dato !== null) expect(sugerenciaEsMasiva(h)).toBe(false);
    }
  });

  it("no muta el hallazgo", () => {
    const h = una(fila(SAN_JUAN, { xml: xmlDe({ isc: "770.00" }) }), "R-ISC");
    const antes = JSON.stringify(h);
    sugerenciaEsMasiva(h);
    expect(JSON.stringify(h)).toBe(antes);
    expect(de([h], "R-ISC")).toHaveLength(1);
  });
});
