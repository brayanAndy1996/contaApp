/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 022 (T6, RP-3): excluir y restaurar una venta leen la venta por id y no todo el periodo.
//  - CA-8 (equivalencia HTTP): la misma respuesta de siempre, con el mismo 404 (`no_encontrado`) para id mal formado, de otro cliente,
//    de otro periodo y de otro estudio (RLS), y 409 `no_excluida` al restaurar una no excluida. Que `leerFilasVentas` ya no se llama
//    lo prueba `exclusion-por-id.spec.ts`.
//  - CA-9 (tiempo): con 5.000 ventas en el periodo, el p95 de 20 repeticiones de excluir y de restaurar < 300 ms y la mediana
//    <= 2 x la de un periodo de 100 ventas (D-8: solo sin cobertura).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, descuadrada, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base } from "../../../test/soporte-ventas.js";
import { BAJO_COBERTURA } from "../../../test/tiempos.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let F: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  F = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
});

const MOTIVO = "Llegó descuadrada del SIRE: se corrige en facturación";
const excluir = (a: Actor, c: { id: string }, ventaId: string, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}/${ventaId}/excluir`, { motivo: MOTIVO });
const restaurar = (a: Actor, c: { id: string }, ventaId: string, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}/${ventaId}/restaurar`, {});

/** Un cliente con `n` ventas S001 que cuadran y una descuadrada (D001-1): la única excluible. */
async function periodoCon(n: number): Promise<{ c: { id: string }; id: string }> {
  const c = await v.cliente(E, { responsable: contador.id });
  await v.sembrarMuchas(E.tenantId, c.id, n, { usuarioId: E.titular.id });
  const [id] = await v.sembrarVentas(E.tenantId, c.id, [descuadrada("D001", 1)], { usuarioId: E.titular.id });
  return { c, id: id! };
}

describe("CA-8 · equivalencia de excluir y restaurar por id", () => {
  it("excluir y restaurar responden 200 con la exclusión vigente y luego con null; se puede volver a excluir", async () => {
    const { c, id } = await periodoCon(30);
    const a = await excluir(contador, c, id);
    expect(a.status, a.text).toBe(200);
    expect(a.body).toMatchObject({ id, origen: "sire", serie: "D001", cuadra: false });
    expect(a.body.exclusion).toEqual({ motivo: MOTIVO, por: contador.id, en: expect.any(String) });
    const b = await restaurar(contador, c, id);
    expect(b.status, b.text).toBe(200);
    expect(b.body).toMatchObject({ id, exclusion: null });
    expect((await excluir(contador, c, id)).status).toBe(200);
  });

  it("un id mal formado, inexistente, de otro cliente, de otro periodo o de otro estudio es 404 no_encontrado", async () => {
    const { c, id } = await periodoCon(5);
    const otro = await periodoCon(5);
    const propio = await v.cliente(F);
    const casos: Array<[string, () => Promise<{ status: number; body: any; text: string }>]> = [];
    for (const mal of ["abc", "..", "' or 1=1 --", randomUUID()]) {
      casos.push([`id ${mal}`, () => excluir(contador, c, mal)], [`id ${mal}`, () => restaurar(contador, c, mal)]);
    }
    casos.push(
      ["otro cliente", () => excluir(contador, otro.c, id)],
      ["otro cliente (restaurar)", () => restaurar(contador, otro.c, id)],
      ["otro periodo", () => excluir(contador, c, id, "202609")],
      ["otro periodo (restaurar)", () => restaurar(contador, c, id, "202609")],
      ["otro estudio, cliente de E", () => excluir(F.titular, c, id)],
      ["otro estudio, cliente propio", () => excluir(F.titular, propio, id)],
      ["otro estudio (restaurar)", () => restaurar(F.titular, c, id)],
    );
    for (const [nombre, llamar] of casos) {
      const r = await llamar();
      expect(r.status, `${nombre}: ${r.text}`).toBe(404);
      expect(r.body, nombre).toEqual({ codigo: "no_encontrado" });
    }
    expect(await A.exclusiones(c.id)).toEqual([]);
    expect(await A.exclusiones(otro.c.id)).toEqual([]);
  });

  it("restaurar una venta no excluida (o ya restaurada) es 409 no_excluida", async () => {
    const { c, id } = await periodoCon(5);
    expect((await restaurar(contador, c, id)).body).toEqual({ codigo: "no_excluida" });
    await excluir(contador, c, id);
    await restaurar(contador, c, id);
    const r = await restaurar(contador, c, id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "no_excluida" });
  });
});

const REPETICIONES = 20;
const mediana = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

/** 20 pares excluir/restaurar de la misma venta; devuelve los ms de cada llamada. */
async function medir(c: { id: string }, id: string): Promise<{ ex: number[]; re: number[] }> {
  const ex: number[] = [];
  const re: number[] = [];
  for (let i = 0; i < REPETICIONES; i++) {
    const a = await excluir(contador, c, id);
    expect(a.status, a.text).toBe(200);
    ex.push(a.ms);
    const b = await restaurar(contador, c, id);
    expect(b.status, b.text).toBe(200);
    re.push(b.ms);
  }
  return { ex, re };
}

describe("CA-9 · tiempo de excluir y restaurar con 5.000 ventas en el periodo", () => {
  it("p95 < 300 ms y mediana <= 2 x la de un periodo de 100 ventas", async () => {
    const chico = await periodoCon(100);
    const grande = await periodoCon(5000);
    await medir(chico.c, chico.id); // calentamiento: planes y conexiones del pool
    const m100 = await medir(chico.c, chico.id);
    const m5000 = await medir(grande.c, grande.id);
    const resumen = (n: string, m: { ex: number[]; re: number[] }) =>
      `${n}: excluir mediana ${mediana(m.ex).toFixed(0)} p95 ${p95(m.ex).toFixed(0)} ms; restaurar mediana ${mediana(m.re).toFixed(0)} p95 ${p95(m.re).toFixed(0)} ms`;
    console.info(`CA-9 ${resumen("100", m100)} | ${resumen("5000", m5000)}`);
    if (BAJO_COBERTURA) return;
    expect(p95(m5000.ex), "excluir, p95 con 5.000 ventas").toBeLessThan(300);
    expect(p95(m5000.re), "restaurar, p95 con 5.000 ventas").toBeLessThan(300);
    expect(mediana(m5000.ex), "excluir: mediana 5.000 vs 2 x (100)").toBeLessThanOrEqual(2 * mediana(m100.ex));
    expect(mediana(m5000.re), "restaurar: mediana 5.000 vs 2 x (100)").toBeLessThanOrEqual(2 * mediana(m100.re));
  });
});
