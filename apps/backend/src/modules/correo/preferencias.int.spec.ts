/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 028 (T6, rojo): preferencias de correo por HTTP (R-10, R-11, R-15; CA-1, CA-10, CA-12; D-7). PG real.
// Contrato (plan 028, «Contratos: HTTP», shared y BD; lo implementa T12 sobre las funciones de T10; los detalles fijados por T6 están en
// `test/soporte-correo.ts`):
//  - `GET /cuenta/correo` -> 200 con EXACTAMENTE las nueve claves de `PreferenciasCorreoVista`; `PUT /cuenta/correo` (cuerpo estricto con las
//    cinco preferencias) -> 200 con la misma vista. Cualquier rol del estudio (`@SoloEstudio`); usuario y estudio salen de la sesión; todo
//    responde `Cache-Control: no-store`. Sin filas, la efectiva inicial de R-15 (planLimite solo para el Dueño) y `invitacionResumen: true`.
//  - `PUT` crea las cuatro filas (la invitación desaparece), audita solo los cambios reales con `{tipo, de, a, origen: "app"}`, rechaza
//    claves extra / faltantes / no booleanas con 400 `solicitud_invalida`; «todos los clientes» solo a Dueño y Admin sin asignaciones
//    (403 `permiso_denegado` / 409 `todos_clientes_no_disponible`), con rollback total del `PUT`.
//  - El backend lee solo las filas propias (RLS) y nunca escribe directo ni inserta envíos: 42501.
// Cada 403/409/404 se acompaña del control positivo (el mismo cuerpo permitido responde 200) para que una ruta ausente no pase por vacío.
// Rojo: las rutas aún no existen (T12): 404 de ruta; las tablas y funciones (T10) tampoco.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "@contapp/db";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import {
  abrirWorker,
  auditoriaPreferencia,
  cerrarEnvio,
  CLAVES_VISTA,
  esNoStore,
  filasPreferencia,
  inicial,
  notificarAviso,
  prefs,
  provocarFallido,
  tambienEn,
  ultimoEnvio,
  vistaInicial,
} from "../../../test/soporte-correo.js";

let b: Banco;
let worker: ContappDb;
let E: Estudio;
let F: Estudio;
let c0: string;
let c1: string;

