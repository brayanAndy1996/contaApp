/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 T18 · correcciones de la ronda adversarial que se ven por HTTP con PostgreSQL real (rojo hasta T19).
//  - H-013-3: un carácter de control en el comentario de «Justificar» es 400 (no un 500 de PostgreSQL) y nada se escribe.
//  - H-013-7 y H-013-8 (D17, D21): la correlatividad que ve el contador agrupa por la serie normalizada (mayúsculas) y no
//    cuenta los ceros a la izquierda del número, así que lo que muestra se puede cerrar agregando o justificando.
//  - H-013-4 (D19, usuario 2026-11-07): el tope de 20.000 filas es de las filas que llegan en esa importación, no del total
//    vivo del periodo; agregar a mano no tiene tope. D9 y D10 no cambian.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  csvVentas,
  cuerpoVenta,
  fila,
  type Actor,
  type BancoVentas,
  type Estudio,
  type FilaV,
} from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

const nuevo = () => v.cliente(E, { responsable: contador.id });
const conBoletas = async () => {
  const c = await nuevo();
  await v.sembrarVentas(E.tenantId, c.id, [fila("B001", 290), fila("B001", 292)], { usuarioId: E.titular.id });
  return c;
};
const justificar = (clienteId: string, cuerpo: unknown) =>
  v.llamar(contador, "POST", `${base(clienteId)}/saltos-justificados`, cuerpo);
const agregar = (clienteId: string, cuerpo: unknown) => v.llamar(contador, "POST", base(clienteId), cuerpo);
const confirmar = (clienteId: string, bytes: Uint8Array) =>
  v.bin(contador, "POST", `${base(clienteId)}/importar/confirmar`, bytes);
const salto = (comentario: string) => ({ tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario });
const tantas = (n: number, serie: string): FilaV[] => Array.from({ length: n }, (_v, i) => fila(serie, i + 1));

describe("H-013-3 · el comentario de una justificación no admite caracteres de control", () => {
  it.each([
    ["SOH (U+0001)", "\u0001anulada"],
    ["BEL (U+0007)", "anulada\u0007"],
    ["ESC (U+001B)", "\u001b[31manulada"],
    ["DEL (U+007F)", "anulada\u007f"],
    ["NEL, C1 (U+0085)", "anulada\u0085por error"],
    ["NUL al final (U+0000)", "anulada\u0000"],
  ])("%s: 400 y no se guarda nada", async (_nombre, comentario) => {
    const c = await conBoletas();
    const r = await justificar(c.id, salto(comentario));
    expect(r.status, r.text).toBe(400);
    expect(await v.saltos(c.id)).toHaveLength(0);
  });

  it("caso feliz: un comentario con tildes, ñ, comillas y emoji se guarda tal cual (201)", async () => {
    const c = await conBoletas();
    const comentario = "Anulación nº 3 — «cliente» pidió cambio; ver 'acta' \"2026\" ✔";
    const r = await justificar(c.id, salto(comentario));
    expect(r.status, r.text).toBe(201);
    const guardadas = await v.saltos(c.id);
    expect(guardadas).toHaveLength(1);
    expect((guardadas[0] as any).comentario).toBe(comentario);
  });
});

const corr = (clienteId: string) => v.llamar(contador, "GET", `${base(clienteId)}/correlatividad`);
const sembrar = async (filas: FilaV[]) => {
  const c = await nuevo();
  await v.sembrarVentas(E.tenantId, c.id, filas, { usuarioId: E.titular.id });
  return c;
};

describe("H-013-8 · los ceros a la izquierda no abren un faltante (D21)", () => {
  it("caso feliz: 290, «0000000291» y 292 son una serie completa (antes: «Falta B001-291» imposible de cerrar)", async () => {
    const c = await sembrar([fila("B001", 290), fila("B001", "0000000291"), fila("B001", 292)]);
    const r = await corr(c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.series).toEqual([{ tipo: "03", serie: "B001", estado: "completa", faltantes: [], noEvaluables: 0 }]);
  });

  it("con ceros delante el hueco real se informa sin ellos y se puede justificar", async () => {
    const c = await sembrar([fila("B001", "0000000290"), fila("B001", "0000000293")]);
    const r = await corr(c.id);
    expect(r.body.series[0]).toMatchObject({ faltantes: [{ desde: 291, hasta: 292, estado: "pendiente" }], noEvaluables: 0 });
    const j = await justificar(c.id, { ...salto("Boletas anuladas"), desde: 291, hasta: 292 });
    expect(j.status, j.text).toBe(201);
    expect((await corr(c.id)).body.series[0].faltantes).toEqual([
      { desde: 291, hasta: 292, estado: "justificado", comentario: "Boletas anuladas" },
    ]);
  });

  it("error: un número de más de 8 dígitos significativos sigue siendo no evaluable (no inventa huecos)", async () => {
    const c = await sembrar([fila("B001", 290), fila("B001", "0123456789"), fila("B001", 292)]);
    const r = await corr(c.id);
    expect(r.body.series[0]).toMatchObject({ noEvaluables: 1, faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }] });
  });
});

