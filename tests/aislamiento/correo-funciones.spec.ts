// Spec 028 (T3, rojo): funciones acotadas de correo y preferencias en BD real (R-10, R-15; D-7; CA-1, CA-12). Catalogo (dueño, search_path,
// EXECUTE), preferencia efectiva por rol, `correo_preferencias_fijar` (validacion, «todos los clientes», auditoria exacta, apagar deja
// `omitido` lo pendiente) y el rechazo de cada funcion a los roles que no la ejecutan. Falla hoy porque las migraciones 0073-0074 aun no
// existen. El contrato esta en la cabecera de correo-soporte.ts.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  ACCION_PREFERENCIA,
  conExecute,
  crearDb,
  enTx,
  EscenarioCorreo,
  FUNCIONES_CORREO,
  infoFuncion,
  probar,
  ROLES_EXEC,
  ROLES_SIN_ACCESO,
  type ClientePrueba,
} from "./correo-soporte";

let admin: Pool;
let ec: EscenarioCorreo;
let backend: ContappDb;
let worker: ContappDb;
let E: string;
let E2: string;
let uDueno: string;
let uAdmin: string;
let uConta: string;
let uAsis: string;
let uLect: string;
let uOff: string; // contador desactivado
let uAjeno: string; // miembro solo de E2

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioCorreo(admin);
  E = await ec.estudioPlan();
  E2 = await ec.estudioPlan();
  uDueno = (await ec.et.miembro(E, "dueno")).id;
  uAdmin = (await ec.et.miembro(E, "admin")).id;
  uConta = (await ec.et.miembro(E, "contador")).id;
  uAsis = (await ec.et.miembro(E, "asistente")).id;
  uLect = (await ec.et.miembro(E, "lectura")).id;
  uOff = (await ec.et.miembro(E, "contador", { desactivada: true })).id;
  uAjeno = (await ec.et.miembro(E2, "contador")).id;
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};
const PREF = { buzonCritico: true, credencialInvalida: true, planLimite: false, resumen: false, todosClientes: false };
type Pref = Record<string, unknown>;
const fijarSql = "select correo_preferencias_fijar($1::jsonb) as r";
const fijar = (tenant: string, userId: string, p: Pref) =>
  backend.withTenant({ tenantId: tenant, userId }, async (tx) => (await tx.query(fijarSql, [JSON.stringify(p)])).rows[0].r as unknown);
const intentarFijar = (tenant: string, userId: string | undefined, p: unknown) =>
  intentar(backend, { tenantId: tenant, ...(userId ? { userId } : {}) }, fijarSql, [p === null ? null : JSON.stringify(p)]);
const filasPref = async (tenant: string, usuario: string) =>
  (await admin.query("select tipo, activo, todos_clientes from correo_preferencia where tenant_id = $1 and usuario_id = $2 order by tipo", [tenant, usuario]))
    .rows as { tipo: string; activo: boolean; todos_clientes: boolean }[];
const cambios = async (tenant: string, usuario: string) =>
  (await ec.auditoriaPreferencia(tenant, usuario)).map((a) => a.datos as Record<string, unknown>);
const porTipo = (xs: Record<string, unknown>[]) => [...xs].sort((a, b) => String(a.tipo).localeCompare(String(b.tipo)));

