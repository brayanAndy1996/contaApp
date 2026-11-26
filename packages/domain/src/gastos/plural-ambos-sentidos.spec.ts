// Spec 027 · T16 (rojo; corrección de H-027-1-1, decisión del usuario 2026-11-23): plural simple en ambos sentidos también para el
// diccionario efectivo (globales, propias, desactivadas), `proponerTerminos` (no propone una palabra que ya está en la otra forma) y el
// puntaje (CA-9: aprender «audifonos» y que «AUDÍFONO» marque; S1 cuenta el ítem una vez aunque el diccionario tenga las dos formas).
import { describe, expect, it } from "vitest";
import { SEMILLA_GLOBAL, contextoGastos, contextoNeutro, entrada } from "../../tests/ayudas/gastos";
import type { PalabraPlana } from "../../tests/ayudas/gastos";
import { crearDiccionarioEfectivo } from "./contexto";
import { puntuarGastoPersonal } from "./puntaje";
import { proponerTerminos } from "./terminos";

const p = (palabra: string, categoria = "entretenimiento", activa = true): PalabraPlana => ({ palabra, categoria, excepciones: [], activa });
const efectivo = (propias: string[], globales: readonly PalabraPlana[] = SEMILLA_GLOBAL, desactivadas: string[] = []) =>
  crearDiccionarioEfectivo({ globales, desactivadas, propias: propias.map((w) => p(w)) });

describe("T16 · proponerTerminos no ofrece la palabra que ya está en la otra forma (H-027-1-1)", () => {
  it("propia «parlantes»: «PARLANTE PORTATIL» solo propone «portatil»; propia «portatiles»: solo «parlante»", () => {
    expect(proponerTerminos(["PARLANTE PORTATIL"], efectivo(["parlantes"]))).toEqual(["portatil"]);
    expect(proponerTerminos(["PARLANTE PORTATIL"], efectivo(["portatiles"]))).toEqual(["parlante"]);
  });

  it("propia «parlantes» y «portatiles» (lo aprendido de la glosa en plural): la compra en singular ya no propone nada", () => {
    expect(proponerTerminos(["PARLANTE PORTATIL"], efectivo(["parlantes", "portatiles"]))).toEqual([]);
  });

  it("propia en singular y glosa en plural (011 ya lo hacía): no la propone", () => {
    expect(proponerTerminos(["PARLANTES PORTATILES"], efectivo(["parlante", "portatil"]))).toEqual([]);
  });

  it("palabra global guardada en plural («tabletas»): la glosa en singular no la propone; una desactivada por el estudio sí", () => {
    const globales = [...SEMILLA_GLOBAL, p("tabletas")];
    expect(proponerTerminos(["TABLETA GRAFICA"], crearDiccionarioEfectivo({ globales, desactivadas: [], propias: [] }))).toEqual(["grafica"]);
    expect(proponerTerminos(["TABLETA GRAFICA"], crearDiccionarioEfectivo({ globales, desactivadas: ["tabletas"], propias: [] }))).toEqual([
      "tableta",
      "grafica",
    ]);
  });

  it("propia desactivada no cuenta: «audifonos» desactivada no impide proponer «audifono»", () => {
    const d = crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias: [p("audifonos", "entretenimiento", false)] });
    expect(proponerTerminos(["AUDIFONO JBL"], d)).toEqual(["audifono", "jbl"]);
  });

  it("sin raíces ni prefijos: propia «lapices» no oculta «lapiz»; propia «audifonos» no oculta «audifonera»", () => {
    expect(proponerTerminos(["LAPIZ NEGRO"], efectivo(["lapices"]))).toEqual(["lapiz", "negro"]);
    expect(proponerTerminos(["AUDIFONERA NEGRA"], efectivo(["audifonos"]))).toEqual(["audifonera", "negra"]);
  });

  it("una misma propuesta no ofrece dos formas de la misma palabra: gana la primera que aparece", () => {
    expect(proponerTerminos(["AUDIFONO JBL", "AUDIFONOS SONY"], efectivo([]))).toEqual(["audifono", "jbl", "sony"]);
    expect(proponerTerminos(["AUDIFONOS JBL", "AUDIFONO SONY"], efectivo([]))).toEqual(["audifonos", "jbl", "sony"]);
  });

  it("CA-9: «AUDIFONOS BLUETOOTH JBL X2 UND 2.00» sigue proponiendo audifonos, bluetooth y jbl con el diccionario de semilla", () => {
    expect(proponerTerminos(["AUDIFONOS BLUETOOTH JBL X2 UND 2.00"], efectivo([]))).toEqual(["audifonos", "bluetooth", "jbl"]);
  });
});

