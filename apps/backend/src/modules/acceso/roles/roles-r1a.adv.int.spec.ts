/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T11 (030) · Ronda adversarial 1a, caja negra por HTTP (CA-12). Solo usa spec.md, plan.md#contratos y la interfaz HTTP.
// Ataques que las suites de T3 no cubren: alcance por la asignación masiva, `baseRolId` con más permisos, vista previa de impacto fuera de
// contención, permisos con nombres de `Object.prototype` o duplicados, nombres de sistema en NFD o con espacios, invisibles, 404 idénticos
// entre rutas, carreras de reactivar y reenviar contra eliminar (0084), invitaciones muertas de un rol eliminado, reenviar fuera de
// contención, U8 en `/acceso/yo` y rutas de roles, CSRF/Origen en las rutas de escritura restantes, canarios de secretos y U10.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import {
  asignar,
  cerrar,
  crear,
  crearOk,
  cuentaRoles,
  editar,
  eliminar,
  filaRol,
  huerfanos,
  impacto,
  invitar,
  membresiaDe,
  miembroConRol,
  nombreUnico,
  permisosEnBd,
  type RolCreado,
} from "../../../../test/soporte-roles.js";
import { PWD } from "../../../../test/soporte.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const EXIGIDO = { codigo: "segundo_factor_requerido" };

let b: Banco;
let E: Estudio;
let D: Actor;
// Gestor de roles y de usuarios con rol propio global, sin credenciales.editar ni clientes.editar.
const PERMISOS_G = cerrar(["roles.gestionar", "usuarios.gestionar", "clientes.crear"]);
let G: RolCreado;
let gestor: Actor;
// Un rol con más que el gestor.
let H: RolCreado;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  D = E.titular;
  G = await crearOk(b, D, { nombre: nombreUnico("Gestor"), permisos: PERMISOS_G, alcance: "global" });
  gestor = await miembroConRol(b, D, G.id);
  H = await crearOk(b, D, { nombre: nombreUnico("Mayor"), permisos: cerrar(["credenciales.editar", "clientes.editar"]), alcance: "global" });
});
afterAll(async () => {
  await b?.cerrar();
});

const no5xx = (r: { status: number; text: string }, etiqueta: string): void => {
  expect(r.status, `${etiqueta}: ${r.text}`).toBeLessThan(500);
};
const asignacionesDe = async (clienteId: string, usuarioId: string): Promise<number> =>
  Number((await b.sql("select count(*)::int as n from asignacion where cliente_id = $1 and usuario_id = $2", [clienteId, usuarioId]))[0].n);

describe("alcance: un rol propio asignado con clientes.asignar no se abre clientes ajenos", () => {
  it("PUT individual, por-usuario y por-cliente sobre un cliente no asignado: nunca 2xx ni fila nueva (U4, HU-08)", async () => {
    const rol = await crearOk(b, D, { permisos: cerrar(["clientes.asignar"]), alcance: "asignado" });
    const M = await miembroConRol(b, D, rol.id);
    const [c1, c2] = await b.clientes(E.tenantId, 2);
    await b.asignar(E.tenantId, c1!, M.id, "colaborador");
    // Control: sobre su propio cliente la masiva sí responde (si no, el resto no probaría nada).
    const otro = await b.miembro(E.tenantId, "lectura", { sesion: false });
    const ctrl = await b.llamar(M, "POST", "/asignaciones/por-cliente", { clienteId: c1, usuarioIds: [otro.id] });
    expect(ctrl.status, ctrl.text).toBe(200);

    const intentos = [
      await b.llamar(M, "PUT", `/clientes/${c2}/asignaciones/${M.id}`, { tipo: "colaborador" }),
      await b.llamar(M, "POST", "/asignaciones/por-usuario", { usuarioId: M.id, clienteIds: [c2], tipo: "colaborador" }),
      await b.llamar(M, "POST", "/asignaciones/por-cliente", { clienteId: c2, usuarioIds: [M.id] }),
      await b.llamar(M, "POST", "/asignaciones/por-cliente", { clienteId: c2, usuarioIds: [otro.id] }),
    ];
    const abiertos = ["PUT individual", "por-usuario a sí mismo", "por-cliente a sí mismo", "por-cliente a otro"].filter((_, i) => intentos[i]!.status < 400);
    expect(abiertos, "rutas que asignaron sobre un cliente fuera de su alcance").toEqual([]);
    expect(await asignacionesDe(c2!, M.id)).toBe(0);
    expect(await asignacionesDe(c2!, otro.id)).toBe(0);
    expect((await b.llamar(M, "GET", `/clientes/${c2}`)).status).toBe(404);
  });
});