beforeAll(async () => {
  b = await abrirBanco();
  worker = abrirWorker();
  E = await b.estudio();
  F = await b.estudio();
  [c0, c1] = (await b.clientes(E.tenantId, 2)) as [string, string];
});
afterAll(async () => {
  await worker?.close();
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const get = (a: Actor) => b.llamar(a, "GET", "/cuenta/correo");
const put = (a: Actor, cuerpo: unknown) => b.llamar(a, "PUT", "/cuenta/correo", cuerpo);
/** Miembro nuevo de E (cada prueba usa el suyo). Antes de nada, la ruta debe existir: así el rojo es «ruta ausente» y no «tabla ausente». */
const nuevo = async (rol: RolSistema, asignadoA: string[] = []): Promise<Actor> => {
  const a = await b.miembro(E.tenantId, rol);
  for (const c of asignadoA) await b.asignar(E.tenantId, c, a.id, "colaborador");
  const sonda = await get(a);
  expect(sonda.status, `GET /cuenta/correo no responde 200 (¿ruta ausente?): ${sonda.text}`).toBe(200);
  return a;
};
const vista = async (a: Actor): Promise<any> => {
  const r = await get(a);
  expect(r.status, r.text).toBe(200);
  return r.body;
};
const guardar = async (a: Actor, cuerpo: unknown): Promise<any> => {
  const r = await put(a, cuerpo);
  expect(r.status, r.text).toBe(200);
  return r.body;
};
const filas = (a: Actor) => filasPreferencia(sql, a.tenantId, a.id);
const auditoria = (a: Actor) => auditoriaPreferencia(sql, a.tenantId, a.id);
const sinCambios = async (a: Actor): Promise<void> => {
  expect(await filas(a), "no debe haber filas de preferencia").toEqual([]);
  expect(await auditoria(a), "no debe haber auditoría").toEqual([]);
};
/** Las cuatro filas que guarda un `PUT`, por tipo. */
const filasEsperadas = (p: { buzonCritico: boolean; credencialInvalida: boolean; planLimite: boolean; resumen: boolean; todosClientes?: boolean }) => [
  { tipo: "buzon_critico", activo: p.buzonCritico, todos_clientes: false },
  { tipo: "credencial_invalida", activo: p.credencialInvalida, todos_clientes: false },
  { tipo: "plan_limite", activo: p.planLimite, todos_clientes: false },
  { tipo: "resumen", activo: p.resumen, todos_clientes: p.todosClientes === true },
];
const datos = (f: { datos: Record<string, unknown> }) => f.datos;
const ordenar = <T extends Record<string, unknown>>(xs: T[]): T[] => [...xs].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

describe("CA-1 · GET /cuenta/correo: valores iniciales, forma y propiedad", () => {
  it("sin filas, cada rol ve la preferencia inicial de R-15 (límite del plan solo para el Dueño) y la invitación; GET no escribe nada", async () => {
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura"] as const) {
      const a = await nuevo(rol);
      const r = await get(a);
      expect(r.status, `${rol}: ${r.text}`).toBe(200);
      expect(Object.keys(r.body).sort(), rol).toEqual([...CLAVES_VISTA]);
      expect(r.body, rol).toEqual(vistaInicial(rol));
      expect(esNoStore(r.headers["cache-control"]), rol).toBe(true);
      await get(a);
      await sinCambios(a); // dos lecturas y ninguna fila: la efectiva se calcula, no se siembra (decisión técnica del plan)
    }
  });

  it("«todos los clientes» solo está disponible a Dueño y Admin sin asignaciones", async () => {
    expect((await vista(await nuevo("dueno", [c0]))).todosDisponible).toBe(false);
    expect((await vista(await nuevo("admin", [c1]))).todosDisponible).toBe(false);
    expect((await vista(await nuevo("dueno"))).todosDisponible).toBe(true);
    expect((await vista(await nuevo("admin"))).todosDisponible).toBe(true);
    for (const rol of ["contador", "asistente", "lectura"] as const) expect((await vista(await nuevo(rol))).todosDisponible, rol).toBe(false);
  });

  it("la vista no expone ids, correo, estudio ni motivos (R-8): solo las nueve claves", async () => {
    const a = await nuevo("contador");
    await guardar(a, prefs("contador", { resumen: true }));
    const r = await get(a);
    for (const prohibido of [a.id, a.correo, a.tenantId, "tenantId", "usuarioId", "motivo", "transporte"]) expect(r.text).not.toContain(prohibido);
  });

  it("sin sesión, GET y PUT son 401 sesion_invalida (control: con sesión responde 200)", async () => {
    const a = await nuevo("contador");
    expect((await get(a)).status).toBe(200);
    for (const [metodo, cuerpo] of [
      ["GET", undefined],
      ["PUT", prefs("contador")],
    ] as const) {
      const r = await b.h.pedir({ metodo, ruta: "/cuenta/correo", ...(cuerpo ? { cuerpo } : {}) });
      expect(r.status, metodo).toBe(401);
      expect(r.body).toEqual({ codigo: "sesion_invalida" });
    }
    await sinCambios(a);
  });

  it("con el X-Estudio de otro estudio no se llega al negocio (409 estudio_desfasado) y no se cambia nada", async () => {
    const a = await nuevo("contador");
    const g = await b.llamar(a, "GET", "/cuenta/correo", undefined, { estudio: F.tenantId });
    const p = await b.llamar(a, "PUT", "/cuenta/correo", prefs("contador", { resumen: true }), { estudio: F.tenantId });
    for (const r of [g, p]) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "estudio_desfasado" });
    }
    await sinCambios(a);
    expect((await put(a, prefs("contador", { resumen: true }))).status).toBe(200); // control
  });
});

