// Spec 017 · T15 · Ronda adversarial 1 (BD): aislamiento, inmutabilidad, actor y secretos.
// Caja negra (spec D-2..D-5, D-8..D-10; plan «Contratos: BD») y caja blanca (0041-0044, packages/db/src/{auditoria,notificaciones},
// packages/db/src/acceso/asignaciones.ts). Las pruebas en rojo son hallazgos H-017-n (ver tasks.md, «Resultado» de T15); las que
// pasan quedan como regresión. Siembra con el superusuario; las acciones, con los roles de la app (`withTenant`).
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAuditoria, abrirAdmin, exportado, type FilaAud } from "./auditoria-soporte";
import { abrirApp } from "./auth-soporte";
import type { Tx } from "./soporte";

const f = <T extends (...a: any[]) => any>(n: string) => exportado<T>(n);
const asignar = (tx: Tx, a: unknown) => f<(tx: Tx, a: unknown) => Promise<unknown>>("asignar")(tx, a);
const marcarCredencialInvalida = (tx: Tx, c: string, t: string) =>
  f<(tx: Tx, c: string, t: string) => Promise<boolean>>("marcarCredencialInvalida")(tx, c, t);
const destinatariosNuevos = (tx: Tx) => f<(tx: Tx) => Promise<string[]>>("destinatariosNuevos")(tx);

/** Roles de la app (y los internos de 004/018 que la app alcanza): ninguno usa al registrador. */
const ROLES = ["contapp_backend", "contapp_worker", "contapp_app", "contapp_platform", "contapp_auth", "contapp_enumerador"];

let admin: Pool;
let app: Pool;
let ec: EscenarioAuditoria;
let X: string;
let ux: string; // actor de las acciones del backend en X

beforeAll(async () => {
  admin = abrirAdmin(6);
  app = abrirApp(4);
  ec = new EscenarioAuditoria(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
});

afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await app?.end();
  await admin?.end();
});

/** Filas de auditoria de X que agrega `hacer` (cualquier accion). */
async function nuevas<T>(hacer: () => Promise<T>): Promise<FilaAud[]> {
  const previas = new Set((await ec.filas(X)).map((x) => x.id));
  await hacer();
  return (await ec.filas(X)).filter((x) => !previas.has(x.id));
}

async function codigoDe(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? "lanzo";
  }
}

