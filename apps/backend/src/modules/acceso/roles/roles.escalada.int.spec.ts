/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (030) · CA-5 (escalada, U1–U2, U4) por API: crear, editar, eliminar y asignar roles propios. Los permisos y el alcance del rol tocado
// (antes y después) deben estar contenidos en los del actor (global ⊇ asignado); nadie crea, edita ni elimina el rol que tiene asignado.
// Cubre: `acceso/roles/roles.service.ts`, `usuarios.service.ts`, `invitaciones.service.ts`, `guards/permiso.guard.ts`.
// Rojo: `/roles` (T9) y la asignación de roles propios (T8) no existen; faltan las tablas de la 0082 (T6).
// Contrato: 403 `{ codigo: "escalada" }` al crear, editar o eliminar fuera de contención y 403 `{ codigo: "rol_propio" }` sobre el rol propio
// del actor. Al asignar (invitar, cambiar rol, desactivar) se exige 403; el código puede ser `escalada` o el `permiso_denegado` de 005 D8.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import {
  asignar,
  asignarSistema,
  cerrar,
  crear,
  crearOk,
  cuentaRoles,
  eliminar,
  editar,
  filaRol,
  invitar,
  membresiaDe,
  miembroConRol,
  ordenados,
  permisosEnBd,
  rolConMiembro,
  type RolCreado,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let b: Banco;
let S: Estudio;
let D: Actor;
// Roles de los actores.
let G: RolCreado; // gestor de roles global: roles.gestionar, usuarios.ver, clientes.ver, clientes.crear
let GA: RolCreado; // el mismo con alcance asignado
let gestor: Actor;
let gestorA: Actor;
// Roles que se tocan.
let Hsub: RolCreado; // global, {clientes.ver}: contenido en G
let H: RolCreado; // global, {clientes.ver, clientes.editar}: NO contenido en G (falta clientes.editar)

const PERMISOS_G = cerrar(["roles.gestionar", "clientes.crear"]);
const esEscalada = (r: { status: number; body: any }): void => {
  expect(r.status, JSON.stringify(r.body)).toBe(403);
  expect(["escalada", "permiso_denegado"]).toContain(r.body.codigo);
};

beforeAll(async () => {
  b = await abrirBanco();
  S = await b.estudio();
  D = S.titular;
  G = await crearOk(b, D, { nombre: "Gestor de roles", permisos: PERMISOS_G, alcance: "global" });
  GA = await crearOk(b, D, { nombre: "Gestor de roles asignado", permisos: PERMISOS_G, alcance: "asignado" });
  gestor = await miembroConRol(b, D, G.id);
  gestorA = await miembroConRol(b, D, GA.id);
  Hsub = await crearOk(b, D, { nombre: "Hsub", permisos: ["clientes.ver"], alcance: "global" });
  H = await crearOk(b, D, { nombre: "H", permisos: ["clientes.ver", "clientes.editar"], alcance: "global" });
});
afterAll(async () => {
  await b?.cerrar();
});

describe("U2 · crear un rol: los permisos y el alcance deben estar contenidos en los del actor", () => {
  it("un gestor de alcance global crea un subconjunto (201) y no puede crear uno con un permiso que no tiene (403 escalada)", async () => {
    const dentro = await crear(b, gestor, { permisos: ["clientes.ver", "clientes.crear"], alcance: "global" });
    expect(dentro.status, dentro.text).toBe(201);
    const conSuyos = await crear(b, gestor, { permisos: PERMISOS_G, alcance: "asignado" }); // roles.gestionar está dentro de G
    expect(conSuyos.status, conSuyos.text).toBe(201);
    const antes = await cuentaRoles(b, S.tenantId);
    for (const permisos of [
      cerrar(["clientes.editar"]),
      cerrar(["clientes.crear", "clientes.archivar"]),
      cerrar(["usuarios.gestionar"]), // permiso sensible que no tiene
      cerrar(["credenciales.editar"]),
      cerrar(["auditoria.ver"]),
    ]) {
      const r = await crear(b, gestor, { permisos, alcance: "asignado" });
      expect(r.status, r.text).toBe(403);
      expect(r.body).toEqual({ codigo: "escalada" });
    }
    expect(await cuentaRoles(b, S.tenantId)).toBe(antes);
  });

  it("U4: un gestor de alcance asignado no crea un rol global aunque los permisos quepan (403 escalada); uno asignado sí", async () => {
    const global = await crear(b, gestorA, { permisos: ["clientes.ver"], alcance: "global" });
    expect(global.status, global.text).toBe(403);
    expect(global.body).toEqual({ codigo: "escalada" });
    const asignado = await crear(b, gestorA, { permisos: ["clientes.ver", "clientes.crear"], alcance: "asignado" });
    expect(asignado.status, asignado.text).toBe(201);
  });

  it("el Dueño y el Administrador crean un rol global con todos los permisos asignables (U1: contienen todo)", async () => {
    const admin = await b.miembro(S.tenantId, "admin");
    for (const a of [D, admin]) {
      const r = await crear(b, a, { permisos: cerrar(["usuarios.gestionar", "roles.gestionar", "credenciales.editar", "auditoria.ver", "prorrata.gestionar", "estudio.configurar"]), alcance: "global" });
      expect(r.status, r.text).toBe(201);
      expect((await eliminar(b, a, r.body.id)).status).toBe(204);
    }
  });

  it("el rechazo por escalada no deja rastro: ni rol, ni permisos, ni nombre ocupado", async () => {
    const nombre = "Nombre libre tras escalada";
    const r = await crear(b, gestor, { nombre, permisos: cerrar(["clientes.editar"]) });
    expect(r.status).toBe(403);
    const ok = await crear(b, gestor, { nombre, permisos: ["clientes.ver"] }); // el nombre sigue libre
    expect(ok.status, ok.text).toBe(201);
  });
});

