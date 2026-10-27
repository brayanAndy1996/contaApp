/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T4 (005) · CA-9 (desactivar/reactivar), CA-10 (último Dueño por HTTP), CA-6 (desactivado con sesión viva)
// y lectura de miembros. Rojo: endpoints, guards y `membresia.desactivada_en` aún no existen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco, type Estudio } from "../../../test/soporte-acceso.js";

let b: Banco;
let E: Estudio;
beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  await b?.cerrar();
});

const membresia = async (tenantId: string, usuarioId: string) =>
  (await b.sql("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [tenantId, usuarioId]))[0];
const cuentaAsignaciones = async (tenantId: string, usuarioId: string) =>
  Number((await b.sql("select count(*)::int as n from asignacion where tenant_id = $1 and usuario_id = $2", [tenantId, usuarioId]))[0].n);

describe("GET /usuarios", () => {
  it("lista solo los miembros del estudio con rol, estado y esYo; sin hashes ni datos de otros estudios", async () => {
    const otro = await b.estudio();
    const ajeno = await b.miembro(otro.tenantId, "contador", { sesion: false });
    const m = await b.miembro(E.tenantId, "asistente", { sesion: false });
    const off = await b.miembro(E.tenantId, "lectura", { sesion: false });
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, off.id]);

    const r = await b.llamar(E.titular, "GET", "/usuarios");
    expect(r.status).toBe(200);
    const porId = new Map<string, any>(r.body.map((x: any) => [x.usuarioId, x]));
    expect(porId.has(ajeno.id)).toBe(false);
    expect(porId.get(m.id)).toMatchObject({ usuarioId: m.id, correo: m.correo, rol: "asistente", activo: true, esYo: false });
    expect(porId.get(off.id)).toMatchObject({ rol: "lectura", activo: false });
    expect(porId.get(E.titular.id)).toMatchObject({ rol: "dueno", activo: true, esYo: true });
    for (const x of r.body) {
      expect(Object.keys(x).sort()).toEqual(["activo", "correo", "esYo", "nombre", "rol", "usuarioId"]);
    }
    expect(r.text).not.toMatch(/argon2|hash|contrasena/i);
  });
});

