/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T3 (006) · CA-6 (límite de usuarios, D7), CA-7 (bajar de plan, usuarios), CA-2 (límite en BD) y CA-9 (regresión
// con el adaptador real: los fixtures de 005 son `corporativo`). `crearApp` SIN `cupoUsuarios`: el adaptador real por
// defecto (T7). Orden de bloqueo de plan.md: las carreras mezclan invitar, aceptar y reactivar y no admiten 5xx
// (un 40P01 sería un 500). Rojo: plan, suscripción y adaptador aún no existen (T5, T7).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Estudio } from "../../../test/soporte-acceso.js";
import { abrirBancoPlanes, type BancoPlanes, type PlanPrueba } from "../../../test/soporte-planes.js";

const PWD_NUEVA = "Clave-nueva-006-canario-ñ";
let p: BancoPlanes;
beforeAll(async () => {
  p = await abrirBancoPlanes();
});
afterAll(async () => {
  await p?.cerrar();
});

const CUPO = { codigo: "cupo_usuarios" };
const invitaciones = (t: string) =>
  p.sql("select * from invitacion where tenant_id = $1 and aceptada_en is null and revocada_en is null", [t]);
const activos = async (t: string) =>
  Number((await p.sql("select count(*)::int n from membresia where tenant_id = $1 and desactivada_en is null", [t]))[0].n);
const pendientes = async (t: string) =>
  Number(
    (
      await p.sql(
        "select count(*)::int n from invitacion where tenant_id = $1 and aceptada_en is null and revocada_en is null and vence_en > now()",
        [t],
      )
    )[0].n,
  );
const invitar = (E: Estudio, correo: string, rol = "lectura") =>
  p.b.llamar(E.titular, "POST", "/invitaciones", { correo, rol });
const aceptar = (token: string) =>
  p.b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Nuevo Miembro", contrasena: PWD_NUEVA } });
const reactivar = (E: Estudio, usuarioId: string) => p.b.llamar(E.titular, "POST", `/usuarios/${usuarioId}/reactivar`);
const desactivar = (E: Estudio, usuarioId: string) => p.b.llamar(E.titular, "POST", `/usuarios/${usuarioId}/desactivar`);
/** Estudio con `max` usuarios en el plan y `n` miembros activos más el Dueño. */
async function conPlan(max: number | null, miembros = 0): Promise<{ E: Estudio; plan: PlanPrueba }> {
  const plan = await p.plan({ maxUsuarios: max });
  const E = await p.estudio(plan);
  for (let i = 0; i < miembros; i++) await p.b.miembro(E.tenantId, "contador", { sesion: false });
  return { E, plan };
}

describe("CA-6 · invitar (D7: activos + pendientes + 1 <= max)", () => {
  it("al llegar al máximo con miembros activos: 409 cupo_usuarios, sin invitación ni correo", async () => {
    const { E } = await conPlan(2, 1); // Dueño + 1 = 2 = max
    const correo = p.b.correoNuevo();
    const r = await invitar(E, correo);
    expect(r.status).toBe(409);
    expect(r.body).toEqual(CUPO);
    expect(await invitaciones(E.tenantId)).toHaveLength(0);
    expect(p.b.h.correo.para(correo)).toHaveLength(0);
  });

  it("el borde entra: con exactamente un cupo libre la invitación se crea (201) y el siguiente se rechaza", async () => {
    const { E } = await conPlan(3, 1); // activos 2, libre 1
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
    const otro = await invitar(E, p.b.correoNuevo());
    expect(otro.status).toBe(409);
    expect(otro.body).toEqual(CUPO);
    expect(await pendientes(E.tenantId)).toBe(1);
  });

  it("las invitaciones pendientes vigentes cuentan; revocar una libera el cupo en la misma consulta siguiente", async () => {
    const { E } = await conPlan(2, 0); // Dueño + 1 pendiente = 2
    const a = await invitar(E, p.b.correoNuevo());
    expect(a.status).toBe(201);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(409);
    expect((await p.b.llamar(E.titular, "POST", `/invitaciones/${a.body.id}/revocar`)).status).toBe(204);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
  });

  it("una invitación vencida no cuenta (D7: vigentes)", async () => {
    const { E } = await conPlan(2, 0);
    const a = await invitar(E, p.b.correoNuevo());
    expect(a.status).toBe(201);
    await p.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [a.body.id]);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
  });

  it("reenviar y revocar no consumen cupo (no llaman al cupo)", async () => {
    const { E } = await conPlan(2, 0);
    const a = await invitar(E, p.b.correoNuevo());
    expect(a.status).toBe(201); // el estudio queda lleno
    expect((await p.b.llamar(E.titular, "POST", `/invitaciones/${a.body.id}/reenviar`)).status).toBe(200);
    expect((await p.b.llamar(E.titular, "POST", `/invitaciones/${a.body.id}/revocar`)).status).toBe(204);
  });

  it("max_usuarios NULL es ilimitado: 25 miembros más y una invitación entran (CA-9, fixtures corporativo)", async () => {
    const E = await p.b.estudio(); // fixture de 005: corporativo, usuarios NULL
    await p.b.miembrosMasivos(E.tenantId, 25);
    const r = await invitar(E, p.b.correoNuevo());
    expect(r.status).toBe(201);
  });

  it("sin suscripción falla cerrado: 409 sin_plan y no se crea la invitación", async () => {
    const E = await p.estudio(null);
    const r = await invitar(E, p.b.correoNuevo());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "sin_plan" });
    expect(await invitaciones(E.tenantId)).toHaveLength(0);
  });

  it("el 409 no revela datos del plan ni del estudio", async () => {
    const { E, plan } = await conPlan(1, 0);
    const r = await invitar(E, p.b.correoNuevo());
    expect(r.status).toBe(409);
    expect(r.text).not.toContain(plan.codigo);
    expect(r.text).not.toMatch(/max|limite|plan|precio/i);
  });
});