describe("U2 · editar y eliminar: el rol tocado, antes y después, debe estar contenido", () => {
  it("editar a un subconjunto contenido: 200; agregar un permiso que el actor no tiene: 403 escalada y no cambia", async () => {
    const r = await crearOk(b, gestor, { permisos: ["clientes.ver"], alcance: "asignado" });
    const ok = await editar(b, gestor, r.id, { permisos: ["clientes.ver", "clientes.crear"] });
    expect(ok.status, ok.text).toBe(200);
    const mal = await editar(b, gestor, r.id, { permisos: ["clientes.ver", "clientes.crear", "clientes.editar"] });
    expect(mal.status, mal.text).toBe(403);
    expect(mal.body).toEqual({ codigo: "escalada" });
    expect(await permisosEnBd(b, r.id)).toEqual(["clientes.crear", "clientes.ver"]);
  });

  it("un rol cuyo estado actual no está contenido (le faltan permisos al actor) no se puede editar, renombrar, reducir ni eliminar (403)", async () => {
    for (const cuerpo of [{ nombre: "Renombrado por intruso" }, { permisos: ["clientes.ver"] }, { alcance: "asignado" }]) {
      const r = await editar(b, gestor, H.id, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(403);
      expect(r.body).toEqual({ codigo: "escalada" });
    }
    const del = await eliminar(b, gestor, H.id);
    expect(del.status, del.text).toBe(403);
    expect(del.body).toEqual({ codigo: "escalada" });
    expect(await filaRol(b, H.id)).toMatchObject({ nombre: "H", alcance: "global" });
    expect(await permisosEnBd(b, H.id)).toEqual(["clientes.editar", "clientes.ver"]);
  });

  it("el gestor elimina un rol contenido y sin uso (204)", async () => {
    const r = await crearOk(b, gestor, { permisos: ["clientes.ver"], alcance: "asignado" });
    expect((await eliminar(b, gestor, r.id)).status).toBe(204);
  });

  it("U4: el gestor de alcance asignado no edita ni elimina un rol global; tampoco sube uno asignado a global", async () => {
    const e = await editar(b, gestorA, Hsub.id, { nombre: "Intruso" });
    expect(e.status).toBe(403);
    expect(e.body).toEqual({ codigo: "escalada" });
    expect((await eliminar(b, gestorA, Hsub.id)).status).toBe(403);
    const propio = await crearOk(b, gestorA, { permisos: ["clientes.ver"], alcance: "asignado" });
    const sube = await editar(b, gestorA, propio.id, { alcance: "global" });
    expect(sube.status).toBe(403);
    expect(sube.body).toEqual({ codigo: "escalada" });
    expect((await filaRol(b, propio.id))?.alcance).toBe("asignado");
    expect((await filaRol(b, Hsub.id))?.nombre).toBe("Hsub");
  });

  it("el gestor global sí edita un rol de alcance asignado contenido (global ⊇ asignado), incluido el rol del otro gestor", async () => {
    const r = await editar(b, gestor, GA.id, { nombre: "Gestor de roles asignado (renombrado)" });
    expect(r.status, r.text).toBe(200);
    expect(await editar(b, gestor, GA.id, { nombre: GA.nombre })).toMatchObject({ status: 200 });
  });

  it("el Dueño edita y elimina cualquiera que no use, sin límites de contención", async () => {
    const r = await editar(b, D, H.id, { permisos: cerrar(["clientes.editar", "clientes.archivar"]) });
    expect(r.status, r.text).toBe(200);
    expect(ordenados(await permisosEnBd(b, H.id))).toEqual(["clientes.archivar", "clientes.editar", "clientes.ver"]);
  });
});

describe("U2 · nadie crea, edita ni elimina el rol que tiene asignado", () => {
  it("el gestor no edita ni elimina su propio rol (403 rol_propio), ni siquiera sin cambios de permisos; otro gestor con el mismo rol, tampoco", async () => {
    const otro = await miembroConRol(b, D, G.id);
    for (const a of [gestor, otro]) {
      for (const cuerpo of [{ nombre: "Mi rol, mejor" }, { permisos: ["clientes.ver"] }, { permisos: PERMISOS_G }]) {
        const r = await editar(b, a, G.id, cuerpo);
        expect(r.status, JSON.stringify(cuerpo)).toBe(403);
        expect(r.body).toEqual({ codigo: "rol_propio" });
      }
      const del = await eliminar(b, a, G.id);
      expect(del.status, del.text).toBe(403);
      expect(del.body).toEqual({ codigo: "rol_propio" });
    }
    expect(await permisosEnBd(b, G.id)).toEqual(ordenados(PERMISOS_G));
    expect((await filaRol(b, G.id))?.nombre).toBe("Gestor de roles");
  });

  it("el Dueño (sin rol propio) sí edita el rol de ese gestor y el cambio le aplica en su siguiente petición", async () => {
    const { rol, miembro } = await rolConMiembro(b, D, ["roles.gestionar", "clientes.crear"], "global");
    expect((await b.llamar(miembro, "GET", "/roles")).status).toBe(200);
    expect((await editar(b, D, rol.id, { permisos: ["clientes.ver"] })).status).toBe(200);
    expect((await b.llamar(miembro, "GET", "/roles")).status).toBe(403);
  });
});

describe("U2 · asignar (invitar, cambiar rol, desactivar): el rol nuevo y el actual del miembro deben estar contenidos en los del actor", () => {
  let ug: Actor; // usuarios.gestionar + usuarios.ver, global
  let uga: Actor; // lo mismo, asignado
  let Ru: RolCreado; // {usuarios.ver} global
  let RuAsig: RolCreado; // {usuarios.ver} asignado
  let Rx: RolCreado; // {clientes.ver} asignado: no contenido en ug
  let RroL: RolCreado; // {usuarios.ver, roles.gestionar}: roles.gestionar no lo tiene ug
  beforeAll(async () => {
    ug = (await rolConMiembro(b, D, ["usuarios.gestionar"], "global")).miembro;
    uga = (await rolConMiembro(b, D, ["usuarios.gestionar"], "asignado")).miembro;
    Ru = await crearOk(b, D, { permisos: ["usuarios.ver"], alcance: "global" });
    RuAsig = await crearOk(b, D, { permisos: ["usuarios.ver"], alcance: "asignado" });
    Rx = await crearOk(b, D, { permisos: ["clientes.ver"], alcance: "asignado" });
    RroL = await crearOk(b, D, { permisos: cerrar(["roles.gestionar"]), alcance: "global" });
  });

  it("invitar: un rol contenido da 201; uno con permisos de más (incluido roles.gestionar y los de sistema) da 403 y no crea la invitación", async () => {
    expect((await invitar(b, ug, b.correoNuevo(), Ru.id)).status).toBe(201);
    expect((await invitar(b, ug, b.correoNuevo(), RuAsig.id)).status).toBe(201);
    const antes = Number((await b.sql("select count(*)::int as n from invitacion where tenant_id = $1", [S.tenantId]))[0].n);
    for (const rolId of [Rx.id, RroL.id, H.id]) esEscalada(await invitar(b, ug, b.correoNuevo(), rolId));
    for (const rol of ["admin", "contador", "asistente", "lectura", "dueno"]) {
      esEscalada(await b.llamar(ug, "POST", "/invitaciones", { correo: b.correoNuevo(), rol }));
    }
    const despues = Number((await b.sql("select count(*)::int as n from invitacion where tenant_id = $1", [S.tenantId]))[0].n);
    expect(despues).toBe(antes);
  });

  it("U4: con alcance asignado no se invita un rol global aunque los permisos quepan; uno asignado sí", async () => {
    esEscalada(await invitar(b, uga, b.correoNuevo(), Ru.id));
    expect((await invitar(b, uga, b.correoNuevo(), RuAsig.id)).status).toBe(201);
  });

  it("cambiar de rol: el miembro actual y el nuevo rol deben estar contenidos; si no, 403 y nada cambia", async () => {
    const contenido = await miembroConRol(b, D, Ru.id, { sesion: false });
    const ajeno = await b.miembro(S.tenantId, "lectura", { sesion: false }); // su rol (lectura) no cabe en el de ug
    // contenido → contenido: 200.
    expect((await asignar(b, ug, contenido.id, RuAsig.id)).status).toBe(200);
    expect((await asignar(b, ug, contenido.id, Ru.id)).status).toBe(200);
    // contenido → algo que no cabe: 403.
    for (const r of [await asignar(b, ug, contenido.id, Rx.id), await asignar(b, ug, contenido.id, RroL.id), await asignarSistema(b, ug, contenido.id, "lectura")]) esEscalada(r);
    expect(await membresiaDe(b, S.tenantId, contenido.id)).toMatchObject({ rol: "propio", rol_id: Ru.id });
    // actual no contenido → 403 aunque el nuevo sí lo esté.
    esEscalada(await asignar(b, ug, ajeno.id, Ru.id));
    expect(await membresiaDe(b, S.tenantId, ajeno.id)).toMatchObject({ rol: "lectura", rol_id: null });
  });

  it("U4: con alcance asignado no se asigna un rol global ni se toca a un miembro de rol global", async () => {
    const global = await miembroConRol(b, D, Ru.id, { sesion: false });
    esEscalada(await asignar(b, uga, global.id, RuAsig.id)); // su rol actual (global) no cabe
    const asignado = await miembroConRol(b, D, RuAsig.id, { sesion: false });
    esEscalada(await asignar(b, uga, asignado.id, Ru.id)); // el nuevo (global) no cabe
    expect((await asignar(b, uga, asignado.id, RuAsig.id)).status).toBe(200);
    expect(await membresiaDe(b, S.tenantId, global.id)).toMatchObject({ rol_id: Ru.id });
  });

  it("desactivar y reactivar: solo a miembros cuyo rol está contenido", async () => {
    const dentro = await miembroConRol(b, D, Ru.id, { sesion: false });
    const fuera = await miembroConRol(b, D, Rx.id, { sesion: false });
    esEscalada(await b.llamar(ug, "POST", `/usuarios/${fuera.id}/desactivar`));
    expect((await membresiaDe(b, S.tenantId, fuera.id)).desactivada_en).toBeNull();
    expect((await b.llamar(ug, "POST", `/usuarios/${dentro.id}/desactivar`)).status).toBe(200);
    expect((await b.llamar(ug, "POST", `/usuarios/${dentro.id}/reactivar`)).status).toBe(200);
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [S.tenantId, fuera.id]);
    esEscalada(await b.llamar(ug, "POST", `/usuarios/${fuera.id}/reactivar`));
  });

  it("nadie cambia su propio rol ni se desactiva, tampoco hacia un rol propio contenido", async () => {
    esEscalada(await asignar(b, ug, ug.id, Ru.id));
    esEscalada(await b.llamar(ug, "POST", `/usuarios/${ug.id}/desactivar`));
    expect(await membresiaDe(b, S.tenantId, ug.id)).toMatchObject({ rol: "propio", desactivada_en: null });
  });

  it("roles.gestionar sin usuarios.gestionar no asigna roles: 403 permiso_denegado antes de mirar el rol", async () => {
    const m = await b.miembro(S.tenantId, "lectura", { sesion: false });
    const r = await asignar(b, gestor, m.id, Hsub.id);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    const i = await invitar(b, gestor, b.correoNuevo(), Hsub.id);
    expect(i.status).toBe(403);
    expect(i.body).toEqual({ codigo: "permiso_denegado" });
  });

  it("un permiso se gana por asignación solo si el actor lo tiene: el miembro de rol contenido sube a otro contenido, nunca a uno con roles.gestionar (lateral)", async () => {
    const m = await miembroConRol(b, D, Ru.id, { sesion: true });
    esEscalada(await asignar(b, ug, m.id, RroL.id));
    expect((await b.llamar(m, "GET", "/roles")).status).toBe(403);
  });
});
