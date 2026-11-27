// Spec 030 · T13a · ronda adversarial 2 (caja blanca: SQL). Ataca las correcciones de la ronda 1 (0085: disparador de asignación ampliado,
// revocación en rol_guardar y recomprobación al aceptar, orden de bloqueo con auth.cupo_usuarios_aceptar, auditoría de invitaciones y
// nombre_clave). Solo afirma el comportamiento SEGURO esperado: una prueba roja es un hallazgo. Conexiones reales: contapp_backend por el
// login contapp_app (SET LOCAL ROLE); el superusuario solo siembra, observa (pg_stat_activity) y limpia.
import { randomBytes } from "node:crypto";
import { bloquearCupo, bloquearMiembros } from "@contapp/db";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirAdmin, abrirApp, hashFalso, llamar } from "./auth-soporte";
import { COD, EscenarioRoles, cierreU3, codigo, ejecutar, guardar, probar, sha256, type Res } from "./roles-soporte";
import type { ContappDb } from "./soporte";

vi.setConfig({ testTimeout: 90_000 });

let admin: Pool;
let app: Pool;
let er: EscenarioRoles;
let db: ContappDb;
beforeAll(() => {
  admin = abrirAdmin(6);
  app = abrirApp(16);
  er = new EscenarioRoles(admin);
  db = er.backend(8);
});
afterAll(async () => {
  await er?.limpiar();
  await er?.cerrar();
  await app?.end();
  await admin?.end();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- filas de pg sin tipo
const adm = async (sql: string, v: unknown[] = []): Promise<any[]> => (await admin.query(sql, v)).rows;
const ctx = (tenantId: string, u?: { id: string }) => ({ tenantId, ...(u ? { userId: u.id } : {}) });
const nombreDe = async (rolId: string): Promise<string> => (await adm("select nombre from rol where id = $1", [rolId]))[0].nombre as string;
const atrapar = (p: Promise<{ rows: unknown[] }>): Promise<Res> =>
  p.then(
    (r) => ({ ok: true as const, rows: r.rows as never[] }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? ""), message: String(e.message ?? "") }),
  );
const NADA: Res = { ok: false, code: "sin-correr", message: "" };
const SQL_ACEPTAR = "select auth.invitacion_aceptar_nueva($1, $2, $3) as r";
const SQL_CUPO = "select auth.cupo_usuarios_aceptar($1::uuid) as ok";
const aceptarNueva = async (tokenHash: Buffer, nombre = "Invitada R2"): Promise<string> => {
  const r = await llamar(app, SQL_ACEPTAR, [tokenHash, nombre, hashFalso()]);
  return r.ok ? (r.rows[0].r as string) : r.code;
};

interface Sesion {
  c: PoolClient;
  q: (sql: string, v?: unknown[]) => Promise<Res>;
  fin: (confirmar: boolean) => Promise<void>;
}
/** Transacción abierta como contapp_backend (login contapp_app + SET LOCAL ROLE); estudio y actor opcionales (sin ellos: como withAuth). */
async function sesion(tenantId: string | null, userId?: string): Promise<Sesion> {
  const c = await app.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE contapp_backend");
  await c.query("SET LOCAL lock_timeout = '25s'");
  if (tenantId) await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
  if (userId) await c.query("select set_config('app.user_id', $1, true)", [userId]);
  let cerrada = false;
  return {
    c,
    q: (sql, v = []) => atrapar(c.query(sql, v)),
    fin: async (confirmar) => {
      if (cerrada) return;
      cerrada = true;
      await c.query(confirmar ? "COMMIT" : "ROLLBACK").catch(() => c.query("ROLLBACK").catch(() => undefined));
      c.release();
    },
  };
}
/** Espera a que alguna sentencia cuyo texto calce con `patron` esté esperando un bloqueo. */
async function esperarEspera(patron: string, ms = 15_000): Promise<void> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const [{ n: k }] = await adm(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike $1",
      [patron],
    );
    if (k > 0) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`ninguna sentencia ${patron} llegó a esperar un bloqueo`);
}

