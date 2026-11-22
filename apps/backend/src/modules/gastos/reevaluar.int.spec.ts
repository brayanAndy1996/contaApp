// Spec 027 (T6, rojo): «Volver a evaluar» por HTTP (U-12, R-8, R-12, R-1; CA-3, CA-12).
// Contrato (plan 027, «Contratos: HTTP» y «Cola»):
//  - `POST /clientes/:clienteId/periodos/:periodo/gastos/reevaluar` (`sire.clasificar`, cliente visible) -> 202 `{trabajoId}`: encola un trabajo
//    `compras.reevaluar` (cola `xml`, canal `ninguno`, parámetros `{periodo}`, creado por quien pulsó) y no espera a nadie. Dedupe de 008 por
//    cliente y periodo: dos pedidos comparten trabajo y devuelven el mismo `trabajoId` (200 o 202; el plan solo fija 202).
//  - Solo en un periodo `abierto` (sin fila = abierto): `revisado` o `generado` 409 `periodo_no_abierto`; cliente archivado 409 `cliente_archivado`;
//    cliente de otro estudio, no visible o inexistente 404 `no_encontrado`, el mismo.
//  - Solo encola: no escribe en compras (sin versión nueva, sin evaluación, sin operación), ni en el diccionario, ni audita al pedir (R-1, CA-3).
//    Re-evaluar es del worker (T5); los hallazgos guardados no cambian solos (R-8).
// Rojo: la ruta aún no existe (T12): responde 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  inexistente,
  NO_ENCONTRADO,
  PERIODO,
  rutaReevaluar,
  SOLICITUD_INVALIDA,
  TIPO_REEVALUAR,
  type Actor,
  type BancoGastos,
  type Estudio,
} from "../../../test/soporte-gastos.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoGastos;
let E: Estudio;
let F: Estudio;
let admin: Actor;
let contador: Actor;
let contadorAjeno: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoGastos();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  contadorAjeno = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id] });
const reevaluar = (a: Actor, c: { id: string }, periodo = PERIODO, ...cuerpo: [unknown?]) =>
  v.http(a, "POST", rutaReevaluar(c.id, periodo), cuerpo.length === 0 ? {} : cuerpo[0]);

describe("POST …/gastos/reevaluar · encola sin evaluar (U-12, R-12, CA-12)", () => {
  it("202 {trabajoId}: un trabajo compras.reevaluar en la cola xml, sin canal, con {periodo}, creado por quien pulsó; no espera a nadie", async () => {
    const c = await nuevoCliente();
    const r = await reevaluar(contador, c);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajoId"]);
    expect(typeof r.body.trabajoId).toBe("string");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.ms).toBeLessThan(3000);
    const trabajos = await v.trabajosReevaluar(E.tenantId, c.id);
    expect(trabajos).toHaveLength(1);
    expect(trabajos[0]).toMatchObject({
      id: r.body.trabajoId,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: TIPO_REEVALUAR,
      cola: "xml",
      canal: "ninguno",
      estado: "en_cola",
      creado_por: contador.id,
      ruc: c.ruc,
    });
    expect(trabajos[0].parametros).toEqual({ periodo: PERIODO });
    expect(trabajos[0].resultado ?? null).toBeNull();
  });

  it("CA-3 · solo encola: no crea versiones, evaluaciones, operaciones ni cambios de periodo, no toca el diccionario y no audita al pedir", async () => {
    const c = await nuevoCliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const antes = await v.foto(c.id);
    const antesGastos = await v.fotoGastos(E.tenantId);
    const evaluacionesAntes = await Promise.all(Object.values(ids).map((id) => v.evaluaciones(id)));
    const r = await reevaluar(contador, c);
    expect(r.status, r.text).toBe(202);
    const despues = await v.foto(c.id);
    expect({ ...despues, trabajos: 0 }).toEqual({ ...antes, trabajos: 0 });
    expect(despues.trabajos).toBe(antes.trabajos + 1);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antesGastos);
    expect(await Promise.all(Object.values(ids).map((id) => v.evaluaciones(id)))).toEqual(evaluacionesAntes);
    for (const id of Object.values(ids)) expect((await v.versiones(id)).filter((x) => x.excluida)).toEqual([]);
  });

  it("R-8 · agregar una palabra al diccionario no cambia los hallazgos guardados: solo «Volver a evaluar» (y el worker) lo hace", async () => {
    const c = await nuevoCliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const antes = await Promise.all(Object.values(ids).map((id) => v.hallazgosDe(id, 1)));
    const agregada = await v.http(admin, "POST", "/estudio/reglas-motor/gastos/palabras", { palabra: "abarrotes", categoria: "alimentos-personales" });
    expect(agregada.status, agregada.text).toBe(201);
    expect(await Promise.all(Object.values(ids).map((id) => v.hallazgosDe(id, 1)))).toEqual(antes);
    expect((await reevaluar(contador, c)).status).toBe(202);
    expect(await Promise.all(Object.values(ids).map((id) => v.hallazgosDe(id, 1)))).toEqual(antes); // encolar tampoco evalúa
  });

  it("dedupe de 008: dos pedidos del mismo cliente y periodo comparten UN trabajo y devuelven el mismo trabajoId", async () => {
    const c = await nuevoCliente();
    const a = await reevaluar(contador, c);
    const b = await reevaluar(admin, c);
    expect(a.status, a.text).toBe(202);
    expect([200, 202], b.text).toContain(b.status);
    expect(b.body.trabajoId).toBe(a.body.trabajoId);
    expect(await v.trabajosReevaluar(E.tenantId, c.id)).toHaveLength(1);
  });

  it("pedidos simultáneos del mismo cliente y periodo: un solo trabajo", async () => {
    const c = await nuevoCliente();
    const rs = await Promise.all([reevaluar(contador, c), reevaluar(admin, c), reevaluar(E.titular, c), reevaluar(asistente, c)]);
    for (const r of rs) expect([200, 202], r.text).toContain(r.status);
    expect(new Set(rs.map((r) => r.body.trabajoId)).size).toBe(1);
    expect(await v.trabajosReevaluar(E.tenantId, c.id)).toHaveLength(1);
  });

  it("otro periodo, otro cliente u otro estudio es otro trabajo", async () => {
    const c = await nuevoCliente();
    const d = await nuevoCliente();
    const deF = await v.cliente(F, { responsable: F.titular.id });
    const a = await reevaluar(contador, c, "202610");
    const b = await reevaluar(contador, c, "202609");
    const x = await reevaluar(contador, d, "202610");
    const f = await reevaluar(F.titular, deF, "202610");
    for (const r of [a, b, x, f]) expect(r.status, r.text).toBe(202);
    expect(new Set([a.body.trabajoId, b.body.trabajoId, x.body.trabajoId, f.body.trabajoId]).size).toBe(4);
    expect((await v.trabajosReevaluar(E.tenantId, c.id)).map((t) => t.parametros.periodo).sort()).toEqual(["202609", "202610"]);
  });

  it("un periodo con fila `abierto` se puede re-evaluar", async () => {
    const c = await nuevoCliente();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "abierto");
    const r = await reevaluar(contador, c);
    expect(r.status, r.text).toBe(202);
  });
});

