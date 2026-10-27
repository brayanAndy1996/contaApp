/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T4 (005) · CA-1 (tabla 5 roles x endpoints), CA-4 (escalada D8) y CA-6 (rol cambiado con sesión viva).
// Rojo: los endpoints, los guards y la columna `desactivada_en` aún no existen (T7-T11).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBanco,
  clase,
  ROLES,
  type Actor,
  type Banco,
  type Estudio,
  type RolSistema,
} from "../../../test/soporte-acceso.js";

let b: Banco;
let E: Estudio;
const actores = {} as Record<RolSistema, Actor>;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  actores.dueno = E.titular;
  for (const rol of ROLES) if (rol !== "dueno") actores[rol] = await b.miembro(E.tenantId, rol);
});
afterAll(async () => {
  await b?.cerrar();
});

/* ---------------- CA-1 · matriz de roles ---------------- */
interface Ctx {
  /** Contador fresco sin sesión: objetivo de las acciones de gestión. */
  objetivo: Actor;
  /** Contador fresco ya desactivado (para reactivar). */
  desactivado: Actor;
  cliente: string;
  invitacionId: string;
}
interface Caso {
  nombre: string;
  /** Roles que deben recibir 2xx (el resto, 403 `permiso_denegado`), D2. */
  permitidos: RolSistema[];
  pedir: (c: Ctx) => { metodo: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; ruta: string; cuerpo?: unknown };
}
const TODOS: RolSistema[] = [...ROLES];
const GESTORES: RolSistema[] = ["dueno", "admin"];

const CASOS: Caso[] = [
  { nombre: "GET /acceso/yo", permitidos: TODOS, pedir: () => ({ metodo: "GET", ruta: "/acceso/yo" }) },
  { nombre: "GET /usuarios", permitidos: GESTORES, pedir: () => ({ metodo: "GET", ruta: "/usuarios" }) },
  {
    nombre: "PATCH /usuarios/:id/rol",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "PATCH", ruta: `/usuarios/${c.objetivo.id}/rol`, cuerpo: { rol: "asistente" } }),
  },
  {
    nombre: "POST /usuarios/:id/desactivar",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "POST", ruta: `/usuarios/${c.objetivo.id}/desactivar` }),
  },
  {
    nombre: "POST /usuarios/:id/reactivar",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "POST", ruta: `/usuarios/${c.desactivado.id}/reactivar` }),
  },
  { nombre: "GET /invitaciones", permitidos: GESTORES, pedir: () => ({ metodo: "GET", ruta: "/invitaciones" }) },
  {
    nombre: "POST /invitaciones",
    permitidos: GESTORES,
    pedir: () => ({
      metodo: "POST",
      ruta: "/invitaciones",
      cuerpo: { correo: b.correoNuevo(), rol: "lectura" },
    }),
  },
  {
    nombre: "POST /invitaciones/:id/reenviar",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "POST", ruta: `/invitaciones/${c.invitacionId}/reenviar` }),
  },
  {
    nombre: "POST /invitaciones/:id/revocar",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "POST", ruta: `/invitaciones/${c.invitacionId}/revocar` }),
  },
  { nombre: "GET /clientes", permitidos: TODOS, pedir: () => ({ metodo: "GET", ruta: "/clientes" }) },
  {
    nombre: "GET /clientes/:clienteId",
    permitidos: TODOS,
    pedir: (c) => ({ metodo: "GET", ruta: `/clientes/${c.cliente}` }),
  },
  {
    nombre: "GET /clientes/:clienteId/asignaciones",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "GET", ruta: `/clientes/${c.cliente}/asignaciones` }),
  },
  {
    nombre: "PUT /clientes/:clienteId/asignaciones/:usuarioId",
    permitidos: GESTORES,
    pedir: (c) => ({
      metodo: "PUT",
      ruta: `/clientes/${c.cliente}/asignaciones/${c.objetivo.id}`,
      cuerpo: { tipo: "colaborador" },
    }),
  },
  {
    nombre: "DELETE /clientes/:clienteId/asignaciones/:usuarioId",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "DELETE", ruta: `/clientes/${c.cliente}/asignaciones/${c.objetivo.id}` }),
  },
  {
    nombre: "POST /asignaciones/por-usuario",
    permitidos: GESTORES,
    pedir: (c) => ({
      metodo: "POST",
      ruta: "/asignaciones/por-usuario",
      cuerpo: { usuarioId: c.objetivo.id, clienteIds: [c.cliente], tipo: "colaborador" },
    }),
  },
  {
    nombre: "POST /asignaciones/por-cliente",
    permitidos: GESTORES,
    pedir: (c) => ({
      metodo: "POST",
      ruta: "/asignaciones/por-cliente",
      cuerpo: { clienteId: c.cliente, usuarioIds: [c.objetivo.id] },
    }),
  },
];