describe("catalogo de funciones: dueño, search_path fijo y EXECUTE solo a quien toca (0074)", () => {
  it.each(FUNCIONES_CORREO.map((f) => [f.firma, f] as const))(
    "%s es SECURITY DEFINER de contapp_migrator, sin superusuario, con search_path fijo",
    async (firma) => {
      const f = await infoFuncion(admin, firma);
      expect(f.secdef).toBe(true);
      expect(f.dueno).toBe("contapp_migrator");
      expect(f.duenoSuper).toBe(false);
      // como `sistema.estudios_buzon` (0055), la enumeracion de estudios puede ser de un dueño que lee todas las suscripciones
      if (firma !== "sistema.estudios_correo()") expect(f.duenoBypass, `dueño ${f.dueno}`).toBe(false);
      expect(f.config.join(",")).toBe("search_path=pg_catalog, pg_temp");
    },
  );

  it.each(FUNCIONES_CORREO.map((f) => [f.firma, f.ejecuta] as const))("%s: EXECUTE solo para %j (ni PUBLIC ni otro rol de la app)", async (firma, ejecuta) => {
    expect(await conExecute(admin, firma, ROLES_EXEC)).toEqual(ejecuta);
  });

  it("correo_preferencia_efectiva la ejecuta contapp_registrador (y solo el, de entre los roles internos)", async () => {
    const r = await admin.query("select has_function_privilege('contapp_registrador', 'correo_preferencia_efectiva(uuid,uuid,text)'::regprocedure, 'execute') as ok");
    expect(r.rows[0].ok).toBe(true);
  });

  it("interno.notificar conserva dueño contapp_registrador, search_path fijo y EXECUTE solo para contapp_migrator", async () => {
    const f = await infoFuncion(admin, "interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)");
    expect(f).toMatchObject({ secdef: true, dueno: "contapp_registrador", duenoSuper: false });
    expect(f.config.join(",")).toBe("search_path=pg_catalog, pg_temp");
    const r = await admin.query(
      `select coalesce((select array_agg(x.rolname::text order by x.rolname) from pg_roles x
                         where x.oid <> p.proowner and x.rolname like 'contapp\\_%'
                           and has_function_privilege(x.oid, p.oid, 'EXECUTE')), '{}'::text[]) as ejecutan
         from pg_proc p where p.oid = 'interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)'::regprocedure`,
    );
    expect(r.rows[0].ejecutan).toEqual(["contapp_migrator"]);
  });

  it("auth.correo_baja_aplicar: dueño contapp_auth (como auth.recuperacion_consumir), search_path fijo y EXECUTE solo para contapp_backend", async () => {
    const f = await infoFuncion(admin, "auth.correo_baja_aplicar(bytea)");
    expect(f).toMatchObject({ secdef: true, dueno: "contapp_auth", duenoSuper: false, duenoBypass: false });
    expect(f.config.join(",")).toBe("search_path=pg_catalog, pg_temp");
    expect(await conExecute(admin, "auth.correo_baja_aplicar(bytea)", ROLES_EXEC)).toEqual(["contapp_backend"]);
  });

  it("ninguna usa EXCEPTION WHEN ni SAVEPOINT (corren en la transaccion del hecho; plan: Funciones nuevas)", async () => {
    const r = await admin.query(
      `select p.oid::regprocedure::text as firma, p.prosrc from pg_proc p
        where p.oid = any($1::regprocedure[])`,
      [[...FUNCIONES_CORREO.map((f) => f.firma), "interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)", "auth.correo_baja_aplicar(bytea)"]],
    );
    expect(r.rows, "faltan funciones (migracion 0074)").toHaveLength(FUNCIONES_CORREO.length + 2);
    for (const f of r.rows as { firma: string; prosrc: string }[]) {
      expect(/\bEXCEPTION\s+WHEN\b/i.test(f.prosrc), `${f.firma}: EXCEPTION WHEN`).toBe(false);
      expect(/\bSAVEPOINT\b/i.test(f.prosrc), `${f.firma}: SAVEPOINT`).toBe(false);
    }
  });

  it.each(FUNCIONES_CORREO.map((f) => [f.firma, f] as const))("%s: los roles que no la ejecutan reciben 42501", async (_firma, f) => {
    const ajenos = ["contapp_backend", "contapp_worker", ...ROLES_SIN_ACCESO].filter((r) => !f.ejecuta.includes(r));
    for (const rol of ajenos) {
      if (rol === "contapp_backend" || rol === "contapp_worker") {
        const db = rol === "contapp_backend" ? backend : worker;
        rechazo(await intentar(db, { tenantId: E, ...(rol === "contapp_backend" ? { userId: uConta } : {}) }, f.llamada), "42501");
      } else {
        rechazo(await enTx(admin, rol, (c) => probar(c, f.llamada)), "42501");
      }
    }
  });
});