// =================================================================================================
describe("(a) contapp_registrador e interno.*: ningún rol de la app los alcanza", () => {
  it("el registrador no tiene miembros y SET ROLE a él falla desde el login de la app, también tras SET ROLE backend/worker", async () => {
    const r = await admin.query(
      `select rolname, pg_has_role(rolname, 'contapp_registrador', 'MEMBER') as miembro,
              (select count(*)::int from pg_auth_members a join pg_roles g on g.oid = a.roleid where g.rolname = 'contapp_registrador') as n
         from pg_roles where rolname = any($1::text[])`,
      [[...ROLES, "contapp_migrator"]],
    );
    for (const fila of r.rows) expect(fila.miembro, fila.rolname).toBe(false);
    expect(r.rows[0]?.n).toBe(0);
    for (const previo of [null, "contapp_backend", "contapp_worker"]) {
      const c = await app.connect();
      try {
        await c.query("BEGIN");
        if (previo) await c.query(`SET LOCAL ROLE ${previo}`);
        expect(await codigoDe(c.query("SET LOCAL ROLE contapp_registrador")), String(previo)).toBe("42501");
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
  });

  it("sin USAGE en `interno` ni EXECUTE de las funciones que escriben; llamarlas desde backend/worker da 42501", async () => {
    const r = await admin.query(
      `select x.rol, has_schema_privilege(x.rol, 'interno', 'USAGE') as usa,
              array_agg(p.oid::regprocedure::text) filter (where has_function_privilege(x.rol, p.oid, 'EXECUTE')) as ejecuta
         from unnest($1::text[]) x(rol)
         cross join pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'interno'
           or p.oid in ('public.auditoria_registrar(uuid,text,uuid,text,uuid,jsonb,uuid)'::regprocedure,
                        'public.plan_aviso_recalcular(uuid)'::regprocedure)
        group by x.rol`,
      [["contapp_backend", "contapp_worker", "contapp_app", "contapp_platform", "contapp_enumerador"]],
    );
    for (const fila of r.rows) {
      expect(fila.usa, fila.rol).toBe(false);
      expect(fila.ejecuta ?? [], fila.rol).toEqual([]);
    }
    const tenant = X;
    const intentos = [
      "select plan_aviso_recalcular($1::uuid)",
      "select auditoria_registrar($1::uuid, 'cliente.creado', null, 'cliente', null, '{}'::jsonb)",
      "select interno.notificar($1::uuid, array[$1::uuid], 'plan_limite', null, null, '{}'::jsonb, 'x')",
      "select interno.auditoria_insertar($1::uuid, 'sistema', null, null, 'cliente.creado', null, 'cliente', null, '{}'::jsonb)",
    ];
    for (const sql of intentos) {
      expect(await codigoDe(ec.comoBackend(X, ux, (tx) => tx.query(sql, [tenant]))), `backend: ${sql}`).toBe("42501");
      expect(await codigoDe(ec.comoWorker(X, {}, (tx) => tx.query(sql, [tenant]))), `worker: ${sql}`).toBe("42501");
    }
  });
});

// =================================================================================================
describe("(b) actor e inmutabilidad: toda escritura de una acción de D-3 deja su fila", () => {
  it("H-017-1 · promover un colaborador a responsable con `asignar` (ON CONFLICT DO UPDATE) deja fila de auditoría", async () => {
    const c = await ec.cliente(X);
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, c.id, u, "colaborador");
    const filas = await nuevas(() => ec.comoBackend(X, ux, (tx) => asignar(tx, { clienteId: c.id, usuarioId: u, tipo: "responsable" })));
    // Control: el cambio sí ocurrió (el Asistente/Contador ahora es responsable y recibirá los avisos de P-4).
    const tipo = (await admin.query("select tipo from asignacion where cliente_id = $1 and usuario_id = $2", [c.id, u])).rows[0]?.tipo;
    expect(tipo).toBe("responsable");
    const deAsignacion = filas.filter((x) => x.entidad === "asignacion");
    expect(
      deAsignacion.map((x) => ({ accion: x.accion, datos: x.datos, actor: x.usuario_id })),
      "el cambio de colaborador a responsable no dejó ninguna fila en auditoria",
    ).toContainEqual({ accion: "asignacion.tipo_cambiado", datos: { de: "colaborador", a: "responsable", usuarioId: u }, actor: ux });
    // Contrato de T16 (0045): exactamente una fila para el cambio.
    expect(deAsignacion.filter((x) => x.accion === "asignacion.tipo_cambiado")).toHaveLength(1);
  });

  it("H-017-1 · cambiar de responsable con `anterior: 'colaborador'` deja rastro del responsable degradado", async () => {
    const c = await ec.cliente(X);
    const u1 = (await ec.miembro(X, "contador")).id;
    const u2 = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, c.id, u1, "responsable");
    const filas = await nuevas(() =>
      ec.comoBackend(X, ux, (tx) => asignar(tx, { clienteId: c.id, usuarioId: u2, tipo: "responsable", anterior: "colaborador" })),
    );
    const estado = (await admin.query("select usuario_id, tipo from asignacion where cliente_id = $1 order by tipo", [c.id])).rows;
    expect(estado).toEqual([
      { usuario_id: u1, tipo: "colaborador" },
      { usuario_id: u2, tipo: "responsable" },
    ]);
    const tocadas = filas.filter((x) => x.entidad === "asignacion").map((x) => (x.datos as { usuarioId?: string }).usuarioId);
    expect(tocadas, "solo u2 tiene fila: la degradación de u1 (responsable -> colaborador) no se audita").toContain(u1);
  });

  it("H-017-2 · las escrituras que los grants permiten al backend sin trigger de captura (DELETE membresia, UPDATE invitacion.rol, UPDATE asignacion.usuario_id) no dejan fila", async () => {
    const dueno = (await ec.miembro(X, "dueno")).id;
    const victima = (await ec.miembro(X, "contador")).id;
    const otro = (await ec.miembro(X, "contador")).id;
    const c = await ec.cliente(X);
    await ec.asignar(X, c.id, victima, "colaborador");
    const inv = await ec.ea.invitacion(X, { invitadoPor: dueno, rol: "asistente" });
    const mid = (await admin.query("select id from membresia where tenant_id = $1 and usuario_id = $2", [X, otro])).rows[0].id as string;

    const borrado = await nuevas(() => ec.comoBackend(X, ux, (tx) => tx.query("delete from membresia where id = $1", [mid])));
    const escalada = await nuevas(() =>
      ec.comoBackend(X, ux, (tx) => tx.query("update invitacion set rol = 'admin' where id = $1", [inv.id])),
    );
    const otroMiembro = (await ec.miembro(X, "contador")).id;
    const reasignada = await nuevas(() =>
      ec.comoBackend(X, ux, (tx) =>
        tx.query("update asignacion set usuario_id = $3 where cliente_id = $1 and usuario_id = $2", [c.id, victima, otroMiembro]),
      ),
    );
    // Control: las tres escrituras ocurrieron.
    expect((await admin.query("select count(*)::int as n from membresia where id = $1", [mid])).rows[0].n).toBe(0);
    expect((await admin.query("select rol from invitacion where id = $1", [inv.id])).rows[0].rol).toBe("admin");
    expect((await admin.query("select usuario_id from asignacion where cliente_id = $1", [c.id])).rows[0].usuario_id).toBe(otroMiembro);

    expect.soft(borrado.length, "DELETE de membresia (baja de un miembro) sin fila").toBeGreaterThan(0);
    expect.soft(escalada.length, "UPDATE de invitacion.rol (asistente -> admin) sin fila").toBeGreaterThan(0);
    expect.soft(reasignada.length, "UPDATE de asignacion.usuario_id (otro usuario ve el cliente) sin fila").toBeGreaterThan(0);
  });

  it("app.trabajo_id mal formado en el worker: la acción se revierte (falla cerrado), no queda como `sistema`", async () => {
    const c = await ec.cliente(X);
    await ec.credencialCentinela(X, c.id, `r1-${randomBytes(4).toString("hex")}`);
    const filas = await nuevas(async () => {
      const codigo = await codigoDe(
        ec.comoWorker(X, {}, async (tx) => {
          await tx.query("select set_config('app.trabajo_id', 'no-es-uuid', true)");
          return marcarCredencialInvalida(tx, c.id, "sol");
        }),
      );
      expect(codigo).toBeDefined();
    });
    expect(filas).toEqual([]);
    expect((await admin.query("select estado from credencial where cliente_id = $1", [c.id])).rows[0].estado).not.toBe("invalida");
  });

  it("0044: ni el superusuario guarda un instante con microsegundos en auditoria ni en notificacion (23514)", async () => {
    const us = "2026-01-01T00:00:00.123456Z";
    const aud = codigoDe(
      admin.query(
        `insert into auditoria (tenant_id, ocurrida_en, actor_tipo, accion, entidad, datos) values ($1, $2, 'sistema', 'sesion.ingreso', 'sesion', '{}')`,
        [X, us],
      ),
    );
    const notif = codigoDe(
      admin.query(
        `insert into notificacion (tenant_id, usuario_id, tipo, params, clave_dedupe, creada_en) values ($1, $2, 'plan_limite', '{}', $3, $4)`,
        [X, ux, `r1:${randomUUID()}`, us],
      ),
    );
    expect(await aud).toBe("23514");
    expect(await notif).toBe("23514");
  });
});