describe("CA-6 · aceptar (D7: solo activos + 1 <= max, la invitación ya estaba contada)", () => {
  it("con el cupo justo (la invitación pendiente ya cuenta) la aceptación entra", async () => {
    const { E } = await conPlan(2, 0);
    const correo = p.b.correoNuevo();
    const { r, token } = await p.b.invitar(E.titular, correo, "lectura");
    expect(r.status).toBe(201); // Dueño + pendiente = 2 = max
    expect((await aceptar(token as string)).status).toBe(204);
    expect(await activos(E.tenantId)).toBe(2);
  });

  it("con el plan bajado antes de aceptar: 409 cupo_usuarios, sin usuario y la invitación sigue viva; al regularizar se acepta", async () => {
    const { E, plan } = await conPlan(3, 0);
    const correo = p.b.correoNuevo();
    const { r, token } = await p.b.invitar(E.titular, correo, "lectura");
    expect(r.status).toBe(201);
    await p.editarPlan(plan, { max_usuarios: 1 }); // activos 1 + 1 > 1 (CA-7: no se borra nada)

    const rechazo = await aceptar(token as string);
    expect(rechazo.status).toBe(409);
    expect(rechazo.body).toEqual(CUPO);
    expect(await p.sql("select id from usuario where email = $1", [correo])).toHaveLength(0);
    expect((await p.sql("select aceptada_en from invitacion where id = $1", [r.body.id]))[0].aceptada_en).toBeNull();

    await p.editarPlan(plan, { max_usuarios: 2 }); // CA-2: sin reiniciar
    expect((await aceptar(token as string)).status).toBe(204);
  });

  it("sin suscripción falla cerrado: 409 sin_plan o cupo_usuarios, y no se crea la cuenta", async () => {
    const { E } = await conPlan(3, 0);
    const correo = p.b.correoNuevo();
    const { token } = await p.b.invitar(E.titular, correo, "lectura");
    await p.sql("delete from suscripcion where tenant_id = $1", [E.tenantId]);
    const r = await aceptar(token as string);
    expect(r.status).toBe(409);
    expect(["sin_plan", "cupo_usuarios"]).toContain(r.body.codigo);
    expect(await p.sql("select id from usuario where email = $1", [correo])).toHaveLength(0);
  });
});

