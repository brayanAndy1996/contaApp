/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (030) · CA-1 (asignable al invitar y al cambiar rol, HU-05), CA-8 (U7: un rol propio nunca es Dueño; nunca 0 Dueños, también en
// concurrencia), CA-9 (rol ajeno: 404), `GET /roles/asignables` y `GET /acceso/yo` con rol propio (plan 030, «HTTP»).
// Cubre: `acceso/roles/roles.controller.ts`, `acceso/roles/roles.service.ts`, `usuarios.service.ts`, `invitaciones.service.ts`, `yo.controller.ts`.
// Rojo: `{ rol: { rolId } }` aún no se acepta en `/invitaciones` ni `/usuarios/:id/rol` (T8), `/roles` no existe (T9) y faltan las
// tablas de la 0082 (T6).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import {
  asignables,
  asignar,
  asignarSistema,
  cerrar,
  contiene,
  crearOk,
  cuentaRoles,
  duenosActivos,
  editar,
  huerfanos,
  invitar,
  listar,
  membresiaDe,
  miembroConRol,
  ordenados,
  propiosDe,
  rolConMiembro,
  rolDe,
  uuidInexistente,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
let admin: Actor;
const PWD_NUEVA = "Clave-nueva-030-canario-ñ";

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  admin = await b.miembro(E.tenantId, "admin");
});
afterAll(async () => {
  await b?.cerrar();
});

const D = (): Actor => E.titular;
const yo = (a: Actor) => b.llamar(a, "GET", "/acceso/yo");

