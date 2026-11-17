/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 · T20: correcciones de la ronda adversarial 2 (rojo) por HTTP con PostgreSQL real. Una prueba normal por hallazgo con el
// comportamiento que fija la spec (decisiones del usuario sobre la ronda 2, 2026-11-13). Fallan hasta T21.
//  - H-021-2-2: el contador corrige una fila «Según historial» y deshace la corrección: la fila vuelve a tener `segunHistorial`
//    `{reglaId}` en el listado y en el detalle (`GET …/:compraId`), y sale con el filtro `segunHistorial=true` (con el que se revierte en masa, CA-3).
//    Hoy `REGLA_HISTORIAL` (`packages/db/src/compras/lectura.ts`) solo mira si la versión vigente tiene fila en `regla_aplicacion`,
//    y la versión `deshacer` no la tiene.
//  - H-021-2-3: con R-NEW apagada en el estudio (`PUT /estudio/reglas-motor/R-NEW`), el listado y la lupa (`…/:compraId/detalle`, `cabecera`) devuelven
//    `proveedorNuevo: false` y `?proveedorNuevo=true` no devuelve filas por esa marca. Hoy el SQL de la lectura no lee los
//    interruptores y sigue marcando «Proveedor nuevo».
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoReglas,
  base,
  RUTA_MOTOR,
  type Actor,
  type BancoReglas,
  type Estudio,
} from "../../../test/soporte-reglas.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoReglas;
let E: Estudio; // filas «Según historial»
let H: Estudio; // interruptor R-NEW: su propio estudio, para no apagar la regla a las demás pruebas
let contador: Actor;
let adminH: Actor;
let contadorH: Actor;

beforeAll(async () => {
  v = await abrirBancoReglas();
  E = await v.estudio();
  H = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  adminH = await p.miembro(H.tenantId, "admin");
  contadorH = await p.miembro(H.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const listar = (a: Actor, c: Cliente, query = "") =>
  v.llamar(a, "GET", `${base(c.id)}${query}`);
const detalle = (a: Actor, c: Cliente, id: string) =>
  v.llamar(a, "GET", `${base(c.id)}/${id}`);
/** Lupa de la fila (`…/:compraId/detalle`): la cabecera trae `proveedorNuevo`. */
const lupa = (a: Actor, c: Cliente, id: string) =>
  v.llamar(a, "GET", `${base(c.id)}/${id}/detalle`);
const post = (a: Actor, c: Cliente, ruta: string, cuerpo?: unknown) =>
  v.llamar(a, "POST", `${base(c.id)}${ruta}`, cuerpo);
const filasDe = (r: { body: any }): any[] => r.body.filas as any[];
const idsDe = (r: { body: any }): string[] => filasDe(r).map((f) => f.id);

describe("H-021-2-2 · corregir una fila «Según historial» y deshacer la corrección", () => {
  it("la fila vuelve a mostrar segunHistorial con el id de la regla (listado y detalle) y sale con el filtro segunHistorial=true", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const reglaId = await v.sembrarRegla(E.tenantId, c.id, {
      destino: "DNG",
      usuarioId: E.titular.id,
    });
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, {
      libro: "compras",
      nuevas: 1,
      usuarioId: E.titular.id,
    });
    const id = await v.sembrarSegunHistorial(E.tenantId, c.id, reglaId, {
      serie: "F001",
      numero: "1",
      propuestaId,
      usuarioId: E.titular.id,
    });

    // Antes de corregir: tiene la etiqueta (control).
    expect(
      filasDe(await listar(contador, c)).find((f) => f.id === id)!
        .segunHistorial,
    ).toEqual({ reglaId });

    const corregir = await post(contador, c, `/${id}/clasificar`, {
      versionBase: 2,
      destino: "DG",
    });
    expect(corregir.status, corregir.text).toBe(200);
    expect(corregir.body.fila.segunHistorial).toBeNull();
    expect(idsDe(await listar(contador, c, "?segunHistorial=true"))).toEqual(
      [],
    );

    const deshacer = await post(contador, c, "/deshacer");
    expect(deshacer.status, deshacer.text).toBe(200);
    expect(deshacer.body.filas).toEqual([id]);
    const vs = await v.versiones(id);
    expect(vs.map((x) => x.accion)).toEqual([
      "original",
      "historial",
      "clasificar",
      "deshacer",
    ]);
    // La versión que deja deshacer repite los montos de la versión `historial` (la fila quedó como la dejó la regla).
    expect(vs[3]).toMatchObject({
      biDg: vs[1]!.biDg,
      biDng: vs[1]!.biDng,
      igvDng: vs[1]!.igvDng,
      total: vs[1]!.total,
      clasificada: true,
    });

    const fila = filasDe(await listar(contador, c)).find((f) => f.id === id);
    expect(fila.segunHistorial).toEqual({ reglaId });
    expect(
      (await detalle(contador, c, id)).body.vigente.segunHistorial,
    ).toEqual({ reglaId });
    const filtro = await listar(contador, c, "?segunHistorial=true");
    expect(filtro.status, filtro.text).toBe(200);
    expect(idsDe(filtro)).toEqual([id]);
  });
});

describe("H-021-2-3 · con R-NEW apagada en el estudio no hay «Proveedor nuevo»", () => {
  const apagar = (activa: boolean) =>
    v.http(adminH, "PUT", `${RUTA_MOTOR}/R-NEW`, { activa });

  it("listado, detalle y filtro proveedorNuevo=true: la marca no sale (con R-NEW encendida, antes y después, sí)", async () => {
    const c = await v.cliente(H, { responsable: contadorH.id });
    const id = await v.sembrarCompra(H.tenantId, c.id, {
      serie: "F001",
      numero: "1",
      doc: "20700000051",
      usuarioId: H.titular.id,
    });

    // Control: encendida, el proveedor sin historial en el cliente es nuevo.
    expect(
      filasDe(await listar(contadorH, c)).find((f) => f.id === id)!
        .proveedorNuevo,
    ).toBe(true);
    expect((await lupa(contadorH, c, id)).body.cabecera.proveedorNuevo).toBe(
      true,
    );
    expect(idsDe(await listar(contadorH, c, "?proveedorNuevo=true"))).toEqual([
      id,
    ]);

    const off = await apagar(false);
    expect(off.status, off.text).toBe(200);
    try {
      expect(
        filasDe(await listar(contadorH, c)).find((f) => f.id === id)!
          .proveedorNuevo,
      ).toBe(false);
      expect((await lupa(contadorH, c, id)).body.cabecera.proveedorNuevo).toBe(
        false,
      );
      const filtro = await listar(contadorH, c, "?proveedorNuevo=true");
      expect(filtro.status, filtro.text).toBe(200);
      expect(idsDe(filtro)).toEqual([]);
    } finally {
      expect((await apagar(true)).status).toBe(200);
    }

    // Vuelve a encenderse: la marca regresa.
    expect(
      filasDe(await listar(contadorH, c)).find((f) => f.id === id)!
        .proveedorNuevo,
    ).toBe(true);
  });
});
