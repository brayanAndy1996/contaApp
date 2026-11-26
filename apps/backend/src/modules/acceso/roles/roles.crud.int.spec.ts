/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (030) · CA-1, CA-2, CA-3, CA-9 (nombre y límite): CRUD de `/roles` con sus errores de código fijo, y la tabla 5 roles x endpoints nuevos.
// Cubre (≥ 90 % por archivo, con roles.permisos/escalada/uso/auditoria): `acceso/roles/roles.controller.ts`, `acceso/roles/roles.service.ts`.
// Rojo: las rutas `/roles` (T9), las tablas `rol`/`rol_permiso` y las funciones de la 0082 (T6) aún no existen: 404 de ruta.
// Contrato (plan 030, «HTTP»): 201 · 422 `permiso_invalido`/`combinacion_invalida` (con el permiso faltante en `permiso`) · 409
// `nombre_duplicado`/`limite_roles` · 404 ajeno, inexistente o de sistema · 204 al eliminar. Cuerpo mal formado: 400 `solicitud_invalida`.
import { PERMISOS } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, clase, ROLES, type Actor, type Banco, type Estudio, type RolSistema } from "../../../../test/soporte-acceso.js";
import {
  ASIGNABLES,
  cerrar,
  crear,
  crearOk,
  cuentaRoles,
  editar,
  eliminar,
  filaRol,
  impacto,
  LIMITE_ROLES,
  listar,
  asignables,
  NOMBRES_DE_SISTEMA,
  nombreUnico,
  ordenados,
  permisosEnBd,
  propiosDe,
  uuidInexistente,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
const actores = {} as Record<RolSistema, Actor>;

beforeAll(async () => {
  b = await abrirBanco();
});
afterAll(async () => {
  await b?.cerrar();
});

const D = (): Actor => E.titular;
/** Cada `describe` trabaja en un estudio nuevo: así el límite de 20 roles (U9) no cuenta lo de las demás. */
const estudioNuevo = (): void => {
  beforeAll(async () => {
    E = await b.estudio();
  });
};

describe("CA-1 · crear un rol propio", () => {
  estudioNuevo();
  it("201 con id, nombre, alcance y permisos; queda en BD y en GET /roles con 0 miembros y 0 invitaciones", async () => {
    const permisos = cerrar(["clientes.crear", "buzon.atender"]);
    const nombre = nombreUnico("Practicante");
    const r = await crear(b, D(), { nombre, alcance: "asignado", permisos });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ nombre, alcance: "asignado" });
    expect(ordenados(r.body.permisos)).toEqual(ordenados(permisos));
    const id: string = r.body.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const fila = await filaRol(b, id);
    expect(fila).toMatchObject({ tenant_id: E.tenantId, nombre, alcance: "asignado" });
    expect(await permisosEnBd(b, id)).toEqual(ordenados(permisos));

    const lista = await listar(b, D());
    expect(lista.status, lista.text).toBe(200);
    const propio = propiosDe(lista).find((x) => x.id === id);
    expect(propio).toMatchObject({ id, nombre, alcance: "asignado", miembros: 0, invitaciones: 0 });
    expect(ordenados(propio.permisos)).toEqual(ordenados(permisos));
  });

  it("alcance global y la lista vacía de permisos son válidos; el tenantId del cuerpo se ignora", async () => {
    const otro = await b.estudio();
    const r = await crear(b, D(), { alcance: "global", permisos: [], extra: { tenantId: otro.tenantId, id: uuidInexistente() } });
    expect(r.status, r.text).toBe(201);
    expect(r.body.alcance).toBe("global");
    expect(r.body.permisos).toEqual([]);
    expect((await filaRol(b, r.body.id))?.tenant_id).toBe(E.tenantId);
    expect(await cuentaRoles(b, otro.tenantId)).toBe(0);
  });

  it("nombre de 1 y de 40 caracteres valen; el administrador también crea; el rol del cuerpo `baseRolId` ajeno o inexistente da 404", async () => {
    expect((await crear(b, D(), { nombre: "A", permisos: [] })).status).toBe(201);
    expect((await crear(b, D(), { nombre: "x".repeat(40), permisos: [] })).status).toBe(201);
    const admin = await b.miembro(E.tenantId, "admin");
    expect((await crear(b, admin, { permisos: ["clientes.ver"] })).status).toBe(201);
    const base = await crearOk(b, D(), { permisos: ["clientes.ver"] });
    const conBase = await crear(b, D(), { permisos: ["clientes.ver", "clientes.crear"], baseRolId: base.id });
    expect(conBase.status, conBase.text).toBe(201);
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: ["clientes.ver"] });
    for (const baseRolId of [ajeno.id, uuidInexistente()]) {
      const r = await crear(b, D(), { permisos: ["clientes.ver"], baseRolId });
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
  });

  it("nombre único por estudio sin importar mayúsculas ni tildes; otro estudio puede repetirlo", async () => {
    const base = nombreUnico("Práctícante").replace(/á/g, "a");
    const original = await crear(b, D(), { nombre: `${base} Á`, permisos: [] });
    expect(original.status, original.text).toBe(201);
    const antes = await cuentaRoles(b, E.tenantId);
    for (const dup of [`${base} á`, `${base} A`.toUpperCase(), `${base} Á`]) {
      const r = await crear(b, D(), { nombre: dup, permisos: [] });
      expect(r.status, dup).toBe(409);
      expect(r.body).toEqual({ codigo: "nombre_duplicado" });
    }
    expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
    const otro = await b.estudio();
    expect((await crear(b, otro.titular, { nombre: `${base} Á`, permisos: [] })).status).toBe(201);
  });

  it.each(NOMBRES_DE_SISTEMA)("el nombre %j choca con un rol de sistema: 409 nombre_duplicado", async (nombre) => {
    const antes = await cuentaRoles(b, E.tenantId);
    const r = await crear(b, D(), { nombre, permisos: [] });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "nombre_duplicado" });
    expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
  });
});

