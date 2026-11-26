// Spec 030 (T1, rojo hasta 0082) · CA-4, CA-7, CA-8, D3, U7, U8, U10: el espejo SQL del resolvedor (`acceso.permisos_membresia` contra la misma
// tabla CASOS_EFECTIVOS que el TS), `auth.totp_desactivar` con roles propios (CASOS_FACTOR_EXIGIDO), las funciones de invitacion con
// `rol = 'propio'` y las funciones de avisos que siguen explicitas para Dueño y Administrador (U10).
// Rojo por: acceso.permisos_membresia no existe (3F000 / 42883) y rol / rol_permiso / membresia.rol_id tampoco (0082).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CASOS_EFECTIVOS } from "../../packages/shared/src/acceso/efectivos.casos";
import { CASOS_FACTOR_EXIGIDO } from "../../packages/shared/src/auth/factor-exigido.casos";
import { abrirAdmin, abrirApp, exito, hashFalso, llamar } from "./auth-soporte";
import { EscenarioTotp, SQL } from "./auth-totp-soporte";
import { COD, EscenarioRoles, PERMISOS_ASIGNABLES, codigo, eliminar, guardar } from "./roles-soporte";

vi.setConfig({ testTimeout: 60_000 });

let admin: Pool;
let app: Pool;
let er: EscenarioRoles;
let et: EscenarioTotp;
beforeAll(() => {
  admin = abrirAdmin(6);
  app = abrirApp(12);
  er = new EscenarioRoles(admin);
  et = new EscenarioTotp(admin);
});
afterAll(async () => {
  await et?.limpiar();
  await er?.limpiar();
  await er?.cerrar();
  await app?.end();
  await admin?.end();
});
const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const PM = "select rol_sistema, permisos, alcance from acceso.permisos_membresia($1::uuid, $2::uuid)";
const efectivo = async (tenant: string, usuario: string) => {
  const f = await adm(PM, [tenant, usuario]);
  return f.map((r) => ({ rol_sistema: r.rol_sistema as string | null, permisos: [...(r.permisos as string[])].sort(), alcance: r.alcance as string }));
};