describe("escalada por baseRolId y por la vista previa", () => {
  it("baseRolId de un rol con más permisos no hereda nada: nunca queda un rol con permisos que el gestor no tiene", async () => {
    const intentos = [
      { nombre: nombreUnico("Base1"), alcance: "asignado", baseRolId: H.id },
      { nombre: nombreUnico("Base2"), alcance: "asignado", baseRolId: H.id, permisos: ["clientes.ver"] },
      { nombre: nombreUnico("Base3"), alcance: "asignado", baseRolId: H.id, permisos: [] },
    ];
    for (const cuerpo of intentos) {
      const r = await b.llamar(gestor, "POST", "/roles", cuerpo);
      no5xx(r, JSON.stringify(cuerpo));
      if (r.status === 201) {
        const enBd = await permisosEnBd(b, r.body.id);
        expect(enBd.every((p) => PERMISOS_G.includes(p as any)), `heredó ${enBd.join(",")}`).toBe(true);
        expect(enBd).toEqual([...((cuerpo as any).permisos ?? [])].sort());
      }
    }
  });

  it("POST /roles/:id/impacto: un rol fuera de contención o el propio del actor da 403 sin conteos (U2)", async () => {
    const M = await miembroConRol(b, D, H.id);
    expect(M.id).toBeTruthy();
    const ajeno = await impacto(b, gestor, H.id, { permisos: ["clientes.ver"] });
    expect(ajeno.status, ajeno.text).toBe(403);
    expect(ajeno.text).not.toMatch(/miembros|clientesSinResponsable/);
    const propio = await impacto(b, gestor, G.id, { permisos: cerrar(["usuarios.gestionar"]) });
    expect(propio.status, propio.text).toBe(403);
  });
});

describe("cuerpos de /roles: catálogo cerrado (CA-2) y sin 5xx", () => {
  it("plan.gestionar disfrazado, claves de Object.prototype y tipos raros: 400/422 y no se crea nada; duplicados no dan 5xx", async () => {
    const antes = await cuentaRoles(b, E.tenantId);
    const malos: unknown[] = [
      ["PLAN.GESTIONAR"],
      ["plan.gestionar "],
      ["plan.gestionar\u0000"],
      ["toString"],
      ["constructor"],
      ["__proto__"],
      ["hasOwnProperty"],
      ["clientes.ver", "valueOf"],
      [["clientes.ver"]],
      [null],
      [1],
      "clientes.ver",
      { 0: "clientes.ver", length: 1 },
    ];
    for (const permisos of malos) {
      const r = await b.llamar(D, "POST", "/roles", { nombre: nombreUnico("Malo"), alcance: "asignado", permisos });
      expect([400, 422], `${JSON.stringify(permisos)}: ${r.text}`).toContain(r.status);
    }
    expect(await cuentaRoles(b, E.tenantId)).toBe(antes);

    const rol = await crearOk(b, D, { permisos: ["clientes.ver"] });
    const ed = await editar(b, D, rol.id, { permisos: ["clientes.ver", "toString"] });
    expect([400, 422], ed.text).toContain(ed.status);
    expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.ver"]);

    const dup = await crear(b, D, { permisos: ["clientes.ver", "clientes.ver", "clientes.crear", "clientes.crear"] });
    no5xx(dup, "duplicados");
    if (dup.status === 201) expect(await permisosEnBd(b, dup.body.id)).toEqual(["clientes.crear", "clientes.ver"]);
    const dupEd = await editar(b, D, rol.id, { permisos: ["clientes.ver", "clientes.ver"] });
    no5xx(dupEd, "duplicados al editar");
    const enorme = await crear(b, D, { permisos: Array.from({ length: 5000 }, () => "clientes.ver") });
    no5xx(enorme, "5000 permisos");
  });
});