describe("CA-2 · permisos fuera del catálogo y combinaciones inválidas (U3)", () => {
  estudioNuevo();
  it.each(["plan.gestionar", "otra.cosa", "", "Clientes.ver", "clientes.ver ", "__proto__", "*"])(
    "el permiso %j se rechaza con 422 permiso_invalido y no se crea nada",
    async (permiso) => {
      const antes = await cuentaRoles(b, E.tenantId);
      const r = await crear(b, D(), { permisos: ["clientes.ver", permiso] });
      expect(r.status, r.text).toBe(422);
      expect(r.body.codigo).toBe("permiso_invalido");
      expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
    },
  );

  it("plan.gestionar tampoco entra por la edición, ni solo ni mezclado, ni aunque el actor sea Dueño", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"] });
    for (const permisos of [["plan.gestionar"], ["clientes.ver", "plan.gestionar"]]) {
      const r = await editar(b, D(), rol.id, { permisos });
      expect(r.status, r.text).toBe(422);
      expect(r.body.codigo).toBe("permiso_invalido");
    }
    expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.ver"]);
  });

  // [permisos enviados, el que falta]. U3: toda acción exige el `.ver` de su módulo y todo permiso de cliente exige `clientes.ver`.
  const COMBINACIONES: ReadonlyArray<readonly [string[], string]> = [
    [["usuarios.gestionar", "clientes.ver"], "usuarios.ver"],
    [["roles.gestionar"], "usuarios.ver"],
    [["buzon.atender", "clientes.ver"], "buzon.ver"],
    [["buzon.marcar_leido", "clientes.ver"], "buzon.ver"],
    [["reglas.gestionar", "clientes.ver"], "reglas.ver"],
    [["prorrata.gestionar", "clientes.ver"], "prorrata.ver"],
    [["clientes.crear"], "clientes.ver"],
    [["clientes.editar"], "clientes.ver"],
    [["clientes.archivar"], "clientes.ver"],
    [["clientes.asignar"], "clientes.ver"],
    [["credenciales.editar"], "clientes.ver"],
    [["sire.descargar"], "clientes.ver"],
    [["sire.clasificar"], "clientes.ver"],
    [["sire.aprobar_generar"], "clientes.ver"],
    [["ajustes.crear"], "clientes.ver"],
    [["ajustes.generar"], "clientes.ver"],
    [["buzon.ver"], "clientes.ver"],
    [["reglas.ver"], "clientes.ver"],
    [["prorrata.ver"], "clientes.ver"],
  ];
  it.each(COMBINACIONES.map(([p, f]) => [p.join(" + "), p, f] as const))(
    "%s sin su requisito: 422 combinacion_invalida que nombra el permiso faltante (no se completa solo)",
    async (_n, permisos, falta) => {
      const antes = await cuentaRoles(b, E.tenantId);
      const r = await crear(b, D(), { permisos });
      expect(r.status, r.text).toBe(422);
      expect(r.body).toMatchObject({ codigo: "combinacion_invalida", permiso: falta });
      expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
      // La edición aplica la misma regla.
      const rol = await crearOk(b, D(), { permisos: [] });
      const e = await editar(b, D(), rol.id, { permisos });
      expect(e.status, e.text).toBe(422);
      expect(e.body).toMatchObject({ codigo: "combinacion_invalida", permiso: falta });
      expect(await permisosEnBd(b, rol.id)).toEqual([]);
      await eliminar(b, D(), rol.id);
    },
  );

  it("todo permiso asignable del catálogo, con sus requisitos, se acepta (los 23 y todos juntos)", async () => {
    for (const p of ASIGNABLES) {
      const r = await crear(b, D(), { permisos: cerrar([p]), alcance: "global" });
      expect(r.status, `${p}: ${r.text}`).toBe(201);
      await eliminar(b, D(), r.body.id);
    }
    const todos = await crear(b, D(), { permisos: ASIGNABLES, alcance: "global" });
    expect(todos.status, todos.text).toBe(201);
    expect(ordenados(todos.body.permisos)).toEqual(ordenados(ASIGNABLES));
    expect(PERMISOS).toContain("plan.gestionar"); // el catálogo lo tiene; el rol propio no
    await eliminar(b, D(), todos.body.id);
  });

  it.each<[string, unknown]>([
    ["alcance fuera de catálogo", { nombre: "N", alcance: "todos", permisos: [] }],
    ["sin alcance", { nombre: "N", permisos: [] }],
    ["sin nombre", { alcance: "global", permisos: [] }],
    ["nombre vacío", { nombre: "", alcance: "global", permisos: [] }],
    ["nombre de 41 caracteres", { nombre: "x".repeat(41), alcance: "global", permisos: [] }],
    ["nombre con caracteres de control", { nombre: "mal\nnombre", alcance: "global", permisos: [] }],
    ["nombre con BEL", { nombre: "mal\u0007", alcance: "global", permisos: [] }],
    ["nombre que no es texto", { nombre: 7, alcance: "global", permisos: [] }],
    ["permisos que no es lista", { nombre: "N", alcance: "global", permisos: "clientes.ver" }],
    ["permiso que no es texto", { nombre: "N", alcance: "global", permisos: [1] }],
    ["sin permisos", { nombre: "N", alcance: "global" }],
    ["cuerpo vacío", {}],
  ])("cuerpo mal formado (%s): 4xx de validación y no se crea nada", async (_n, cuerpo) => {
    const antes = await cuentaRoles(b, E.tenantId);
    const r = await b.llamar(D(), "POST", "/roles", cuerpo);
    expect([400, 422], r.text).toContain(r.status);
    expect(r.status).not.toBe(201);
    expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
  });
});