async function preparar(): Promise<Ctx> {
  const objetivo = await b.miembro(E.tenantId, "contador", { sesion: false });
  const desactivado = await b.miembro(E.tenantId, "contador", { sesion: false });
  await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [
    E.tenantId,
    desactivado.id,
  ]);
  const [cliente] = await b.clientes(E.tenantId, 1);
  // Los roles de alcance "asignado" necesitan ver el cliente para que el 2xx de lectura sea posible.
  for (const rol of ["contador", "asistente", "lectura"] as const) {
    await b.asignar(E.tenantId, cliente!, actores[rol].id, "colaborador");
  }
  // Pre-asignado el objetivo para que DELETE tenga algo que quitar.
  await b.asignar(E.tenantId, cliente!, objetivo.id, "colaborador");
  const inv = await b.llamar(E.titular, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "lectura" });
  return { objetivo, desactivado, cliente: cliente!, invitacionId: inv.body?.id };
}

describe("CA-1 · tabla 5 roles x endpoints de 005 (D2)", () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const observado: Record<string, number | "2xx"> = {};
    const esperado: Record<string, number | "2xx"> = {};
    for (const rol of ROLES) {
      const ctx = await preparar();
      const p = caso.pedir(ctx);
      const r = await b.llamar(actores[rol], p.metodo, p.ruta, p.cuerpo);
      observado[rol] = clase(r);
      esperado[rol] = caso.permitidos.includes(rol) ? "2xx" : 403;
      if (!caso.permitidos.includes(rol)) expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    expect(observado).toEqual(esperado);
  });

  it("GET /acceso/yo informa rol, permisos y alcance de cada rol (22 / 21 / 12 / 7 / 4)", async () => {
    const esperados: Record<RolSistema, { n: number; alcance: string }> = {
      dueno: { n: 22, alcance: "global" },
      admin: { n: 21, alcance: "global" },
      contador: { n: 12, alcance: "asignado" },
      asistente: { n: 7, alcance: "asignado" },
      lectura: { n: 4, alcance: "asignado" },
    };
    for (const rol of ROLES) {
      const r = await b.llamar(actores[rol], "GET", "/acceso/yo");
      expect(r.status).toBe(200);
      expect(r.body.rol).toBe(rol);
      expect(r.body.alcance).toBe(esperados[rol].alcance);
      expect(r.body.permisos).toHaveLength(esperados[rol].n);
      expect(Object.keys(r.body).sort()).toEqual(["alcance", "permisos", "rol"]);
    }
    const admin = await b.llamar(actores.admin, "GET", "/acceso/yo");
    expect(admin.body.permisos).not.toContain("plan.gestionar");
    const lectura = await b.llamar(actores.lectura, "GET", "/acceso/yo");
    expect([...lectura.body.permisos].sort()).toEqual(["buzon.ver", "clientes.ver", "prorrata.ver", "reglas.ver"]);
  });

  it("no existe endpoint que modifique los permisos de un rol de sistema", async () => {
    const intentos: [("PUT" | "PATCH" | "POST" | "DELETE"), string][] = [
      ["PUT", "/roles/asistente/permisos"],
      ["PATCH", "/roles/asistente"],
      ["POST", "/roles"],
      ["PUT", "/permisos"],
      ["POST", "/acceso/permisos"],
      ["PATCH", "/acceso/roles/asistente"],
      ["DELETE", "/roles/lectura"],
    ];
    for (const [m, ruta] of intentos) {
      const r = await b.llamar(actores.dueno, m, ruta, { permisos: ["plan.gestionar"] });
      expect([404, 403]).toContain(r.status);
      expect(r.status).not.toBeLessThan(400);
    }
    // Y los permisos del asistente no cambiaron.
    const yo = await b.llamar(actores.asistente, "GET", "/acceso/yo");
    expect(yo.body.permisos).toHaveLength(7);
  });
});