async function base() {
  const x = await er.estudio();
  const dueno = await er.miembro(x.id, "dueno");
  return { x, dueno, cD: ctx(x.id, dueno) };
}
/** Un rol con más que un gestor de solo `usuarios.gestionar` (alcance global, sensibles). */
const poderoso = (tenantId: string) =>
  er.rol(tenantId, { alcance: "global", permisos: cierreU3(["credenciales.editar", "usuarios.gestionar", "roles.gestionar"]) });

describe("R2 · (a) el disparador de asignación ampliado (0085) no se elude con otras columnas", () => {
  it("re-emitir una invitación a un rol que el actor NO contiene (nuevo token_hash, revivir vence_en o des-revocar) pasa por la regla; si no, el actor se queda con un miembro de ese rol", async () => {
    // 0085 solo mira rol_id/tenant_id/correo/invitado_por. Pero rotar `token_hash` es re-emitir la invitación (lo que hace reenviar, que por
    // HTTP exige contención): quien conoce el token nuevo crea la cuenta del correo invitado con el rol propio que el actor no podría dar.
    const a = await base();
    const actor = await er.actor(a.x.id, ["usuarios.gestionar"]);
    const P = await poderoso(a.x.id);
    const viva = await er.invitacionPropia(a.x.id, P.id, a.dueno.id);
    const vencida = await er.invitacionPropia(a.x.id, P.id, a.dueno.id, { vencida: true });
    const revocada = await er.invitacionPropia(a.x.id, P.id, a.dueno.id, { revocada: true });
    const cX = ctx(a.x.id, actor);
    const mio = randomBytes(32);
    const vistos = {
      reemitir: codigo(await probar(db, cX, "update invitacion set token_hash = $1, vence_en = now() + interval '72 hours' where id = $2", [sha256(randomBytes(32)), vencida.id])),
      revivir: codigo(await probar(db, cX, "update invitacion set vence_en = now() + interval '72 hours' where id = $1", [vencida.id])),
      desrevocar: codigo(await probar(db, cX, "update invitacion set revocada_en = null, token_hash = $1 where id = $2", [sha256(randomBytes(32)), revocada.id])),
      // Confirmado: el actor fija un token que solo él conoce en la invitación viva del Dueño y la acepta.
      rotar: codigo(await ejecutar(db, cX, "update invitacion set token_hash = $1 where id = $2", [sha256(mio), viva.id])),
      aceptar: await aceptarNueva(sha256(mio), "Cómplice R2"),
      miembrosDeP: (await adm("select count(*)::int as n from membresia m join usuario u on u.id = m.usuario_id where u.email = $1 and m.rol_id = $2", [viva.correo, P.id]))[0].n,
    };
    expect(vistos).toEqual({ reemitir: COD.escalada, revivir: COD.escalada, desrevocar: COD.escalada, rotar: COD.escalada, aceptar: "invalida", miembrosDeP: 0 });
  });

  it("reactivar (UPDATE o INSERT ... ON CONFLICT DO UPDATE) una membresía desactivada con un rol propio que el actor NO contiene pasa por la regla (T13 lo dejó sin cubrir)", async () => {
    const a = await base();
    const actor = await er.actor(a.x.id, ["usuarios.gestionar"]);
    const P = await poderoso(a.x.id);
    const t1 = await er.miembroPropio(a.x.id, P.id, { desactivada: true });
    const t2 = await er.miembroPropio(a.x.id, P.id, { desactivada: true });
    const otro = await er.miembro(a.x.id, "lectura");
    const cX = ctx(a.x.id, actor);
    const vistos = {
      control: codigo(await probar(db, a.cD, "update membresia set desactivada_en = null where usuario_id = $1", [t1.id])),
      sinRolId: codigo(await probar(db, a.cD, "update membresia set rol = 'propio' where usuario_id = $1", [otro.id])),
      reactivar: codigo(await probar(db, cX, "update membresia set desactivada_en = null, updated_at = now() where usuario_id = $1", [t1.id])),
      // La fila propuesta es de sistema (el disparador de INSERT la deja pasar) y el UPDATE del conflicto no cambia rol_id ni usuario_id.
      upsert: codigo(
        await probar(
          db,
          cX,
          "insert into membresia (usuario_id, rol) values ($1, 'lectura') on conflict (tenant_id, usuario_id) do update set desactivada_en = null",
          [t2.id],
        ),
      ),
    };
    expect(vistos).toEqual({ control: "ok", sinRolId: COD.check, reactivar: COD.escalada, upsert: COD.escalada });
  });
});