describe("nombres (CA-1)", () => {
  it("NFC/NFD y espacios de borde son el mismo nombre (409); un nombre de sistema en NFD, con espacios o NBSP no se acepta (crear ni renombrar)", async () => {
    const base = `Práctica ${randomUUID().slice(0, 6)}`;
    await crearOk(b, D, { nombre: base, permisos: [] });
    for (const nombre of [base.normalize("NFD"), `${base} `, ` ${base}`]) {
      const r = await crear(b, D, { nombre, permisos: [] });
      expect(r.status, `${JSON.stringify(nombre)}: ${r.text}`).toBe(409);
      expect(r.body.codigo).toBe("nombre_duplicado");
    }
    const reservados = ["Duen\u0303o", " Dueño", "Dueño ", "DUEÑO", "Lectura\u00a0", " contador ", "Administrador\u00a0", "\u00a0Asistente"];
    const rol = await crearOk(b, D, { permisos: [] });
    const aceptados: string[] = [];
    for (const nombre of reservados) {
      const r = await crear(b, D, { nombre, permisos: [] });
      no5xx(r, JSON.stringify(nombre));
      if (r.status === 201) {
        aceptados.push(`crear ${JSON.stringify(nombre)}`);
        await eliminar(b, D, r.body.id);
      }
      const e = await editar(b, D, rol.id, { nombre });
      if (e.status === 200) aceptados.push(`renombrar ${JSON.stringify(nombre)}`);
    }
    expect(aceptados, "nombres que se confunden con un rol de sistema").toEqual([]);
  });

  it("controles, solo espacios e invisibles (incl. «Dueño» con un carácter de ancho cero) se rechazan", async () => {
    const antes = await cuentaRoles(b, E.tenantId);
    const aceptados: string[] = [];
    for (const nombre of ["Rol\u0000x", "Rol\u0007", "Rol\nX", "Rol\u007f", "Rol\u0085", "   ", "\u00a0", "\u200b", "Dueño\u200b", "\u202eoñeuD", "Rol\u2028X"]) {
      const r = await crear(b, D, { nombre, permisos: [] });
      no5xx(r, JSON.stringify(nombre));
      if (r.status === 201) {
        aceptados.push(JSON.stringify(nombre));
        await eliminar(b, D, r.body.id);
      }
    }
    expect(aceptados, "nombres invisibles o con controles aceptados").toEqual([]);
    expect(await cuentaRoles(b, E.tenantId)).toBe(antes);
  });
});

describe("ids ajenos (CA-9): la misma respuesta que un id inexistente en todas las rutas", () => {
  it("PATCH, DELETE, impacto, cambiar rol e invitar con un id de otro estudio responden igual que con uno inexistente; el ajeno no cambia", async () => {
    const otro = await b.estudio();
    const RX = await crearOk(b, otro.titular, { nombre: nombreUnico("Ajeno"), permisos: ["clientes.ver"] });
    const M = await b.miembro(E.tenantId, "lectura", { sesion: false });
    const forma = (r: { status: number; body: unknown }) => ({ status: r.status, body: r.body });
    const sondas = async (id: string) => [
      forma(await editar(b, D, id, { nombre: nombreUnico("X") })),
      forma(await eliminar(b, D, id)),
      forma(await impacto(b, D, id, {})),
      forma(await asignar(b, D, M.id, id)),
      forma(await invitar(b, D, b.correoNuevo(), id)),
      forma(await editar(b, gestor, id, { nombre: nombreUnico("X") })),
      forma(await asignar(b, gestor, M.id, id)),
    ];
    const ajeno = await sondas(RX.id);
    const inexistente = await sondas(randomUUID());
    expect(ajeno).toEqual(inexistente);
    for (const r of ajeno) expect(r.status).toBe(404);
    expect((await filaRol(b, RX.id))?.nombre).toBe(RX.nombre);
    expect((await membresiaDe(b, E.tenantId, M.id)).rol).toBe("lectura");
  });
});