describe("CA-1 · PUT /cuenta/correo: guarda, devuelve la vista y crea las cuatro filas", () => {
  it("guarda las cinco preferencias, responde la vista (invitación apagada) y GET la repite; no-store", async () => {
    const a = await nuevo("contador");
    const cuerpo = { buzonCritico: false, credencialInvalida: true, planLimite: true, resumen: true, todosClientes: false };
    const r = await put(a, cuerpo);
    expect(r.status, r.text).toBe(200);
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    expect(r.body).toEqual({ ...cuerpo, todosDisponible: false, todosIgnorado: false, invitacionResumen: false, ultimoEnvioFallido: null });
    expect((await get(a)).body).toEqual(r.body);
    expect(await filas(a)).toEqual(filasEsperadas(cuerpo));
  });

  it("guardar los valores iniciales («Ahora no») crea las filas y apaga la invitación, sin auditar nada (no cambió ningún valor)", async () => {
    for (const rol of ["dueno", "contador"] as const) {
      const a = await nuevo(rol);
      expect((await vista(a)).invitacionResumen, rol).toBe(true);
      const v = await guardar(a, prefs(rol)); // resumen: false = «Ahora no»
      expect(v, rol).toEqual({ ...vistaInicial(rol), invitacionResumen: false });
      expect(await filas(a), rol).toEqual(filasEsperadas(inicial(rol)));
      expect(await auditoria(a), rol).toEqual([]);
      expect((await vista(a)).invitacionResumen, rol).toBe(false);
    }
  });

  it("«Activar resumen» deja resumen en true, sin invitación, y audita el cambio", async () => {
    const a = await nuevo("admin");
    const v = await guardar(a, prefs("admin", { resumen: true }));
    expect(v).toMatchObject({ resumen: true, invitacionResumen: false });
    expect((await auditoria(a)).map(datos)).toEqual([{ tipo: "resumen", de: false, a: true, origen: "app" }]);
  });

  it("todos los roles pueden guardar las suyas (es @SoloEstudio, sin permiso aparte)", async () => {
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura"] as const) {
      const a = await nuevo(rol);
      const v = await guardar(a, prefs(rol, { buzonCritico: false }));
      expect(v.buzonCritico, rol).toBe(false);
      expect((await vista(a)).buzonCritico, rol).toBe(false);
    }
  });

  it("cuerpos inválidos son 400 solicitud_invalida y no cambian nada: claves extra (usuarioId, tenantId), faltantes, no booleanas, vacío, lista", async () => {
    const a = await nuevo("contador");
    const base = prefs("contador");
    const { resumen: _r, ...sinResumen } = base;
    void _r;
    const malos: unknown[] = [
      { ...base, usuarioId: F.titular.id },
      { ...base, tenantId: F.tenantId },
      { ...base, estudioId: F.tenantId },
      { ...base, todosDisponible: true },
      sinResumen,
      { ...base, resumen: "true" },
      { ...base, resumen: 1 },
      { ...base, buzonCritico: null },
      {},
      [base],
    ];
    for (const cuerpo of malos) {
      const r = await put(a, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(esNoStore(r.headers["cache-control"])).toBe(true);
    }
    const noJson = await b.h.pedir({ metodo: "PUT", ruta: "/cuenta/correo", crudo: "{", cookie: a.cookie, csrf: a.csrf, estudio: a.tenantId });
    expect(noJson.status).toBe(400);
    await sinCambios(a);
    expect((await put(a, base)).status).toBe(200); // control: el cuerpo bueno sí
  });

  it("el estudio y el usuario salen de la sesión: un usuarioId o tenantId en la consulta no mueve las filas de otro", async () => {
    const x = await nuevo("contador");
    const y = await nuevo("contador");
    await guardar(y, prefs("contador", { buzonCritico: false }));
    const antes = await filas(y);
    for (const consulta of [`?usuarioId=${y.id}`, `?tenantId=${F.tenantId}&usuarioId=${y.id}`]) {
      const r = await b.llamar(x, "PUT", `/cuenta/correo${consulta}`, prefs("contador", { resumen: true }));
      expect([200, 400], r.text).toContain(r.status);
    }
    expect(await filas(y)).toEqual(antes); // la otra no se tocó
    // Solo queda la auditoría del propio cambio de y (R-10), a su nombre y en su estudio; ninguna de las peticiones de x movió nada.
    expect((await auditoria(y)).map(datos)).toEqual([{ tipo: "buzon_critico", de: true, a: false, origen: "app" }]);
    expect((await auditoria(y)).every((f) => f.usuario_id === y.id && f.tenant_id === E.tenantId)).toBe(true);
    const deX = await auditoria(x);
    expect(deX.every((f) => f.usuario_id === x.id && f.tenant_id === E.tenantId)).toBe(true); // nunca a nombre de y ni del estudio del cuerpo
    expect(await auditoriaPreferencia(sql, F.tenantId, x.id)).toEqual([]);
    expect(await auditoriaPreferencia(sql, F.tenantId, y.id)).toEqual([]);
    expect((await put(x, prefs("contador", { resumen: true }))).status).toBe(200); // control
    expect((await vista(x)).resumen).toBe(true);
    expect((await vista(y)).resumen).toBe(false);
  });
});