describe("R-15 · preferencia efectiva sin filas: critico y clave inicial para todos, limite del plan solo para Dueños, resumen apagado", () => {
  it.each([
    ["dueno", () => uDueno, [true, true, true, false]],
    ["admin", () => uAdmin, [true, true, false, false]],
    ["contador", () => uConta, [true, true, false, false]],
    ["asistente", () => uAsis, [true, true, false, false]],
    ["lectura", () => uLect, [true, true, false, false]],
  ] as const)("rol %s", async (_rol, usuario, esperado) => {
    const tipos = ["buzon_critico", "credencial_invalida", "plan_limite", "resumen"];
    const reales = await Promise.all(tipos.map((t) => ec.efectiva(E, usuario(), t)));
    expect(reales).toEqual(esperado);
  });

  it("una fila explicita gana al valor inicial, por estudio: lo apagado en uno no cambia el otro", async () => {
    const u = await ec.et.ea.cuenta();
    await ec.et.ea.membresia(E, u.id, "contador");
    await ec.et.ea.membresia(E2, u.id, "contador");
    await ec.preferencia(E, u.id, "buzon_critico", false);
    await ec.preferencia(E, u.id, "plan_limite", true);
    expect(await ec.efectiva(E, u.id, "buzon_critico")).toBe(false);
    expect(await ec.efectiva(E, u.id, "plan_limite")).toBe(true);
    expect(await ec.efectiva(E2, u.id, "buzon_critico")).toBe(true);
    expect(await ec.efectiva(E2, u.id, "plan_limite")).toBe(false);
  });
});

describe("CA-1 · correo_preferencias_fijar: valida, crea las cuatro filas y audita solo los cambios reales", () => {
  it("guardar los valores iniciales crea las cuatro filas y no audita nada", async () => {
    const r = await fijar(E, uAdmin, PREF);
    expect(r).toBeTypeOf("object");
    expect(r).not.toBeNull();
    expect(await filasPref(E, uAdmin)).toEqual([
      { tipo: "buzon_critico", activo: true, todos_clientes: false },
      { tipo: "credencial_invalida", activo: true, todos_clientes: false },
      { tipo: "plan_limite", activo: false, todos_clientes: false },
      { tipo: "resumen", activo: false, todos_clientes: false },
    ]);
    expect(await cambios(E, uAdmin)).toEqual([]);
  });

  it("cada cambio real deja una fila correo.preferencia_cambiada con actor el usuario y datos exactos {tipo, de, a, origen: app}; guardar lo mismo no audita", async () => {
    await fijar(E, uConta, { ...PREF, resumen: true, buzonCritico: false });
    const filas = await ec.auditoriaPreferencia(E, uConta);
    expect(filas).toHaveLength(2);
    for (const f of filas) expect(f).toMatchObject({ accion: ACCION_PREFERENCIA, actor_tipo: "usuario", usuario_id: uConta, tenant_id: E, trabajo_id: null });
    expect(porTipo(filas.map((f) => f.datos))).toEqual([
      { tipo: "buzon_critico", de: true, a: false, origen: "app" },
      { tipo: "resumen", de: false, a: true, origen: "app" },
    ]);
    await fijar(E, uConta, { ...PREF, resumen: true, buzonCritico: false }); // sin cambios
    expect(await cambios(E, uConta)).toHaveLength(2);
    // un solo cambio mas: el limite del plan se compara con su valor inicial para el rol (apagado para un Contador)
    await fijar(E, uConta, { ...PREF, resumen: true, buzonCritico: false, planLimite: true });
    const ultimo = (await cambios(E, uConta)).filter((d) => d.tipo === "plan_limite");
    expect(ultimo).toEqual([{ tipo: "plan_limite", de: false, a: true, origen: "app" }]);
    expect(await filasPref(E, uConta)).toEqual([
      { tipo: "buzon_critico", activo: false, todos_clientes: false },
      { tipo: "credencial_invalida", activo: true, todos_clientes: false },
      { tipo: "plan_limite", activo: true, todos_clientes: false },
      { tipo: "resumen", activo: true, todos_clientes: false },
    ]);
  });

  it("para un Dueño, planLimite true es su valor inicial: guardarlo no es un cambio", async () => {
    const d2 = (await ec.et.miembro(E, "dueno")).id;
    await fijar(E, d2, { ...PREF, planLimite: true });
    expect(await cambios(E, d2)).toEqual([]);
    await fijar(E, d2, { ...PREF, planLimite: false });
    expect(await cambios(E, d2)).toEqual([{ tipo: "plan_limite", de: true, a: false, origen: "app" }]);
  });

  it("solo toca las filas del usuario de la sesion en el estudio activo: ni las de otro usuario ni las del mismo usuario en otro estudio", async () => {
    const u = await ec.et.ea.cuenta();
    await ec.et.ea.membresia(E, u.id, "contador");
    await ec.et.ea.membresia(E2, u.id, "contador");
    await fijar(E, u.id, { ...PREF, resumen: true });
    expect(await filasPref(E, u.id)).toHaveLength(4);
    expect(await filasPref(E2, u.id)).toEqual([]);
    expect(await filasPref(E, uLect)).toEqual([]);
  });

  it("claves faltantes o de mas, valores que no son booleanos y el cuerpo que no es un objeto: 22023 y no cambia nada", async () => {
    const malos: unknown[] = [
      null,
      [],
      "x",
      {},
      { buzonCritico: true },
      { ...PREF, usuarioId: uConta },
      { ...PREF, tenantId: E },
      { ...PREF, extra: true },
      { ...PREF, resumen: "true" },
      { ...PREF, resumen: 1 },
      { ...PREF, buzonCritico: null },
      { ...PREF, todosClientes: "no" },
    ];
    for (const p of malos) rechazo(await intentarFijar(E, uLect, p), "22023");
    expect(await filasPref(E, uLect)).toEqual([]);
    expect(await cambios(E, uLect)).toEqual([]);
  });

  it("sin usuario en la sesion, con un usuario de otro estudio o con la membresia desactivada: 42501", async () => {
    rechazo(await intentarFijar(E, undefined, PREF), "42501");
    rechazo(await intentarFijar(E, uAjeno, PREF), "42501");
    rechazo(await intentarFijar(E, uOff, PREF), "42501");
    expect(await filasPref(E, uOff)).toEqual([]);
    expect(await filasPref(E, uAjeno)).toEqual([]);
  });

  it("el cliente de un solo estudio no puede forzar otro: sin app.tenant_id, 42501", async () => {
    const r = await backend.withUsuario({ userId: uConta }, async (tx) => {
      try {
        await tx.query(fijarSql, [JSON.stringify(PREF)]);
        return "ok";
      } catch (e) {
        return String((e as { code?: string }).code);
      }
    });
    expect(r).toBe("42501");
  });
});

