import { describe, expect, it } from "vitest";
import { textoAccion, textoDetalle } from "./auditoria";

// Spec 025 · T7 (rojo; CA-3, D-5, D-11). Textos de auditoría del aprendizaje de arranque.
// Contrato (T13), `lib/auditoria.ts`: las dos acciones nuevas del catálogo salen en español (ni genéricas ni el código), la
// activación de una candidata (`regla.creada` con `datos.origen = "importacion"`) no se lee como «Recordó una regla», y el
// detalle muestra solo valores simples: nunca el id de la importación ni de la candidata.
const GENERICO = "Realizó una acción";
const UUID = "5f6c1d7e-0000-4000-8000-000000000001";

describe("textoAccion · acciones de 025", () => {
  it.each(["regla.historial_importado", "regla.candidata_descartada"])(
    "%s tiene texto propio en español (ni genérico ni el código crudo)",
    (accion) => {
      const t = textoAccion(accion);
      expect(t, accion).not.toBe(GENERICO);
      expect(t, accion).not.toContain(accion);
      expect(t, accion).not.toMatch(/[._]/);
      expect(t.length).toBeGreaterThan(8);
    },
  );

  it("los dos textos son distintos entre sí y de los de las demás acciones de reglas", () => {
    const nuevos = ["regla.historial_importado", "regla.candidata_descartada"].map((a) => textoAccion(a));
    const previos = ["regla.creada", "regla.editada", "regla.activada", "regla.desactivada", "regla.eliminada"].map((a) =>
      textoAccion(a),
    );
    expect(new Set([...nuevos, ...previos]).size).toBe(nuevos.length + previos.length);
  });

  it("una regla creada por activar una candidata del historial no se lee como «Recordó una regla»", () => {
    const recordada = textoAccion("regla.creada", { origen: "contador" });
    const importada = textoAccion("regla.creada", { origen: "importacion" });
    expect(recordada).toBe(textoAccion("regla.creada"));
    expect(importada).not.toBe(recordada);
    expect(importada).not.toContain("Recordó");
    expect(importada).not.toMatch(/[._]/);
  });
});

describe("textoDetalle · datos de las acciones de 025", () => {
  it("historial importado: sin el id de la importación (solo valores simples)", () => {
    const detalle = textoDetalle({ accion: "regla.historial_importado", datos: { importacionId: UUID, periodos: 6 } });
    expect(detalle).not.toContain(UUID);
    expect(detalle).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(detalle).not.toContain("importacionId");
  });

  it("candidata descartada: sin los ids de la candidata ni de la importación", () => {
    const detalle = textoDetalle({
      accion: "regla.candidata_descartada",
      datos: { candidataId: UUID, importacionId: UUID },
    });
    expect(detalle).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(detalle).not.toContain("candidataId");
  });

  it("regla creada con origen importación: dice de dónde vino y no muestra el código", () => {
    const detalle = textoDetalle({
      accion: "regla.creada",
      datos: { reglaId: UUID, destino: "DNG", origen: "importacion" },
    });
    expect(detalle).toContain("Importado del historial");
    expect(detalle).not.toContain("importacion");
    expect(detalle).not.toContain(UUID);
  });
});