describe("CA-1 · al invitar con un rol propio (HU-05)", () => {
  it("201: la invitación guarda rol 'propio' y rol_id; el rol cuenta 1 invitación y la lista de invitaciones sigue respondiendo", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver", "buzon.ver"], alcance: "asignado" });
    const correo = b.correoNuevo();
    const r = await invitar(b, D(), correo, rol.id);
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ correo });
    expect(JSON.stringify(r.body)).not.toMatch(/token|hash/i);
    const f = (await b.sql("select rol, rol_id, tenant_id from invitacion where id = $1", [r.body.id]))[0];
    expect(f).toEqual({ rol: "propio", rol_id: rol.id, tenant_id: E.tenantId });
    expect(propiosDe(await listar(b, D())).find((x) => x.id === rol.id)).toMatchObject({ miembros: 0, invitaciones: 1 });
    const lista = await b.llamar(D(), "GET", "/invitaciones");
    expect(lista.status, lista.text).toBe(200);
    expect(lista.body.map((i: any) => i.id)).toContain(r.body.id);
    expect(await huerfanos(b, E.tenantId)).toBe(0);
  });

  it("aceptar con cuenta nueva copia el rol propio a la membresía; entra con sus permisos y alcance, y /acceso/yo informa el rol", async () => {
    const rol = await crearOk(b, D(), { nombre: "Practicante A", permisos: cerrar(["clientes.crear", "buzon.atender"]), alcance: "asignado" });
    const correo = b.correoNuevo();
    const inv = await invitar(b, D(), correo, rol.id);
    expect(inv.status, inv.text).toBe(201);
    const token = await b.tokenDe(correo);
    const ok = await b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Pasante Uno", contrasena: PWD_NUEVA } });
    expect(ok.status, ok.text).toBe(204);
    const u = (await b.sql("select id from usuario where email = $1", [correo]))[0];
    expect(await membresiaDe(b, E.tenantId, u.id)).toMatchObject({ rol: "propio", rol_id: rol.id, desactivada_en: null });

    const s = await b.sesion({ id: u.id, correo, contrasena: PWD_NUEVA }, E.tenantId);
    const actor = { ...s, tenantId: E.tenantId } as Actor;
    const r = await yo(actor);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ rol: "propio", alcance: "asignado", rolPropio: { id: rol.id, nombre: "Practicante A" } });
    expect(ordenados(r.body.permisos)).toEqual(ordenados(rol.permisos));
    expect((await b.llamar(actor, "GET", "/clientes")).status).toBe(200);
    expect((await b.llamar(actor, "GET", "/usuarios")).status).toBe(403);
    expect(propiosDe(await listar(b, D())).find((x) => x.id === rol.id)).toMatchObject({ miembros: 1, invitaciones: 0 });
  });

  it("aceptar-con-sesion (cuenta existente) también copia el rol propio", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"], alcance: "asignado" });
    const u = await b.h.crearUsuario({ estudios: [] });
    const inv = await invitar(b, D(), u.correo, rol.id);
    expect(inv.status, inv.text).toBe(201);
    const token = await b.tokenDe(u.correo);
    const s = await b.h.entrar(u);
    const acepta = await b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: s.cookie, csrf: s.csrf });
    expect(acepta.status, acepta.text).toBe(200);
    expect(await membresiaDe(b, E.tenantId, u.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
  });

  it("reenviar y revocar una invitación con rol propio funcionan; revocada deja de contar en el rol", async () => {
    const rol = await crearOk(b, D(), { permisos: [] });
    const inv = await invitar(b, D(), b.correoNuevo(), rol.id);
    expect(inv.status, inv.text).toBe(201);
    expect((await b.llamar(D(), "POST", `/invitaciones/${inv.body.id}/reenviar`)).status).toBeLessThan(300);
    expect((await b.llamar(D(), "POST", `/invitaciones/${inv.body.id}/revocar`)).status).toBe(204);
    expect(propiosDe(await listar(b, D())).find((x) => x.id === rol.id)).toMatchObject({ invitaciones: 0 });
  });

  it("el rol propio no se puede pedir por nombre ni con formas inválidas: 400 y no se crea la invitación", async () => {
    const rol = await crearOk(b, D(), { permisos: [] });
    const antes = Number((await b.sql("select count(*)::int as n from invitacion where tenant_id = $1", [E.tenantId]))[0].n);
    const formas: unknown[] = [
      "propio",
      { rolId: "no-es-uuid" },
      { rolId: 7 },
      { rolId: null },
      {},
      [rol.id],
      rol.id,
    ];
    for (const rol_ of formas) {
      const r = await b.llamar(D(), "POST", "/invitaciones", { correo: b.correoNuevo(), rol: rol_ });
      expect(r.status, JSON.stringify(rol_)).toBe(400);
    }
    const despues = Number((await b.sql("select count(*)::int as n from invitacion where tenant_id = $1", [E.tenantId]))[0].n);
    expect(despues).toBe(antes);
  });

  it("los roles de sistema siguen valiendo como en 005 (`rol: \"contador\"`)", async () => {
    const r = await b.llamar(D(), "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "contador" });
    expect(r.status, r.text).toBe(201);
    const f = (await b.sql("select rol, rol_id from invitacion where id = $1", [r.body.id]))[0];
    expect(f).toEqual({ rol: "contador", rol_id: null });
  });
});