describe("R-10 · auditoría exacta de cada cambio real", () => {
  it("solo los cambios reales: una fila por tipo con {tipo, de, a, origen} de lista blanca y actor el usuario; guardar igual no audita", async () => {
    const a = await nuevo("contador");
    await guardar(a, prefs("contador", { resumen: true, planLimite: true }));
    const filasA = await auditoria(a);
    expect(ordenar(filasA.map(datos))).toEqual(
      ordenar([
        { tipo: "resumen", de: false, a: true, origen: "app" },
        { tipo: "plan_limite", de: false, a: true, origen: "app" },
      ]),
    );
    for (const f of filasA) {
      expect(f.actor_tipo).toBe("usuario");
      expect(f.usuario_id).toBe(a.id);
      expect(f.tenant_id).toBe(a.tenantId);
      expect(Object.keys(f.datos).sort()).toEqual(["a", "de", "origen", "tipo"]);
      expect(JSON.stringify(f.datos)).not.toContain(a.correo);
    }
    await guardar(a, prefs("contador", { resumen: true, planLimite: true })); // sin cambios
    expect(await auditoria(a)).toHaveLength(2);
    await guardar(a, prefs("contador", { resumen: false, planLimite: true }));
    const todas = (await auditoria(a)).map(datos);
    expect(todas).toHaveLength(3);
    expect(todas.at(-1)).toEqual({ tipo: "resumen", de: true, a: false, origen: "app" });
  });

  it("un Dueño que marca «todos los clientes» deja tipo resumen_todos; los demás valores no cambian y no se auditan", async () => {
    const a = await nuevo("dueno");
    await guardar(a, prefs("dueno", { todosClientes: true }));
    expect((await auditoria(a)).map(datos)).toEqual([{ tipo: "resumen_todos", de: false, a: true, origen: "app" }]);
    const f = await filas(a);
    expect(f.find((x) => x.tipo === "resumen")).toMatchObject({ activo: false, todos_clientes: true });
    expect(f.filter((x) => x.tipo !== "resumen").every((x) => x.todos_clientes === false)).toBe(true);
  });

  it("dos usuarios y dos estudios: cada cambio queda en SU estudio y a nombre de SU usuario", async () => {
    const x = await nuevo("contador");
    const y = await nuevo("contador");
    const xEnF = await tambienEn(b, x, F.tenantId, "dueno");
    expect((await get(xEnF)).status).toBe(200); // control: la sesión del otro estudio funciona
    await guardar(x, prefs("contador", { resumen: true }));
    await guardar(xEnF, prefs("dueno", { buzonCritico: false }));
    await guardar(y, prefs("contador", { credencialInvalida: false }));
    expect((await auditoriaPreferencia(sql, E.tenantId, x.id)).map((f) => [f.tenant_id, f.datos])).toEqual([
      [E.tenantId, { tipo: "resumen", de: false, a: true, origen: "app" }],
    ]);
    expect((await auditoriaPreferencia(sql, F.tenantId, x.id)).map((f) => [f.tenant_id, f.datos])).toEqual([
      [F.tenantId, { tipo: "buzon_critico", de: true, a: false, origen: "app" }],
    ]);
    expect((await auditoria(y)).map(datos)).toEqual([{ tipo: "credencial_invalida", de: true, a: false, origen: "app" }]);
  });
});

describe("R-4 · una preferencia por (usuario, estudio)", () => {
  it("el mismo usuario en dos estudios tiene valores propios en cada uno (y la efectiva inicial sigue su rol allí)", async () => {
    const x = await nuevo("contador"); // contador en E
    const xEnF = await tambienEn(b, x, F.tenantId, "dueno"); // dueño en F
    expect(await vista(x)).toEqual(vistaInicial("contador"));
    expect(await vista(xEnF)).toEqual(vistaInicial("dueno"));
    await guardar(x, prefs("contador", { resumen: true, buzonCritico: false }));
    expect(await vista(x)).toMatchObject({ resumen: true, buzonCritico: false, invitacionResumen: false });
    expect(await vista(xEnF)).toEqual(vistaInicial("dueno")); // F no se enteró
    expect(await filasPreferencia(sql, F.tenantId, x.id)).toEqual([]);
    await guardar(xEnF, prefs("dueno", { planLimite: false }));
    expect((await vista(x)).planLimite).toBe(false); // el de E sigue siendo el inicial del contador
    expect(await vista(xEnF)).toMatchObject({ planLimite: false, resumen: false, buzonCritico: true });
    expect(await vista(x)).toMatchObject({ resumen: true, buzonCritico: false });
  });

  it("dos usuarios del mismo estudio no se ven ni se pisan", async () => {
    const x = await nuevo("contador");
    const y = await nuevo("contador");
    await guardar(x, prefs("contador", { resumen: true }));
    expect(await vista(y)).toEqual(vistaInicial("contador"));
    await guardar(y, prefs("contador", { buzonCritico: false }));
    expect(await vista(x)).toMatchObject({ resumen: true, buzonCritico: true });
    expect(await vista(y)).toMatchObject({ resumen: false, buzonCritico: false });
  });
});

