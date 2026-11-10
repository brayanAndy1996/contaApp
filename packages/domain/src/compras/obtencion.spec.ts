// Spec 016 · T2 (rojo). `planificarObtencionXml(filas, tamLote = 100) → compraId[][]` (plan, Contratos: Dominio; CA-10, D-4).
// Qué XML pedir tras la descarga de la propuesta: los de las filas sin XML, primero las que tienen hallazgos, en lotes.
// Contrato fijado aquí: cada fila es `{ compraId, conHallazgos, tieneXml, obtencion }` (la salida de `listarPorObtener`),
// con `obtencion: "pendiente" | "no_encontrado" | "credencial" | "transitorio" | null`. El `pendiente` de más de 1 h ya llega
// convertido a `transitorio` desde la capa de BD (el dominio no tiene reloj). El orden es estable dentro de cada grupo.
import { describe, expect, it } from "vitest";
import { planificarObtencionXml } from "./obtencion";
import type { FilaPorObtener } from "./obtencion";

type Estado = FilaPorObtener["obtencion"];
const fila = (compraId: string, o: Partial<FilaPorObtener> = {}): FilaPorObtener => ({
  compraId,
  conHallazgos: false,
  tieneXml: false,
  obtencion: null,
  ...o,
});
const ids = (n: number, desde = 0): string[] => Array.from({ length: n }, (_, i) => `c${String(desde + i).padStart(4, "0")}`);

describe("planificarObtencionXml · orden y lotes", () => {
  it("sin filas no hay lotes", () => {
    expect(planificarObtencionXml([])).toEqual([]);
  });

  it("las filas con hallazgos van primero; dentro de cada grupo se conserva el orden recibido", () => {
    const r = planificarObtencionXml([fila("a"), fila("b", { conHallazgos: true }), fila("c"), fila("d", { conHallazgos: true })]);
    expect(r).toEqual([["b", "d", "a", "c"]]);
  });

  it("lotes de 100 por defecto", () => {
    const r = planificarObtencionXml(ids(250).map((id) => fila(id)));
    expect(r.map((l) => l.length)).toEqual([100, 100, 50]);
  });

  it("100 exactos son un lote; 101 son dos", () => {
    expect(planificarObtencionXml(ids(100).map((id) => fila(id))).map((l) => l.length)).toEqual([100]);
    expect(planificarObtencionXml(ids(101).map((id) => fila(id))).map((l) => l.length)).toEqual([100, 1]);
  });

  it("el tamaño del lote es parametrizable", () => {
    const r = planificarObtencionXml([fila("a"), fila("b", { conHallazgos: true }), fila("c"), fila("d", { conHallazgos: true })], 2);
    expect(r).toEqual([["b", "d"], ["a", "c"]]);
  });

  it("con muchos hallazgos, todos caen en los primeros lotes antes que cualquier fila sin hallazgos", () => {
    const sin = ids(150).map((id) => fila(id));
    const con = ids(30, 1000).map((id) => fila(id, { conHallazgos: true }));
    const r = planificarObtencionXml([...sin, ...con]);
    expect(r[0]!.slice(0, 30)).toEqual(con.map((f) => f.compraId));
    expect(r.flat()).toHaveLength(180);
  });

  it("no repite compras ni pierde ninguna", () => {
    const todas = ids(333).map((id, i) => fila(id, { conHallazgos: i % 7 === 0 }));
    const plano = planificarObtencionXml(todas).flat();
    expect(new Set(plano).size).toBe(333);
    expect([...plano].sort()).toEqual(todas.map((f) => f.compraId).sort());
  });

  it("no muta las filas recibidas", () => {
    const entrada = Object.freeze([Object.freeze(fila("a")), Object.freeze(fila("b", { conHallazgos: true }))]);
    expect(() => planificarObtencionXml(entrada)).not.toThrow();
    expect(entrada.map((f) => f.compraId)).toEqual(["a", "b"]);
  });
});

describe("planificarObtencionXml · qué se omite (CA-10, CA-11)", () => {
  it("omite las filas que ya tienen XML guardado (ni con hallazgos)", () => {
    const r = planificarObtencionXml([fila("a", { tieneXml: true }), fila("b", { tieneXml: true, conHallazgos: true }), fila("c")]);
    expect(r).toEqual([["c"]]);
  });

  it("omite lo que ya está pendiente (hay un trabajo en vuelo)", () => {
    expect(planificarObtencionXml([fila("a", { obtencion: "pendiente" }), fila("b")])).toEqual([["b"]]);
  });

  it("omite lo que no se encontró y lo que falló por credencial (no se insiste sin que el usuario lo pida)", () => {
    const r = planificarObtencionXml([fila("a", { obtencion: "no_encontrado" }), fila("b", { obtencion: "credencial" }), fila("c")]);
    expect(r).toEqual([["c"]]);
  });

  it("un fallo transitorio sí se vuelve a pedir", () => {
    expect(planificarObtencionXml([fila("a", { obtencion: "transitorio" }), fila("b", { obtencion: "transitorio", conHallazgos: true })])).toEqual([["b", "a"]]);
  });

  it.each<[Estado, boolean]>([
    [null, true],
    ["transitorio", true],
    ["pendiente", false],
    ["no_encontrado", false],
    ["credencial", false],
  ])("estado de obtención %s → se pide: %s", (obtencion, seMuestra) => {
    expect(planificarObtencionXml([fila("a", { obtencion })]).flat()).toEqual(seMuestra ? ["a"] : []);
  });

  it("si todo se omite no hay lotes vacíos", () => {
    expect(planificarObtencionXml([fila("a", { tieneXml: true }), fila("b", { obtencion: "pendiente" })])).toEqual([]);
  });

  it("repetir la planificación con el mismo estado da lo mismo (idempotente)", () => {
    const filas = [fila("a"), fila("b", { conHallazgos: true }), fila("c", { tieneXml: true })];
    expect(planificarObtencionXml(filas)).toEqual(planificarObtencionXml(filas));
  });
});