describe("R2 · (b) revocación en rol_guardar y recomprobación al aceptar", () => {
  it("carrera editar el rol del invitador vs aceptar, en ambos órdenes: si la edición gana, la invitación queda revocada y no nace cuenta; si gana aceptar, la membresía es coherente", async () => {
    const a = await base();
    // Orden 1: rol_guardar (le quita credenciales.editar al rol del invitador) confirma después de que aceptar ya espera el advisory.
    const X = await er.actor(a.x.id, ["usuarios.gestionar", "credenciales.editar"]);
    const Q = await er.rol(a.x.id, { alcance: "asignado", permisos: cierreU3(["credenciales.editar"]) });
    const inv = await er.invitacionPropia(a.x.id, Q.id, X.id);
    const t1 = await sesion(a.x.id, a.dueno.id);
    let ed: Res = NADA;
    let acepta: Res = NADA;
    try {
      ed = await t1.q("select acceso.rol_guardar($1::uuid, $2::text, $3::text, $4::text[]) as id", [X.rolId, await nombreDe(X.rolId), "asignado", cierreU3(["usuarios.gestionar"])]);
      const p = llamar(app, SQL_ACEPTAR, [inv.tokenHash, "Carrera R2", hashFalso()]);
      await esperarEspera("%invitacion_aceptar_nueva%");
      await t1.fin(true);
      acepta = await p;
    } finally {
      await t1.fin(false);
    }
    // Orden 2: aceptar (otra invitación del mismo invitador, a un rol que ya contiene) confirma antes que una edición que lo reduce.
    const Y = await er.actor(a.x.id, ["usuarios.gestionar", "credenciales.editar"]);
    const inv2 = await er.invitacionPropia(a.x.id, Q.id, Y.id);
    const t2 = await sesion(null);
    let acepta2: Res = NADA;
    let ed2: Res = NADA;
    try {
      acepta2 = await t2.q(SQL_ACEPTAR, [inv2.tokenHash, "Carrera R2 b", hashFalso()]);
      const p = ejecutar(db, a.cD, "select acceso.rol_guardar($1::uuid, $2::text, $3::text, $4::text[]) as id", [Y.rolId, await nombreDe(Y.rolId), "asignado", cierreU3(["usuarios.gestionar"])]);
      await esperarEspera("%rol_guardar%");
      await t2.fin(true);
      ed2 = await p;
    } finally {
      await t2.fin(false);
    }
    const cuentas = async (correo: string) => (await adm("select count(*)::int as n from usuario where email = $1", [correo]))[0].n;
    expect({
      ed: codigo(ed),
      acepta: acepta.ok ? acepta.rows[0].r : codigo(acepta),
      cuenta: await cuentas(inv.correo),
      revocada: (await adm("select revocada_en is not null as r from invitacion where id = $1", [inv.id]))[0].r,
      acepta2: acepta2.ok ? acepta2.rows[0].r : codigo(acepta2),
      ed2: codigo(ed2),
      miembro2: (await adm("select m.rol_id from membresia m join usuario u on u.id = m.usuario_id where u.email = $1", [inv2.correo])).map((x) => x.rol_id),
    }).toEqual({ ed: "ok", acepta: "invalida", cuenta: 0, revocada: true, acepta2: "aceptada", ed2: "ok", miembro2: [Q.id] });
  });

  it("invitador desactivado o que no contiene el rol invitado (sembrado): aceptar (nueva y existente) no crea nada y se deshace todo; editar su rol revoca sus pendientes", async () => {
    const a = await base();
    const X = await er.actor(a.x.id, ["usuarios.gestionar", "clientes.ver"]);
    const Q = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const deX = await er.invitacionPropia(a.x.id, Q.id, X.id);
    const deX2 = await er.invitacionPropia(a.x.id, Q.id, X.id);
    await adm("update membresia set desactivada_en = now() where usuario_id = $1", [X.id]);
    // Y solo tiene usuarios.gestionar y una invitación (sembrada: el disparador la habría rechazado) a un rol con credenciales.editar.
    const Y = await er.actor(a.x.id, ["usuarios.gestionar"]);
    const P = await poderoso(a.x.id);
    const deY = await er.invitacionPropia(a.x.id, P.id, Y.id);
    // Cuenta existente con sesión para el camino de aceptar_existente.
    const existente = await er.cuenta();
    const deYexistente = await er.invitacionPropia(a.x.id, P.id, Y.id);
    await adm("update invitacion set correo = $1 where id = $2", [existente.correo, deYexistente.id]);
    const sesionTok = await er.esc.sesion(existente.id);
    const altas = async (): Promise<number> =>
      (await adm("select count(*)::int as n from auditoria where tenant_id = $1 and accion = 'miembro.alta'", [a.x.id]))[0].n as number;
    const altasAntes = await altas();
    const ex = await llamar(app, "select * from auth.invitacion_aceptar_existente($1, $2)", [deYexistente.tokenHash, sha256(sesionTok)]);
    const r = {
      desactivado: await aceptarNueva(deX.tokenHash),
      excede: await aceptarNueva(deY.tokenHash),
      existente: ex.ok ? ex.rows.length : codigo(ex),
    };
    // Editar el rol del invitador desactivado (sin cambiar nada) revoca lo que ya no puede dar.
    const ed = await guardar(db, a.cD, { id: X.rolId, nombre: await nombreDe(X.rolId), alcance: "asignado", permisos: cierreU3(["usuarios.gestionar", "clientes.ver"]) });
    const correos = [deX.correo, deY.correo];
    expect({
      ...r,
      ed: codigo(ed),
      revocadaX2: (await adm("select revocada_en is not null as r from invitacion where id = $1", [deX2.id]))[0].r,
      usuarios: (await adm("select count(*)::int as n from usuario where email = any($1::text[])", [correos]))[0].n,
      membresiasNuevas: (await adm("select count(*)::int as n from membresia where tenant_id = $1 and (rol_id = $2 or usuario_id = $3)", [a.x.id, P.id, existente.id]))[0].n,
      altas: (await altas()) - altasAntes,
      pendientes: (await adm("select count(*)::int as n from invitacion where id = any($1::uuid[]) and aceptada_en is not null", [[deX.id, deY.id, deYexistente.id]]))[0].n,
    }).toEqual({ desactivado: "invalida", excede: "invalida", existente: 0, ed: "ok", revocadaX2: true, usuarios: 0, membresiasNuevas: 0, altas: 0, pendientes: 0 });
  });
});