describe("CA-12 · «todos los clientes» por rol y asignaciones", () => {
  it("un Dueño o Admin sin asignaciones lo marca (200); la vista lo muestra y desmarcarlo también es 200", async () => {
    for (const rol of ["dueno", "admin"] as const) {
      const a = await nuevo(rol);
      const v = await guardar(a, prefs(rol, { resumen: true, todosClientes: true }));
      expect(v, rol).toMatchObject({ resumen: true, todosClientes: true, todosDisponible: true, todosIgnorado: false });
      expect((await vista(a)).todosClientes, rol).toBe(true);
      const v2 = await guardar(a, prefs(rol, { resumen: true, todosClientes: false }));
      expect(v2, rol).toMatchObject({ todosClientes: false, todosDisponible: true });
    }
  });

  it("un Contador, Asistente o Lectura recibe 403 permiso_denegado y NADA se guarda (ni las otras claves del mismo PUT)", async () => {
    const control = await nuevo("dueno");
    expect((await put(control, prefs("dueno", { todosClientes: true }))).status).toBe(200); // control: la misma petición, con permiso, es 200
    for (const rol of ["contador", "asistente", "lectura"] as const) {
      const a = await nuevo(rol);
      const r = await put(a, prefs(rol, { resumen: true, todosClientes: true }));
      expect(r.status, `${rol}: ${r.text}`).toBe(403);
      expect(r.body, rol).toEqual({ codigo: "permiso_denegado" });
      expect(esNoStore(r.headers["cache-control"]), rol).toBe(true);
      await sinCambios(a);
      expect(await vista(a), rol).toEqual(vistaInicial(rol)); // el resumen y la invitación siguen como estaban
      expect((await put(a, prefs(rol, { resumen: true }))).status, `${rol} control`).toBe(200);
    }
  });

  it("un Dueño o Admin CON asignaciones recibe 409 todos_clientes_no_disponible y nada se guarda; sin marcarlo guarda normal", async () => {
    for (const rol of ["dueno", "admin"] as const) {
      const a = await nuevo(rol, [c0]);
      const r = await put(a, prefs(rol, { resumen: true, todosClientes: true }));
      expect(r.status, `${rol}: ${r.text}`).toBe(409);
      expect(r.body, rol).toEqual({ codigo: "todos_clientes_no_disponible" });
      expect(esNoStore(r.headers["cache-control"]), rol).toBe(true);
      await sinCambios(a);
      expect(await vista(a), rol).toEqual(vistaInicial(rol, false));
      const ok = await put(a, prefs(rol, { resumen: true, todosClientes: false })); // control: sin la marca es 200
      expect(ok.status, `${rol}: ${ok.text}`).toBe(200);
      expect(ok.body, rol).toMatchObject({ resumen: true, todosClientes: false, todosDisponible: false });
    }
  });

  it("si al Dueño que la marcó le asignan un cliente, la marca se ignora y la vista lo dice; al desmarcar vuelve a la normalidad", async () => {
    const a = await nuevo("dueno");
    await guardar(a, prefs("dueno", { resumen: true, todosClientes: true }));
    expect(await vista(a)).toMatchObject({ todosClientes: true, todosDisponible: true, todosIgnorado: false });
    await b.asignar(E.tenantId, c1, a.id, "responsable");
    const ignorada = await vista(a);
    expect(ignorada).toMatchObject({ todosClientes: true, todosDisponible: false, todosIgnorado: true }); // [T6] la marca guardada se conserva
    // Guardarla otra vez con la marca es 409 (no hay manera de «re-marcar»); desmarcarla es 200 y apaga el aviso.
    expect((await put(a, prefs("dueno", { resumen: true, todosClientes: true }))).status).toBe(409);
    const v = await guardar(a, prefs("dueno", { resumen: true, todosClientes: false }));
    expect(v).toMatchObject({ todosClientes: false, todosDisponible: false, todosIgnorado: false });
  });

  it("si el Dueño que la marcó deja de serlo (pasa a Contador), la marca se ignora", async () => {
    const a = await nuevo("dueno");
    await guardar(a, prefs("dueno", { resumen: true, todosClientes: true }));
    await sql("update membresia set rol = 'contador' where tenant_id = $1 and usuario_id = $2", [a.tenantId, a.id]);
    expect(await vista(a)).toMatchObject({ todosClientes: true, todosDisponible: false, todosIgnorado: true });
    await sql("update membresia set rol = 'dueno' where tenant_id = $1 and usuario_id = $2", [a.tenantId, a.id]);
    expect(await vista(a)).toMatchObject({ todosClientes: true, todosDisponible: true, todosIgnorado: false });
  });
});