describe("CA-9 · desactivar y reactivar (RF-027, D9, D19)", () => {
  it("desactivar marca la membresía sin borrar al usuario; sus asignaciones se retiran y el cliente queda sin responsable", async () => {
    const c = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c1, c2] = await b.clientes(E.tenantId, 2);
    await b.asignar(E.tenantId, c1!, c.id, "responsable");
    await b.asignar(E.tenantId, c2!, c.id, "colaborador");

    const r = await b.llamar(E.titular, "POST", `/usuarios/${c.id}/desactivar`);
    expect(r.status).toBe(200);
    const fila = await membresia(E.tenantId, c.id);
    expect(fila.desactivada_en).not.toBeNull();
    expect(fila.rol).toBe("contador");
    expect(Number((await b.sql("select count(*)::int as n from usuario where id = $1", [c.id]))[0].n)).toBe(1);
    expect(await cuentaAsignaciones(E.tenantId, c.id)).toBe(0);
    const lista = await b.llamar(E.titular, "GET", "/clientes");
    const fila1 = lista.body.find((x: any) => x.id === c1);
    expect(fila1.responsable).toBeNull();
    const u = (await b.llamar(E.titular, "GET", "/usuarios")).body.find((x: any) => x.usuarioId === c.id);
    expect(u).toMatchObject({ activo: false, rol: "contador" });
  });

  it("las sesiones del usuario con ese estudio activo quedan sin estudio; las de otro estudio siguen (CA-6)", async () => {
    const otro = await b.estudio();
    const u = await b.miembro(E.tenantId, "contador"); // sesión viva en E
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'lectura')", [otro.tenantId, u.id]);
    const enOtro = await b.sesion(u, otro.tenantId); // segunda sesión, con el otro estudio activo
    const actorOtro = { ...enOtro, tenantId: otro.tenantId };
    expect((await b.llamar(u, "GET", "/clientes")).status).toBe(200);
    expect((await b.llamar(actorOtro, "GET", "/clientes")).status).toBe(200);

    expect((await b.llamar(E.titular, "POST", `/usuarios/${u.id}/desactivar`)).status).toBe(200);

    const sinEstudio = await b.llamar(u, "GET", "/clientes");
    expect(sinEstudio.status).toBe(403);
    expect(sinEstudio.body).toEqual({ codigo: "estudio_requerido" });
    const ses = await b.h.pedir({ ruta: "/auth/sesion", cookie: u.cookie });
    expect(ses.status).toBe(200);
    expect(ses.body.estudioActivo).toBeNull();
    const lista = await b.h.pedir({ ruta: "/auth/estudios", cookie: u.cookie });
    expect(lista.body.map((e: any) => e.id)).toEqual([otro.tenantId]); // el desactivado no se ofrece
    expect((await b.llamar(actorOtro, "GET", "/clientes")).status).toBe(200); // la del otro estudio sigue
  });

  it("un desactivado no puede volver a elegir el estudio; al reactivarlo recupera su rol, pero no sus asignaciones (D19)", async () => {
    const u = await b.miembro(E.tenantId, "contador");
    const [cl] = await b.clientes(E.tenantId, 1);
    await b.asignar(E.tenantId, cl!, u.id, "colaborador");
    expect((await b.llamar(u, "GET", `/clientes/${cl}`)).status).toBe(200);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${u.id}/desactivar`)).status).toBe(200);

    const ses = await b.h.pedir({ ruta: "/auth/sesion", cookie: u.cookie });
    const elegir = await b.h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: E.tenantId }, cookie: u.cookie, csrf: ses.body.csrf });
    expect(elegir.status).toBe(403);
    expect(elegir.body).toEqual({ codigo: "estudio_no_disponible" });
    const login = await b.h.login(u.correo, u.contrasena); // la cuenta sigue viva
    expect(login.status).toBe(200);

    const r = await b.llamar(E.titular, "POST", `/usuarios/${u.id}/reactivar`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usuarioId: u.id, rol: "contador", activo: true });
    expect((await membresia(E.tenantId, u.id)).desactivada_en).toBeNull();
    expect(await cuentaAsignaciones(E.tenantId, u.id)).toBe(0);
    const nueva = await b.sesion(u, E.tenantId);
    const vistos = await b.llamar({ ...nueva, tenantId: E.tenantId }, "GET", "/clientes");
    expect(vistos.status).toBe(200);
    expect(vistos.body.map((x: any) => x.id)).not.toContain(cl);
  });

  it("reactivar a un miembro activo o inexistente no cambia nada", async () => {
    const activo = await b.miembro(E.tenantId, "asistente", { sesion: false });
    const r = await b.llamar(E.titular, "POST", `/usuarios/${activo.id}/reactivar`);
    expect([200, 404, 409]).toContain(r.status);
    expect((await membresia(E.tenantId, activo.id)).desactivada_en).toBeNull();
    const inexistente = await b.llamar(E.titular, "POST", "/usuarios/00000000-0000-4000-8000-000000000000/reactivar");
    expect(inexistente.status).toBe(404);
    const malformado = await b.llamar(E.titular, "POST", "/usuarios/no-es-uuid/desactivar");
    expect(malformado.status).toBe(404);
  });
});

describe("CA-10 · último Dueño", () => {
  const duenos = async (tenantId: string) =>
    Number(
      (await b.sql("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [tenantId]))[0].n,
    );

  it("el único Dueño no puede degradarse ni desactivarse (403 por D8) y la BD queda intacta", async () => {
    const solo = await b.estudio();
    expect(await duenos(solo.tenantId)).toBe(1);
    for (const rol of ["admin", "lectura", "dueno"]) {
      const r = await b.llamar(solo.titular, "PATCH", `/usuarios/${solo.titular.id}/rol`, { rol });
      expect(r.status).toBe(403);
    }
    expect((await b.llamar(solo.titular, "POST", `/usuarios/${solo.titular.id}/desactivar`)).status).toBe(403);
    expect(await duenos(solo.tenantId)).toBe(1);
    // Un Administrador no puede quitárselo (D8).
    const admin = await b.miembro(solo.tenantId, "admin");
    expect((await b.llamar(admin, "PATCH", `/usuarios/${solo.titular.id}/rol`, { rol: "admin" })).status).toBe(403);
    expect((await b.llamar(admin, "POST", `/usuarios/${solo.titular.id}/desactivar`)).status).toBe(403);
    expect(await duenos(solo.tenantId)).toBe(1);
  });

  it("con dos Dueños, uno degrada al otro y queda uno; el degradado ya no puede devolver el golpe", async () => {
    const par = await b.estudio();
    const d2 = await b.miembro(par.tenantId, "dueno");
    expect((await b.llamar(par.titular, "PATCH", `/usuarios/${d2.id}/rol`, { rol: "admin" })).status).toBe(200);
    expect(await duenos(par.tenantId)).toBe(1);
    const revancha = await b.llamar(d2, "PATCH", `/usuarios/${par.titular.id}/rol`, { rol: "lectura" });
    expect(revancha.status).toBe(403);
    expect(await duenos(par.tenantId)).toBe(1);
  });

  it("dos Dueños que se degradan o desactivan a la vez: nunca quedan 0 (409 ultimo_dueno o 403 al perdedor)", async () => {
    for (const accion of ["rol", "desactivar"] as const) {
      for (let ronda = 0; ronda < 3; ronda++) {
        const par = await b.estudio();
        const d2 = await b.miembro(par.tenantId, "dueno");
        const golpe = (de: typeof d2, a: typeof d2) =>
          accion === "rol"
            ? b.llamar(de, "PATCH", `/usuarios/${a.id}/rol`, { rol: "lectura" })
            : b.llamar(de, "POST", `/usuarios/${a.id}/desactivar`);
        const [r1, r2] = await Promise.all([golpe(par.titular, d2), golpe(d2, par.titular)]);
        expect(await duenos(par.tenantId)).toBeGreaterThanOrEqual(1);
        for (const r of [r1, r2]) {
          expect([200, 403, 409]).toContain(r.status);
          if (r.status === 409) expect(r.body).toEqual({ codigo: "ultimo_dueno" });
        }
        expect([r1.status, r2.status]).toContain(200);
      }
    }
  });
});