describe("R2 · (c) orden de bloqueo nuevo y cupo de usuarios (006)", () => {
  it("dos o más aceptaciones simultáneas en el límite del plan no lo superan (cupo_usuarios_aceptar + aceptar en la misma transacción)", async () => {
    const a = await base();
    // `independiente`: max_usuarios = 2 (el Dueño ya ocupa uno).
    await adm("insert into suscripcion (tenant_id, plan_id, estado) select $1, id, 'activa' from plan where codigo = 'independiente'", [a.x.id]);
    const Q = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const invs = [
      await er.invitacionPropia(a.x.id, Q.id, a.dueno.id),
      await er.invitacionPropia(a.x.id, Q.id, a.dueno.id),
      await er.invitacion(a.x.id, { invitadoPor: a.dueno.id, rol: "contador" }),
      await er.invitacion(a.x.id, { invitadoPor: a.dueno.id, rol: "lectura" }),
    ];
    const aceptarConCupo = async (tokenHash: Buffer): Promise<string> => {
      const s = await sesion(null);
      try {
        const c = await s.q(SQL_CUPO, [a.x.id]);
        if (!c.ok) return c.code;
        if (c.rows[0].ok !== true) return "sin_cupo";
        const r = await s.q(SQL_ACEPTAR, [tokenHash, "Cupo R2", hashFalso()]);
        await s.fin(r.ok);
        return r.ok ? (r.rows[0].r as string) : r.code;
      } finally {
        await s.fin(false);
      }
    };
    const rs = await Promise.all(invs.map((i) => aceptarConCupo(i.tokenHash)));
    const activos = (await adm("select count(*)::int as n from membresia where tenant_id = $1 and desactivada_en is null", [a.x.id]))[0].n;
    expect({ aceptadas: rs.filter((x) => x === "aceptada").length, otros: rs.filter((x) => x !== "aceptada" && x !== "sin_cupo"), activos }).toEqual({
      aceptadas: 1,
      otros: [],
      activos: 2,
    });
  });

  it("reactivar (bloquearMiembros -> bloquearCupo) contra aceptar (cupo_usuarios_aceptar -> aceptar) y editar/eliminar el rol a la vez: sin 40P01 y sin superar el plan", async () => {
    const a = await base();
    // `estudio`: max_usuarios = 5. Dueño + 3 activos = 4: queda un lugar, que piden una reactivación y una aceptación.
    await adm("insert into suscripcion (tenant_id, plan_id, estado) select $1, id, 'activa' from plan where codigo = 'estudio'", [a.x.id]);
    const Q = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const libre = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    for (let i = 0; i < 3; i++) await er.miembro(a.x.id, "lectura");
    const dormido = await er.miembroPropio(a.x.id, Q.id, { desactivada: true });
    const inv = await er.invitacionPropia(a.x.id, Q.id, a.dueno.id);
    const t1 = await sesion(a.x.id, a.dueno.id);
    let reac: Res = NADA;
    let acepta: string = "sin-correr";
    let otros: Res[] = [];
    try {
      // El backend: bloquearMiembros (toma acceso.roles y las filas) y luego el cupo.
      await bloquearMiembros(t1.c as never, [a.dueno.id, dormido.id]);
      const pAceptar = (async () => {
        const s = await sesion(null);
        try {
          const c = await s.q(SQL_CUPO, [a.x.id]);
          if (!c.ok) return c.code;
          if (c.rows[0].ok !== true) return "sin_cupo";
          const r = await s.q(SQL_ACEPTAR, [inv.tokenHash, "Orden R2", hashFalso()]);
          await s.fin(r.ok);
          return r.ok ? (r.rows[0].r as string) : r.code;
        } finally {
          await s.fin(false);
        }
      })();
      const pOtros = Promise.all([
        ejecutar(db, a.cD, "select acceso.rol_guardar($1::uuid, $2::text, $3::text, $4::text[]) as id", [Q.id, await nombreDe(Q.id), "asignado", cierreU3(["buzon.ver"])]),
        ejecutar(db, a.cD, "select acceso.rol_eliminar($1::uuid)", [libre.id]),
      ]);
      await esperarEspera("%cupo_usuarios_aceptar%");
      reac = await atrapar(
        (async () => {
          await bloquearCupo(t1.c as never, a.x.id);
          const [{ n }] = (await t1.c.query("select count(*)::int as n from membresia where tenant_id = $1 and desactivada_en is null", [a.x.id])).rows;
          if (n + 1 > 5) throw Object.assign(new Error("sin cupo"), { code: "sin_cupo" });
          return t1.c.query("update membresia set desactivada_en = null, updated_at = now() where usuario_id = $1 returning usuario_id", [dormido.id]);
        })(),
      );
      await t1.fin(reac.ok);
      acepta = await pAceptar;
      otros = await pOtros;
    } finally {
      await t1.fin(false);
    }
    const todos = [codigo(reac), acepta, ...otros.map(codigo)];
    const activos = (await adm("select count(*)::int as n from membresia where tenant_id = $1 and desactivada_en is null", [a.x.id]))[0].n;
    expect({ interbloqueos: todos.filter((c) => c === COD.interbloqueo || c === COD.serializacion || c === "55P03"), reac: codigo(reac), acepta, activos }).toEqual({
      interbloqueos: [],
      reac: "ok",
      acepta: "sin_cupo",
      activos: 5,
    });
  });
});

