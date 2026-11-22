import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 026 · T19 (tester; pruebas de las correcciones de la ronda adversarial 2, en rojo). Contrato de `shared` que fijan:
//  - H-026-2-4 (decisión del usuario 2026-11-22): con la suma de la ventana fuera de NUMERIC(14,2) el coeficiente de la vista es
//    {estado: "no_determinable", motivo: "montos_fuera_de_rango"} (motivo propio de la prorrata; el 422 `resumen_fuera_de_rango` deja de
//    usarse en la lectura). `MOTIVOS_NO_DETERMINABLE` = total_cero | acumulado_invalido | montos_fuera_de_rango.
//  - H-026-2-6 (decisión del usuario 2026-11-22): `igvEstimado` en estado «calculado» lleva `avisos`: lista de códigos fijos; hoy el único
//    es "ventas_usd_sin_tipo_cambio" (hay ventas USD de M sin tipo de cambio y no se incluyeron). Una vista sin la clave `avisos` sigue
//    siendo válida (se lee como lista vacía) para no romper a quien arma vistas sin avisos.
//  - H-026-2-5: el motivo del mes manual rechaza U+2028 (LINE SEPARATOR) y U+2029 (PARAGRAPH SEPARATOR) igual que un salto de línea.
// Pruebas por comportamiento público de los esquemas; el nombre de los códigos es lo que se fija.
type Json = Record<string, unknown>;
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const esquema = (nombre: string): Esquema => {
  const s = (shared as Record<string, unknown>)[nombre] as Esquema | undefined;
  if (s === undefined) throw new Error(`no implementado: @contapp/shared no exporta ${nombre}`);
  return s;
};

const PERIODOS = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];
const mes = (periodo: string): Json => ({
  periodo,
  origen: "declarado",
  gravadas: "999999999999.99",
  exportaciones: "0.00",
  noGravadas: "0.00",
  total: "999999999999.99",
  avisos: [],
  declaracion: { numeroOrden: "7654321", fechaPresentacion: "2026-11-10", tipo: "original", presentaciones: 1 },
  manual: null,
  versionManual: 0,
  sireCargado: false,
});
const igvCalculado = (o: Json = {}): Json => ({
  estado: "calculado",
  igvVentas: "18000.00",
  creditoDg: "9000.00",
  igvDgng: "3600.00",
  creditoDgng: "3000.00",
  igvDng: "180.00",
  resultado: "6000.00",
  situacion: "a_pagar",
  estadoPeriodoCompras: "revisado",
  ...o,
});
const vista = (o: Json = {}): Json => ({
  periodo: "202610",
  ventana: PERIODOS.map(mes),
  coeficiente: { estado: "no_determinable", motivo: "montos_fuera_de_rango" },
  igvEstimado: { estado: "no_estimable", motivo: "coeficiente" },
  diferencia: null,
  ultimaObtencion: null,
  prorrataUsada: null,
  versionUsada: 0,
  ...o,
});

describe("H-026-2-4 · coeficiente «no_determinable» por montos fuera de rango", () => {
  it("el coeficiente acepta el motivo `montos_fuera_de_rango` y lo conserva", () => {
    const r = esquema("coeficienteVistaSchema").safeParse({ estado: "no_determinable", motivo: "montos_fuera_de_rango" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ estado: "no_determinable", motivo: "montos_fuera_de_rango" });
  });

  it("la vista completa (12 meses de 12 dígitos, coeficiente no determinable e IGV «no_estimable: coeficiente») es válida", () => {
    const r = esquema("prorrataVistaSchema").safeParse(vista());
    expect(r.success).toBe(true);
    expect((r.data as Json).coeficiente).toEqual({ estado: "no_determinable", motivo: "montos_fuera_de_rango" });
  });

  it.each(["total_cero", "acumulado_invalido"])("los motivos que ya existían (%s) siguen válidos", (motivo) => {
    expect(esquema("coeficienteVistaSchema").safeParse({ estado: "no_determinable", motivo }).success).toBe(true);
  });

  it.each(["fuera_de_rango", "resumen_fuera_de_rango", "", "MONTOS_FUERA_DE_RANGO"])("un motivo inventado (%j) sigue rechazado", (motivo) => {
    expect(esquema("coeficienteVistaSchema").safeParse({ estado: "no_determinable", motivo }).success).toBe(false);
  });
});

