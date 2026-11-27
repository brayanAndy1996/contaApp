/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (030) · auditoría de altas, ediciones y bajas de roles (spec «Alcance»; plan 030, «BD: Auditoría»): `rol.creado`, `rol.editado` y
// `rol.eliminado` con `datos` = `{ antes, despues }`, cada uno `{ permisos, alcance }` (null o ausente donde no aplica); el actor es el de
// la sesión; lo rechazado y la vista previa no auditan; solo se ve con `auditoria.ver` y solo en el estudio propio (CA-9).
// Cubre: `acceso/roles/roles.service.ts`, `auditoria/auditoria.service.ts` (con las acciones nuevas).
// Rojo: `/roles` (T9), las acciones `rol.*` en el catálogo (T7) y su `CHECK` en `auditoria` (T6) aún no existen.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import {
  asignar,
  cerrar,
  crear,
  crearOk,
  cuentaAuditoria,
  editar,
  eliminar,
  impacto,
  invitar,
  ordenados,
  rolConMiembro,
  uuidInexistente,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
let D: Actor;
let admin: Actor;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  D = E.titular;
  admin = await b.miembro(E.tenantId, "admin");
});
afterAll(async () => {
  await b?.cerrar();
});

/** Todas las filas de auditoría que ve `a` (sigue `siguiente`, a lo sumo 10 páginas). */
async function filas(a: Actor, accion?: string, entidadId?: string): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await b.llamar(a, "GET", `/auditoria${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`);
    expect(r.status, r.text).toBe(200);
    items.push(...r.body.items);
    cursor = r.body.siguiente;
    if (cursor === null) break;
  }
  return items.filter((x) => (accion === undefined || x.accion === accion) && (entidadId === undefined || x.entidadId === entidadId));
}
const sinAntes = (datos: any): boolean => datos.antes === undefined || datos.antes === null;
const sinDespues = (datos: any): boolean => datos.despues === undefined || datos.despues === null;

describe("rol.creado · rol.editado · rol.eliminado", () => {
  it("crear deja rol.creado con el actor de la sesión, la entidad rol y los permisos y alcance «después»", async () => {
    const permisos = cerrar(["clientes.crear", "buzon.atender"]);
    const rol = await crearOk(b, D, { permisos, alcance: "asignado" });
    const [x, ...resto] = await filas(D, "rol.creado", rol.id);
    expect(resto).toEqual([]);
    expect(x).toMatchObject({ accion: "rol.creado", entidad: "rol", entidadId: rol.id, cliente: null, objetivo: null });
    expect(x.actor).toMatchObject({ tipo: "usuario", autor: { id: D.id, activo: true } });
    expect(ordenados(x.datos.despues.permisos)).toEqual(ordenados(permisos));
    expect(x.datos.despues.alcance).toBe("asignado");
    expect(sinAntes(x.datos)).toBe(true);
    expect(JSON.stringify(x)).not.toMatch(/tenantId|usuarioId/);
  });

  it("editar deja rol.editado con permisos y alcance antes y después; un cambio solo de nombre también deja fila", async () => {
    const rol = await crearOk(b, D, { permisos: cerrar(["clientes.crear"]), alcance: "asignado" });
    expect((await editar(b, D, rol.id, { permisos: cerrar(["clientes.editar", "reglas.gestionar"]), alcance: "global" })).status).toBe(200);
    expect((await editar(b, D, rol.id, { nombre: "Solo cambia el nombre" })).status).toBe(200);
    const xs = await filas(D, "rol.editado", rol.id);
    expect(xs).toHaveLength(2);
    // De la más nueva a la más vieja (017).
    const [soloNombre, cambio] = xs as [any, any];
    expect(ordenados(cambio.datos.antes.permisos)).toEqual(ordenados(cerrar(["clientes.crear"])));
    expect(cambio.datos.antes.alcance).toBe("asignado");
    expect(ordenados(cambio.datos.despues.permisos)).toEqual(ordenados(cerrar(["clientes.editar", "reglas.gestionar"])));
    expect(cambio.datos.despues.alcance).toBe("global");
    expect(soloNombre.datos.antes.permisos).toEqual(soloNombre.datos.despues.permisos);
    expect(soloNombre.datos.antes.alcance).toBe("global");
    expect(cambio.actor.autor.id).toBe(D.id);
  });

  it("eliminar deja rol.eliminado con permisos y alcance «antes»", async () => {
    const rol = await crearOk(b, D, { permisos: cerrar(["prorrata.gestionar"]), alcance: "global" });
    expect((await eliminar(b, D, rol.id)).status).toBe(204);
    const [x] = await filas(D, "rol.eliminado", rol.id);
    expect(x).toMatchObject({ accion: "rol.eliminado", entidad: "rol", entidadId: rol.id });
    expect(ordenados(x.datos.antes.permisos)).toEqual(ordenados(cerrar(["prorrata.gestionar"])));
    expect(x.datos.antes.alcance).toBe("global");
    expect(sinDespues(x.datos)).toBe(true);
  });

  it("el actor es siempre el de la sesión: el Administrador queda como autor; un usuarioId o actor del cuerpo no lo cambia", async () => {
    const rol = await crear(b, admin, { permisos: ["clientes.ver"], extra: { usuarioId: D.id, actor: D.id, creadoPor: D.id } });
    expect(rol.status, rol.text).toBe(201);
    const [x] = await filas(D, "rol.creado", rol.body.id);
    expect(x.actor.autor.id).toBe(admin.id);
  });
});