/* ---------------- CA-4 · escalada (D8) ---------------- */
describe("CA-4 · escalada de privilegios (D8)", () => {
  const rolEn = async (usuarioId: string) =>
    (await b.sql("select rol, tenant_id, desactivada_en from membresia where usuario_id = $1", [usuarioId]))[0];

  it("un Administrador no puede invitar, ascender, degradar ni desactivar a un Dueño (403)", async () => {
    const otroDueno = await b.miembro(E.tenantId, "dueno", { sesion: false });
    const contador = await b.miembro(E.tenantId, "contador", { sesion: false });
    const admin = actores.admin;

    const invitar = await b.llamar(admin, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "dueno" });
    expect(invitar.status).toBe(403);
    const ascender = await b.llamar(admin, "PATCH", `/usuarios/${contador.id}/rol`, { rol: "dueno" });
    expect(ascender.status).toBe(403);
    const degradar = await b.llamar(admin, "PATCH", `/usuarios/${otroDueno.id}/rol`, { rol: "lectura" });
    expect(degradar.status).toBe(403);
    const desactivar = await b.llamar(admin, "POST", `/usuarios/${otroDueno.id}/desactivar`);
    expect(desactivar.status).toBe(403);

    expect((await rolEn(otroDueno.id)).rol).toBe("dueno");
    expect((await rolEn(otroDueno.id)).desactivada_en).toBeNull();
    expect((await rolEn(contador.id)).rol).toBe("contador");
    const inv = await b.sql("select 1 from invitacion where tenant_id = $1 and rol = 'dueno'", [E.tenantId]);
    expect(inv).toHaveLength(0);
  });

  it("un Administrador no reenvía ni revoca una invitación de rol dueno", async () => {
    const creada = await b.llamar(actores.dueno, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "dueno" });
    expect(creada.status).toBe(201);
    const id = creada.body.id;
    expect((await b.llamar(actores.admin, "POST", `/invitaciones/${id}/reenviar`)).status).toBe(403);
    expect((await b.llamar(actores.admin, "POST", `/invitaciones/${id}/revocar`)).status).toBe(403);
    const fila = (await b.sql("select revocada_en from invitacion where id = $1", [id]))[0];
    expect(fila.revocada_en).toBeNull();
    // El Dueño sí puede.
    expect((await b.llamar(actores.dueno, "POST", `/invitaciones/${id}/revocar`)).status).toBe(204);
  });

  it("el Dueño sí invita a otro Dueño, asciende y degrada; el Administrador gestiona roles que no superan el suyo", async () => {
    const invDueno = await b.llamar(actores.dueno, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "dueno" });
    expect(invDueno.status).toBe(201);
    const c1 = await b.miembro(E.tenantId, "contador", { sesion: false });
    expect((await b.llamar(actores.dueno, "PATCH", `/usuarios/${c1.id}/rol`, { rol: "admin" })).status).toBe(200);
    expect((await rolEn(c1.id)).rol).toBe("admin");
    const invAdmin = await b.llamar(actores.admin, "POST", "/invitaciones", { correo: b.correoNuevo(), rol: "admin" });
    expect(invAdmin.status).toBe(201);
    const c2 = await b.miembro(E.tenantId, "contador", { sesion: false });
    expect((await b.llamar(actores.admin, "PATCH", `/usuarios/${c2.id}/rol`, { rol: "lectura" })).status).toBe(200);
    expect((await rolEn(c2.id)).rol).toBe("lectura");
  });

  it("nadie cambia su propio rol ni se desactiva (ni el Dueño ni el Administrador)", async () => {
    const [d1, a1] = [await b.miembro(E.tenantId, "dueno"), await b.miembro(E.tenantId, "admin")];
    for (const yo of [d1, a1]) {
      const nuevo = yo.rol === "dueno" ? "admin" : "dueno";
      expect((await b.llamar(yo, "PATCH", `/usuarios/${yo.id}/rol`, { rol: nuevo })).status).toBe(403);
      expect((await b.llamar(yo, "PATCH", `/usuarios/${yo.id}/rol`, { rol: yo.rol })).status).toBe(403);
      expect((await b.llamar(yo, "POST", `/usuarios/${yo.id}/desactivar`)).status).toBe(403);
      const fila = await rolEn(yo.id);
      expect(fila.rol).toBe(yo.rol);
      expect(fila.desactivada_en).toBeNull();
    }
  });

  it("el rol y el tenantId del cuerpo se ignoran donde no corresponden; un rol fuera del catálogo da 400", async () => {
    const otro = await b.estudio();
    const objetivo = await b.miembro(E.tenantId, "contador", { sesion: false });
    // PATCH: solo cuenta `rol`; `tenantId`, `usuarioId` y `desactivadaEn` sobran.
    const r = await b.llamar(actores.dueno, "PATCH", `/usuarios/${objetivo.id}/rol`, {
      rol: "asistente",
      tenantId: otro.tenantId,
      usuarioId: otro.titular.id,
      desactivadaEn: "2020-01-01T00:00:00Z",
    });
    expect(r.status).toBe(200);
    const fila = await rolEn(objetivo.id);
    expect(fila).toMatchObject({ rol: "asistente", tenant_id: E.tenantId, desactivada_en: null });
    expect((await rolEn(otro.titular.id)).rol).toBe("dueno");
    // Invitar: `tenantId`, `invitadoPor` y `tokenHash` del cuerpo no mandan.
    const correo = b.correoNuevo();
    const i = await b.llamar(actores.dueno, "POST", "/invitaciones", {
      correo,
      rol: "lectura",
      tenantId: otro.tenantId,
      invitadoPor: otro.titular.id,
      tokenHash: "00".repeat(32),
    });
    expect(i.status).toBe(201);
    const inv = (await b.sql("select tenant_id, invitado_por, encode(token_hash, 'hex') as h from invitacion where correo = $1", [correo]))[0];
    expect(inv.tenant_id).toBe(E.tenantId);
    expect(inv.invitado_por).toBe(actores.dueno.id);
    expect(inv.h).not.toBe("00".repeat(32));
    // Roles fuera del catálogo.
    for (const rol of ["superadmin", "DUENO", "dueño", "", 7, null]) {
      const x = await b.llamar(actores.dueno, "PATCH", `/usuarios/${objetivo.id}/rol`, { rol });
      expect(x.status).toBe(400);
      const y = await b.llamar(actores.dueno, "POST", "/invitaciones", { correo: b.correoNuevo(), rol });
      expect(y.status).toBe(400);
    }
    expect((await rolEn(objetivo.id)).rol).toBe("asistente");
  });

  it("gestionar a un miembro de otro estudio da 404 y no toca nada", async () => {
    const otro = await b.estudio();
    const ajeno = await b.miembro(otro.tenantId, "contador", { sesion: false });
    for (const [m, ruta, cuerpo] of [
      ["PATCH", `/usuarios/${ajeno.id}/rol`, { rol: "lectura" }],
      ["POST", `/usuarios/${ajeno.id}/desactivar`, {}],
      ["POST", `/usuarios/${ajeno.id}/reactivar`, {}],
    ] as const) {
      const r = await b.llamar(actores.dueno, m, ruta, cuerpo);
      expect(r.status).toBe(404);
    }
    const fila = await rolEn(ajeno.id);
    expect(fila).toMatchObject({ rol: "contador", tenant_id: otro.tenantId, desactivada_en: null });
  });
});