describe("H-026-2-6 · `igvEstimado.avisos` (ventas USD de M sin tipo de cambio)", () => {
  it("el IGV calculado conserva el aviso `ventas_usd_sin_tipo_cambio`", () => {
    const r = esquema("igvEstimadoVistaSchema").safeParse(igvCalculado({ avisos: ["ventas_usd_sin_tipo_cambio"] }));
    expect(r.success).toBe(true);
    expect((r.data as Json).avisos).toEqual(["ventas_usd_sin_tipo_cambio"]);
  });

  it("la vista completa con el aviso en el IGV lo conserva", () => {
    const r = esquema("prorrataVistaSchema").safeParse(
      vista({ igvEstimado: igvCalculado({ avisos: ["ventas_usd_sin_tipo_cambio"] }), coeficiente: { estado: "calculado", porcentaje: "83.33", numerador: "1200000.00", total: "1440000.00", provisional: false, avisos: [] } }),
    );
    expect(r.success).toBe(true);
    expect(((r.data as Json).igvEstimado as Json).avisos).toEqual(["ventas_usd_sin_tipo_cambio"]);
  });

  it("sin avisos: lista vacía (con la clave `avisos: []` o sin ella)", () => {
    for (const igv of [igvCalculado({ avisos: [] }), igvCalculado()]) {
      const r = esquema("igvEstimadoVistaSchema").safeParse(igv);
      expect(r.success).toBe(true);
      expect((r.data as Json).avisos ?? []).toEqual([]);
    }
  });

  it.each([["usd_sin_tipo_cambio"], ["inventado"], [""], ["ventas_usd_sin_tipo_cambio", "inventado"]])(
    "un código de aviso fuera del catálogo (%j) se rechaza",
    (...avisos) => {
      expect(esquema("igvEstimadoVistaSchema").safeParse(igvCalculado({ avisos })).success).toBe(false);
    },
  );

  it("`avisos` no es una cadena suelta ni un `number`", () => {
    expect(esquema("igvEstimadoVistaSchema").safeParse(igvCalculado({ avisos: "ventas_usd_sin_tipo_cambio" })).success).toBe(false);
    expect(esquema("igvEstimadoVistaSchema").safeParse(igvCalculado({ avisos: 1 })).success).toBe(false);
  });
});

describe("H-026-2-5 · motivo sin separadores de línea Unicode", () => {
  const cuerpoGuardar = (motivo: string): Json => ({ gravadas: "100.00", exportaciones: "0.00", noGravadas: "0.00", motivo, version: 0 });
  const cuerpoEliminar = (motivo: string): Json => ({ motivo, version: 1 });

  it.each([
    ["U+2028 LINE SEPARATOR", "Libro de ventas\u2028físico"],
    ["U+2029 PARAGRAPH SEPARATOR", "Libro de ventas\u2029físico"],
    ["U+2028 entre dos letras", "a\u2028b"],
    ["U+2029 seguido de texto", "uno\u2029dos\u2029tres"],
  ])("guardar: %s se rechaza", (_n, motivo) => {
    expect(esquema("guardarMesManualSchema").safeParse(cuerpoGuardar(motivo)).success).toBe(false);
  });

  it.each([
    ["U+2028 LINE SEPARATOR", "Se retira\u2028el mes"],
    ["U+2029 PARAGRAPH SEPARATOR", "Se retira\u2029el mes"],
  ])("eliminar: %s se rechaza", (_n, motivo) => {
    expect(esquema("eliminarMesManualSchema").safeParse(cuerpoEliminar(motivo)).success).toBe(false);
  });

  it("el motivo ordinario (con tilde, ñ, comas y dos puntos) sigue válido", () => {
    expect(esquema("guardarMesManualSchema").safeParse(cuerpoGuardar("Libro físico: ventas de la ñapa, mes 09")).success).toBe(true);
    expect(esquema("eliminarMesManualSchema").safeParse(cuerpoEliminar("Se retira el mes")).success).toBe(true);
  });

  it("`motivoProrrataSchema` también los rechaza", () => {
    expect(esquema("motivoProrrataSchema").safeParse("uno\u2028dos").success).toBe(false);
    expect(esquema("motivoProrrataSchema").safeParse("uno\u2029dos").success).toBe(false);
    expect(esquema("motivoProrrataSchema").safeParse("uno dos").success).toBe(true);
  });
});
