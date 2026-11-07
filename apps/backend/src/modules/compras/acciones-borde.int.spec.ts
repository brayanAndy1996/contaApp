// Spec 014 (T16): los bordes de las acciones que `acciones.int.spec.ts` y `masivas.int.spec.ts` (T9) no recorren: montos cuya
// suma no cabe en NUMERIC(14,2) (400, nunca 500), cuerpos mal formados de restaurar y descartar, restaurar una fila que no
// está excluida y excluir en masa con agregadas (DU-16: se descartan, no entran en la operación ni en deshacer).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  type Actor,
  type BancoCompras,
  type Estudio,
} from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = () => v.cliente(E, { responsable: contador.id });
const post = (c: Cliente, ruta: string, cuerpo?: unknown) => v.llamar(contador, "POST", `${base(c.id)}${ruta}`, cuerpo ?? {});
const doc = (n: number) => `2070000${String(n).padStart(4, "0")}`;
const sembrar = (c: Cliente, n: number, o: Record<string, unknown> = {}) =>
  v.sembrarCompra(E.tenantId, c.id, { serie: "F010", numero: String(n), doc: doc(n), usuarioId: E.titular.id, ...o });

const DESBORDA = { biDg: "999999999999.99", igvDg: "999999999999.99" };

describe("montos que no caben en NUMERIC(14,2): 400 solicitud_invalida y no se escribe", () => {
  it("editar, calcular y agregar con componentes cuya suma desborda el total", async () => {
    const c = await nuevoCliente();
    const id = await sembrar(c, 1);
    const antes = await v.foto(c.id);
    const e = await post(c, `/${id}/editar`, { versionBase: 1, cambios: DESBORDA });
    const k = await post(c, `/${id}/calcular`, { cambios: DESBORDA });
    const a = await post(c, "", {
      tipo: "01",
      serie: "F010",
      numero: "77",
      proveedor: { tipo: "6", numero: doc(77), razonSocial: "PROVEEDOR GRANDE SAC" },
      fecha: "2026-10-15",
      moneda: "PEN",
      montos: DESBORDA,
    });
    for (const r of [e, k, a]) {
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

describe("cuerpos mal formados de restaurar y descartar", () => {
  it.each(["restaurar", "descartar"])("%s sin versionBase es 400 y no escribe", async (accion) => {
    const c = await nuevoCliente();
    const id = await sembrar(c, 2);
    const antes = await v.foto(c.id);
    const r = await post(c, `/${id}/${accion}`, {});
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("aceptar sugerencia con el cuerpo vacío es 400", async () => {
    const c = await nuevoCliente();
    const id = await sembrar(c, 3);
    const r = await post(c, `/${id}/sugerencias/aceptar`, {});
    expect(r.status, r.text).toBe(400);
  });
});

describe("restaurar una fila que no está excluida", () => {
  it("409 no_excluida y no escribe; en masa va en la fila como no_excluida", async () => {
    const c = await nuevoCliente();
    const id = await sembrar(c, 4);
    const antes = await v.foto(c.id);
    const r = await post(c, `/${id}/restaurar`, { versionBase: 1 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "no_excluida" });
    const m = await post(c, "/masivas/restaurar", { items: [{ compraId: id, versionBase: 1 }] });
    expect(m.status, m.text).toBe(200);
    expect(m.body).toEqual({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: id, codigo: "no_excluida" }] });
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

describe("DU-16 · excluir una agregada la descarta (individual y en masa)", () => {
  it("excluir con una versionBase vieja es 409 version_obsoleta y la agregada sigue viva", async () => {
    const c = await nuevoCliente();
    const id = await sembrar(c, 5, { origen: "agregada" });
    const r = await post(c, `/${id}/excluir`, { versionBase: 9 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "version_obsoleta", versionVigente: 1 });
    expect((await v.compras(c.id)).find((x) => x.id === id)!.descartada).toBe(false);
  });

  it("en masa: las del SIRE se excluyen en una operación, las agregadas se descartan y no entran en deshacer", async () => {
    const c = await nuevoCliente();
    const sire = [await sembrar(c, 6), await sembrar(c, 7)];
    const agregadas = [await sembrar(c, 8, { origen: "agregada" }), await sembrar(c, 9, { origen: "agregada" })];
    const vieja = await sembrar(c, 10, { origen: "agregada" });
    const r = await post(c, "/masivas/excluir", {
      items: [
        ...agregadas.map((compraId) => ({ compraId, versionBase: 1 })),
        ...sire.map((compraId) => ({ compraId, versionBase: 1 })),
        { compraId: vieja, versionBase: 4 },
      ],
      motivo: "no es del giro",
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(4);
    expect(r.body.operacionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.rechazadas).toEqual([{ compraId: vieja, codigo: "version_obsoleta" }]);
    const cs = await v.compras(c.id);
    for (const id of agregadas) expect(cs.find((x) => x.id === id)!.descartada).toBe(true);
    expect(cs.find((x) => x.id === vieja)!.descartada).toBe(false);
    for (const id of sire) expect((await v.versiones(id)).at(-1)).toMatchObject({ accion: "excluir", excluida: true, motivo: "no es del giro" });
    // Una agregada descartada no queda como excluida.
    for (const id of agregadas) expect((await v.versiones(id)).map((x) => x.n)).toEqual([1]);
    // Deshacer revierte solo la operación de las del SIRE.
    const d = await post(c, "/deshacer");
    expect(d.status, d.text).toBe(200);
    expect([...d.body.filas].sort()).toEqual([...sire].sort());
  });

  it("en masa con solo agregadas: se descartan y no hay operación", async () => {
    const c = await nuevoCliente();
    const agregadas = [await sembrar(c, 11, { origen: "agregada" }), await sembrar(c, 12, { origen: "agregada" })];
    const r = await post(c, "/masivas/excluir", { items: agregadas.map((compraId) => ({ compraId, versionBase: 1 })) });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ operacionId: null, aplicadas: 2, rechazadas: [] });
    expect((await v.compras(c.id)).filter((x) => x.descartada)).toHaveLength(2);
    expect(await v.operaciones(c.id)).toHaveLength(0);
    expect((await post(c, "/deshacer")).body).toEqual({ codigo: "nada_que_deshacer" });
  });

  it("un id inexistente al excluir en masa se informa no_encontrada", async () => {
    const c = await nuevoCliente();
    const inexistente = randomUUID();
    const r = await post(c, "/masivas/excluir", { items: [{ compraId: inexistente, versionBase: 1 }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.rechazadas).toEqual([{ compraId: inexistente, codigo: "no_encontrada" }]);
  });
});

describe("resumen cuya suma no cabe en NUMERIC(14,2) (D-8)", () => {
  it("422 resumen_fuera_de_rango, no un 500", async () => {
    const c = await nuevoCliente();
    await sembrar(c, 13, { montos: { biDg: "999999999999.99" } });
    await sembrar(c, 14, { montos: { biDg: "999999999999.99" } });
    const r = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "resumen_fuera_de_rango" });
  });
});
