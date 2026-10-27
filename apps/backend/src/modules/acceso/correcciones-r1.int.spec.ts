// Spec 005 · T15: pruebas propias (HTTP + BD) de las correcciones de la ronda adversarial 1 en `acceso`.
// Estudios, usuarios y correos propios (abrirBanco los borra al cerrar); canarios, sin secretos.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco } from "../../../test/soporte-acceso.js";

let b: Banco;
beforeAll(async () => {
  b = await abrirBanco();
});
afterAll(async () => {
  await b?.cerrar();
});

const PWD = "Clave-t15-005-canario-ñ";
const aceptar = (token: string, nombre = "Invitado T15") =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre, contrasena: PWD } });
const pendientesDe = async (tenantId: string, usuarioId: string): Promise<string[]> =>
  (
    await b.sql(
      "select rol from invitacion where tenant_id = $1 and invitado_por = $2 and revocada_en is null and aceptada_en is null order by rol",
      [tenantId, usuarioId],
    )
  ).map((f: { rol: string }) => f.rol);

describe("H-005-1b-1 · revocar las pendientes del invitador al degradarlo o desactivarlo", () => {
  it("degradar Dueño -> Administrador revoca solo sus invitaciones dueno; la de admin sigue y se acepta", async () => {
    const E = await b.estudio();
    const d2 = await b.miembro(E.tenantId, "dueno");
    const iDueno = await b.invitar(d2, b.correoNuevo(), "dueno");
    const iAdmin = await b.invitar(d2, b.correoNuevo(), "admin");
    expect([iDueno.r.status, iAdmin.r.status]).toEqual([201, 201]);

    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${d2.id}/rol`, { rol: "admin" })).status).toBe(200);
    expect(await pendientesDe(E.tenantId, d2.id)).toEqual(["admin"]);
    expect((await aceptar(iDueno.token as string)).status).toBe(400);
    expect((await aceptar(iAdmin.token as string)).status).toBe(204);
  });

  it("desactivar revoca todas sus pendientes (GET /invitaciones ya no las lista) y reactivar no las devuelve", async () => {
    const E = await b.estudio();
    const adm = await b.miembro(E.tenantId, "admin");
    for (const rol of ["admin", "lectura"] as const) expect((await b.invitar(adm, b.correoNuevo(), rol)).r.status).toBe(201);
    const propia = await b.invitar(E.titular, b.correoNuevo(), "contador");

    expect((await b.llamar(E.titular, "POST", `/usuarios/${adm.id}/desactivar`)).status).toBe(200);
    expect(await pendientesDe(E.tenantId, adm.id)).toEqual([]);
    const lista = await b.llamar(E.titular, "GET", "/invitaciones");
    expect(lista.status).toBe(200);
    expect((lista.body as Array<{ invitadoPor: { usuarioId: string } }>).map((i) => i.invitadoPor.usuarioId)).toEqual([
      E.titular.id,
    ]);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${adm.id}/reactivar`)).status).toBe(200);
    expect(await pendientesDe(E.tenantId, adm.id)).toEqual([]);
    expect((await aceptar(propia.token as string)).status).toBe(204);
  });

  it("cambiar el rol de un miembro sin invitaciones no falla (cero revocadas)", async () => {
    const E = await b.estudio();
    const c = await b.miembro(E.tenantId, "contador", { sesion: false });
    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${c.id}/rol`, { rol: "asistente" })).status).toBe(200);
  });
});

describe("H-005-1a-1 · el ID de la ruta se compara normalizado", () => {
  it("sobre otro miembro, el ID en mayúsculas funciona igual (200); sobre uno mismo, 403", async () => {
    const E = await b.estudio();
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    const r = await b.llamar(E.titular, "PATCH", `/usuarios/${m.id.toUpperCase()}/rol`, { rol: "lectura" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usuarioId: m.id, rol: "lectura" });
    expect((await b.llamar(E.titular, "POST", `/usuarios/${m.id.toUpperCase()}/desactivar`)).status).toBe(200);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${E.titular.id.toUpperCase()}/desactivar`)).status).toBe(403);
  });
});

describe("H-005-1b-2/3 · entradas con caracteres de control", () => {
  it("invitar con DEL en el correo -> 400 solicitud_invalida; aceptar con BEL en el nombre -> 400 y el token sigue vivo", async () => {
    const E = await b.estudio();
    const inv = await b.llamar(E.titular, "POST", "/invitaciones", { correo: "t15\u007fx@t15.contapp.test", rol: "lectura" });
    expect(inv.status).toBe(400);
    expect(inv.body).toEqual({ codigo: "solicitud_invalida" });

    const { token } = await b.invitar(E.titular, b.correoNuevo(), "lectura");
    const r = await aceptar(token as string, "Ana\u0007T15");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect((await aceptar(token as string)).status).toBe(204);
  });
});