describe("CA-10 · ultimoEnvioFallido con un fallido real", () => {
  it("el último envío fallido del usuario en el estudio sale como ISO; un envío posterior enviado lo borra; sin motivo ni texto", async () => {
    const a = await nuevo("contador", [c0]);
    expect((await vista(a)).ultimoEnvioFallido).toBeNull(); // control: antes no hay fallo
    const envioId = await provocarFallido(sql, worker, { tenantId: E.tenantId, usuarioId: a.id, clienteId: c0 });
    const e = (await sql("select estado, motivo, intentos from correo_envio where id = $1", [envioId]))[0];
    expect(e).toMatchObject({ estado: "fallido", motivo: "transporte", intentos: 3 }); // el fallo es REAL: lo dejó el cierre del worker
    const r = await get(a);
    expect(r.status, r.text).toBe(200);
    expect(typeof r.body.ultimoEnvioFallido).toBe("string");
    expect(Number.isNaN(Date.parse(r.body.ultimoEnvioFallido))).toBe(false);
    expect(r.body.ultimoEnvioFallido).toMatch(/(Z|[+-]\d\d:\d\d)$/); // ISO con zona (`z.iso.datetime({ offset: true })`)
    expect(Math.abs(Date.now() - Date.parse(r.body.ultimoEnvioFallido))).toBeLessThan(10 * 60_000);
    for (const prohibido of ["transporte", envioId, a.correo]) expect(r.text).not.toContain(prohibido);
    expect((await put(a, prefs("contador"))).body.ultimoEnvioFallido).toBe(r.body.ultimoEnvioFallido); // el PUT lo repite

    // Un envío posterior entregado: ya no es «el último».
    await notificarAviso(sql, { tenantId: E.tenantId, usuarios: [a.id], tipo: "buzon_critico", clienteId: c0 });
    const nuevoEnvio = await ultimoEnvio(sql, E.tenantId, a.id, "buzon_critico");
    expect(nuevoEnvio?.estado).toBe("pendiente");
    await cerrarEnvio(worker, E.tenantId, nuevoEnvio!.id, "enviado", null);
    expect((await vista(a)).ultimoEnvioFallido).toBeNull();
  });

  it("el fallo de otro usuario o de otro estudio no se muestra", async () => {
    const x = await nuevo("contador", [c0]);
    const y = await nuevo("contador", [c0]);
    const xEnF = await tambienEn(b, x, F.tenantId, "dueno");
    const fallo = await provocarFallido(sql, worker, { tenantId: E.tenantId, usuarioId: x.id, clienteId: c0 });
    expect((await ultimoEnvio(sql, E.tenantId, x.id, "credencial_invalida"))?.id).toBe(fallo);
    expect((await vista(x)).ultimoEnvioFallido).not.toBeNull(); // control: a quien le falló, sí
    expect((await vista(y)).ultimoEnvioFallido).toBeNull();
    expect((await vista(xEnF)).ultimoEnvioFallido).toBeNull();
  });
});