describe("carreras con la eliminación (D4, CA-6, 0084)", () => {
  it("reactivar a un miembro desactivado del rol y eliminar el rol a la vez: sin 5xx, sin huérfanos, nunca activo con un rol borrado", async () => {
    const { tenantId: T, titular: D } = await b.estudio();
    for (let i = 0; i < 6; i++) {
      const rol = await crearOk(b, D, { permisos: ["clientes.ver"] });
      const M = await miembroConRol(b, D, rol.id);
      expect((await b.llamar(D, "POST", `/usuarios/${M.id}/desactivar`)).status).toBe(200);
      const [del, re] = await Promise.all([eliminar(b, D, rol.id), b.llamar(D, "POST", `/usuarios/${M.id}/reactivar`)]);
      no5xx(del, "eliminar");
      no5xx(re, "reactivar");
      expect(await huerfanos(b, T)).toBe(0);
      const m = await membresiaDe(b, T, M.id);
      if (del.status === 204) expect(m.rol_id).toBeNull();
      if (m.rol_id !== null) expect(await filaRol(b, rol.id)).toBeDefined();
      expect([del.status === 204, del.status === 409]).toContain(true);
    }
  });

  it("reenviar una invitación vencida del rol y eliminar el rol a la vez: sin 5xx ni huérfanos; una invitación revivida implica rol vivo", async () => {
    const { tenantId: T, titular: D } = await b.estudio();
    for (let i = 0; i < 6; i++) {
      const rol = await crearOk(b, D, { permisos: ["clientes.ver"] });
      const inv = await invitar(b, D, b.correoNuevo(), rol.id);
      expect(inv.status, inv.text).toBe(201);
      await b.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [inv.body.id]);
      const [del, re] = await Promise.all([eliminar(b, D, rol.id), b.llamar(D, "POST", `/invitaciones/${inv.body.id}/reenviar`)]);
      no5xx(del, "eliminar");
      no5xx(re, "reenviar");
      expect(await huerfanos(b, T)).toBe(0);
      if (re.status < 300) expect(del.status, "reenviar revivió la invitación pero el rol se eliminó").toBe(409);
    }
  });

  it("invitación revocada o vencida de un rol luego eliminado: reenviar 404, el token no vale y no nace ninguna membresía", async () => {
    const { tenantId: T, titular: D } = await b.estudio();
    for (const muerte of ["revocar", "vencer"] as const) {
      const rol = await crearOk(b, D, { permisos: ["clientes.ver"] });
      const correo = b.correoNuevo();
      const inv = await invitar(b, D, correo, rol.id);
      expect(inv.status).toBe(201);
      const token = await b.tokenDe(correo);
      if (muerte === "revocar") expect((await b.llamar(D, "POST", `/invitaciones/${inv.body.id}/revocar`)).status).toBe(204);
      else await b.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [inv.body.id]);
      expect((await eliminar(b, D, rol.id)).status).toBe(204);
      const re = await b.llamar(D, "POST", `/invitaciones/${inv.body.id}/reenviar`);
      expect(re.status, `${muerte}: ${re.text}`).toBe(404);
      const acepta = await b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Invitado", contrasena: PWD } });
      expect(acepta.status, `${muerte}: ${acepta.text}`).toBe(400);
      const n = Number((await b.sql("select count(*)::int n from membresia m join usuario u on u.id = m.usuario_id where u.email = $1", [correo]))[0].n);
      expect(n).toBe(0);
      expect(await huerfanos(b, T)).toBe(0);
    }
  });
});

describe("escalada al re-emitir invitaciones", () => {
  it("un gestor no reenvía (re-emite token) una invitación a un rol con más permisos que el suyo, vigente o vencida (U2)", async () => {
    const vigente = await invitar(b, D, b.correoNuevo(), H.id);
    const vencida = await invitar(b, D, b.correoNuevo(), H.id);
    expect(vigente.status).toBe(201);
    expect(vencida.status).toBe(201);
    await b.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [vencida.body.id]);
    const antes = (await b.sql("select vence_en from invitacion where id = $1", [vencida.body.id]))[0].vence_en;
    for (const id of [vigente.body.id, vencida.body.id]) {
      const r = await b.llamar(gestor, "POST", `/invitaciones/${id}/reenviar`);
      expect(r.status, r.text).toBe(403);
    }
    const despues = (await b.sql("select vence_en from invitacion where id = $1", [vencida.body.id]))[0].vence_en;
    expect(despues).toEqual(antes);
  });
});

describe("U8: un rol propio sensible sin factor no llega a nada del estudio", () => {
  it("sesión sin_factor con roles.gestionar: /acceso/yo, /roles, /roles/asignables, impacto, POST /roles y cambiar rol dan 403 segundo_factor_requerido", async () => {
    const S = await crearOk(b, D, { permisos: cerrar(["roles.gestionar", "usuarios.gestionar"]), alcance: "global" });
    const otro = await b.miembro(E.tenantId, "lectura", { sesion: false });
    const h = b.h as any;
    h.factorReal = true;
    let P: Actor;
    try {
      P = await b.miembro(E.tenantId, "lectura");
    } finally {
      h.factorReal = false;
    }
    expect((await asignar(b, D, P.id, S.id)).status).toBe(200);
    const rutas: Array<[any, string, unknown]> = [
      ["GET", "/acceso/yo", undefined],
      ["GET", "/roles", undefined],
      ["GET", "/roles/asignables", undefined],
      ["POST", `/roles/${S.id}/impacto`, "basura"],
      ["POST", "/roles", { nombre: 1 }],
      ["PATCH", `/usuarios/${otro.id}/rol`, { rol: { rolId: S.id } }],
      ["GET", "/usuarios", undefined],
      ["GET", "/invitaciones", undefined],
    ];
    for (const [m, ruta, cuerpo] of rutas) {
      const r = await b.llamar(P, m, ruta, cuerpo);
      expect(r.status, `${m} ${ruta}: ${r.text}`).toBe(403);
      expect(r.body, `${m} ${ruta}`).toEqual(EXIGIDO);
    }
    expect((await membresiaDe(b, E.tenantId, otro.id)).rol).toBe("lectura");
  });
});