describe("acceso.permisos_membresia · espejo de CASOS_EFECTIVOS (D3, CA-4)", () => {
  it("la tabla comun trae los 5 roles de sistema y los roles propios", () => {
    expect(CASOS_EFECTIVOS.filter((c) => c.rolSistema !== null).map((c) => c.rolSistema).sort()).toEqual(["admin", "asistente", "contador", "dueno", "lectura"]);
    expect(CASOS_EFECTIVOS.filter((c) => c.rolSistema === null).length).toBeGreaterThanOrEqual(25);
  });

  it.each(CASOS_EFECTIVOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const x = await er.estudio();
    let usuarioId: string;
    if (caso.rolSistema !== null) {
      usuarioId = (await er.miembro(x.id, caso.rolSistema)).id;
    } else {
      const rol = await er.rol(x.id, { alcance: caso.propio!.alcance, permisos: caso.propio!.permisos });
      usuarioId = (await er.miembroPropio(x.id, rol.id)).id;
    }
    expect(await efectivo(x.id, usuarioId)).toEqual([
      { rol_sistema: caso.rolSistema, permisos: [...caso.permisos].sort(), alcance: caso.alcance },
    ]);
  });

  it("una membresia desactivada, un usuario sin membresia o de otro estudio, y un estudio ajeno dan cero filas (sin acceso por esa via)", async () => {
    const a = await er.estudio();
    const b = await er.estudio();
    const desactivado = await er.miembro(a.id, "admin", { desactivada: true });
    const sinMembresia = await er.cuenta();
    const deB = await er.miembro(b.id, "dueno");
    expect(await efectivo(a.id, desactivado.id)).toEqual([]);
    expect(await efectivo(a.id, sinMembresia.id)).toEqual([]);
    expect(await efectivo(a.id, deB.id), "el usuario es de otro estudio").toEqual([]);
    expect(await adm(PM, [a.id, "00000000-0000-4000-8000-00000000dead"])).toEqual([]);
  });

  it("CA-4: editar el rol cambia los permisos efectivos en la consulta siguiente (sin cache); eliminarlo no deja un fantasma", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const m = await er.miembroPropio(x.id, rol.id);
    const db = er.backend();
    const cD = { tenantId: x.id, userId: d.id };
    expect((await efectivo(x.id, m.id))[0]?.permisos).toEqual(["clientes.ver"]);
    expect(codigo(await guardar(db, cD, { id: rol.id, nombre: rol.nombre, alcance: "global", permisos: ["clientes.ver", "sire.descargar"] }))).toBe("ok");
    expect(await efectivo(x.id, m.id)).toEqual([{ rol_sistema: null, permisos: ["clientes.ver", "sire.descargar"], alcance: "global" }]);
    await adm("update membresia set desactivada_en = now() where usuario_id = $1", [m.id]);
    expect(await efectivo(x.id, m.id)).toEqual([]);
  });

  it("U7: un rol propio con los 23 permisos y alcance global sigue sin ser 'dueno' ni 'admin' (rol_sistema NULL)", async () => {
    const x = await er.estudio();
    const rol = await er.rol(x.id, { alcance: "global", permisos: [...PERMISOS_ASIGNABLES] });
    const m = await er.miembroPropio(x.id, rol.id);
    expect((await efectivo(x.id, m.id))[0]?.rol_sistema).toBeNull();
    expect((await efectivo(x.id, m.id))[0]?.permisos).not.toContain("plan.gestionar");
  });

  it("la funcion no es ejecutable por platform ni app (recibe un estudio arbitrario); solo las funciones definer, el migrador y el worker (T17a: revalidacion al despachar) la usan", async () => {
    const f = "acceso.permisos_membresia(uuid, uuid)";
    const r = await adm(
      `select r, has_function_privilege(r, $1, 'EXECUTE') as ok from unnest(array['contapp_worker', 'contapp_platform', 'contapp_app']) r`,
      [f],
    );
    expect(r.filter((x) => x.ok).map((x) => x.r)).toEqual(["contapp_worker"]);
    const [p] = await adm("select prosecdef, proconfig::text as cfg, pg_get_userbyid(proowner) as dueno from pg_proc where oid = $1::regprocedure", [f]);
    expect(p.prosecdef).toBe(true);
    expect(p.cfg).toContain("search_path=pg_catalog, pg_temp");
    expect(p.dueno).toBe("contapp_migrator");
  });
});