describe("R2 · (d) auditoría de invitaciones (0085) sin secretos", () => {
  it("creada con rolId, modificada con deRolId/aRolId, re-emitida solo con vence_en, revocada por rol_guardar con su conteo: ningún dato lleva correo, token ni su hash", async () => {
    const a = await base();
    const X = await er.actor(a.x.id, ["usuarios.gestionar", "credenciales.editar"]);
    const Q = await er.rol(a.x.id, { alcance: "asignado", permisos: cierreU3(["credenciales.editar"]) });
    const Q2 = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const correo = er.esc.correoNuevo();
    er.recordarCorreo(correo);
    const token = randomBytes(32);
    const creada = await ejecutar(
      db,
      ctx(a.x.id, X),
      "insert into invitacion (correo, rol, rol_id, invitado_por, token_hash, vence_en) values ($1, 'propio', $2, $3, $4, now() + interval '72 hours') returning id",
      [correo, Q.id, X.id, sha256(token)],
    );
    expect(codigo(creada)).toBe("ok");
    const id = creada.ok ? (creada.rows[0].id as string) : "";
    const token2 = randomBytes(32);
    expect(codigo(await ejecutar(db, a.cD, "update invitacion set rol_id = $1 where id = $2", [Q2.id, id]))).toBe("ok");
    expect(codigo(await ejecutar(db, a.cD, "update invitacion set rol_id = $1 where id = $2", [Q.id, id]))).toBe("ok");
    expect(codigo(await ejecutar(db, a.cD, "update invitacion set token_hash = $1, vence_en = now() + interval '80 hours' where id = $2", [sha256(token2), id]))).toBe("ok");
    expect(codigo(await guardar(db, a.cD, { id: X.rolId, nombre: await nombreDe(X.rolId), alcance: "asignado", permisos: cierreU3(["usuarios.gestionar"]) }))).toBe("ok");
    const filas = await adm(
      "select accion, usuario_id, datos from auditoria where tenant_id = $1 and (entidad_id = $2 or accion = 'rol.editado') order by ocurrida_en, id",
      [a.x.id, id],
    );
    const de = (acc: string) => filas.filter((f) => f.accion === acc);
    const texto = JSON.stringify(filas.map((f) => f.datos)).toLowerCase();
    const secretos = [correo.toLowerCase(), token.toString("hex"), sha256(token).toString("hex"), token2.toString("hex"), sha256(token2).toString("hex"), "token"].filter((s) =>
      texto.includes(s),
    );
    expect({
      creada: de("invitacion.creada").map((f) => f.datos),
      modificadas: de("invitacion.modificada").map((f) => f.datos),
      revocada: de("invitacion.revocada").map((f) => ({ datos: f.datos, actor: f.usuario_id })),
      editado: de("rol.editado").map((f) => f.datos.invitacionesRevocadas),
      secretos,
    }).toEqual({
      creada: [{ rol: "propio", rolId: Q.id }],
      modificadas: [
        { campos: ["rol_id"], deRolId: Q.id, aRolId: Q2.id },
        { campos: ["rol_id"], deRolId: Q2.id, aRolId: Q.id },
        { campos: ["vence_en"] },
      ],
      revocada: [{ datos: {}, actor: a.dueno.id }],
      editado: [1],
      secretos: [],
    });
  });
});