/* ---------------- CA-6 · el rol cambia con la sesión viva (D3) ---------------- */
describe("CA-6 · rol cambiado durante la sesión", () => {
  it("al degradar a un Administrador, su siguiente petición ya recibe 403 sin volver a iniciar sesión", async () => {
    const admin = await b.miembro(E.tenantId, "admin");
    expect((await b.llamar(admin, "GET", "/usuarios")).status).toBe(200);
    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${admin.id}/rol`, { rol: "lectura" })).status).toBe(200);
    const despues = await b.llamar(admin, "GET", "/usuarios");
    expect(despues.status).toBe(403);
    expect(despues.body).toEqual({ codigo: "permiso_denegado" });
    const yo = await b.llamar(admin, "GET", "/acceso/yo");
    expect(yo.body.rol).toBe("lectura");
    expect(yo.body.alcance).toBe("asignado");
  });

  it("al ascender a un Contador a Administrador, su siguiente petición ya ve todos los clientes", async () => {
    const contador = await b.miembro(E.tenantId, "contador");
    const [c] = await b.clientes(E.tenantId, 1);
    const antes = await b.llamar(contador, "GET", "/clientes");
    expect(antes.body.map((x: any) => x.id)).not.toContain(c);
    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${contador.id}/rol`, { rol: "admin" })).status).toBe(200);
    const despues = await b.llamar(contador, "GET", "/clientes");
    expect(despues.status).toBe(200);
    expect(despues.body.map((x: any) => x.id)).toContain(c);
  });
});