describe("D-7 · apagar un tipo deja omitido lo pendiente de ese tipo", () => {
  it("el PUT que apaga buzonCritico omite sus envíos pendientes (preferencia_apagada) y deja los de otros tipos; la notificación sigue en la app", async () => {
    const a = await nuevo("contador", [c0]);
    await notificarAviso(sql, { tenantId: E.tenantId, usuarios: [a.id], tipo: "buzon_critico", clienteId: c0 });
    await notificarAviso(sql, { tenantId: E.tenantId, usuarios: [a.id], tipo: "credencial_invalida", clienteId: c0 });
    expect((await ultimoEnvio(sql, E.tenantId, a.id, "buzon_critico"))?.estado).toBe("pendiente"); // control: el aviso real dejó su envío
    await guardar(a, prefs("contador", { buzonCritico: false }));
    expect(await ultimoEnvio(sql, E.tenantId, a.id, "buzon_critico")).toMatchObject({ estado: "omitido", motivo: "preferencia_apagada" });
    expect((await ultimoEnvio(sql, E.tenantId, a.id, "credencial_invalida"))?.estado).toBe("pendiente");
    const notificaciones = await sql("select tipo from notificacion where tenant_id = $1 and usuario_id = $2 order by tipo", [E.tenantId, a.id]);
    expect(notificaciones.map((n) => n.tipo)).toEqual(["buzon_critico", "credencial_invalida"]);
  });

  it("con la preferencia apagada, un aviso nuevo no registra envío pero sí la notificación (R-2)", async () => {
    const a = await nuevo("contador", [c0]);
    await guardar(a, prefs("contador", { buzonCritico: false }));
    await notificarAviso(sql, { tenantId: E.tenantId, usuarios: [a.id], tipo: "buzon_critico", clienteId: c0 });
    expect(await ultimoEnvio(sql, E.tenantId, a.id, "buzon_critico")).toBeUndefined();
    expect((await b.llamar(a, "GET", "/notificaciones")).body.items).toHaveLength(1);
    // control: con el tipo activo el mismo aviso sí deja su envío
    await guardar(a, prefs("contador", { buzonCritico: true }));
    await notificarAviso(sql, { tenantId: E.tenantId, usuarios: [a.id], tipo: "buzon_critico", clienteId: c0 });
    expect((await ultimoEnvio(sql, E.tenantId, a.id, "buzon_critico"))?.estado).toBe("pendiente");
  });
});

