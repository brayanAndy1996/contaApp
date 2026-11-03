// T15a (006) · defecto T15-1: `POST /invitaciones/aceptar-con-sesion` debe consultar el cupo ANTES de crear la
// membresía (misma regla que `aceptar` sin sesión: la invitación pendiente ya estaba contada, D7). Hoy crea la
// membresía primero y el último cupo da 409. Contrato fijado:
//  - max_usuarios = 2, Dueño + 1 invitación pendiente para un usuario existente sin membresía: 204/200 con
//    `{ estudio: { id, nombre } }`, membresía creada con el rol invitado e invitación aceptada.
//  - con el cupo ya lleno (plan bajado tras invitar; CA-7 no borra nada): 409 `{ codigo: "cupo_usuarios" }`, sin
//    membresía, la invitación sigue viva y, al regularizar el plan (CA-2), el mismo token se acepta.
//  - sin suscripción: falla cerrado (409), sin membresía.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Estudio } from "../../../test/soporte-acceso.js";
import { abrirBancoPlanes, type BancoPlanes } from "../../../test/soporte-planes.js";

let p: BancoPlanes;
beforeAll(async () => {
  p = await abrirBancoPlanes();
});
afterAll(async () => {
  await p?.cerrar();
});

const CUPO = { codigo: "cupo_usuarios" };
const membresiaDe = (E: Estudio, usuarioId: string) =>
  p.sql("select rol from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, usuarioId]);

/** Estudio con `max` usuarios, Dueño y una invitación pendiente para un usuario existente con sesión sin estudio. */
async function escenario(max: number) {
  const plan = await p.plan({ maxUsuarios: max });
  const E = await p.estudio(plan);
  const u = await p.b.h.crearUsuario({ estudios: [] });
  const { r, token } = await p.b.invitar(E.titular, u.correo, "asistente");
  expect(r.status).toBe(201);
  const s = await p.b.h.entrar(u);
  const aceptar = () =>
    p.b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: s.cookie, csrf: s.csrf });
  return { plan, E, u, aceptar, invitacionId: r.body.id as string };
}

describe("T15-1 · aceptar-con-sesion respeta el cupo antes de crear la membresía", () => {
  it("con el cupo justo (Dueño + invitación pendiente = max) entra: crea la membresía con el rol invitado", async () => {
    const { E, u, aceptar, invitacionId } = await escenario(2);
    const r = await aceptar();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estudio: { id: E.tenantId, nombre: expect.any(String) } });
    expect((await membresiaDe(E, u.id))[0]?.rol).toBe("asistente");
    expect((await p.sql("select aceptada_por from invitacion where id = $1", [invitacionId]))[0].aceptada_por).toBe(u.id);
  });

  it("con el cupo ya lleno: 409 cupo_usuarios, sin membresía y la invitación sigue viva; al regularizar el plan se acepta", async () => {
    const { plan, E, u, aceptar, invitacionId } = await escenario(3);
    await p.editarPlan(plan, { max_usuarios: 1 }); // activos 1 + 1 > 1 (CA-7: no se borra nada)

    const rechazo = await aceptar();
    expect(rechazo.status).toBe(409);
    expect(rechazo.body).toEqual(CUPO);
    expect(await membresiaDe(E, u.id)).toHaveLength(0);
    const inv = (await p.sql("select aceptada_en, aceptada_por from invitacion where id = $1", [invitacionId]))[0];
    expect(inv.aceptada_en).toBeNull();
    expect(inv.aceptada_por).toBeNull();

    await p.editarPlan(plan, { max_usuarios: 2 }); // CA-2: sin reiniciar
    expect((await aceptar()).status).toBe(200);
    expect(await membresiaDe(E, u.id)).toHaveLength(1);
  });

  it("sin suscripción falla cerrado: 409 y no se crea la membresía", async () => {
    const { E, u, aceptar } = await escenario(3);
    await p.sql("delete from suscripcion where tenant_id = $1", [E.tenantId]);
    const r = await aceptar();
    expect(r.status).toBe(409);
    expect(["sin_plan", "cupo_usuarios"]).toContain(r.body.codigo);
    expect(await membresiaDe(E, u.id)).toHaveLength(0);
  });
});