describe("auth.totp_desactivar con roles propios (CA-7, U8): misma regla que factorExigido", () => {
  const guardables = CASOS_FACTOR_EXIGIDO.filter((c) => c.guardable === true);

  /** Usuario con TOTP activo y una sesion `verificado`, con un rol propio que tiene `permisos` en un estudio propio. */
  async function cuentaConPropio(permisos: readonly string[], o: { membresiaDesactivada?: boolean } = {}) {
    const x = await er.estudio();
    const rol = await er.rol(x.id, { permisos });
    const m = await er.miembroPropio(x.id, rol.id, { desactivada: o.membresiaDesactivada });
    await et.totpActivo(m.id);
    await et.codigos(m.id, 10);
    const s = await et.sesionF(m.id, { factor: "verificado", tenant: x.id });
    return { x, rol, m, s };
  }
  const desactivar = async (token: Buffer) => (await exito(llamar(app, SQL.desactivar, [token, "1"])))[0].r as string;

  it("hay filas de roles propios guardables en la tabla comun (exigidas y no exigidas)", () => {
    expect(guardables.some((c) => c.exigido)).toBe(true);
    expect(guardables.some((c) => !c.exigido)).toBe(true);
  });

  it.each(guardables.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const c = await cuentaConPropio(caso.permisos);
    const r = await desactivar(c.s.token);
    expect(r).toBe(caso.exigido ? "exigido" : "desactivado");
    const fila = await et.filaTotp(c.m.id);
    if (caso.exigido) {
      expect(fila?.activo_cifrado).not.toBeNull(); // sin ningun efecto: el secreto sigue
      expect(await et.filasCodigos(c.m.id)).toHaveLength(10);
      expect(await et.eventos(c.m.id)).toEqual([]);
    } else {
      expect(fila).toBeUndefined();
      expect(await et.eventos(c.m.id)).toEqual(["totp_desactivado"]);
    }
  });

  it("la membresia propia DESACTIVADA no exige (no hay acceso por ella), aunque su rol tenga permisos sensibles", async () => {
    const c = await cuentaConPropio(["usuarios.ver", "usuarios.gestionar"], { membresiaDesactivada: true });
    expect(await desactivar(c.s.token)).toBe("desactivado");
  });

  it("un rol que gana un sensible exige factor en la SIGUIENTE peticion (editar el rol cambia la respuesta)", async () => {
    const c = await cuentaConPropio(["clientes.ver"]);
    const dueno = await er.miembro(c.x.id, "dueno");
    const db = er.backend();
    expect(codigo(await guardar(db, { tenantId: c.x.id, userId: dueno.id }, { id: c.rol.id, nombre: c.rol.nombre, alcance: "asignado", permisos: ["clientes.ver", "credenciales.editar"] }))).toBe("ok");
    expect(await desactivar(c.s.token)).toBe("exigido");
    expect(codigo(await guardar(db, { tenantId: c.x.id, userId: dueno.id }, { id: c.rol.id, nombre: c.rol.nombre, alcance: "asignado", permisos: ["clientes.ver"] }))).toBe("ok");
    expect(await desactivar(c.s.token)).toBe("desactivado");
  });

  it("la regla mira TODAS las membresias vigentes: un propio sin sensibles en un estudio y uno con sensibles en otro sigue exigido", async () => {
    const c = await cuentaConPropio(["clientes.ver"]);
    const otro = await er.estudio();
    const rolSensible = await er.rol(otro.id, { permisos: ["usuarios.ver", "roles.gestionar"] });
    await admin.query("insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'propio', $3)", [otro.id, c.m.id, rolSensible.id]);
    expect(await desactivar(c.s.token)).toBe("exigido");
  });

  it("un propio sin sensibles mas una membresia de sistema Administrador en otro estudio: exigido (U1 de 029 intacta)", async () => {
    const c = await cuentaConPropio(["clientes.ver"]);
    const otro = await er.estudio();
    await admin.query("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')", [otro.id, c.m.id]);
    expect(await desactivar(c.s.token)).toBe("exigido");
  });
});