describe("T16 · CA-9 y puntaje con el plural en ambos sentidos", () => {
  const puntaje = (glosas: string[], propias: string[], over = {}) =>
    puntuarGastoPersonal(entrada({ glosas, ...over }), contextoNeutro({ diccionario: efectivo(propias) }));

  it("aprender «audifonos» (tal como lo propone la glosa) y luego «AUDÍFONO»: S1 con la palabra guardada, +3", () => {
    const r = puntaje(["AUDÍFONO INALAMBRICO"], ["audifonos"]);
    expect(r).toMatchObject({ palabra: "audifonos", categoria: "entretenimiento", puntaje: 3 });
    expect(r.senales.find((s) => s.codigo === "S1")).toMatchObject({ palabra: "audifonos", items: { coinciden: 1, total: 1 } });
  });

  it("al revés: «audifono» guardada marca «AUDIFONOS»", () => {
    expect(puntaje(["AUDIFONOS JBL"], ["audifono"])).toMatchObject({ palabra: "audifono", puntaje: 3 });
  });

  it("cuenta por ítem: «audifonos» marca «audifono jbl», «cable» no y «AUDIFONOS» sí → 2 de 3 ítems, +6", () => {
    const r = puntaje(["audifono jbl", "cable usb", "AUDIFONOS sony"], ["audifonos"]);
    expect(r.senales.find((s) => s.codigo === "S1")).toMatchObject({ puntos: 6, items: { coinciden: 2, total: 3 } });
  });

  it("sin la palabra no hay S1: «AUDÍFONO» sin diccionario propio no puntúa (el control de CA-9)", () => {
    expect(puntaje(["AUDÍFONO INALAMBRICO"], [])).toMatchObject({ palabra: null, puntaje: 0 });
  });

  it("no hay falso positivo: «audifonos» no puntúa «audifonera», «audifon» ni «audi»", () => {
    for (const glosa of ["AUDIFONERA NEGRA", "AUDIFON", "AUDI A4"]) expect(puntaje([glosa], ["audifonos"]), glosa).toMatchObject({ palabra: null, puntaje: 0 });
  });

  it("con las dos formas en el diccionario (datos viejos) el ítem cuenta una vez y gana la palabra menor en orden de código", () => {
    for (const glosa of ["AUDIFONO JBL", "AUDIFONOS JBL"]) {
      const r = puntaje([glosa], ["audifonos", "audifono"]);
      expect(r, glosa).toMatchObject({ palabra: "audifono", puntaje: 3 });
      expect(r.senales.find((s) => s.codigo === "S1"), glosa).toMatchObject({ puntos: 3, items: { coinciden: 1, total: 1 } });
    }
  });

  it("es independiente del orden en que se guardaron las palabras y de la forma de la glosa", () => {
    const a = puntaje(["AUDÍFONO"], ["audifonos", "parlantes"]);
    const b = puntaje(["AUDÍFONO"], ["parlantes", "audifonos"]);
    expect(b).toEqual(a);
  });

  it("con el contexto de CA-1 (ferretería, proveedor de ropa, miércoles): la global «zapatilla» y una propia «zapatillas» suman S1 una sola vez", () => {
    const r = puntuarGastoPersonal(entrada({ glosas: ["ZAPATILLA URBANA T42"] }), contextoGastos({ diccionario: efectivo(["zapatillas"]) }));
    expect(r.senales.find((s) => s.codigo === "S1")).toMatchObject({ puntos: 3, items: { coinciden: 1, total: 1 } });
  });
});
