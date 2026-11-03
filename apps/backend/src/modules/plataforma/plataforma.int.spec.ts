/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T3 (006) · CA-1 (planes y suscripción por el super-admin, D5, D13), CA-7 (bajar de plan por la API), CA-2 (el
// cambio vale sin reiniciar) y CA-8 (aislamiento). Contrato de errores de plan.md ("Ratificaciones"): 409
// `plan_inactivo`, 409 `codigo_existente`, 400 por extra sobre el tope, 404 `no_encontrado` (estudio o plan
// inexistente, o estudio sin suscripción: no se crea). Rojo: rutas /plataforma/*, `admin_plataforma` y las funciones
// `auth.plan_*`/`auth.suscripcion_asignar` aún no existen (T5, T9).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forma } from "../../../test/soporte.js";
import { abrirBancoPlanes, type BancoPlanes, type SuperAdmin } from "../../../test/soporte-planes.js";
import { CupoRucsPlanes, CupoRucsError } from "../planes/cupo/cupo-rucs.js";

let p: BancoPlanes;
let admin: SuperAdmin;
beforeAll(async () => {
  p = await abrirBancoPlanes();
  admin = await p.superAdmin();
});
afterAll(async () => {
  await p?.cerrar();
});

const plat = (metodo: "GET" | "POST" | "PUT", ruta: string, cuerpo?: unknown, a: { cookie: string; csrf: string } = admin) =>
  p.como(a, metodo, ruta, cuerpo);
const codigoNuevo = () => `t3_api_${randomBytes(4).toString("hex")}`;
const cuerpoPlan = (o: Record<string, unknown> = {}) => ({
  codigo: codigoNuevo(),
  nombre: "Plan API T3",
  precioMensual: "120.00",
  precioAnual: "1200.00",
  maxRucs: 40,
  maxUsuarios: 6,
  precioRucExtra: "3.50",
  maxRucsExtra: 8,
  frecuenciaBuzonMin: 720,
  features: { reportes: true, nivel: 2 },
  activo: true,
  ...o,
});
const crearPlan = async (o: Record<string, unknown> = {}) => {
  const c = cuerpoPlan(o);
  const r = await plat("POST", "/plataforma/planes", c);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, id: r.body.id as string, r };
};
const filaPlan = async (id: string) => (await p.sql("select * from plan where id = $1", [id]))[0];
const planPorCodigo = (codigo: string) => p.sql("select * from plan where codigo = $1", [codigo]);
const sus = async (t: string) => (await p.sql("select * from suscripcion where tenant_id = $1", [t]))[0];
const asignar = (tenantId: string, planId: string, rucsExtraContratados = 0, extra: Record<string, unknown> = {}) =>
  plat("PUT", `/plataforma/estudios/${tenantId}/suscripcion`, { planId, rucsExtraContratados, ...extra });

const RUTAS: ReadonlyArray<readonly [string, "GET" | "POST" | "PUT", string, unknown]> = [
  ["yo", "GET", "/plataforma/yo", undefined],
  ["listar planes", "GET", "/plataforma/planes", undefined],
  ["crear plan", "POST", "/plataforma/planes", {}],
  ["editar plan", "PUT", `/plataforma/planes/${randomUUID()}`, {}],
  ["listar estudios", "GET", "/plataforma/estudios", undefined],
  ["asignar suscripción", "PUT", `/plataforma/estudios/${randomUUID()}/suscripcion`, {}],
];