describe("POST …/gastos/reevaluar · solo en un periodo abierto (R-12, U-12)", () => {
  it.each(["revisado", "generado"] as const)("un periodo %s: 409 periodo_no_abierto, no se encola nada y el cuerpo es solo el código", async (estado) => {
    const c = await nuevoCliente();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, estado, contador.id);
    const antes = await v.foto(c.id);
    const r = await reevaluar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "periodo_no_abierto" });
    expect(await v.foto(c.id)).toEqual(antes);
    expect(await v.trabajosReevaluar(E.tenantId, c.id)).toEqual([]);
  });

  it("el estado es del periodo pedido: revisado en otro periodo no impide el abierto", async () => {
    const c = await nuevoCliente();
    await v.estadoPeriodo(E.tenantId, c.id, "202609", "revisado", contador.id);
    expect((await reevaluar(contador, c, "202610")).status).toBe(202);
    const r = await reevaluar(contador, c, "202609");
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "periodo_no_abierto" });
  });

  it("reabrir el periodo lo vuelve a permitir", async () => {
    const c = await nuevoCliente();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    expect((await reevaluar(contador, c)).status).toBe(409);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "abierto");
    expect((await reevaluar(contador, c)).status).toBe(202);
  });

  it("un cliente archivado: 409 cliente_archivado y no se encola nada", async () => {
    const c = await nuevoCliente();
    await v.archivar(c.id);
    const r = await reevaluar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.trabajosReevaluar(E.tenantId, c.id)).toEqual([]);
  });
});

describe("POST …/gastos/reevaluar · alcance y cuerpo", () => {
  it("cliente de otro estudio, no visible para el contador o inexistente: el mismo 404 no_encontrado y no se encola nada", async () => {
    const mio = await nuevoCliente();
    const deF = await v.cliente(F, { responsable: F.titular.id });
    expect((await reevaluar(contador, mio, "202601")).status, "control: el cliente propio y visible sí se encola").toBe(202);
    const referencia = await reevaluar(contador, { id: inexistente() });
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    for (const [quien, c] of [
      [contador, deF],
      [admin, deF],
      [contadorAjeno, mio],
    ] as const) {
      const r = await reevaluar(quien, c);
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(referencia.text);
    }
    expect((await v.trabajosReevaluar(E.tenantId, mio.id)).map((t) => t.parametros.periodo)).toEqual(["202601"]); // solo el del control
    expect(await v.trabajosReevaluar(F.tenantId, deF.id)).toEqual([]);
  });

  it.each([
    ["con guion", "2026-10"],
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["corto", "20261"],
    ["con letras", "2026AB"],
  ])("un periodo %s en la ruta: 400 o 404 y no se encola nada", async (_n, periodo) => {
    const c = await nuevoCliente();
    expect((await reevaluar(contador, c, "202610")).status, "control: un periodo válido sí se encola").toBe(202);
    const r = await reevaluar(contador, c, periodo);
    expect([400, 404], r.text).toContain(r.status);
    expect((await v.trabajosReevaluar(E.tenantId, c.id)).map((t) => t.parametros.periodo)).toEqual(["202610"]);
  });

  it.each([
    ["clienteId (el cliente sale de la ruta)", { clienteId: "x" }],
    ["tenantId", { tenantId: "x" }],
    ["periodo (sale de la ruta)", { periodo: "202610" }],
  ])("un cuerpo con %s: 400 solicitud_invalida y no se encola nada", async (_n, cuerpo) => {
    const c = await nuevoCliente();
    const r = await reevaluar(contador, c, PERIODO, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.trabajosReevaluar(E.tenantId, c.id)).toEqual([]);
  });

  it("sin cuerpo también se acepta (202): no hay nada que enviar", async () => {
    const c = await nuevoCliente();
    const r = await v.http(contador, "POST", rutaReevaluar(c.id, PERIODO));
    expect(r.status, r.text).toBe(202);
  });

  it("sin sesión: 401", async () => {
    const c = await nuevoCliente();
    const r = await v.sinSesion("POST", rutaReevaluar(c.id, PERIODO), {});
    expect(r.status, r.text).toBe(401);
  });
});
