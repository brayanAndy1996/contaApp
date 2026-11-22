// Spec 026 (T14a): una suma de la ventana que excede NUMERIC(14,2) es un 422 controlado `resumen_fuera_de_rango` (como el resumen de
// 014), nunca un 500, y la lectura no deja nada escrito. Contra la BD real por HTTP.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  M,
  rutaVista,
  VENTANA_M,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

const MAXIMO = "999999999999.99"; // el mayor NUMERIC(14,2)

describe("suma de la ventana fuera de NUMERIC(14,2)", () => {
  it("12 meses manuales en el máximo: 422 resumen_fuera_de_rango, sin 500 ni escritura", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    for (const periodo of VENTANA_M) {
      await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: MAXIMO, exportaciones: "0.00", noGravadas: "0.00", autor: E.titular.id });
    }
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await v.http(contador, "GET", rutaVista(c.id, M));
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "resumen_fuera_de_rango" });
    expect(r.text).not.toContain(MAXIMO);
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("control: con montos normales la misma ruta responde 200", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    for (const periodo of VENTANA_M) {
      await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: "1000.00", exportaciones: "0.00", noGravadas: "0.00", autor: E.titular.id });
    }
    const r = await v.http(contador, "GET", rutaVista(c.id, M));
    expect(r.status, r.text).toBe(200);
  });
});
