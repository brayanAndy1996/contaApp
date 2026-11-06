// Spec 013 (T3, rojo): el caso real de la boleta 291 (CA-6, CA-8, CA-11) sobre el fixture del contribuyente de prueba
// (fixtures/sire/20700000002-ventas-202610.json, T1; copia en tests/ayudas/ventas.ts). B001-290 y B001-292 sin la 291: el contador debe ver «Falta B001-291»,
// poder justificarla, o agregarla a mano, y el complemento de una nueva descarga no la altera.
import { describe, expect, it } from "vitest";
import { FIXTURE_VENTAS_202610 } from "../../tests/ayudas/ventas";
import { analizarCorrelatividad } from "./index";

// packages/domain no hace IO: las filas del fixture están copiadas en tests/ayudas/ventas.ts.
const filas = FIXTURE_VENTAS_202610.map(({ tipo, serie, numero }) => ({ tipo, serie, numero }));
const serieDe = (r: ReturnType<typeof analizarCorrelatividad>, tipo: string, serie: string) =>
  r.series.find((s) => s.tipo === tipo && s.serie === serie)!;

describe("boleta 291 · fixture de ventas del contribuyente de prueba", () => {
  const r = analizarCorrelatividad(filas, []);

  it("las boletas B001-290 y B001-292: falta la B001-291 (un solo número, pendiente)", () => {
    expect(serieDe(r, "03", "B001")).toEqual({
      tipo: "03",
      serie: "B001",
      estado: "con_faltantes",
      faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
      noEvaluables: 0,
    });
  });

  it("F001-10 a 12 es «completa» (empieza en 10 y no genera faltantes anteriores)", () => {
    expect(serieDe(r, "01", "F001")).toMatchObject({ estado: "completa", faltantes: [] });
  });

  it("B003-400, 401 y 405: faltan la 402 a la 404, en un solo rango", () => {
    expect(serieDe(r, "03", "B003").faltantes).toEqual([{ desde: 402, hasta: 404, estado: "pendiente" }]);
  });

  it("la nota de crédito 07 F001-1 no se mezcla con las facturas 01 F001 y F002 es «completa»", () => {
    expect(serieDe(r, "07", "F001")).toMatchObject({ estado: "completa", faltantes: [] });
    expect(serieDe(r, "01", "F002")).toMatchObject({ estado: "completa", faltantes: [] });
  });

  it("el periodo tiene 5 series y exactamente 2 con faltantes; ninguna bloquea nada", () => {
    expect(r.series).toHaveLength(5);
    expect(r.series.filter((s) => s.estado === "con_faltantes").map((s) => s.serie)).toEqual(["B001", "B003"]);
    expect(Object.keys(r)).toEqual(["series"]);
  });
});

describe("boleta 291 · justificar (HU-12, CA-7)", () => {
  it("con comentario, la 291 figura «justificado» y la B003 sigue pendiente", () => {
    const r = analizarCorrelatividad(filas, [{ tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "Boleta anulada en caja" }]);
    expect(serieDe(r, "03", "B001").faltantes).toEqual([
      { desde: 291, hasta: 291, estado: "justificado", comentario: "Boleta anulada en caja" },
    ]);
    expect(serieDe(r, "03", "B003").faltantes[0]!.estado).toBe("pendiente");
  });

  it("revertir (quitarla de la lista) vuelve a dejarla pendiente", () => {
    const r = analizarCorrelatividad(filas, []);
    expect(serieDe(r, "03", "B001").faltantes[0]!.estado).toBe("pendiente");
  });
});

describe("boleta 291 · agregar la venta faltante (RF-055, CA-8)", () => {
  const conLa291 = [...filas, { tipo: "03", serie: "B001", numero: "291" }];

  it("al agregar B001-291 el salto desaparece y la serie queda «completa»", () => {
    const r = analizarCorrelatividad(conLa291, []);
    expect(serieDe(r, "03", "B001")).toMatchObject({ estado: "completa", faltantes: [] });
  });

  it("la justificación que quedó sin hueco no reaparece ni hace fallar el análisis", () => {
    const r = analizarCorrelatividad(conLa291, [{ tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "x" }]);
    expect(serieDe(r, "03", "B001")).toMatchObject({ estado: "completa", faltantes: [] });
  });
});

describe("boleta 291 · una nueva descarga con la 293 (CA-11)", () => {
  it("290, 291 (agregada y justificada) y 292 más la 293 nueva: la serie queda «completa»", () => {
    const base = [
      { tipo: "03", serie: "B001", numero: "290" },
      { tipo: "03", serie: "B001", numero: "291" },
      { tipo: "03", serie: "B001", numero: "292" },
    ];
    const r = analizarCorrelatividad([...base, { tipo: "03", serie: "B001", numero: "293" }], [{ tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "x" }]);
    expect(r.series).toEqual([{ tipo: "03", serie: "B001", estado: "completa", faltantes: [], noEvaluables: 0 }]);
  });

  it("si la justificada sigue sin agregarse y llega la 293, el hueco justificado se mantiene", () => {
    const r = analizarCorrelatividad(
      [290, 292, 293].map((n) => ({ tipo: "03", serie: "B001", numero: String(n) })),
      [{ tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "Boleta anulada" }],
    );
    expect(r.series[0]!.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "justificado", comentario: "Boleta anulada" }]);
  });
});
