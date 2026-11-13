// Spec 021 · T19: ronda adversarial 2 sobre la planificación de R-HIS en la descarga (caja blanca: `compras-historial.ts` →
// `planificarHistorial` del dominio → `cambiarDestino`/`Money.suma`). Sin BD. Una prueba `it.fails` es un hallazgo H-021-2-n.
import type { FilaPropuestaSire } from "@contapp/sunat";
import type { ReglaVigente } from "@contapp/db";
import { describe, expect, it } from "vitest";
import { persistidorCompras } from "./compras.js";
import { planificarHistorialDescarga } from "./compras-historial.js";

const RUC = "20100070970";

const fila = (numero: string, extra: Partial<FilaPropuestaSire> = {}): FilaPropuestaSire => ({
  tipo: "01",
  serie: "F001",
  numero,
  rucContraparte: RUC,
  razonSocialContraparte: "PROVEEDOR SINTETICO S.A.C.",
  fechaEmision: "2026-10-05",
  moneda: "PEN",
  biDg: "1000.00",
  igvDg: "180.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "1180.00",
  ...extra,
});

const regla: ReglaVigente = {
  reglaId: "0190a000-0000-7000-8000-000000000001",
  docTipo: "6",
  docNumero: RUC,
  destino: "DNG",
  version: 1,
};

describe("R2 · R-HIS en la descarga con montos al borde de NUMERIC(14,2)", () => {
  // H-021-2-4: cada columna cabe en NUMERIC(14,2) (`preparar` la acepta: 014 D-3 guarda tal cual una fila legible, aunque
  // descuadre), pero la suma de los BI (o de los IGV) que hace `cambiarDestino` no cabe y `Money.suma` lanza
  // MontoFueraDeRangoError dentro de `planificarHistorial`. Sale de `persistidorCompras.insertar` sin capturar: la descarga ENTERA
  // del periodo se revierte (y no como ErrorDatos), solo porque el proveedor tiene regla. Sin regla la misma fila se guarda.
  // Lo coherente con D-7 y con la BD (que rechaza esa consolidación) es dejar esa fila en su versión 1 y seguir con las demás.
  it.fails("H-021-2-4 · una fila cuya suma de BI o de IGV desborda no tumba el plan: se queda en la versión 1 y las demás se mueven", () => {
    const preparadas = persistidorCompras.preparar([
      fila("1"),
      fila("2", { biDg: "999999999999.99", biDgng: "0.01", igvDg: "0.00", total: "999999999999.99" }),
      fila("3", { igvDg: "999999999999.99", igvDgng: "0.01", total: "999999999999.99" }),
      fila("4"),
    ]);
    // Control: cada fila es legible por sí sola (sin regla se guardarían las cuatro).
    expect(preparadas).toHaveLength(4);
    const nuevas = preparadas.map((p) => p.datos);
    const plan = planificarHistorialDescarga(nuevas, [regla], true);
    const movidas = nuevas.map((n) => plan.historial(n as never) !== null);
    expect(movidas).toEqual([true, false, false, true]);
  });
});