describe("R-11 · el backend lee solo lo propio y nunca escribe directo ni inserta envíos", () => {
  const como = <T>(tenantId: string, userId: string, fn: (q: (t: string, v?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> =>
    b.h.dbBackend.withTenant({ tenantId, userId }, (tx) => fn(async (t, v) => (await tx.query(t, v)).rows));
  /** Cada sentencia en su propia transacción: un 42501 aborta la transacción de PG y no deja seguir. */
  const codigo = async (tenantId: string, userId: string, texto: string, valores: unknown[] = []): Promise<string | null> => {
    try {
      await como(tenantId, userId, (q) => q(texto, valores));
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? "otro";
    }
  };

  it("SQL directo como backend: solo las filas del usuario de la sesión en el estudio activo, y escribir directo es 42501", async () => {
    const x = await nuevo("contador", [c0]); // (la sonda de `nuevo` falla primero si la ruta no existe)
    const y = await nuevo("contador", [c0]);
    const xEnF = await tambienEn(b, x, F.tenantId, "dueno");
    await guardar(x, prefs("contador", { resumen: true }));
    await guardar(xEnF, prefs("dueno", { buzonCritico: false }));
    // El fallo de y se provoca con el tipo aún activo (apagado, no se crea envío: R-2) y luego se apaga.
    await provocarFallido(sql, worker, { tenantId: E.tenantId, usuarioId: x.id, clienteId: c0 });
    await provocarFallido(sql, worker, { tenantId: E.tenantId, usuarioId: y.id, clienteId: c0 });
    await guardar(y, prefs("contador", { credencialInvalida: false }));

    const propias = await como(E.tenantId, x.id, (q) => q("select tenant_id, usuario_id, tipo from correo_preferencia"));
    expect(propias).toHaveLength(4);
    expect(propias.every((f) => f.usuario_id === x.id && f.tenant_id === E.tenantId)).toBe(true);
    const deF = await como(F.tenantId, x.id, (q) => q("select tenant_id, usuario_id from correo_preferencia"));
    expect(deF).toHaveLength(4);
    expect(deF.every((f) => f.usuario_id === x.id && f.tenant_id === F.tenantId)).toBe(true);
    const envios = await como(E.tenantId, x.id, (q) => q("select usuario_id from correo_envio"));
    expect(envios.length).toBeGreaterThan(0);
    expect(envios.every((f) => f.usuario_id === x.id)).toBe(true); // el fallo de y existe y no se ve
    // Ajeno por consulta directa: ni con el id de la otra, ni con el estudio de la otra.
    expect(await como(E.tenantId, x.id, (q) => q("select 1 from correo_preferencia where usuario_id = $1", [y.id]))).toEqual([]);
    expect(await como(E.tenantId, x.id, (q) => q("select 1 from correo_envio where usuario_id = $1", [y.id]))).toEqual([]);

    // Escribir directo no existe (solo funciones acotadas): 42501 en las cuatro tablas del estudio.
    expect(await codigo(E.tenantId, x.id, "update correo_preferencia set activo = false")).toBe("42501");
    expect(await codigo(E.tenantId, x.id, "delete from correo_preferencia")).toBe("42501");
    expect(
      await codigo(E.tenantId, x.id, "insert into correo_preferencia (usuario_id, tipo, activo) values ($1, 'resumen', true)", [x.id]),
    ).toBe("42501");
    expect(await codigo(E.tenantId, x.id, "update correo_envio set estado = 'enviado'")).toBe("42501");
    expect(await codigo(E.tenantId, x.id, "delete from correo_envio")).toBe("42501");
    expect(
      await codigo(
        E.tenantId,
        x.id,
        "insert into correo_envio (usuario_id, origen, tipo, estado, clave, programado_para) values ($1, 'aviso', 'buzon_critico', 'pendiente', 'x', now())",
        [x.id],
      ),
    ).toBe("42501");
    for (const tabla of ["correo_envio_aviso", "correo_baja_token", "correo_programacion"])
      expect(await codigo(E.tenantId, x.id, `select 1 from ${tabla}`), tabla).toBe("42501");
    // Nada cambió por los intentos.
    expect(await filas(x)).toEqual(filasEsperadas({ ...prefs("contador", { resumen: true }) }));
  });

  it("las funciones del backend exigen la sesión de un miembro: un usuario ajeno al estudio recibe 42501 y no se crea nada", async () => {
    await nuevo("contador"); // la ruta debe existir
    const ajeno = await b.miembro(F.tenantId, "dueno", { sesion: false });
    const cuerpo = JSON.stringify(prefs("dueno", { resumen: true }));
    expect(await codigo(E.tenantId, ajeno.id, "select correo_preferencias_fijar($1::jsonb)", [cuerpo])).toBe("42501");
    expect(await filasPreferencia(sql, E.tenantId, ajeno.id)).toEqual([]);
    // control: el miembro de verdad sí puede por la misma función
    expect(await codigo(F.tenantId, ajeno.id, "select correo_preferencias_fijar($1::jsonb)", [cuerpo])).toBeNull();
    expect((await filasPreferencia(sql, F.tenantId, ajeno.id)).find((f) => f.tipo === "resumen")?.activo).toBe(true);
  });

  it("el backend no tiene privilegios para insertar, cambiar ni borrar envíos, avisos ni tokens, y la API no deja envíos nuevos", async () => {
    const a = await nuevo("dueno"); // la ruta debe existir
    const privs = await sql<{ t: string; p: string; ok: boolean }>(
      `select t, p, has_table_privilege('contapp_backend', t, p) as ok
         from unnest(array['correo_envio','correo_envio_aviso','correo_baja_token','correo_preferencia']) t,
              unnest(array['INSERT','UPDATE','DELETE']) p`,
    );
    expect(privs).toHaveLength(12);
    expect(privs.filter((f) => f.ok).map((f) => `${f.p} ${f.t}`)).toEqual([]);
    expect((await sql<{ ok: boolean }>("select has_table_privilege('contapp_backend', 'correo_envio', 'SELECT') as ok"))[0]!.ok).toBe(true);
    expect((await sql<{ ok: boolean }>("select has_table_privilege('contapp_backend', 'correo_baja_token', 'SELECT') as ok"))[0]!.ok).toBe(false);

    const cuenta = async () => (await sql("select count(*)::int n from correo_envio where tenant_id = $1", [E.tenantId]))[0].n;
    const antes = await cuenta();
    await get(a);
    await guardar(a, prefs("dueno", { resumen: true, buzonCritico: false }));
    await guardar(a, prefs("dueno", { resumen: false }));
    expect(await cuenta()).toBe(antes); // ni leer ni guardar crea envíos: solo el worker los inserta
  });
});