describe("funciones de invitacion con rol propio (CA-1, CA-6, D4)", () => {
  const VIGENTE = "select estudio_nombre, correo, rol, cuenta_existe from auth.invitacion_vigente($1::bytea)";
  const NUEVA = "select auth.invitacion_aceptar_nueva($1::bytea, $2::text, $3::text) as v";
  const EXISTENTE = "select tenant_id, estudio_nombre from auth.invitacion_aceptar_existente($1::bytea, $2::bytea)";
  const membresiaDe = async (tenant: string, correo: string) =>
    (await adm("select m.rol, m.rol_id, m.desactivada_en from membresia m join usuario u on u.id = m.usuario_id where m.tenant_id = $1 and u.email = $2", [tenant, correo]))[0];

  it("invitacion_vigente devuelve rol 'propio' (sin efectos) para una invitacion del Dueño a un rol propio", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const inv = await er.invitacionPropia(x.id, rol.id, d.id);
    const r = await exito(llamar(app, VIGENTE, [inv.tokenHash]));
    expect(r).toEqual([{ estudio_nombre: x.nombre, correo: inv.correo, rol: "propio", cuenta_existe: false }]);
    expect((await adm("select aceptada_en from invitacion where id = $1", [inv.id]))[0].aceptada_en).toBeNull();
  });

  it("aceptar_nueva crea la membresia con rol 'propio' y el mismo rol_id; los permisos efectivos son los del rol", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { alcance: "global", permisos: ["clientes.ver", "buzon.ver"] });
    const inv = await er.invitacionPropia(x.id, rol.id, d.id);
    er.recordarCorreo(inv.correo);
    expect((await exito(llamar(app, NUEVA, [inv.tokenHash, "Practicante Nuevo", hashFalso()])))[0].v).toBe("aceptada");
    const m = await membresiaDe(x.id, inv.correo);
    expect(m).toEqual({ rol: "propio", rol_id: rol.id, desactivada_en: null });
    const u = (await adm("select id from usuario where email = $1", [inv.correo]))[0].id as string;
    expect(await efectivo(x.id, u)).toEqual([{ rol_sistema: null, permisos: ["buzon.ver", "clientes.ver"], alcance: "global" }]);
  });

  it("rol editado entre la invitacion y la aceptacion: la membresia nace con los permisos ACTUALES del rol", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const inv = await er.invitacionPropia(x.id, rol.id, d.id);
    er.recordarCorreo(inv.correo);
    const db = er.backend();
    expect(codigo(await guardar(db, { tenantId: x.id, userId: d.id }, { id: rol.id, nombre: rol.nombre, alcance: "asignado", permisos: ["clientes.ver", "sire.descargar"] }))).toBe("ok");
    expect((await exito(llamar(app, NUEVA, [inv.tokenHash, "Persona", hashFalso()])))[0].v).toBe("aceptada");
    const u = (await adm("select id from usuario where email = $1", [inv.correo]))[0].id as string;
    expect((await efectivo(x.id, u))[0]?.permisos).toEqual(["clientes.ver", "sire.descargar"]);
  });

  it("rol 'eliminado' entre la invitacion y la aceptacion: no se puede eliminar mientras la invitacion este vigente, y sigue aceptable", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const inv = await er.invitacionPropia(x.id, rol.id, d.id);
    er.recordarCorreo(inv.correo);
    expect(codigo(await eliminar(er.backend(), { tenantId: x.id, userId: d.id }, rol.id))).toBe(COD.enUso);
    expect((await exito(llamar(app, NUEVA, [inv.tokenHash, "Persona", hashFalso()])))[0].v).toBe("aceptada");
    expect((await membresiaDe(x.id, inv.correo)).rol_id).toBe(rol.id);
  });

  it("aceptar_existente con la sesion del titular copia el rol propio y el rol_id", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const u = await er.cuenta();
    const sesion = await er.esc.sesion(u.id, null);
    const inv = await er.invitacionPropia(x.id, rol.id, d.id);
    await adm("update invitacion set correo = $2 where id = $1", [inv.id, u.correo]);
    const r = await exito(llamar(app, EXISTENTE, [inv.tokenHash, sesion]));
    expect(r).toEqual([{ tenant_id: x.id, estudio_nombre: x.nombre }]);
    expect(await adm("select rol, rol_id from membresia where tenant_id = $1 and usuario_id = $2", [x.id, u.id])).toEqual([{ rol: "propio", rol_id: rol.id }]);
  });

  it("la invitacion emitida por un miembro con rol propio con usuarios.gestionar sigue vigente (el invitador ya no tiene que ser Dueño o Administrador)", async () => {
    const x = await er.estudio();
    await er.miembro(x.id, "dueno");
    const invitador = await er.actor(x.id, ["usuarios.ver", "usuarios.gestionar", "clientes.ver"], "global");
    const destino = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const inv = await er.invitacionPropia(x.id, destino.id, invitador.id);
    const r = await exito(llamar(app, VIGENTE, [inv.tokenHash]));
    expect(r).toHaveLength(1);
    expect(r[0].rol).toBe("propio");
  });

  it("... pero no la de un invitador propio SIN usuarios.gestionar, ni la de uno desactivado: cero filas", async () => {
    const x = await er.estudio();
    await er.miembro(x.id, "dueno");
    const sinPermiso = await er.actor(x.id, ["clientes.ver"], "global");
    const destino = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const invalida = await er.invitacionPropia(x.id, destino.id, sinPermiso.id);
    expect(await exito(llamar(app, VIGENTE, [invalida.tokenHash]))).toEqual([]);
    const conPermiso = await er.actor(x.id, ["usuarios.ver", "usuarios.gestionar"], "global");
    const otra = await er.invitacionPropia(x.id, destino.id, conPermiso.id);
    expect(await exito(llamar(app, VIGENTE, [otra.tokenHash]))).toHaveLength(1);
    await adm("update membresia set desactivada_en = now() where usuario_id = $1", [conPermiso.id]);
    expect(await exito(llamar(app, VIGENTE, [otra.tokenHash])), "invitador desactivado").toEqual([]);
  });

  it("las invitaciones de sistema siguen igual: de un Administrador a Dueño no vale; a Contador si", async () => {
    const x = await er.estudio();
    await er.miembro(x.id, "dueno");
    const adminU = await er.miembro(x.id, "admin");
    const aDueno = await er.invitacion(x.id, { invitadoPor: adminU.id, rol: "dueno" });
    const aConta = await er.invitacion(x.id, { invitadoPor: adminU.id, rol: "contador" });
    expect(await exito(llamar(app, VIGENTE, [aDueno.tokenHash]))).toEqual([]);
    expect(await exito(llamar(app, VIGENTE, [aConta.tokenHash]))).toHaveLength(1);
  });
});

