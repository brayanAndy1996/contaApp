/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 013 · T20a (rojo), defecto D-1 de T20 (D24 del usuario, 2026-11-07): `GET /trabajos` (la lista del panel) devuelve el
// `periodo` (AAAAMM) de una descarga de la propuesta del SIRE, para que el panel lo muestre junto al cliente. Solo ese tipo y
// solo esa clave: no salen `libro`, `parametros` ni el RUC. El evento SSE usa la misma proyección (`vistaDeFila`, ver
// `packages/queue/src/periodo-vista-t20a.spec.ts`).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  type Actor,
  type BancoVentas,
  type Estudio,
} from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

describe("GET /trabajos · periodo de la descarga (T20a, D24)", () => {
  it("la descarga de ventas aparece con su periodo y sin ningún otro parámetro", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const r = await v.llamar(contador, "POST", `${base(c.id, "202609")}/descargar`);
    expect(r.status, r.text).toBe(202);
    const lista = await v.llamar(contador, "GET", "/trabajos");
    expect(lista.status, lista.text).toBe(200);
    const t = (lista.body as any[]).find((x) => x.id === r.body.trabajoId);
    expect(t).toMatchObject({ tipo: "sire.propuesta.descargar", clienteId: c.id, periodo: "202609" });
    expect(Object.keys(t)).not.toContain("libro");
    expect(Object.keys(t)).not.toContain("parametros");
    expect(JSON.stringify(t)).not.toContain(c.ruc);
  });

  it("los trabajos de otros tipos no llevan periodo", async () => {
    const lista = await v.llamar(contador, "GET", "/trabajos");
    expect(lista.status, lista.text).toBe(200);
    const otros = (lista.body as any[]).filter((x) => x.tipo !== "sire.propuesta.descargar");
    for (const t of otros) expect(t, t.tipo).not.toHaveProperty("periodo");
  });
});