describe("CA-1 · al cambiar de rol (005)", () => {
  it("200: la membresía pasa a 'propio' con su rol_id, y volver a un rol de sistema limpia rol_id; la lista de usuarios lo muestra", async () => {
    const rol = await crearOk(b, D(), { permisos: cerrar(["clientes.editar"]), alcance: "asignado" });
    const m = await b.miembro(E.tenantId, "asistente", { sesion: false });
    const r = await asignar(b, D(), m.id, rol.id);
    expect(r.status, r.text).toBe(200);
    expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
    const lista = await b.llamar(D(), "GET", "/usuarios");
    const fila = lista.body.find((x: any) => x.usuarioId === m.id);
    expect(fila).toMatchObject({ activo: true, rol: "propio" });
    // De un propio a otro propio.
    const otro = await crearOk(b, D(), { permisos: ["clientes.ver"], alcance: "asignado" });
    expect((await asignar(b, D(), m.id, otro.id)).status).toBe(200);
    expect((await membresiaDe(b, E.tenantId, m.id)).rol_id).toBe(otro.id);
    // De vuelta a uno de sistema.
    expect((await asignarSistema(b, D(), m.id, "contador")).status).toBe(200);
    expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "contador", rol_id: null });
    expect(await huerfanos(b, E.tenantId)).toBe(0);
  });

  it("el efecto es inmediato: con la sesión viva, la siguiente petición ya tiene los permisos del rol propio (y los del anterior se van)", async () => {
    const rol = await crearOk(b, D(), { permisos: cerrar(["clientes.crear"]), alcance: "global" });
    const m = await b.miembro(E.tenantId, "admin");
    expect((await b.llamar(m, "GET", "/usuarios")).status).toBe(200);
    expect((await asignar(b, D(), m.id, rol.id)).status).toBe(200);
    expect((await b.llamar(m, "GET", "/usuarios")).status).toBe(403);
    const r = await yo(m);
    expect(r.body).toMatchObject({ rol: "propio", alcance: "global", rolPropio: { id: rol.id } });
    expect(ordenados(r.body.permisos)).toEqual(ordenados(rol.permisos));
  });

  it("rol inexistente, mal formado o de otro estudio: 404 no_encontrado (invitar y cambiar) y nada cambia", async () => {
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: [] });
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    const invitaciones = async () => Number((await b.sql("select count(*)::int as n from invitacion where tenant_id = $1", [E.tenantId]))[0].n);
    const antes = await invitaciones();
    for (const id of [ajeno.id, uuidInexistente()]) {
      const c = await asignar(b, D(), m.id, id);
      expect(c.status, id).toBe(404);
      expect(c.body).toEqual({ codigo: "no_encontrado" });
      const i = await invitar(b, D(), b.correoNuevo(), id);
      expect(i.status, id).toBe(404);
      expect(i.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "contador", rol_id: null });
    expect(await invitaciones()).toBe(antes);
    // Un miembro de otro estudio: sigue 404 aunque el rol sea nuestro.
    const propio = await crearOk(b, D(), { permisos: [] });
    const ajenoM = await b.miembro(otro.tenantId, "contador", { sesion: false });
    expect((await asignar(b, D(), ajenoM.id, propio.id)).status).toBe(404);
    expect(await membresiaDe(b, otro.tenantId, ajenoM.id)).toMatchObject({ rol: "contador", rol_id: null });
  });

  it("cambiar el rol de un miembro con rol propio, desactivarlo y reactivarlo conserva el rol_id", async () => {
    const { rol, miembro } = await rolConMiembro(b, D(), ["clientes.ver"], "asignado");
    expect((await b.llamar(D(), "POST", `/usuarios/${miembro.id}/desactivar`)).status).toBe(200);
    expect(await membresiaDe(b, E.tenantId, miembro.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
    expect((await b.llamar(D(), "POST", `/usuarios/${miembro.id}/reactivar`)).status).toBe(200);
    const m = await membresiaDe(b, E.tenantId, miembro.id);
    expect(m).toMatchObject({ rol: "propio", rol_id: rol.id, desactivada_en: null });
    expect(await huerfanos(b, E.tenantId)).toBe(0);
  });
});

describe("GET /acceso/yo con roles propios", () => {
  it("rol propio: rol 'propio', permisos y alcance efectivos y rolPropio {id, nombre}; el nombre nuevo sale en la siguiente petición", async () => {
    const { rol, miembro } = await rolConMiembro(b, D(), ["clientes.ver", "sire.descargar"], "asignado");
    const r = await yo(miembro);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ rol: "propio", alcance: "asignado", rolPropio: { id: rol.id, nombre: rol.nombre } });
    expect(ordenados(r.body.permisos)).toEqual(["clientes.ver", "sire.descargar"]);
    expect(Object.keys(r.body.rolPropio).sort()).toEqual(["id", "nombre"]);
    expect((await editar(b, D(), rol.id, { nombre: `${rol.nombre} v2`, alcance: "global" })).status).toBe(200);
    const despues = await yo(miembro);
    expect(despues.body).toMatchObject({ alcance: "global", rolPropio: { id: rol.id, nombre: `${rol.nombre} v2` } });
  });

  it("rol de sistema: rolPropio null y el resto igual que en 005", async () => {
    const r = await yo(admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rol: "admin", alcance: "global", rolPropio: null });
    expect(r.body.permisos).toHaveLength(23);
    expect(r.body.permisos).not.toContain("plan.gestionar");
  });
});