describe("R2 · (g) acceso.rol_impacto con la regla de U2 también en la BD", () => {
  it("un gestor con roles.gestionar que no contiene el rol (antes o después) no obtiene sus conteos llamando a la función directamente", async () => {
    // T13 movió la regla de impacto al servicio (HTTP 403); la función SECURITY DEFINER solo pide actor_gestor, a diferencia de
    // rol_guardar/rol_eliminar, que sí aplican U2 dentro de la BD.
    const a = await base();
    // El gestor necesita clientes.ver para que el control (rol «chico» con clientes.ver) sea un caso permitido por U2.
    const g = await er.actor(a.x.id, ["roles.gestionar", "usuarios.gestionar", "clientes.ver"], "asignado");
    const P = await poderoso(a.x.id);
    await er.miembroPropio(a.x.id, P.id);
    const chico = await er.rol(a.x.id, { alcance: "asignado", permisos: ["clientes.ver"] });
    const cG = ctx(a.x.id, g);
    const SQL = "select * from acceso.rol_impacto($1::uuid, $2::text, $3::text[])";
    expect({
      control: codigo(await probar(db, cG, SQL, [chico.id, "asignado", ["clientes.ver"]])),
      antesExcede: codigo(await probar(db, cG, SQL, [P.id, "asignado", ["clientes.ver"]])),
      despuesExcede: codigo(await probar(db, cG, SQL, [chico.id, "global", cierreU3(["credenciales.editar"])])),
      propio: codigo(await probar(db, cG, SQL, [g.rolId, "asignado", cierreU3(["usuarios.gestionar"])])),
    }).toEqual({ control: "ok", antesExcede: COD.escalada, despuesExcede: COD.escalada, propio: COD.rolPropio });
  });
});