describe("GET /roles · lista", () => {
  estudioNuevo();
  it("5 roles de sistema (solo lectura: 24 / 23 / 14 / 8 / 4 permisos) y solo los propios de este estudio", async () => {
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { nombre: nombreUnico("Ajeno"), permisos: ["clientes.ver"] });
    const propio = await crearOk(b, D(), { permisos: ["clientes.ver"] });
    const r = await listar(b, D());
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["propios", "sistema"]);
    expect(r.body.sistema).toHaveLength(5);
    expect(r.body.sistema.map((s: any) => s.permisos.length).sort((x: number, y: number) => x - y)).toEqual([4, 8, 14, 23, 24]);
    const ids = propiosDe(r).map((x) => x.id);
    expect(ids).toContain(propio.id);
    expect(ids).not.toContain(ajeno.id);
    expect(r.text).not.toContain(ajeno.nombre);
    for (const p of propiosDe(r)) {
      expect(Object.keys(p).sort()).toEqual(["alcance", "id", "invitaciones", "miembros", "nombre", "permisos"]);
      expect(typeof p.miembros).toBe("number");
      expect(typeof p.invitaciones).toBe("number");
    }
    // El del otro estudio no ve los nuestros.
    expect(propiosDe(await listar(b, otro.titular)).map((x) => x.id)).not.toContain(propio.id);
  });
});