describe("lo que no cambia nada no audita", () => {
  it("422, 409, 403 y 404 de /roles y la vista previa de impacto no dejan filas rol.*", async () => {
    const existente = await crearOk(b, D, { permisos: ["clientes.ver"], alcance: "asignado" });
    const { rol: enUso } = await rolConMiembro(b, D, ["clientes.ver"], "asignado");
    const { miembro: gestor } = await rolConMiembro(b, D, ["roles.gestionar"], "asignado");
    const antes = await cuentaAuditoria(b, E.tenantId);
    const intentos = [
      await crear(b, D, { permisos: ["plan.gestionar"] }), // 422
      await crear(b, D, { permisos: ["clientes.crear"] }), // 422 U3
      await crear(b, D, { nombre: existente.nombre, permisos: [] }), // 409
      await crear(b, gestor, { permisos: ["clientes.editar", "clientes.ver"] }), // 403 escalada
      await crear(b, gestor, { permisos: ["clientes.ver"], alcance: "global" }), // 403 escalada (alcance)
      await editar(b, D, uuidInexistente(), { nombre: "x" }), // 404
      await editar(b, D, existente.id, { permisos: ["plan.gestionar"] }), // 422
      await eliminar(b, D, enUso.id), // 409 rol_en_uso
      await eliminar(b, D, uuidInexistente()), // 404
      await impacto(b, D, existente.id, { permisos: cerrar(["credenciales.editar"]) }), // 200 sin escribir
    ];
    expect(intentos.map((r) => r.status)).toEqual([422, 422, 409, 403, 403, 404, 422, 409, 404, 200]);
    expect(await cuentaAuditoria(b, E.tenantId)).toBe(antes);
    expect(await filas(D, "rol.editado", existente.id)).toEqual([]);
  });
});

describe("asignar roles propios deja el rastro de 017", () => {
  it("cambiar el rol de un miembro a uno propio deja miembro.rol_cambiado con su objetivo; invitar deja invitacion.creada sin correo", async () => {
    const rol = await crearOk(b, D, { permisos: ["clientes.ver"], alcance: "asignado" });
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    expect((await asignar(b, D, m.id, rol.id)).status).toBe(200);
    const mid = (await b.sql("select id from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]))[0].id;
    const [cambio] = await filas(D, "miembro.rol_cambiado", mid);
    expect(cambio).toBeDefined();
    expect(cambio.objetivo).toMatchObject({ id: m.id, activo: true });
    expect(cambio.actor.autor.id).toBe(D.id);

    const correo = b.correoNuevo();
    const inv = await invitar(b, D, correo, rol.id);
    expect(inv.status, inv.text).toBe(201);
    const [creada] = await filas(D, "invitacion.creada", inv.body.id);
    expect(creada).toBeDefined();
    const todo = await b.llamar(D, "GET", "/auditoria");
    expect(todo.text.toLowerCase()).not.toContain(correo.toLowerCase());
    expect(todo.text).not.toMatch(/token|hash/i);
  });
});

describe("quién ve la auditoría de roles (017 + CA-9)", () => {
  it("el Administrador la ve; el Contador, el Asistente y Lectura reciben 403 sin datos; otro estudio no ve los roles de este", async () => {
    const rol = await crearOk(b, D, { permisos: [], alcance: "asignado" });
    expect((await filas(admin, "rol.creado", rol.id)).length).toBe(1);
    for (const r of ["contador", "asistente", "lectura"] as const) {
      const a = await b.miembro(E.tenantId, r);
      const res = await b.llamar(a, "GET", "/auditoria");
      expect(res.status, r).toBe(403);
      expect(res.body).toEqual({ codigo: "permiso_denegado" });
    }
    const otro = await b.estudio();
    const ajena = await filas(otro.titular);
    expect(ajena.filter((x) => String(x.accion).startsWith("rol."))).toEqual([]);
    expect(JSON.stringify(ajena)).not.toContain(rol.id);
  });
});
