// R-GP (spec 011, CA-12, D-5): palabra clave de consumo personal en la glosa del XML. Rojo.
import { describe, expect, it } from "vitest";
import {
  ctx,
  de,
  evaluar,
  fila,
  montos,
  unico,
  xml,
} from "../../tests/ayudas/filas-motor";
import { DiccionarioGlosas } from "../texto/index";
import { aplicarSugerencia } from "./index";

const conGlosas = (...glosas: string[]) => fila({ xml: xml({ glosas }) });

describe("R-GP", () => {
  it("'ZAPATILLAS URBANAS T-42' dispara R-GP con la palabra en la explicación y sugiere excluir", () => {
    const h = unico(
      evaluar([conGlosas("ZAPATILLAS URBANAS T-42")]).hallazgos,
      "R-GP",
    );
    expect(h.filaId).toBe("f1");
    expect(h.destino).toBeNull();
    expect(h.sugerencia).toEqual({
      tipo: "excluir",
      palabra: "zapatilla",
      categoria: "calzado-ropa",
    });
    expect(h.explicacion).toContain("zapatilla");
    expect(h.dato).toBeNull();
    expect(h.lecturas).toEqual({});
  });

  it("abreviatura con punto 'zapat. dep.' dispara", () => {
    expect(
      unico(evaluar([conGlosas("zapat. dep.")]).hallazgos, "R-GP").sugerencia,
    ).toMatchObject({
      tipo: "excluir",
      palabra: "zapatilla",
    });
  });

  it("'zapata de concreto' no dispara", () => {
    expect(
      de(evaluar([conGlosas("zapata de concreto")]).hallazgos, "R-GP"),
    ).toEqual([]);
  });

  it("sin XML no se evalúa", () => {
    expect(de(evaluar([fila()]).hallazgos, "R-GP")).toEqual([]);
  });

  it("XML sin glosas o sin coincidencia no dispara", () => {
    expect(de(evaluar([conGlosas()]).hallazgos, "R-GP")).toEqual([]);
    expect(
      de(evaluar([conGlosas("servicio de consultoria")]).hallazgos, "R-GP"),
    ).toEqual([]);
  });

  it("varias glosas: gana la primera coincidencia en orden de glosas (determinista)", () => {
    const h = unico(
      evaluar([conGlosas("cemento", "ZAPATO negro", "POLO azul")]).hallazgos,
      "R-GP",
    );
    expect(h.sugerencia).toMatchObject({
      palabra: "zapato",
      categoria: "calzado-ropa",
    });
  });

  it("usa el diccionario del contexto", () => {
    const d = DiccionarioGlosas.desde([
      { categoria: "ferreteria", palabras: ["tornillo"] },
    ]);
    const f = conGlosas("tornillos de 2 pulgadas", "zapatillas");
    const h = unico(evaluar([f], ctx({ diccionario: d })).hallazgos, "R-GP");
    expect(h.sugerencia).toEqual({
      tipo: "excluir",
      palabra: "tornillo",
      categoria: "ferreteria",
    });
  });

  it("la explicación no copia texto del XML salvo la palabra del diccionario", () => {
    const h = unico(
      evaluar([conGlosas("ZAPATILLAS <script>alert(1)</script> URBANAS")])
        .hallazgos,
      "R-GP",
    );
    expect(h.explicacion).not.toContain("script");
    expect(h.explicacion).not.toContain("URBANAS");
    expect(h.explicacion).not.toContain("alert");
  });

  it("XML de otro comprobante se ignora: no hay R-GP y sí aviso XML_AJENO", () => {
    const f = fila({
      xml: xml({
        comprobante: { tipo: "01", serie: "F001", numero: "777" },
        glosas: ["zapatillas"],
      }),
    });
    const r = evaluar([f]);
    expect(de(r.hallazgos, "R-GP")).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_AJENO"]);
  });
});

describe("R-GP: aplicar", () => {
  it("devuelve excluir=true y los mismos montos", () => {
    const m = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.00",
    });
    const h = unico(
      evaluar([fila({ montos: m, xml: xml({ glosas: ["zapatillas"] }) })])
        .hallazgos,
      "R-GP",
    );
    const r = aplicarSugerencia(m, h);
    expect(r.excluir).toBe(true);
    expect(JSON.stringify(r.montos)).toBe(JSON.stringify(m));
  });
});