describe("PATCH /roles/:id · editar", () => {
  estudioNuevo();
  it("cambia nombre, permisos y alcance; 200 con el rol; BD y lista lo reflejan; parcial deja lo demás igual", async () => {
    const rol = await crearOk(b, D(), { nombre: nombreUnico("Edit"), alcance: "asignado", permisos: ["clientes.ver", "buzon.ver"] });
    const antes = await filaRol(b, rol.id);
    const nuevoNombre = nombreUnico("Editado");
    const r = await editar(b, D(), rol.id, { nombre: nuevoNombre, alcance: "global", permisos: ["clientes.ver", "clientes.crear"] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ id: rol.id, nombre: nuevoNombre, alcance: "global" });
    expect(ordenados(r.body.permisos)).toEqual(["clientes.crear", "clientes.ver"]);
    expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.crear", "clientes.ver"]);
    const despues = await filaRol(b, rol.id);
    expect(despues).toMatchObject({ nombre: nuevoNombre, alcance: "global" });
    expect(new Date(despues!.actualizado_en).getTime()).toBeGreaterThanOrEqual(new Date(antes!.actualizado_en).getTime());

    const soloNombre = await editar(b, D(), rol.id, { nombre: nombreUnico("Otro") });
    expect(soloNombre.status, soloNombre.text).toBe(200);
    expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.crear", "clientes.ver"]);
    expect((await filaRol(b, rol.id))?.alcance).toBe("global");
    const soloAlcance = await editar(b, D(), rol.id, { alcance: "asignado" });
    expect(soloAlcance.status, soloAlcance.text).toBe(200);
    expect((await filaRol(b, rol.id))?.alcance).toBe("asignado");
    const soloPermisos = await editar(b, D(), rol.id, { permisos: [] });
    expect(soloPermisos.status, soloPermisos.text).toBe(200);
    expect(await permisosEnBd(b, rol.id)).toEqual([]);
  });

  it("renombrar a su propio nombre (otras mayúsculas) vale; a uno ya usado, 409 nombre_duplicado; a uno de sistema, 409", async () => {
    const base = nombreUnico("Uno");
    const a = await crearOk(b, D(), { nombre: base, permisos: [] });
    const c = await crearOk(b, D(), { nombre: nombreUnico("Dos"), permisos: [] });
    expect((await editar(b, D(), a.id, { nombre: base.toUpperCase() })).status).toBe(200);
    for (const nombre of [c.nombre, c.nombre.toLowerCase(), "Dueño", "lectura"]) {
      const r = await editar(b, D(), a.id, { nombre });
      expect(r.status, nombre).toBe(409);
      expect(r.body).toEqual({ codigo: "nombre_duplicado" });
    }
    expect((await filaRol(b, a.id))?.nombre).toBe(base.toUpperCase());
  });

  it("cuerpos mal formados y vacíos no cambian nada", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"] });
    for (const cuerpo of [{ nombre: "" }, { nombre: "x".repeat(41) }, { alcance: "otro" }, { permisos: "clientes.ver" }, { permisos: [null] }, { nombre: "a\nb" }]) {
      const r = await editar(b, D(), rol.id, cuerpo);
      expect([400, 422], JSON.stringify(cuerpo)).toContain(r.status);
    }
    expect((await filaRol(b, rol.id))?.nombre).toBe(rol.nombre);
    expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.ver"]);
  });

  it("404 para un id inexistente, mal formado, de sistema o de otro estudio, sin tocar nada", async () => {
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: ["clientes.ver"] });
    for (const id of [uuidInexistente(), "no-es-uuid", "dueno", "admin", "lectura", ajeno.id]) {
      const r = await editar(b, D(), id, { nombre: nombreUnico("X") });
      expect(r.status, id).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect((await filaRol(b, ajeno.id))?.nombre).toBe(ajeno.nombre);
  });
});