describe("H-013-7 · «b001» y «B001» son una sola serie (D17)", () => {
  it("caso feliz: B001-290 y b001-292 guardadas así: un solo faltante en «B001», que se justifica con la serie «B001»", async () => {
    const c = await sembrar([fila("B001", 290), fila("b001", 292)]);
    const r = await corr(c.id);
    expect(r.body.series).toEqual([
      { tipo: "03", serie: "B001", estado: "con_faltantes", faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }], noEvaluables: 0 },
    ]);
    const j = await justificar(c.id, salto("Boleta anulada"));
    expect(j.status, j.text).toBe(201);
    expect((await corr(c.id)).body.series[0].faltantes[0]).toMatchObject({ desde: 291, hasta: 291, estado: "justificado" });
  });

  it("agregar B001-291 cierra el faltante de una serie guardada en minúsculas (b001-290 y b001-292)", async () => {
    const c = await sembrar([fila("b001", 290), fila("b001", 292)]);
    expect((await corr(c.id)).body.series).toHaveLength(1);
    const a = await agregar(c.id, cuerpoVenta("B001", 291));
    expect(a.status, a.text).toBe(201);
    expect((await corr(c.id)).body.series).toEqual([
      { tipo: "03", serie: "B001", estado: "completa", faltantes: [], noEvaluables: 0 },
    ]);
  });

  it("error: justificar un número presente en esa serie sigue siendo 400 (la normalización no abre faltantes)", async () => {
    const c = await sembrar([fila("B001", 290), fila("b001", 291), fila("B001", 292)]);
    expect((await corr(c.id)).body.series[0]).toMatchObject({ estado: "completa", faltantes: [] });
    const j = await justificar(c.id, salto("No había faltante"));
    expect(j.status, j.text).toBe(400);
    expect(await v.saltos(c.id)).toHaveLength(0);
  });
});

describe("H-013-4 · el tope de 20.000 filas es de lo que llega, no del total del periodo (D19)", () => {
  it("caso feliz: con 20.000 filas ya guardadas, importar 2 nuevas se acepta (201) y el periodo queda con 20.002", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 20_000, { usuarioId: E.titular.id });
    const r = await confirmar(c.id, csvVentas([fila("N001", 1), fila("N001", 2)]));
    expect(r.status, r.texto.slice(0, 200)).toBe(201);
    expect(r.json.propuesta).toMatchObject({ filasRecibidas: 2, filasNuevas: 2, filasIguales: 0 });
    expect(await v.conteo(c.id)).toMatchObject({ ventas: 20_002, propuestas: 2 });
  });

  it("caso feliz: sobre un periodo ya pasado de 20.000, repetir lo cargado da 0 nuevas (201) y deja su propuesta", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 20_000, { usuarioId: E.titular.id });
    const bytes = csvVentas([fila("N001", 1)]);
    expect((await confirmar(c.id, bytes)).status).toBe(201);
    const otra = await confirmar(c.id, bytes);
    expect(otra.status, otra.texto.slice(0, 200)).toBe(201);
    expect(otra.json.propuesta).toMatchObject({ filasRecibidas: 1, filasNuevas: 0, filasIguales: 1 });
    expect(await v.conteo(c.id)).toMatchObject({ ventas: 20_001, propuestas: 3 });
  });

  it("caso feliz: agregar a mano no tiene tope, ni con el periodo en 20.000 ni después", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 20_000, { usuarioId: E.titular.id });
    for (const n of [1, 2]) {
      const r = await agregar(c.id, cuerpoVenta("M001", n));
      expect(r.status, r.text).toBe(201);
    }
    expect((await v.conteo(c.id)).ventas).toBe(20_002);
  });

  it("error: un archivo de 20.001 filas sigue siendo 422 propuesta_demasiado_grande y no guarda nada, haya o no filas en el periodo", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 5, { usuarioId: E.titular.id });
    const r = await confirmar(c.id, csvVentas(tantas(20_001, "N001")));
    expect(r.status, r.texto.slice(0, 200)).toBe(422);
    expect(r.json).toEqual({ codigo: "propuesta_demasiado_grande" });
    expect(await v.conteo(c.id)).toMatchObject({ ventas: 5, propuestas: 1 });
  });

  it("borde: 20.000 filas nuevas sobre un periodo que ya tiene 5 se aceptan (el tope no suma lo guardado)", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 5, { usuarioId: E.titular.id });
    const r = await confirmar(c.id, csvVentas(tantas(20_000, "N001")));
    expect(r.status, r.texto.slice(0, 200)).toBe(201);
    expect(r.json.propuesta).toMatchObject({ filasRecibidas: 20_000, filasNuevas: 20_000 });
    expect((await v.conteo(c.id)).ventas).toBe(20_005);
  });
});
