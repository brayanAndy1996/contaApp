/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas en pruebas */
// Spec 021 · T17: correcciones de la ronda adversarial 1 (rojo) sobre las rutas de reglas. Una prueba normal por hallazgo, con el
// comportamiento que fija la spec/plan: H-021-1-1 («Recordar» con un solo periodo: 422 `periodos_distintos`, sin escribir) y
// H-021-1-2 (`versionBase` fuera del rango de int4: 400 `solicitud_invalida` en PATCH y «Recordar», como ya hace DELETE, nunca 500).
// Fallan hasta T18 (el código `periodos_distintos` lo añade T18 a `@contapp/shared`).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoReglas,
  rutaReglas,
  type Actor,
  type BancoReglas,
  type Estudio,
} from "../../../test/soporte-reglas.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoReglas;
let E: Estudio;
let contador: Actor;

const PROV = "20700000012";

beforeAll(async () => {
  v = await abrirBancoReglas();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

const nuevoCliente = () => v.cliente(E, { responsable: contador.id });
const compra = (c: { id: string }, numero: string, periodo?: string) =>
  v.sembrarCompra(E.tenantId, c.id, {
    serie: "F002",
    numero,
    doc: PROV,
    razonSocial: "CANARIO RAZON R1 CORR SAC",
    ...(periodo === undefined ? {} : { periodo }),
    usuarioId: E.titular.id,
  });
const vivas = async (c: { id: string }) => (await v.reglasBd(c.id)).filter((r: any) => !r.eliminada);

describe("«Recordar» exige un solo periodo (plan: «de un mismo periodo»)", () => {
  it("H-021-1-1 · compras del mismo proveedor en dos periodos: 422 periodos_distintos y no se crea regla", async () => {
    const c = await nuevoCliente();
    const p1 = await compra(c, "1", "202609");
    const p2 = await compra(c, "2", "202611");
    const antes = await v.reglasBd(c.id);
    const r = await v.http(contador, "POST", `${rutaReglas(c.id)}/recordar`, { compraIds: [p1, p2], destino: "DNG", versionBase: null });
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "periodos_distintos" });
    expect(await v.reglasBd(c.id)).toEqual(antes);
    expect(await vivas(c)).toEqual([]);
  });
});

describe("versionBase fuera del rango de int4 se rechaza en el borde (como DELETE)", () => {
  const GRANDE = 2 ** 31;

  it("H-021-1-2 · PATCH con versionBase = 2^31: 400 solicitud_invalida y la regla no cambia", async () => {
    const c = await nuevoCliente();
    const regla = await v.sembrarRegla(E.tenantId, c.id, { usuarioId: E.titular.id, destino: "DNG" });
    const antes = await v.reglasBd(c.id);
    const r = await v.http(contador, "PATCH", `${rutaReglas(c.id)}/${regla}`, { versionBase: GRANDE, destino: "DG" });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.reglasBd(c.id)).toEqual(antes);
  });

  it("H-021-1-2 · «Recordar» con versionBase = 2^31: 400 solicitud_invalida y la regla no cambia", async () => {
    const c = await nuevoCliente();
    const id = await compra(c, "1");
    await v.sembrarRegla(E.tenantId, c.id, { usuarioId: E.titular.id, destino: "DNG" });
    const antes = await v.reglasBd(c.id);
    const r = await v.http(contador, "POST", `${rutaReglas(c.id)}/recordar`, { compraIds: [id], destino: "DG", versionBase: GRANDE });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.reglasBd(c.id)).toEqual(antes);
  });
});