describe("R2 · (e) nombre_clave: lo que se ve igual es igual (CA-1)", () => {
  // Conocida: riesgo bajo aceptado por el usuario (030) — confusables/homoglifos en nombres de rol.
  it.fails("nombres de sistema disfrazados (ancho completo, cirílico, matemático, braille en blanco) y duplicados visualmente idénticos se rechazan en la BD", async () => {
    const a = await base();
    const n = (nombre: string) => guardar(db, a.cD, { nombre, alcance: "asignado", permisos: ["clientes.ver"] });
    const base1 = `Auditor ${er.esc.marca}`;
    expect(codigo(await n(base1))).toBe("ok");
    const vistos = {
      anchoCompleto: codigo(await n("Ｄｕｅñｏ")),
      cirilico: codigo(await n("Duеño")), // е = U+0435
      matematico: codigo(await n("𝐋𝐞𝐜𝐭𝐮𝐫𝐚")),
      braille: codigo(await n("Lectura⠀")),
      ligadura: codigo(await n("Solo lectura".replace("l", "ⅼ"))), // ⅼ = U+217C (número romano 50)
      soloMarcas: codigo(await n("́́")),
      duplicadoCirilico: codigo(await n(base1.replace("A", "А"))), // А = U+0410
    };
    expect(vistos).toEqual({
      anchoCompleto: COD.check,
      cirilico: COD.check,
      matematico: COD.check,
      braille: COD.check,
      ligadura: COD.check,
      soloMarcas: COD.check,
      duplicadoCirilico: COD.duplicado,
    });
  });
});