describe("GET /roles/asignables (puedeGestionar)", () => {
  it("el Dueño ve los 5 roles de sistema y todos los propios; el Administrador, todos los propios y los de sistema salvo Dueño", async () => {
    const A = await b.estudio();
    const adminA = await b.miembro(A.tenantId, "admin");
    const p1 = await crearOk(b, A.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
    const p2 = await crearOk(b, A.titular, { permisos: cerrar(["usuarios.gestionar"]), alcance: "global" });
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: [] });

    const d = await asignables(b, A.titular);
    expect(d.status, d.text).toBe(200);
    for (const clave of ["dueno", "admin", "contador", "asistente", "lectura", p1.id, p2.id]) expect(contiene(d, clave), clave).toBe(true);
    expect(contiene(d, ajeno.id)).toBe(false);

    const a = await asignables(b, adminA);
    expect(a.status, a.text).toBe(200);
    for (const clave of ["admin", "contador", "asistente", "lectura", p1.id, p2.id]) expect(contiene(a, clave), clave).toBe(true);
    expect(contiene(a, "dueno")).toBe(false);
    expect(contiene(a, ajeno.id)).toBe(false);
  });

  it("quien tiene un rol propio ve solo lo contenido en sus permisos y alcance (U2, U4); sin usuarios.gestionar es 403", async () => {
    const G = await b.estudio();
    const dentro = await crearOk(b, G.titular, { permisos: ["usuarios.ver"], alcance: "asignado" });
    const dentroGlobal = await crearOk(b, G.titular, { permisos: ["usuarios.ver"], alcance: "global" });
    const fuera = await crearOk(b, G.titular, { permisos: ["clientes.ver", "clientes.editar"], alcance: "asignado" });
    const { miembro: gestorAsignado } = await rolConMiembro(b, G.titular, ["usuarios.gestionar"], "asignado");
    const { miembro: gestorGlobal } = await rolConMiembro(b, G.titular, ["usuarios.gestionar"], "global");

    const ga = await asignables(b, gestorAsignado);
    expect(ga.status, ga.text).toBe(200);
    expect(contiene(ga, dentro.id)).toBe(true);
    expect(contiene(ga, dentroGlobal.id)).toBe(false); // global no cabe en un actor de alcance asignado
    expect(contiene(ga, fuera.id)).toBe(false);
    for (const clave of ["dueno", "admin", "contador", "asistente", "lectura"]) expect(contiene(ga, clave), clave).toBe(false);

    const gg = await asignables(b, gestorGlobal);
    expect(contiene(gg, dentro.id)).toBe(true);
    expect(contiene(gg, dentroGlobal.id)).toBe(true); // global ⊇ asignado
    expect(contiene(gg, fuera.id)).toBe(false);

    // roles.gestionar sin usuarios.gestionar no basta para asignar.
    const { miembro: soloRoles } = await rolConMiembro(b, G.titular, ["roles.gestionar"], "global");
    const r = await asignables(b, soloRoles);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
  });
});