describe("U10: los avisos siguen solo para Dueño y Administrador; un rol propio nunca cuenta como Dueño", () => {
  /** Estudio con Dueño, Administrador y dos roles propios con TODOS los permisos asignables (uno global y uno asignado). */
  async function escenario() {
    const x = await er.estudio();
    const dueno = await er.miembro(x.id, "dueno");
    const adminU = await er.miembro(x.id, "admin");
    const rolG = await er.rol(x.id, { alcance: "global", permisos: PERMISOS_ASIGNABLES });
    const rolA = await er.rol(x.id, { alcance: "asignado", permisos: PERMISOS_ASIGNABLES });
    const propioG = await er.miembroPropio(x.id, rolG.id);
    const propioA = await er.miembroPropio(x.id, rolA.id);
    const cliente = await er.cliente(x.id);
    // interno.uso_plan devuelve cero filas sin suscripcion: se suscribe al estudio al primer plan sembrado (la limpieza la borra).
    await adm("insert into suscripcion (tenant_id, plan_id, estado) select $1::uuid, id, 'activa' from plan order by codigo limit 1", [x.id]);
    return { x, dueno, adminU, propioG, propioA, cliente };
  }

  it("interno.destinatarios_cliente: sin responsable, solo Dueños y Administradores (no los roles propios, aunque lo tengan todo)", async () => {
    const e = await escenario();
    const r = await adm("select interno.destinatarios_cliente($1::uuid, $2::uuid) as u", [e.x.id, e.cliente]);
    expect([...(r[0].u as string[])].sort()).toEqual([e.dueno.id, e.adminU.id].sort());
  });

  it("interno.destinatarios_cliente: un rol propio con sire.clasificar SI recibe el aviso cuando es el responsable activo (regla del responsable intacta)", async () => {
    const e = await escenario();
    await er.asignar(e.x.id, e.cliente, e.propioA.id, "responsable");
    const r = await adm("select interno.destinatarios_cliente($1::uuid, $2::uuid) as u", [e.x.id, e.cliente]);
    expect(r[0].u).toEqual([e.propioA.id]);
  });

  it("interno.uso_plan: la lista de Dueños solo trae roles de sistema 'dueno'", async () => {
    const e = await escenario();
    const r = await adm("select duenos from interno.uso_plan($1::uuid)", [e.x.id]);
    expect(r[0].duenos).toEqual([e.dueno.id]);
  });

  it("correo_preferencia_efectiva: el aviso de limite del plan solo es inicial para el Dueño; los demas avisos iniciales no dependen del rol propio", async () => {
    const e = await escenario();
    const pref = async (u: string, tipo: string) => (await adm("select public.correo_preferencia_efectiva($1::uuid, $2::uuid, $3) as v", [e.x.id, u, tipo]))[0].v as boolean;
    expect(await pref(e.dueno.id, "plan_limite")).toBe(true);
    expect(await pref(e.propioG.id, "plan_limite")).toBe(false);
    expect(await pref(e.propioG.id, "buzon_critico")).toBe(true);
    expect(await pref(e.propioA.id, "resumen")).toBe(false);
  });

  it("U7: un propio con todos los permisos asignables no cuenta como Dueño para el trigger del ultimo Dueño", async () => {
    const x = await er.estudio();
    const unico = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { alcance: "global", permisos: PERMISOS_ASIGNABLES });
    await er.miembroPropio(x.id, rol.id);
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      const e = await c.query("update membresia set desactivada_en = now() where usuario_id = $1", [unico.id]).catch((err) => err);
      expect((e as { code?: string }).code).toBe("P0001");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