describe("DELETE /roles/:id · eliminar", () => {
  estudioNuevo();
  it("un rol sin uso: 204; desaparece de BD (con sus permisos) y de la lista; una segunda vez da 404", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver", "buzon.ver"] });
    const r = await eliminar(b, D(), rol.id);
    expect(r.status, r.text).toBe(204);
    expect(r.text).toBe("");
    expect(await filaRol(b, rol.id)).toBeUndefined();
    expect(await permisosEnBd(b, rol.id)).toEqual([]);
    expect(propiosDe(await listar(b, D())).map((x) => x.id)).not.toContain(rol.id);
    expect((await eliminar(b, D(), rol.id)).status).toBe(404);
  });

  it("404 para inexistente, mal formado, de sistema o de otro estudio; el ajeno sigue vivo", async () => {
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: [] });
    for (const id of [uuidInexistente(), "no-es-uuid", "dueno", "lectura", ajeno.id]) {
      const r = await eliminar(b, D(), id);
      expect(r.status, id).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await filaRol(b, ajeno.id)).toBeDefined();
  });
});

describe("U9 · máximo 20 roles propios por estudio, en cualquier plan", () => {
  estudioNuevo();
  it("el 21.º da 409 limite_roles; eliminar uno libera el cupo; el límite no mira a otros estudios", async () => {
    const L = await b.estudio();
    const ids: string[] = [];
    for (let i = 0; i < LIMITE_ROLES; i++) ids.push((await crearOk(b, L.titular, { nombre: `Rol ${i}`, permisos: [] })).id);
    const tope = await crear(b, L.titular, { nombre: "Rol de más", permisos: [] });
    expect(tope.status, tope.text).toBe(409);
    expect(tope.body).toEqual({ codigo: "limite_roles" });
    expect(await cuentaRoles(b, L.tenantId)).toBe(LIMITE_ROLES);
    // Con el cupo lleno, un nombre repetido sigue siendo nombre_duplicado o limite_roles, nunca 201.
    expect((await crear(b, L.titular, { nombre: "rol 0", permisos: [] })).status).toBe(409);
    expect((await eliminar(b, L.titular, ids[0]!)).status).toBe(204);
    expect((await crear(b, L.titular, { nombre: "Rol nuevo", permisos: [] })).status).toBe(201);
    expect((await crear(b, D(), { permisos: [] })).status).toBe(201); // el estudio E no cuenta los de L
  });
});