describe("CA-6 · reactivar (D7: activos + pendientes + 1 <= max)", () => {
  it("rechaza con 409 cupo_usuarios si no hay cupo y el miembro sigue desactivado; con cupo libre reactiva", async () => {
    const { E, plan } = await conPlan(5, 2);
    const m = await p.b.miembro(E.tenantId, "lectura", { sesion: false });
    expect((await desactivar(E, m.id)).status).toBe(200);
    await p.editarPlan(plan, { max_usuarios: 3 }); // Dueño + 2 activos = 3 = max
    const r = await reactivar(E, m.id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual(CUPO);
    const f = (await p.sql("select desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]))[0];
    expect(f.desactivada_en).not.toBeNull();

    await p.editarPlan(plan, { max_usuarios: 4 });
    expect((await reactivar(E, m.id)).status).toBe(200);
    expect(await activos(E.tenantId)).toBe(4);
  });

  it("las invitaciones pendientes también bloquean reactivar", async () => {
    const { E, plan } = await conPlan(5, 0);
    const m = await p.b.miembro(E.tenantId, "lectura", { sesion: false });
    expect((await desactivar(E, m.id)).status).toBe(200);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
    await p.editarPlan(plan, { max_usuarios: 2 }); // Dueño 1 + pendiente 1 = 2
    expect((await reactivar(E, m.id)).status).toBe(409);
  });
});

describe("CA-7 · bajar el límite no borra ni desactiva y solo bloquea agregar", () => {
  it("con el plan bajado por debajo del uso todos siguen activos, se pueden listar y desactivar, y agregar queda bloqueado", async () => {
    const { E, plan } = await conPlan(10, 3);
    const antes = await activos(E.tenantId);
    expect(antes).toBe(4);
    await p.editarPlan(plan, { max_usuarios: 2 });

    expect(await activos(E.tenantId)).toBe(4); // nada desactivado
    const lista = await p.b.llamar(E.titular, "GET", "/usuarios");
    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(4);
    const uso = await p.b.llamar(E.titular, "GET", "/plan/uso");
    expect(uso.status).toBe(200); // quien excede puede ver su uso
    expect(uso.body.usuarios).toMatchObject({ usados: 4, limite: 2 });
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(409);

    // regularizar: desactivar libera cupo solo cuando activos + 1 <= max
    const miembros = (await p.sql("select usuario_id from membresia where tenant_id = $1 and rol = 'contador'", [E.tenantId])).map(
      (f: any) => f.usuario_id as string,
    );
    for (const id of miembros) expect((await desactivar(E, id)).status).toBe(200);
    expect(await activos(E.tenantId)).toBe(1);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
  });
});

describe("CA-2 · el límite de usuarios cambia en BD sin reiniciar", () => {
  it("lleno -> sube el plan -> entra -> NULL ilimitado -> baja -> se bloquea; cambiar de plan también", async () => {
    const { E, plan } = await conPlan(2, 1);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(409);
    await p.editarPlan(plan, { max_usuarios: 3 });
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(409);
    await p.editarPlan(plan, { max_usuarios: null });
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
    await p.editarPlan(plan, { max_usuarios: 1 });
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(409);
    const otro = await p.plan({ maxUsuarios: 50 });
    await p.fijarPlan(E.tenantId, otro);
    expect((await invitar(E, p.b.correoNuevo())).status).toBe(201);
  });
});

describe("CA-6 · carreras (un solo cupo, bloqueo por estudio, sin interbloqueos)", () => {
  it("dos invitaciones simultáneas con un solo cupo libre: una se crea y la otra da 409 (repetido en 4 estudios)", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const { E } = await conPlan(2, 0); // Dueño + 1 libre
      const [a, b] = await Promise.all([invitar(E, p.b.correoNuevo()), invitar(E, p.b.correoNuevo())]);
      const estados = [a.status, b.status].sort();
      expect(estados, `ronda ${ronda}: ${JSON.stringify([a.body, b.body])}`).toEqual([201, 409]);
      expect(await pendientes(E.tenantId)).toBe(1);
    }
  });

  it("ocho invitaciones simultáneas con tres cupos libres: exactamente tres, el resto 409, ningún 5xx", async () => {
    const { E } = await conPlan(4, 0);
    const rs = await Promise.all(Array.from({ length: 8 }, () => invitar(E, p.b.correoNuevo())));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
    expect((await activos(E.tenantId)) + (await pendientes(E.tenantId))).toBe(4);
  });

  it("invitar + reactivar + aceptar simultáneos con un cupo libre: solo uno de los que suman entra; el aceptar no compite; sin 5xx", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const { E, plan } = await conPlan(5, 0);
      const m = await p.b.miembro(E.tenantId, "lectura", { sesion: false });
      expect((await desactivar(E, m.id)).status).toBe(200);
      const p1 = p.b.correoNuevo();
      const { r: r1, token } = await p.b.invitar(E.titular, p1, "lectura");
      expect(r1.status).toBe(201);
      await p.editarPlan(plan, { max_usuarios: 3 }); // Dueño 1 + pendiente 1 + 1 libre
      const nuevo = p.b.correoNuevo();

      const [inv, rea, ace] = await Promise.all([invitar(E, nuevo), reactivar(E, m.id), aceptar(token as string)]);
      for (const r of [inv, rea, ace]) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      expect(ace.status, `ronda ${ronda}: aceptar no compite por el cupo`).toBe(204);
      const suman = [inv.status === 201, rea.status === 200].filter(Boolean).length;
      expect(suman, `ronda ${ronda}: invitar ${inv.status}, reactivar ${rea.status}`).toBe(1);
      expect([inv.status, rea.status]).toContain(409);
      expect((await activos(E.tenantId)) + (await pendientes(E.tenantId))).toBeLessThanOrEqual(3);
    }
  });

  it("estudios distintos no se serializan entre sí: dos invitaciones a la vez en estudios con un cupo cada uno entran las dos", async () => {
    const x = await conPlan(2, 0);
    const y = await conPlan(2, 0);
    const [a, b] = await Promise.all([invitar(x.E, p.b.correoNuevo()), invitar(y.E, p.b.correoNuevo())]);
    expect([a.status, b.status]).toEqual([201, 201]);
  });
});