// =================================================================================================
describe("(a) GUC de sesión que las funciones SECURITY DEFINER creen", () => {
  it("H-017-3 · notificaciones_de_esta_transaccion() confía en app.notificaciones_tx: un usuario obtiene el destinatario de una notificación ajena que no creó su transacción", async () => {
    const a = (await ec.miembro(X, "contador")).id;
    const b = (await ec.miembro(X, "contador")).id;
    const ajena = randomUUID();
    await admin.query(
      `insert into notificacion (id, tenant_id, usuario_id, tipo, params, clave_dedupe)
       values ($1, $2, $3, 'plan_limite', '{"recurso":"rucs","umbral":90,"usado":9,"limite":10}', $4)`,
      [ajena, X, b, `r1:${ajena}`],
    );
    // Control: la RLS no deja a A ver la de B.
    const visible = await ec.comoBackend(X, a, (tx) => tx.query("select id from notificacion where id = $1", [ajena]));
    expect(visible.rows).toEqual([]);
    const filtrados = await ec.comoBackend(X, a, async (tx) => {
      await tx.query("select set_config('app.notificaciones_tx', $1, true)", [ajena]);
      return destinatariosNuevos(tx);
    });
    expect(filtrados, "la función devolvió el destinatario de una notificación ajena y vieja (oráculo y aviso SSE espurio)").toEqual([]);
  });
});

// =================================================================================================
describe("(c) secretos", () => {
  it("credencial con centinelas invalidada por un trabajo: ni auditoria.datos ni notificacion (params, clave) los contienen", async () => {
    const centinela = `CENT${randomBytes(6).toString("hex")}`;
    const c = await ec.cliente(X);
    await ec.miembro(X, "dueno");
    await ec.credencialCentinela(X, c.id, centinela);
    const trabajo = await ec.trabajo(X, c, ux);
    await ec.comoWorker(X, { trabajoId: trabajo }, (tx) => marcarCredencialInvalida(tx, c.id, "sol"));
    const formas = [centinela, Buffer.from(centinela).toString("hex"), Buffer.from(`ct-${centinela}`).toString("base64")];
    const volcado = [
      ...(await admin.query("select to_jsonb(a)::text as t from auditoria a where tenant_id = $1", [X])).rows,
      ...(await admin.query("select to_jsonb(n)::text as t from notificacion n where tenant_id = $1", [X])).rows,
    ].map((r) => r.t as string);
    // Control: hubo notificación y fila de la invalidación.
    expect(volcado.some((t) => t.includes("credencial.invalidada"))).toBe(true);
    expect(volcado.some((t) => t.includes("credencial_invalida:"))).toBe(true);
    for (const forma of formas) for (const t of volcado) expect(t).not.toContain(forma);
  });
});
