// Spec 028 · T8: ramas de validación y valores por defecto de las plantillas de correo que las pruebas de T1 no recorren
// (complementan, no sustituyen, a `aviso.spec.ts`, `resumen.spec.ts` y `pendientes.spec.ts`).
import { describe, expect, it } from "vitest";
import { armarCorreoAviso, armarCorreoPendientes, armarCorreoResumen, resumenVacio } from "../index";
import { FECHA, avisoBuzon, cliente, entradaAviso, entradaPendientes, entradaResumen, esperarLanza } from "../../tests/ayudas/correo";

const limite = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ razonSocial: null, categoria: null, recurso: "clientes", porcentaje: 85, fecha: FECHA, ...extra });
const comoPlan = (avisos: readonly unknown[], extra: Record<string, unknown> = {}) => entradaAviso(avisos, { tipo: "plan_limite", ...extra });

describe("armarCorreoAviso · ramas de validación y valores por defecto", () => {
  it("la entrada y los avisos deben ser objetos; `avisos` un arreglo", () => {
    esperarLanza(() => armarCorreoAviso(null as never));
    esperarLanza(() => armarCorreoAviso([] as never));
    esperarLanza(() => armarCorreoAviso(entradaAviso("x" as never)));
    esperarLanza(() => armarCorreoAviso(entradaAviso(["x"])));
  });

  it("tipos de datos incorrectos en el aviso o en la entrada → lanza", () => {
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: 5 })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { categoria: 5 })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { recurso: 5 })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { fecha: "2026-11-24" })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1, { fecha: new Date("x") })])));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { estudio: 7 })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { total: "1" })));
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1)], { tipo: 3 })));
  });

  it("un total menor que los avisos recibidos es una entrada incoherente → lanza", () => {
    esperarLanza(() => armarCorreoAviso(entradaAviso([avisoBuzon(1), avisoBuzon(2)], { total: 1 })));
  });

  it("plan_limite exige un porcentaje entero de 0 a 100", () => {
    esperarLanza(() => armarCorreoAviso(comoPlan([limite({ porcentaje: undefined })])));
    esperarLanza(() => armarCorreoAviso(comoPlan([limite({ porcentaje: 101 })])));
    esperarLanza(() => armarCorreoAviso(comoPlan([limite({ porcentaje: 85.5 })])));
    esperarLanza(() => armarCorreoAviso(comoPlan([limite({ porcentaje: -1 })])));
  });

  it("plan_limite sin recurso o con recurso vacío usa «tu plan» en el asunto y «Recursos del plan» en la línea", () => {
    const r = armarCorreoAviso(comoPlan([limite({ recurso: undefined })]));
    expect(r.asunto).toBe("Tu estudio llegó al 85 % de tu plan");
    expect(r.texto).toContain("Recursos del plan: 85 % del límite");
    expect(armarCorreoAviso(comoPlan([limite({ recurso: " ​ " })])).asunto).toBe("Tu estudio llegó al 85 % de tu plan");
  });

  it("plan_limite con varios avisos: el asunto toma el de mayor porcentaje (el primero si empatan)", () => {
    const r = armarCorreoAviso(comoPlan([limite({ porcentaje: 80, recurso: "clientes" }), limite({ porcentaje: 95, recurso: "usuarios" }), limite({ porcentaje: 95, recurso: "buzones" })]));
    expect(r.asunto).toBe("Tu estudio llegó al 95 % de usuarios");
  });

  it("razón social vacía o nula: «Cliente sin nombre» en el asunto y en la línea, sin categoría vacía", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { razonSocial: "\u0000 ", categoria: "" })]));
    expect(r.asunto).toBe("Coactiva y avisos críticos del buzón · Cliente sin nombre");
    expect(r.texto).toContain("- Cliente sin nombre · 24/11/2026 07:06");
  });

  it("estudio vacío tras limpiar → pie «Tu estudio · ContApp»", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1)], { estudio: " ‮ " }));
    expect(r.texto).toContain("Tu estudio · ContApp");
  });

  it("un aviso de buzón puede traer `recurso` y `porcentaje` sin efecto en la línea", () => {
    const r = armarCorreoAviso(entradaAviso([avisoBuzon(1, { recurso: "clientes", porcentaje: 90 })]));
    expect(r.texto).toContain("- Cliente-1-SAC · Coactiva · 24/11/2026 07:06");
  });
});