describe("CA-3 · la tabla 5 roles x endpoints de /roles (Dueño y Administrador pasan; el resto, 403 permiso_denegado)", () => {
  interface Caso {
    nombre: string;
    permitidos: RolSistema[];
    pedir: (rolId: string) => { metodo: "GET" | "POST" | "PATCH" | "DELETE"; ruta: string; cuerpo?: unknown };
  }
  const GESTORES: RolSistema[] = ["dueno", "admin"];
  beforeAll(async () => {
    E = await b.estudio();
    actores.dueno = E.titular;
    for (const rol of ROLES) if (rol !== "dueno") actores[rol] = await b.miembro(E.tenantId, rol);
  });
  const CASOS: Caso[] = [
    { nombre: "GET /roles", permitidos: GESTORES, pedir: () => ({ metodo: "GET", ruta: "/roles" }) },
    { nombre: "POST /roles", permitidos: GESTORES, pedir: () => ({ metodo: "POST", ruta: "/roles", cuerpo: { nombre: nombreUnico("M"), alcance: "asignado", permisos: [] } }) },
    { nombre: "POST /roles/:id/impacto", permitidos: GESTORES, pedir: (id) => ({ metodo: "POST", ruta: `/roles/${id}/impacto`, cuerpo: { permisos: [] } }) },
    { nombre: "PATCH /roles/:id", permitidos: GESTORES, pedir: (id) => ({ metodo: "PATCH", ruta: `/roles/${id}`, cuerpo: { nombre: nombreUnico("P") } }) },
    { nombre: "DELETE /roles/:id", permitidos: GESTORES, pedir: (id) => ({ metodo: "DELETE", ruta: `/roles/${id}` }) },
    { nombre: "GET /roles/asignables", permitidos: GESTORES, pedir: () => ({ metodo: "GET", ruta: "/roles/asignables" }) },
  ];
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const observado: Record<string, number | "2xx"> = {};
    const esperado: Record<string, number | "2xx"> = {};
    for (const rol of ROLES) {
      const propio = await crearOk(b, D(), { permisos: [] }); // uno por rol, para que PATCH/DELETE tengan objetivo
      const p = caso.pedir(propio.id);
      const r = await b.llamar(actores[rol], p.metodo, p.ruta, p.cuerpo);
      observado[rol] = clase(r);
      esperado[rol] = caso.permitidos.includes(rol) ? "2xx" : 403;
      if (!caso.permitidos.includes(rol)) expect(r.body, `${rol}`).toEqual({ codigo: "permiso_denegado" });
      await eliminar(b, D(), propio.id);
    }
    expect(observado).toEqual(esperado);
  });

  it("sin sesión 401, sin CSRF 403 csrf_invalido y con Origin ajeno 403 origen_invalido (004); nada se crea", async () => {
    const antes = await cuentaRoles(b, E.tenantId);
    const cuerpo = { nombre: nombreUnico("Csrf"), alcance: "asignado", permisos: [] };
    expect((await b.h.pedir({ ruta: "/roles" })).status).toBe(401);
    expect((await b.h.pedir({ metodo: "POST", ruta: "/roles", cuerpo })).status).toBe(401);
    const sinCsrf = await b.h.pedir({ metodo: "POST", ruta: "/roles", cuerpo, cookie: D().cookie, estudio: E.tenantId });
    expect(sinCsrf.body).toEqual({ codigo: "csrf_invalido" });
    const origen = await b.llamar(D(), "POST", "/roles", cuerpo, { origen: "https://evil.example" });
    expect(origen.body).toEqual({ codigo: "origen_invalido" });
    expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
  });

  it("los roles de sistema no se pueden tocar por ninguna ruta de /roles (CA-3)", async () => {
    expect((await listar(b, D())).status).toBe(200); // la ruta existe: el 404 de abajo es «rol de sistema», no «ruta ausente»
    for (const id of ["dueno", "admin", "contador", "asistente", "lectura"]) {
      expect((await editar(b, D(), id, { permisos: ["plan.gestionar"] })).status).toBe(404);
      expect((await eliminar(b, D(), id)).status).toBe(404);
      expect((await impacto(b, D(), id, {})).status).toBe(404);
    }
    const yo = await b.llamar(actores.asistente, "GET", "/acceso/yo");
    expect(yo.body.permisos).toHaveLength(8);
  });

  it("asignables: Dueño y Administrador 200; Contador, Asistente y Lectura 403", async () => {
    for (const rol of ROLES) {
      const r = await asignables(b, actores[rol]);
      expect(r.status, rol).toBe(GESTORES.includes(rol) ? 200 : 403);
    }
  });
});