describe("CA-12 · «todos los clientes»: solo Dueño o Administrador sin asignaciones", () => {
  const conTodos = { ...PREF, resumen: true, todosClientes: true };

  it("un Dueño sin asignaciones lo marca: la fila `resumen` lo guarda y se audita tipo resumen_todos", async () => {
    const d = (await ec.et.miembro(E, "dueno")).id;
    await fijar(E, d, { ...conTodos, planLimite: true }); // el limite del plan es activo por omision para un Dueño: guardarlo igual no cambia nada
    const resumen = (await filasPref(E, d)).find((f) => f.tipo === "resumen")!;
    expect(resumen).toEqual({ tipo: "resumen", activo: true, todos_clientes: true });
    expect(porTipo(await cambios(E, d))).toEqual([
      { tipo: "resumen", de: false, a: true, origen: "app" },
      { tipo: "resumen_todos", de: false, a: true, origen: "app" },
    ]);
    await fijar(E, d, { ...conTodos, planLimite: true, todosClientes: false });
    expect((await cambios(E, d)).filter((x) => x.tipo === "resumen_todos").at(-1)).toEqual({ tipo: "resumen_todos", de: true, a: false, origen: "app" });
  });

  it("un Administrador sin asignaciones tambien", async () => {
    const a = (await ec.et.miembro(E, "admin")).id;
    await fijar(E, a, conTodos);
    expect((await filasPref(E, a)).find((f) => f.tipo === "resumen")!.todos_clientes).toBe(true);
  });

  it.each(["contador", "asistente", "lectura"] as const)("un %s lo marca: 42501 y no se crea ninguna fila", async (rol) => {
    const u = (await ec.et.miembro(E, rol)).id;
    rechazo(await intentarFijar(E, u, conTodos), "42501");
    expect(await filasPref(E, u)).toEqual([]);
    await fijar(E, u, { ...conTodos, todosClientes: false }); // lo demas si puede guardarlo
    expect((await filasPref(E, u)).find((f) => f.tipo === "resumen")!.todos_clientes).toBe(false);
  });

  it("un Dueño con asignaciones: CA430; si ya lo tenia marcado y le asignan un cliente, sigue pudiendo guardarlo en false", async () => {
    const d = (await ec.et.miembro(E, "dueno")).id;
    const c: ClientePrueba = await ec.et.cliente(E);
    await ec.et.asignar(E, c.id, d, "colaborador");
    rechazo(await intentarFijar(E, d, conTodos), "CA430");
    expect(await filasPref(E, d)).toEqual([]);
    // marco «todos» antes de recibir la asignacion
    const d2 = (await ec.et.miembro(E, "dueno")).id;
    await fijar(E, d2, conTodos);
    const c2 = await ec.et.cliente(E);
    await ec.et.asignar(E, c2.id, d2, "responsable");
    rechazo(await intentarFijar(E, d2, conTodos), "CA430");
    await fijar(E, d2, { ...conTodos, todosClientes: false });
    expect((await filasPref(E, d2)).find((f) => f.tipo === "resumen")!.todos_clientes).toBe(false);
  });
});