describe("armarCorreoResumen y resumenVacio · ramas de validación", () => {
  it("día inexistente, periodo con mes 13 o tipos incorrectos → lanza", () => {
    esperarLanza(() => armarCorreoResumen(entradaResumen([], { dia: "2026-02-30" })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([], { dia: 20261124 })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([], { periodo: "202613" })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([], { periodo: 202610 })));
    esperarLanza(() => armarCorreoResumen(entradaResumen("x" as never)));
    esperarLanza(() => armarCorreoResumen(entradaResumen([5])));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC", { compras: 3 })])));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { diferidos: "x" })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { diferidos: [null] })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { enlaces: null })));
    esperarLanza(() => armarCorreoResumen(entradaResumen([cliente("Uno SAC")], { enlaces: { pantalla: "https://a.test", baja: 5 } })));
  });

  it("un tipo de diferido repetido es una entrada incoherente → lanza", () => {
    const repetido = [{ tipo: "buzon_critico", cantidad: 1 }, { tipo: "buzon_critico", cantidad: 2 }];
    esperarLanza(() => armarCorreoResumen(entradaResumen([], { diferidos: repetido })));
  });

  it("los diferidos salen en orden canónico y los de cantidad 0 no se listan; si todos son 0 no hay sección", () => {
    const r = armarCorreoResumen(
      entradaResumen([cliente("Uno SAC", { nuevos: 1 })], {
        diferidos: [{ tipo: "plan_limite", cantidad: 4 }, { tipo: "credencial_invalida", cantidad: 0 }, { tipo: "buzon_critico", cantidad: 2 }],
      }),
    );
    expect(r.texto.indexOf("Coactivas y avisos críticos del buzón: 2")).toBeGreaterThan(-1);
    expect(r.texto.indexOf("Coactivas")).toBeLessThan(r.texto.indexOf("Límite del plan: 4"));
    expect(r.texto).not.toContain("Clave SOL inválida");
    const ceros = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })], { diferidos: [{ tipo: "buzon_critico", cantidad: 0 }] }));
    expect(ceros.texto).not.toContain("Avisos que no te enviamos al momento");
  });

  it("sin clientes ni diferidos arma igual (solo el título y el pie); el asunto lleva el día de Lima", () => {
    const r = armarCorreoResumen(entradaResumen([]));
    expect(r.asunto).toBe("Resumen diario · Estudio Quispe · 24/11/2026");
    expect(r.texto).not.toContain("Clientes ·");
    expect(r.texto).toContain("Resumen del 24/11/2026");
  });

  it("razón social vacía → «Cliente sin nombre»; estudio vacío → «Tu estudio» en el asunto", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("\u0000", { nuevos: 1 })], { estudio: "" }));
    expect(r.texto).toContain("- Cliente sin nombre");
    expect(r.asunto).toBe("Resumen diario · Tu estudio · 24/11/2026");
  });

  it("clientes con las mismas cifras y razón social conservan el orden recibido", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Igual SAC", { nuevos: 1, ventas: "abierto" }), cliente("Igual SAC", { nuevos: 1, compras: "revisado" })]));
    expect(r.texto.indexOf("Ventas: abierto")).toBeLessThan(r.texto.indexOf("Compras: revisado"));
  });

  it("resumenVacio: `clientesMas` mayor que 0 no es vacío; valida igual que armar", () => {
    expect(resumenVacio(entradaResumen([], { clientesMas: 2 }))).toBe(false);
    esperarLanza(() => resumenVacio(entradaResumen([], { periodo: "x" })));
  });
});

describe("armarCorreoPendientes · ramas de validación", () => {
  it("la entrada debe ser un objeto con estudio texto y diferidos arreglo; un tipo repetido lanza; cantidad 0 lanza", () => {
    esperarLanza(() => armarCorreoPendientes(null as never));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 1 }], { estudio: 3 })));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes("x" as never)));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 0 }])));
    esperarLanza(() => armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 1 }, { tipo: "buzon_critico", cantidad: 2 }])));
  });

  it("varios tipos salen en orden canónico", () => {
    const r = armarCorreoPendientes(entradaPendientes([{ tipo: "plan_limite", cantidad: 1 }, { tipo: "buzon_critico", cantidad: 2 }]));
    expect(r.texto.indexOf("Coactivas")).toBeLessThan(r.texto.indexOf("Límite del plan"));
  });
});
