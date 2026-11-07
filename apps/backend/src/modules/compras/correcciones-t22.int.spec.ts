/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 T22a · M-1 por HTTP con PostgreSQL real (rojo hasta T22b).
//  - Una masiva de clasificar con una fila cuya suma al cambiar de destino no cabe en NUMERIC(14,2) (BI de DG y de DGNG cerca de
//    999999999999.99, destino DGNG; el total sigue cuadrando con un no gravado negativo) y una fila válida: responde 200, la válida
//    se aplica en UNA operación, la otra viene en `rechazadas` con el código `solicitud_invalida` (D-15) y el informe COMPLETO pasa
//    `informeMasivaSchema`. Hoy el código existe en `transformar.ts` pero no en `CODIGOS_RECHAZO_MASIVA`, y falla el esquema.
//  - La fila rechazada no cambia: sigue en la versión 1 y con los mismos montos.
//  - Si ninguna fila cabe, no se crea operación: `operacionId` null, 0 aplicadas, y el informe pasa el esquema.
import { informeMasivaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  montos,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
} from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

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

const nuevoCliente = () => v.cliente(E, { responsable: contador.id, colaboradores: [] });
const masivaClasificar = (c: { id: string }, cuerpo: unknown) =>
  v.llamar(contador, "POST", `${base(c.id, PERIODO)}/masivas/clasificar`, cuerpo);
const items = (ids: string[]) => ids.map((compraId) => ({ compraId, versionBase: 1 }));

const MAXIMO = "999999999999.99";
/** BI de DG y de DGNG en el máximo; un no gravado negativo (fuera de la suma de BI) mantiene el total dentro de NUMERIC(14,2). Al pasar a DGNG, DGNG vale 1999999999999.98. */
const MONTOS_DESBORDAN = montos({ biDg: MAXIMO, biDgng: MAXIMO, noGravado: `-${MAXIMO}`, total: MAXIMO });

async function sembrar(c: { id: string }, propuestaId: string, numero: string, doc: string, m = montos({ biDg: "100.00", igvDg: "18.00" })) {
  return v.sembrarCompra(E.tenantId, c.id, { serie: "F022", numero, doc, propuestaId, usuarioId: E.titular.id, montos: m });
}

describe("M-1 · masiva de clasificar con una fila cuya suma no cabe en NUMERIC(14,2)", () => {
  it("200: la válida se aplica, la desbordada sale solicitud_invalida y el informe pasa informeMasivaSchema", async () => {
    const c = await nuevoCliente();
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 2, usuarioId: E.titular.id });
    const valida = await sembrar(c, propuestaId, "1", "20700220001");
    const desborda = await sembrar(c, propuestaId, "2", "20700220002", MONTOS_DESBORDAN);

    const r = await masivaClasificar(c, { items: items([valida, desborda]), destino: "DGNG" });

    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(1);
    expect(r.body.rechazadas).toEqual([{ compraId: desborda, codigo: "solicitud_invalida" }]);
    const esquema = informeMasivaSchema.safeParse(r.body);
    expect(esquema.success, JSON.stringify(esquema.error?.issues)).toBe(true);

    const ops = await v.operaciones(c.id);
    expect(ops).toHaveLength(1);
    const vs = await v.versiones(valida);
    expect(vs.map((x) => x.n)).toEqual([1, 2]);
    expect(vs[1]).toMatchObject({ accion: "clasificar", clasificada: true, biDg: "0.00", igvDg: "0.00", biDgng: "100.00", igvDgng: "18.00", operacion_id: r.body.operacionId });
  });

  it("la fila rechazada no cambia: sigue en la versión 1, vigente y con los mismos montos", async () => {
    const c = await nuevoCliente();
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 2, usuarioId: E.titular.id });
    const valida = await sembrar(c, propuestaId, "1", "20700220011");
    const desborda = await sembrar(c, propuestaId, "2", "20700220012", MONTOS_DESBORDAN);

    const r = await masivaClasificar(c, { items: items([desborda, valida]), destino: "DGNG" });
    expect(r.status, r.text).toBe(200);

    const vs = await v.versiones(desborda);
    expect(vs.map((x) => x.n)).toEqual([1]);
    expect(vs[0]).toMatchObject({ biDg: MAXIMO, biDgng: MAXIMO, noGravado: `-${MAXIMO}`, total: MAXIMO, clasificada: false, accion: "original" });
    const fila = (await v.compras(c.id, PERIODO)).find((x) => x.id === desborda);
    expect(fila?.version_vigente).toBe(1);
  });

  it("si ninguna fila cabe: 200, sin operación, 0 aplicadas y el informe pasa el esquema", async () => {
    const c = await nuevoCliente();
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 1, usuarioId: E.titular.id });
    const desborda = await sembrar(c, propuestaId, "1", "20700220021", MONTOS_DESBORDAN);

    const r = await masivaClasificar(c, { items: items([desborda]), destino: "DGNG" });

    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: desborda, codigo: "solicitud_invalida" }] });
    expect(informeMasivaSchema.safeParse(r.body).success).toBe(true);
    expect(await v.operaciones(c.id)).toHaveLength(0);
  });
});