describe("D-7 · apagar un tipo deja `omitido` (preferencia_apagada) lo pendiente sin tomar; activarlo no manda nada", () => {
  it("solo los pendientes sin tomar del tipo, del usuario y del estudio; los demas no cambian", async () => {
    const t = await ec.estudioPlan();
    const u = (await ec.et.miembro(t, "contador")).id;
    const otro = (await ec.et.miembro(t, "contador")).id;
    const c = await ec.et.cliente(t);
    const co = await ec.et.cliente(t);
    await ec.et.asignar(t, c.id, u, "responsable");
    await ec.et.asignar(t, co.id, otro, "responsable");
    await ec.capturar(worker, t, c, 1);
    const [primero] = await ec.envios(t, { usuarioId: u, tipo: "buzon_critico" });
    await worker.withTenant({ tenantId: t }, (tx) => tx.query("select correo_envio_tomar($1::uuid)", [primero!.id])); // este ya lo tomo el ciclo
    await ec.capturar(worker, t, c, 2); // segundo envio: pendiente sin tomar
    await ec.notificarDirecto(admin, t, [u], "credencial_invalida"); // otro tipo, pendiente sin tomar
    await ec.sembrarEnviados(t, u, 1); // uno ya enviado
    await ec.capturar(worker, t, co, 1); // otro usuario
    const antes = await ec.envios(t);
    const sinTomar = antes.find((e) => e.usuario_id === u && e.tipo === "buzon_critico" && e.id !== primero!.id && e.estado === "pendiente")!;
    expect(sinTomar.tomado_en).toBeNull();

    await fijar(t, u, { ...PREF, buzonCritico: false });
    const despues = await ec.envios(t);
    const de = (id: string) => despues.find((e) => e.id === id)!;
    expect(de(sinTomar.id)).toMatchObject({ estado: "omitido", motivo: "preferencia_apagada" });
    for (const e of antes.filter((x) => x.id !== sinTomar.id)) {
      expect({ estado: de(e.id).estado, motivo: de(e.id).motivo }, `${e.tipo} ${e.estado}`).toEqual({ estado: e.estado, motivo: e.motivo });
    }
    expect(de(primero!.id).estado).toBe("pendiente"); // ya tomado: lo revalida el worker (R-3)
    // activar de nuevo no manda lo anterior: no hay envios nuevos ni el omitido vuelve
    await fijar(t, u, { ...PREF, buzonCritico: true });
    const final = await ec.envios(t);
    expect(final).toHaveLength(despues.length);
    expect(final.find((e) => e.id === sinTomar.id)!.estado).toBe("omitido");
  });
});