describe("acceso · solo el super-admin entra (D5); la declaración no se esquiva", () => {
  it("GET /plataforma/yo: el admin recibe 200 { admin: true }, también sin pertenecer a ningún estudio", async () => {
    const r = await plat("GET", "/plataforma/yo");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ admin: true });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await p.sql("select 1 from membresia where usuario_id = $1", [admin.id])).toHaveLength(0);
  });

  it.each(RUTAS)("%s: un Dueño de estudio (con y sin X-Estudio) y un usuario sin estudio reciben el mismo 403 permiso_denegado", async (_n, metodo, ruta, cuerpo) => {
    const E = await p.estudio(await p.plan());
    const sinEstudio = await p.b.h.crearUsuario({ estudios: [] });
    const s = await p.b.h.entrar(sinEstudio);
    const rs = [
      await p.b.llamar(E.titular, metodo, ruta, cuerpo), // con X-Estudio propio
      await plat(metodo, ruta, cuerpo, E.titular), // sin X-Estudio
      await plat(metodo, ruta, cuerpo, s),
    ];
    for (const r of rs) {
      expect(r.status, `${metodo} ${ruta}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
      expect(r.text).not.toMatch(/precio|argon|plan_id/i);
    }
    expect(forma(rs[1]!)).toEqual(forma(rs[2]!));
  });

  it.each(RUTAS)("%s: sin sesión 401 y con CSRF/Origen ajeno no pasa", async (_n, metodo, ruta, cuerpo) => {
    const anon = await p.b.h.pedir({ metodo, ruta, cuerpo });
    expect(anon.status).toBe(401);
    if (metodo !== "GET") {
      const sinCsrf = await p.b.h.pedir({ metodo, ruta, cuerpo, cookie: admin.cookie });
      expect(sinCsrf.status).toBe(403);
      const origen = await p.como(admin, metodo, ruta, cuerpo, { origen: "https://evil.example" });
      expect(origen.status).toBe(403);
    }
  });

  it("el alta en admin_plataforma se revalida en cada llamada: sin alta, el mismo cookie recibe 403 (y con alta, 200)", async () => {
    const otro = await p.superAdmin();
    expect((await plat("GET", "/plataforma/yo", undefined, otro)).status).toBe(200);
    await p.sql("delete from admin_plataforma where usuario_id = $1", [otro.id]);
    for (const [, metodo, ruta, cuerpo] of RUTAS) {
      const r = await plat(metodo, ruta, cuerpo, otro);
      expect(r.status, `${metodo} ${ruta}`).toBe(403);
    }
    await p.sql("insert into admin_plataforma (usuario_id) values ($1)", [otro.id]);
    expect((await plat("GET", "/plataforma/yo", undefined, otro)).status).toBe(200);
  });

  it("cerrar sesión revoca el acceso: tras logout el cookie recibe 401", async () => {
    const otro = await p.superAdmin();
    expect((await plat("POST", "/auth/logout", undefined, otro)).status).toBe(204);
    expect((await plat("GET", "/plataforma/planes", undefined, otro)).status).toBe(401);
  });
});

describe("CA-1 · GET /plataforma/planes", () => {
  it("lista los 5 planes del seed con precios como cadena (todas las columnas de PlanDto) e incluye inactivos", async () => {
    const inactivo = await p.plan({ activo: false });
    const r = await plat("GET", "/plataforma/planes");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const codigos = r.body.map((x: any) => x.codigo);
    expect(codigos).toEqual(expect.arrayContaining(["prueba", "independiente", "estudio", "estudio_pro", "corporativo", inactivo.codigo]));
    const est = r.body.find((x: any) => x.codigo === "estudio");
    expect(Object.keys(est).sort()).toEqual(
      [
        "activo",
        "codigo",
        "features",
        "frecuenciaBuzonMin",
        "id",
        "maxRucs",
        "maxRucsExtra",
        "maxUsuarios",
        "nombre",
        "precioAnual",
        "precioMensual",
        "precioRucExtra",
      ].sort(),
    );
    expect(est).toMatchObject({ precioMensual: "249.00", precioAnual: "2490.00", maxRucs: 100, maxUsuarios: 5, precioRucExtra: "4.00", maxRucsExtra: 20, frecuenciaBuzonMin: 720, activo: true });
    const corp = r.body.find((x: any) => x.codigo === "corporativo");
    expect(corp).toMatchObject({ maxUsuarios: null, precioAnual: null, maxRucs: 600 });
    expect(r.body.find((x: any) => x.codigo === inactivo.codigo).activo).toBe(false);
    for (const x of r.body) {
      expect(typeof x.precioMensual).toBe("string");
      expect(typeof x.precioRucExtra).toBe("string");
    }
  });
});

describe("CA-1 · POST /plataforma/planes (crear)", () => {
  it("crea un plan válido: 201 PlanDto con precios decimales como cadena y lo guarda en BD", async () => {
    const { c, id, r } = await crearPlan();
    expect(r.body).toEqual({ id, ...c });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const f = await filaPlan(id);
    expect(f).toMatchObject({ codigo: c.codigo, max_rucs: 40, max_usuarios: 6, max_rucs_extra: 8, frecuencia_buzon_min: 720, activo: true });
    expect(f.precio_mensual).toBe("120.00");
    expect(f.precio_anual).toBe("1200.00");
    expect(f.features).toEqual({ reportes: true, nivel: 2 });
  });

  it("acepta los bordes: maxUsuarios null (ilimitado), precioAnual null, tope extra = 20 % exacto, activo omitido = true", async () => {
    const c: any = cuerpoPlan({ maxUsuarios: null, precioAnual: null, maxRucs: 10, maxRucsExtra: 2, features: {} });
    delete c.activo;
    const r = await plat("POST", "/plataforma/planes", c);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ maxUsuarios: null, precioAnual: null, maxRucsExtra: 2, activo: true });
  });

  it.each([
    ["precio mensual negativo", { precioMensual: "-1" }],
    ["precio mensual no numérico", { precioMensual: "abc" }],
    ["precio mensual como número (nunca number para dinero)", { precioMensual: 120.5 }],
    ["precio con 3 decimales", { precioMensual: "1.234" }],
    ["precio anual negativo", { precioAnual: "-5.00" }],
    ["precio de RUC extra negativo", { precioRucExtra: "-0.50" }],
    ["max_rucs 0", { maxRucs: 0, maxRucsExtra: 0 }],
    ["max_rucs negativo", { maxRucs: -5, maxRucsExtra: 0 }],
    ["max_rucs fraccionario", { maxRucs: 10.5 }],
    ["max_usuarios 0", { maxUsuarios: 0 }],
    ["max_usuarios negativo", { maxUsuarios: -1 }],
    ["max_rucs_extra negativo", { maxRucsExtra: -1 }],
    ["tope extra sobre el 20 % de max_rucs", { maxRucs: 40, maxRucsExtra: 9 }],
    ["frecuencia de buzón 0", { frecuenciaBuzonMin: 0 }],
    ["features que no es un objeto", { features: "texto" }],
    ["features nulo", { features: null }],
    ["features de más de 4 kB", { features: { relleno: "x".repeat(5000) } }],
    ["código vacío", { codigo: "" }],
    ["código de 201 caracteres", { codigo: "c".repeat(201) }],
    ["nombre vacío", { nombre: "" }],
    ["activo no booleano", { activo: "si" }],
  ])("valor inválido (%s) -> 400 y no se crea el plan", async (_n, cambios) => {
    const c = cuerpoPlan(cambios);
    const antes = Number((await p.sql("select count(*)::int n from plan"))[0].n);
    const r = await plat("POST", "/plataforma/planes", c);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(Number((await p.sql("select count(*)::int n from plan"))[0].n)).toBe(antes);
  });

  it("código ya usado: 409 codigo_existente y el plan existente queda intacto", async () => {
    const antes = (await planPorCodigo("prueba"))[0];
    const r = await plat("POST", "/plataforma/planes", cuerpoPlan({ codigo: "prueba", nombre: "Sustituto" }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "codigo_existente" });
    expect((await planPorCodigo("prueba"))[0]).toEqual(antes);
  });

  it("ignora `id`, `tenantId` y `planId` del cuerpo: el id lo genera el servidor y ninguna suscripción cambia", async () => {
    const E = await p.estudio(await p.plan());
    const antes = await sus(E.tenantId);
    const idFalso = randomUUID();
    const c = cuerpoPlan({ id: idFalso, tenantId: E.tenantId, planId: idFalso });
    const r = await plat("POST", "/plataforma/planes", c);
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(idFalso);
    expect(await sus(E.tenantId)).toEqual(antes);
  });
});

describe("CA-1 · PUT /plataforma/planes/:planId (reemplazo completo)", () => {
  it("reemplaza todos los campos (incluye código y activo) y devuelve el PlanDto", async () => {
    const { id } = await crearPlan();
    const nuevo = cuerpoPlan({ nombre: "Renombrado", precioMensual: "99.90", precioAnual: null, maxRucs: 100, maxUsuarios: null, maxRucsExtra: 20, frecuenciaBuzonMin: 60, features: { a: 1 }, activo: false });
    const r = await plat("PUT", `/plataforma/planes/${id}`, nuevo);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id, ...nuevo, precioMensual: "99.90" });
    const f = await filaPlan(id);
    expect(f).toMatchObject({ codigo: nuevo.codigo, nombre: "Renombrado", max_rucs: 100, max_usuarios: null, activo: false });
  });

  it("valores inválidos -> 400 y el plan queda intacto", async () => {
    const { c, id } = await crearPlan();
    const antes = await filaPlan(id);
    for (const cambios of [{ maxRucs: 0, maxRucsExtra: 0 }, { maxUsuarios: 0 }, { precioMensual: "-1" }, { maxRucsExtra: 9 }, { frecuenciaBuzonMin: 0 }, { activo: undefined }]) {
      const r = await plat("PUT", `/plataforma/planes/${id}`, { ...c, ...cambios });
      expect(r.status, JSON.stringify(cambios)).toBe(400);
    }
    expect(await filaPlan(id)).toEqual(antes);
  });

  it("código de otro plan: 409 codigo_existente; plan inexistente: 404 no_encontrado; id que no es UUID: 400 o 404", async () => {
    const { c, id } = await crearPlan();
    const otro = await crearPlan();
    const antes = await filaPlan(id);
    const dup = await plat("PUT", `/plataforma/planes/${id}`, { ...c, codigo: otro.c.codigo });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ codigo: "codigo_existente" });
    expect(await filaPlan(id)).toEqual(antes);
    const mismo = await plat("PUT", `/plataforma/planes/${id}`, c); // conservar el propio código es válido
    expect(mismo.status).toBe(200);

    const falta = await plat("PUT", `/plataforma/planes/${randomUUID()}`, cuerpoPlan());
    expect(falta.status).toBe(404);
    expect(falta.body).toEqual({ codigo: "no_encontrado" });
    expect([400, 404]).toContain((await plat("PUT", "/plataforma/planes/no-es-uuid", cuerpoPlan())).status);
  });

  it("un `tenantId` o `planId` en el cuerpo no mueve la suscripción de ningún estudio", async () => {
    const E = await p.estudio(await p.plan());
    const { c, id } = await crearPlan();
    const antes = await sus(E.tenantId);
    const r = await plat("PUT", `/plataforma/planes/${id}`, { ...c, tenantId: E.tenantId, planId: id });
    expect(r.status).toBe(200);
    expect(await sus(E.tenantId)).toEqual(antes);
  });

  it("desactivar: quien ya lo tiene lo conserva (GET /plan/uso sigue igual) y no se puede asignar a otros (409 plan_inactivo)", async () => {
    const { c, id } = await crearPlan();
    const E = await p.estudio({ id, codigo: c.codigo });
    const otro = await p.estudio(await p.plan());
    expect((await plat("PUT", `/plataforma/planes/${id}`, { ...c, activo: false })).status).toBe(200);

    const uso = await p.b.llamar(E.titular, "GET", "/plan/uso");
    expect(uso.status).toBe(200);
    expect(uso.body.plan.codigo).toBe(c.codigo);
    expect((await sus(E.tenantId)).plan_id).toBe(id);

    const antes = await sus(otro.tenantId);
    const r = await asignar(otro.tenantId, id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "plan_inactivo" });
    expect(await sus(otro.tenantId)).toEqual(antes);

    expect((await plat("PUT", `/plataforma/planes/${id}`, { ...c, activo: true })).status).toBe(200); // reactivar
    expect((await asignar(otro.tenantId, id)).status).toBe(200);
  });

  it("un usuario de estudio, ni siquiera el Dueño, no puede escribir en plan ni cambiar su plan (CA-1)", async () => {
    const plan = await p.plan();
    const E = await p.estudio(plan);
    const { id } = await crearPlan();
    const antesPlan = await filaPlan(plan.id);
    const antesSus = await sus(E.tenantId);
    const rs = [
      await p.b.llamar(E.titular, "POST", "/plataforma/planes", cuerpoPlan()),
      await p.b.llamar(E.titular, "PUT", `/plataforma/planes/${plan.id}`, cuerpoPlan({ maxRucs: 9999, maxRucsExtra: 0 })),
      await p.b.llamar(E.titular, "PUT", `/plataforma/estudios/${E.tenantId}/suscripcion`, { planId: id, rucsExtraContratados: 0 }),
    ];
    for (const r of rs) expect(r.status).toBe(403);
    expect(await filaPlan(plan.id)).toEqual(antesPlan);
    expect(await sus(E.tenantId)).toEqual(antesSus);
  });
});

describe("D13 · GET /plataforma/estudios", () => {
  it("lista id, nombre, plan {codigo, nombre} y estado, y nada más (sin precios, RUCs, usuarios ni hashes)", async () => {
    const plan = await p.plan();
    const E = await p.estudio(plan, { estado: "prueba" });
    const sinSus = await p.estudio(null);
    const r = await plat("GET", "/plataforma/estudios");
    expect(r.status).toBe(200);
    const mio = r.body.find((x: any) => x.id === E.tenantId);
    expect(mio).toEqual({
      id: E.tenantId,
      nombre: expect.any(String),
      plan: { codigo: plan.codigo, nombre: `Plan T3 ${plan.codigo}` },
      estado: "prueba",
    });
    for (const x of r.body) expect(Object.keys(x).sort()).toEqual(["estado", "id", "nombre", "plan"]);
    expect(r.text).not.toMatch(/precio|email|correo|argon|token/i);
    // un estudio existente sin suscripción no rompe el listado
    const f = r.body.find((x: any) => x.id === sinSus.tenantId);
    if (f) expect(f.plan === null || f.plan?.codigo == null).toBe(true);
  });
});

describe("CA-1 · PUT /plataforma/estudios/:tenantId/suscripcion", () => {
  it("asigna plan y RUCs adicionales: 200 {estudioId, plan, estado, rucsExtraContratados}; GET /plan/uso cambia sin reiniciar (CA-2)", async () => {
    const chico = await p.plan({ maxRucs: 10, maxUsuarios: 2, maxRucsExtra: 2 });
    const grande = await p.plan({ maxRucs: 50, maxUsuarios: 8, maxRucsExtra: 10 });
    const E = await p.estudio(chico);
    expect((await p.b.llamar(E.titular, "GET", "/plan/uso")).body).toMatchObject({ rucs: { limite: 10 }, usuarios: { limite: 2 } });

    const r = await asignar(E.tenantId, grande.id, 4);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      estudioId: E.tenantId,
      plan: { codigo: grande.codigo },
      rucsExtraContratados: 4,
    });
    expect(["prueba", "activa"]).toContain(r.body.estado);
    expect(await sus(E.tenantId)).toMatchObject({ plan_id: grande.id, rucs_extra_contratados: 4 });
    const uso = await p.b.llamar(E.titular, "GET", "/plan/uso");
    expect(uso.body).toMatchObject({ plan: { codigo: grande.codigo }, rucs: { limite: 54, extra: 4 }, usuarios: { limite: 8 } });
  });

  it("el tope de adicionales es el del plan nuevo: el borde entra y uno más da 400 sin cambios (D6, D10)", async () => {
    const p1 = await p.plan({ maxRucs: 100, maxRucsExtra: 20 });
    const p2 = await p.plan({ maxRucs: 10, maxRucsExtra: 2 });
    const E = await p.estudio(p1, { rucsExtra: 5 });
    const antes = await sus(E.tenantId);
    const r = await asignar(E.tenantId, p2.id, 3);
    expect(r.status).toBe(400);
    expect(await sus(E.tenantId)).toEqual(antes);
    expect((await asignar(E.tenantId, p2.id, 2)).status).toBe(200);
    expect((await sus(E.tenantId)).rucs_extra_contratados).toBe(2);
    expect((await asignar(E.tenantId, p2.id, 0)).status).toBe(200);
  });

  it.each([
    ["extra negativo", { rucsExtraContratados: -1 }],
    ["extra fraccionario", { rucsExtraContratados: 1.5 }],
    ["extra como cadena", { rucsExtraContratados: "2" }],
    ["falta el plan", { planId: undefined }],
    ["planId que no es UUID", { planId: "no-es-uuid" }],
  ])("%s -> 400 y la suscripción queda intacta", async (_n, cambios) => {
    const plan = await p.plan({ maxRucsExtra: 2 });
    const E = await p.estudio(plan, { rucsExtra: 1 });
    const antes = await sus(E.tenantId);
    const r = await plat("PUT", `/plataforma/estudios/${E.tenantId}/suscripcion`, { planId: plan.id, rucsExtraContratados: 1, ...cambios });
    expect(r.status).toBe(400);
    expect(await sus(E.tenantId)).toEqual(antes);
  });

  it("plan inactivo: 409 plan_inactivo; plan inexistente: 404 no_encontrado; estudio inexistente: 404 y no se crea ninguna suscripción", async () => {
    const plan = await p.plan();
    const inactivo = await p.plan({ activo: false });
    const E = await p.estudio(plan);
    const antes = await sus(E.tenantId);
    const a = await asignar(E.tenantId, inactivo.id);
    expect(a.status).toBe(409);
    expect(a.body).toEqual({ codigo: "plan_inactivo" });
    const b = await asignar(E.tenantId, randomUUID());
    expect(b.status).toBe(404);
    expect(b.body).toEqual({ codigo: "no_encontrado" });
    const fantasma = randomUUID();
    const c = await asignar(fantasma, plan.id);
    expect(c.status).toBe(404);
    expect(c.body).toEqual({ codigo: "no_encontrado" });
    expect(await p.sql("select 1 from suscripcion where tenant_id = $1", [fantasma])).toHaveLength(0);
    expect(await sus(E.tenantId)).toEqual(antes);
    expect([400, 404]).toContain((await plat("PUT", "/plataforma/estudios/no-es-uuid/suscripcion", { planId: plan.id, rucsExtraContratados: 0 })).status);
  });

  it("estudio existente SIN suscripción: 404 y no se crea la fila (solo el registro y el backfill la crean)", async () => {
    const plan = await p.plan();
    const E = await p.estudio(null);
    const r = await asignar(E.tenantId, plan.id, 0);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await p.sql("select 1 from suscripcion where tenant_id = $1", [E.tenantId])).toHaveLength(0);
  });

  it("solo cambia el estudio de la ruta: un `tenantId` en el cuerpo y las suscripciones de otros no se tocan", async () => {
    const plan = await p.plan({ maxRucsExtra: 2 });
    const q = await p.plan({ maxRucsExtra: 2 });
    const A = await p.estudio(plan, { rucsExtra: 1 });
    const B = await p.estudio(plan, { rucsExtra: 2 });
    const antesB = await sus(B.tenantId);
    const r = await asignar(A.tenantId, q.id, 1, { tenantId: B.tenantId, estudioId: B.tenantId });
    expect(r.status).toBe(200);
    expect(r.body.estudioId).toBe(A.tenantId);
    expect((await sus(A.tenantId)).plan_id).toBe(q.id);
    expect(await sus(B.tenantId)).toEqual(antesB);
  });
});

describe("CA-7 · bajar de plan por la API no borra ni desactiva y solo bloquea agregar", () => {
  async function estudioLleno() {
    const grande = await p.plan({ maxRucs: 100, maxUsuarios: 10, maxRucsExtra: 20 });
    const E = await p.estudio(grande);
    for (let i = 0; i < 3; i++) await p.b.miembro(E.tenantId, "contador", { sesion: false });
    await p.b.clientes(E.tenantId, 6);
    return { grande, E };
  }
  const uso = async (t: string) =>
    (
      await p.sql(
        `select (select count(*) from membresia where tenant_id = $1 and desactivada_en is null)::int miembros,
                (select count(*) from cliente where tenant_id = $1)::int clientes`,
        [t],
      )
    )[0];
  async function bloqueado(E: Awaited<ReturnType<typeof estudioLleno>>["E"]) {
    const inv = await p.b.llamar(E.titular, "POST", "/invitaciones", { correo: p.b.correoNuevo(), rol: "lectura" });
    expect(inv.status).toBe(409);
    expect(inv.body).toEqual({ codigo: "cupo_usuarios" });
    const cupo = new CupoRucsPlanes();
    await expect(p.b.h.dbBackend.withTenant({ tenantId: E.tenantId }, (tx) => cupo.reservar(tx, E.tenantId, 1))).rejects.toBeInstanceOf(CupoRucsError);
    const lista = await p.b.llamar(E.titular, "GET", "/usuarios");
    expect(lista.status).toBe(200);
    const u = await p.b.llamar(E.titular, "GET", "/plan/uso");
    expect(u.status).toBe(200);
  }

  it("asignar un plan menor que el uso actual: 200, nada se borra ni desactiva, agregar usuarios y RUCs queda bloqueado", async () => {
    const { E } = await estudioLleno();
    const chico = await p.plan({ maxRucs: 1, maxUsuarios: 1, maxRucsExtra: 0 });
    expect((await asignar(E.tenantId, chico.id, 0)).status).toBe(200);
    expect(await uso(E.tenantId)).toEqual({ miembros: 4, clientes: 6 });
    await bloqueado(E);
  });

  it("editar el plan en sitio (PUT) con límites menores que el uso vale para todos sus estudios al instante (D11) sin borrar nada", async () => {
    const { c, id } = await crearPlan({ maxRucs: 100, maxUsuarios: 10, maxRucsExtra: 20 });
    const E = await p.estudio({ id, codigo: c.codigo });
    const F = await p.estudio({ id, codigo: c.codigo });
    for (const x of [E, F]) {
      for (let i = 0; i < 3; i++) await p.b.miembro(x.tenantId, "contador", { sesion: false });
      await p.b.clientes(x.tenantId, 6);
    }
    const r = await plat("PUT", `/plataforma/planes/${id}`, { ...c, maxRucs: 5, maxRucsExtra: 1, maxUsuarios: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const x of [E, F]) {
      expect(await uso(x.tenantId)).toEqual({ miembros: 4, clientes: 6 });
      expect((await p.b.llamar(x.titular, "GET", "/plan/uso")).body).toMatchObject({ rucs: { usados: 6, limite: 5, libres: 0 }, usuarios: { usados: 4, limite: 2 } });
      await bloqueado(x);
    }
  });

  it("regularizar (subir el plan otra vez) desbloquea sin reiniciar", async () => {
    const { E } = await estudioLleno();
    const chico = await p.plan({ maxRucs: 1, maxUsuarios: 1 });
    expect((await asignar(E.tenantId, chico.id, 0)).status).toBe(200);
    expect((await p.b.llamar(E.titular, "POST", "/invitaciones", { correo: p.b.correoNuevo(), rol: "lectura" })).status).toBe(409);
    const holgado = await p.plan({ maxRucs: 50, maxUsuarios: 20 });
    expect((await asignar(E.tenantId, holgado.id, 0)).status).toBe(200);
    expect((await p.b.llamar(E.titular, "POST", "/invitaciones", { correo: p.b.correoNuevo(), rol: "lectura" })).status).toBe(201);
  });
});

describe("CA-8 · la API de plataforma no mezcla estudios ni filtra a los de estudio", () => {
  it("el super-admin asignando al estudio A no altera a B, y un Dueño de A con IDs de B recibe 403 en todas las rutas", async () => {
    const plan = await p.plan();
    const A = await p.estudio(plan);
    const B = await p.estudio(plan, { rucsExtra: 0 });
    const q = await p.plan();
    const antesB = await sus(B.tenantId);
    for (const [, metodo, ruta, cuerpo] of RUTAS) {
      const r = await p.b.llamar(A.titular, metodo, ruta.replace(/[0-9a-f-]{36}/, B.tenantId), cuerpo);
      expect(r.status).toBe(403);
    }
    const dueñoContraB = await p.b.llamar(A.titular, "PUT", `/plataforma/estudios/${B.tenantId}/suscripcion`, { planId: q.id, rucsExtraContratados: 0 });
    expect(dueñoContraB.status).toBe(403);
    expect(await sus(B.tenantId)).toEqual(antesB);
    expect((await asignar(A.tenantId, q.id)).status).toBe(200);
    expect(await sus(B.tenantId)).toEqual(antesB);
  });
});