describe("CA-8 (U7) · un rol propio nunca es Dueño y nunca quedan 0 Dueños", () => {
  it("con un solo Dueño, un propio con todos los permisos asignables no lo desactiva ni lo degrada (le falta plan.gestionar)", async () => {
    const S = await b.estudio();
    const todos = await crearOk(b, S.titular, {
      permisos: cerrar(["usuarios.gestionar", "roles.gestionar", "estudio.configurar", "credenciales.editar", "auditoria.ver"]),
      alcance: "global",
    });
    const casiDueno = await miembroConRol(b, S.titular, todos.id);
    expect(await duenosActivos(b, S.tenantId)).toBe(1);
    for (const r of [
      await b.llamar(casiDueno, "POST", `/usuarios/${S.titular.id}/desactivar`),
      await asignarSistema(b, casiDueno, S.titular.id, "lectura"),
      await asignar(b, casiDueno, S.titular.id, todos.id),
    ]) {
      expect(r.status, r.text).toBe(403);
    }
    expect(await duenosActivos(b, S.tenantId)).toBe(1);
    expect(await membresiaDe(b, S.tenantId, S.titular.id)).toMatchObject({ rol: "dueno", rol_id: null, desactivada_en: null });
  });

  it("un propio no cuenta como Dueño: el estudio con un Dueño y un propio sigue con 1 Dueño; invitar con rolId no crea Dueños", async () => {
    const S = await b.estudio();
    const rol = await crearOk(b, S.titular, { permisos: cerrar(["usuarios.gestionar"]), alcance: "global" });
    await miembroConRol(b, S.titular, rol.id, { sesion: false });
    expect((await invitar(b, S.titular, b.correoNuevo(), rol.id)).status).toBe(201);
    expect(await duenosActivos(b, S.tenantId)).toBe(1);
    const duenoInv = await b.sql("select count(*)::int as n from invitacion where tenant_id = $1 and rol = 'dueno'", [S.tenantId]);
    expect(duenoInv[0].n).toBe(0);
  });

  it("dos Dueños: uno degrada al otro a un rol propio y queda uno; el degradado ya no puede devolver el golpe", async () => {
    const par = await b.estudio();
    const d2 = await b.miembro(par.tenantId, "dueno");
    const rol = await crearOk(b, par.titular, { permisos: ["usuarios.ver"], alcance: "global" });
    expect((await asignar(b, par.titular, d2.id, rol.id)).status).toBe(200);
    expect(await duenosActivos(b, par.tenantId)).toBe(1);
    expect(await membresiaDe(b, par.tenantId, d2.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
    expect((await asignarSistema(b, d2, par.titular.id, "lectura")).status).toBe(403);
    // Nadie cambia su propio rol: tampoco el Dueño que queda, ni hacia un rol propio.
    expect((await asignar(b, par.titular, par.titular.id, rol.id)).status).toBe(403);
    expect(await duenosActivos(b, par.tenantId)).toBe(1);
  });

  it("dos Dueños que se degradan a un rol propio (o se desactivan) a la vez: nunca quedan 0 y ninguno da 5xx", async () => {
    for (const accion of ["rol", "desactivar"] as const) {
      for (let ronda = 0; ronda < 3; ronda++) {
        const par = await b.estudio();
        const d2 = await b.miembro(par.tenantId, "dueno");
        const rol = await crearOk(b, par.titular, { permisos: ["usuarios.ver"], alcance: "global" });
        const golpe = (de: Actor, a: Actor) =>
          accion === "rol" ? asignar(b, de, a.id, rol.id) : b.llamar(de, "POST", `/usuarios/${a.id}/desactivar`);
        const [r1, r2] = await Promise.all([golpe(par.titular, d2), golpe(d2, par.titular)]);
        expect(await duenosActivos(b, par.tenantId)).toBeGreaterThanOrEqual(1);
        for (const r of [r1, r2]) {
          expect([200, 403, 409], r.text).toContain(r.status);
          if (r.status === 409) expect(r.body).toEqual({ codigo: "ultimo_dueno" });
        }
        expect([r1.status, r2.status]).toContain(200);
        expect(await huerfanos(b, par.tenantId)).toBe(0);
      }
    }
  });
});

describe("CA-9 · aislamiento de los roles en las rutas de asignación", () => {
  it("un rol propio de otro estudio no se asigna ni se invita desde este (404), aunque se conozca su id", async () => {
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: [] });
    const m = await b.miembro(E.tenantId, "lectura", { sesion: false });
    expect((await asignar(b, D(), m.id, ajeno.id)).status).toBe(404);
    expect((await invitar(b, admin, b.correoNuevo(), ajeno.id)).status).toBe(404);
    expect(await cuentaRoles(b, otro.tenantId)).toBe(1);
    expect(rolDe(ajeno.id)).toEqual({ rolId: ajeno.id });
  });
});