describe("CSRF y Origen (004) en las escrituras de roles y en la asignación con rolId", () => {
  it("PATCH, DELETE e impacto de /roles/:id y PATCH /usuarios/:id/rol sin CSRF o con Origin ajeno: 403 y nada cambia", async () => {
    const rol = await crearOk(b, D, { permisos: ["clientes.ver"] });
    const M = await b.miembro(E.tenantId, "lectura", { sesion: false });
    const escrituras: Array<[any, string, unknown]> = [
      ["PATCH", `/roles/${rol.id}`, { nombre: nombreUnico("Csrf") }],
      ["DELETE", `/roles/${rol.id}`, undefined],
      ["POST", `/roles/${rol.id}/impacto`, {}],
      ["PATCH", `/usuarios/${M.id}/rol`, { rol: { rolId: rol.id } }],
    ];
    for (const [m, ruta, cuerpo] of escrituras) {
      const sin = await b.h.pedir({ metodo: m, ruta, cuerpo, cookie: D.cookie, estudio: E.tenantId });
      expect(sin.status, `sin CSRF ${m} ${ruta}`).toBe(403);
      const ajeno = await b.llamar(D, m, ruta, cuerpo, { origen: "https://evil.example" });
      expect(ajeno.status, `Origin ajeno ${m} ${ruta}`).toBe(403);
    }
    expect((await filaRol(b, rol.id))?.nombre).toBe(rol.nombre);
    expect((await membresiaDe(b, E.tenantId, M.id)).rol).toBe("lectura");
  });
});

describe("canarios: ninguna respuesta con roles propios expone secretos", () => {
  it("/roles, /roles/asignables, /acceso/yo, /usuarios, /invitaciones y las escrituras no llevan token, hash ni contraseña", async () => {
    const { titular: D } = await b.estudio();
    const rol = await crearOk(b, D, { permisos: cerrar(["usuarios.ver"]) });
    const M = await miembroConRol(b, D, rol.id);
    const correo = b.correoNuevo();
    const inv = await invitar(b, D, correo, rol.id);
    const token = await b.tokenDe(correo);
    const respuestas = [
      inv,
      await b.llamar(D, "GET", "/roles"),
      await b.llamar(D, "GET", "/roles/asignables"),
      await b.llamar(M, "GET", "/acceso/yo"),
      await b.llamar(D, "GET", "/usuarios"),
      await b.llamar(M, "GET", "/usuarios"),
      await b.llamar(D, "GET", "/invitaciones"),
      await impacto(b, D, rol.id, { permisos: cerrar(["credenciales.editar"]) }),
      await editar(b, D, rol.id, { nombre: nombreUnico("Canario") }),
      await b.llamar(D, "POST", `/invitaciones/${inv.body.id}/reenviar`),
    ];
    const nuevo = b.h.correo.tokenDe(correo);
    for (const r of respuestas) {
      expect(r.status, r.text).toBeLessThan(300);
      const texto = `${r.text}\n${JSON.stringify(r.headers)}`;
      expect(texto).not.toMatch(/token_?hash|contrasena|password|secreto|client_secret/i);
      expect(texto).not.toContain(token);
      expect(texto).not.toContain(nuevo);
      expect(texto).not.toContain(PWD);
    }
  });
});

describe("U10: los avisos siguen solo para Dueño y Administrador", () => {
  it("sin responsable, los destinatarios de un cliente son Dueño y Administrador, nunca un rol propio aunque tenga todos los permisos", async () => {
    const { tenantId: T, titular: D } = await b.estudio();
    const todo = await crearOk(b, D, { permisos: cerrar(["buzon.atender", "credenciales.editar", "clientes.asignar", "usuarios.gestionar", "roles.gestionar"]), alcance: "global" });
    const P = await miembroConRol(b, D, todo.id, { sesion: false });
    const A = await b.miembro(T, "admin", { sesion: false });
    const [c] = await b.clientes(T, 1);
    await b.asignar(T, c!, P.id, "colaborador");
    const f = await b.sql("select interno.destinatarios_cliente($1, $2) as u", [T, c]);
    const u: string[] = f[0].u;
    expect(u).toContain(D.id);
    expect(u).toContain(A.id);
    expect(u).not.toContain(P.id);
    const plan = await b.sql("select duenos from interno.uso_plan($1)", [T]);
    expect(plan[0].duenos).not.toContain(P.id);
  });
});
