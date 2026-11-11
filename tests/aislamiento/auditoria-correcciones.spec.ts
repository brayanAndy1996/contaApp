// Spec 017 · T16 · Pruebas (en rojo) de las correcciones de la ronda adversarial R1: H-017-1 y H-017-2 (auditoría). Se escriben desde el
// COMPORTAMIENTO decidido, no copian las pruebas de `auditoria-r1.adv.spec.ts` (esas siguen como regresión). Las acciones se ejecutan con los
// roles de la app (`withTenant`), por la función de @contapp/db (`asignar`, `cambiarRol`) o por el SQL que los grants permiten.
//
// CONTRATO QUE FIJAN ESTAS PRUEBAS (lo implementa T17 en la migración 0045 —0044 ya existe—, el catálogo de `shared` y los textos del frontend):
//   Acciones nuevas del catálogo cerrado (CHECK de `auditoria.accion`, `ACCIONES_AUDITORIA`, texto en español del frontend):
//     asignacion.tipo_cambiado  entidad 'asignacion' (entidad_id = asignacion.id), cliente_id = el cliente, datos {de, a, usuarioId}
//     miembro.eliminado         entidad 'membresia'  (entidad_id = membresia.id), sin cliente,            datos {rol}
//     cliente.eliminado         entidad 'cliente'    (entidad_id = cliente_id = id),                      datos {}
//     invitacion.modificada     entidad 'invitacion' (entidad_id = invitacion.id), sin cliente,           datos {campos, de?, a?}
//   Capturas (triggers AFTER ... FOR EACH ROW, mismo actor y mismo falla-cerrado que 0042; `datos` EXACTOS, sin correos ni ids de más):
//     asignacion UPDATE (cualquier camino: UPDATE directo y INSERT ... ON CONFLICT DO UPDATE):
//       · cambia `tipo` (y no la clave usuario/cliente) -> asignacion.tipo_cambiado {de, a, usuarioId}
//       · cambia `usuario_id` o `cliente_id`            -> asignacion.quitada (la fila vieja) + asignacion.agregada (la nueva), con el
//                                                          {tipo, usuarioId} de cada una; nunca tipo_cambiado
//       · no cambia nada de eso (mismo tipo, solo updated_at) -> ninguna fila
//     membresia DELETE -> miembro.eliminado {rol: el rol que tenía}
//     cliente DELETE   -> cliente.eliminado {}
//     invitacion UPDATE de rol, correo o vence_en -> UNA fila invitacion.modificada con `campos` = columnas cambiadas, en orden alfabético
//       (['correo','rol','vence_en'] como máximo); `de` y `a` (rol antes y después) solo si cambió `rol`. NUNCA el correo (D-5) ni la fecha.
//       Revocar (`revocada_en`) sigue siendo solo invitacion.revocada. Un UPDATE que deja los mismos valores no deja fila.
//   (Que el DELETE de membresia y de cliente recalcule `plan_aviso` lo prueba `notificaciones-correcciones.spec.ts`.)
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAuditoria, abrirAdmin, exportado, unaFila, type FilaAud } from "./auditoria-soporte";
import type { Tx } from "./soporte";

const f = <T extends (...a: any[]) => any>(n: string) => exportado<T>(n);
const asignar = (tx: Tx, a: unknown) => f<(tx: Tx, a: unknown) => Promise<unknown>>("asignar")(tx, a);
const asignarPorUsuario = (tx: Tx, a: unknown) => f<(tx: Tx, a: unknown) => Promise<unknown>>("asignarPorUsuario")(tx, a);
const cambiarRol = (tx: Tx, usuarioId: string, rol: string, responsableAColaborador: boolean) =>
  f<(tx: Tx, u: string, r: string, c: boolean) => Promise<unknown>>("cambiarRol")(tx, usuarioId, rol, responsableAColaborador);

const TIPO_CAMBIADO = "asignacion.tipo_cambiado";

let admin: Pool;
let ec: EscenarioAuditoria;
let X: string;
let ux: string; // actor de las acciones del backend en X

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioAuditoria(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
});

afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
});

/** TODAS las filas de auditoria de X que agrega `hacer` (la siembra deja ruido: solo cuenta lo que la acción agrega). */
async function nuevas(hacer: () => Promise<unknown>): Promise<FilaAud[]> {
  const previas = new Set((await ec.filas(X)).map((x) => x.id));
  await hacer();
  return (await ec.filas(X)).filter((x) => !previas.has(x.id));
}

const backend = <T>(fn: (tx: Tx) => Promise<T>) => ec.comoBackend(X, ux, fn);
const idDe = async (sql: string, v: unknown[]): Promise<string> => (await admin.query(sql, v)).rows[0].id as string;
const asignacionId = (cliente: string, usuario: string) =>
  idDe("select id from asignacion where cliente_id = $1 and usuario_id = $2", [cliente, usuario]);
const comoUsuario = (clienteId: string | null, entidadId: string, datos: Record<string, unknown>) => ({
  actorTipo: "usuario" as const,
  usuarioId: ux,
  trabajoId: null,
  clienteId,
  entidad: "asignacion",
  entidadId,
  datos,
});
/** Resumen comparable e independiente del orden: accion|usuarioId|tipo (o de>a). */
const resumen = (filas: FilaAud[]) =>
  filas
    .map((x) => {
      const d = x.datos as { usuarioId?: string; tipo?: string; de?: string; a?: string };
      return [x.accion, d.usuarioId, d.tipo ?? `${d.de}>${d.a}`].join("|");
    })
    .sort();

// =================================================================================================
describe("H-017-1 · cambiar el tipo de una asignación deja fila (asignacion.tipo_cambiado {de, a, usuarioId})", () => {
  it("promover a un colaborador con `asignar` (INSERT ... ON CONFLICT DO UPDATE): una sola fila, con actor, cliente, entidad y datos exactos", async () => {
    const cli = await ec.cliente(X);
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u, "colaborador");
    const aid = await asignacionId(cli.id, u);
    const filas = await nuevas(() => backend((tx) => asignar(tx, { clienteId: cli.id, usuarioId: u, tipo: "responsable" })));
    expect(filas.map((x) => x.accion)).toEqual([TIPO_CAMBIADO]);
    unaFila(filas, TIPO_CAMBIADO, comoUsuario(cli.id, aid, { de: "colaborador", a: "responsable", usuarioId: u }));
  });

  it("degradar a un responsable con `asignar` (de responsable a colaborador) también deja fila", async () => {
    const cli = await ec.cliente(X);
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u, "responsable");
    const aid = await asignacionId(cli.id, u);
    const filas = await nuevas(() => backend((tx) => asignar(tx, { clienteId: cli.id, usuarioId: u, tipo: "colaborador" })));
    unaFila(filas, TIPO_CAMBIADO, comoUsuario(cli.id, aid, { de: "responsable", a: "colaborador", usuarioId: u }));
  });

  it("nuevo responsable con `anterior: 'colaborador'`: el responsable previo (UPDATE) y el alta del nuevo dejan cada uno su fila", async () => {
    const cli = await ec.cliente(X);
    const u1 = (await ec.miembro(X, "contador")).id;
    const u2 = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u1, "responsable");
    const filas = await nuevas(() =>
      backend((tx) => asignar(tx, { clienteId: cli.id, usuarioId: u2, tipo: "responsable", anterior: "colaborador" })),
    );
    expect(resumen(filas)).toEqual(
      [`${TIPO_CAMBIADO}|${u1}|responsable>colaborador`, `asignacion.agregada|${u2}|responsable`].sort(),
    );
    for (const x of filas) expect([x.actor_tipo, x.usuario_id, x.cliente_id, x.entidad]).toEqual(["usuario", ux, cli.id, "asignacion"]);
  });

  it("cambio de responsable entre dos asignados existentes: dos filas tipo_cambiado, una por usuario, en sentidos opuestos", async () => {
    const cli = await ec.cliente(X);
    const u1 = (await ec.miembro(X, "contador")).id;
    const u2 = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u1, "responsable");
    await ec.asignar(X, cli.id, u2, "colaborador");
    const filas = await nuevas(() =>
      backend((tx) => asignar(tx, { clienteId: cli.id, usuarioId: u2, tipo: "responsable", anterior: "colaborador" })),
    );
    expect(resumen(filas)).toEqual(
      [`${TIPO_CAMBIADO}|${u1}|responsable>colaborador`, `${TIPO_CAMBIADO}|${u2}|colaborador>responsable`].sort(),
    );
  });

  it("asignación en lote de un usuario a varios clientes (`asignarPorUsuario`): una fila por cliente cuyo tipo cambia, ninguna por el que ya lo tenía", async () => {
    const [c1, c2, c3] = [await ec.cliente(X), await ec.cliente(X), await ec.cliente(X)];
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, c1.id, u, "colaborador");
    await ec.asignar(X, c2.id, u, "colaborador");
    await ec.asignar(X, c3.id, u, "responsable"); // ya responsable: el lote no cambia nada aquí
    const filas = await nuevas(() =>
      backend((tx) => asignarPorUsuario(tx, { usuarioId: u, clienteIds: [c1.id, c2.id, c3.id], tipo: "responsable" })),
    );
    expect(filas.map((x) => x.accion)).toEqual([TIPO_CAMBIADO, TIPO_CAMBIADO]);
    expect(filas.map((x) => x.cliente_id).sort()).toEqual([c1.id, c2.id].sort());
  });

  it("`cambiarRol` a un rol sin sire.clasificar (D18) deja el cambio de rol y, por cada cliente, el responsable que pasó a colaborador", async () => {
    const [c1, c2] = [await ec.cliente(X), await ec.cliente(X)];
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, c1.id, u, "responsable");
    await ec.asignar(X, c2.id, u, "responsable");
    const filas = await nuevas(() => backend((tx) => cambiarRol(tx, u, "lectura", true)));
    expect(filas.map((x) => x.accion).sort()).toEqual(["miembro.rol_cambiado", TIPO_CAMBIADO, TIPO_CAMBIADO].sort());
    const tipos = filas.filter((x) => x.accion === TIPO_CAMBIADO);
    expect(tipos.map((x) => x.cliente_id).sort()).toEqual([c1.id, c2.id].sort());
    for (const x of tipos) {
      expect(x.datos).toEqual({ de: "responsable", a: "colaborador", usuarioId: u });
      expect([x.actor_tipo, x.usuario_id]).toEqual(["usuario", ux]);
    }
  });

  it("repetir el mismo tipo (ON CONFLICT DO UPDATE sin cambio) no deja fila: se audita el cambio, no la escritura", async () => {
    const cli = await ec.cliente(X);
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u, "responsable");
    const filas = await nuevas(() => backend((tx) => asignar(tx, { clienteId: cli.id, usuarioId: u, tipo: "responsable" })));
    expect(filas).toEqual([]);
  });
});

// =================================================================================================
describe("H-017-2 · lo que los grants permiten sin ruta de la app queda auditado por triggers (sin cambiar permisos)", () => {
  it("DELETE de membresia -> miembro.eliminado {rol}, con el actor de la sesión y sin cliente", async () => {
    const m = (await ec.miembro(X, "contador")).id;
    const mid = await idDe("select id from membresia where tenant_id = $1 and usuario_id = $2", [X, m]);
    const filas = await nuevas(() => backend((tx) => tx.query("delete from membresia where id = $1", [mid])));
    unaFila(filas, "miembro.eliminado", {
      actorTipo: "usuario",
      usuarioId: ux,
      trabajoId: null,
      clienteId: null,
      entidad: "membresia",
      entidadId: mid,
      datos: { rol: "contador" },
    });
  });

  it("DELETE de cliente -> cliente.eliminado {} con el cliente en `cliente_id` y `entidad_id`", async () => {
    const cid = await ec.ea.cliente(X);
    const filas = await nuevas(() => backend((tx) => tx.query("delete from cliente where id = $1", [cid])));
    unaFila(filas, "cliente.eliminado", {
      actorTipo: "usuario",
      usuarioId: ux,
      trabajoId: null,
      clienteId: cid,
      entidad: "cliente",
      entidadId: cid,
      datos: {},
    });
  });

  it("DELETE de cliente hecho por el worker dentro de un trabajo: actor `trabajo` (con el creador del trabajo)", async () => {
    const propio = await ec.cliente(X); // el cliente del trabajo (no se borra)
    const cid = await ec.ea.cliente(X);
    const trabajo = await ec.trabajo(X, propio, ux);
    const filas = await nuevas(() => ec.comoWorker(X, { trabajoId: trabajo }, (tx) => tx.query("delete from cliente where id = $1", [cid])));
    unaFila(filas, "cliente.eliminado", {
      actorTipo: "trabajo",
      usuarioId: ux,
      trabajoId: trabajo,
      clienteId: cid,
      entidad: "cliente",
      entidadId: cid,
      datos: {},
    });
  });

  it("UPDATE de asignacion.usuario_id (reasignación): quitada del usuario anterior y agregada al nuevo, ambas con el cliente y el tipo", async () => {
    const cli = await ec.cliente(X);
    const u1 = (await ec.miembro(X, "contador")).id;
    const u2 = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u1, "colaborador");
    const aid = await asignacionId(cli.id, u1);
    const filas = await nuevas(() =>
      backend((tx) => tx.query("update asignacion set usuario_id = $3 where cliente_id = $1 and usuario_id = $2", [cli.id, u1, u2])),
    );
    expect(filas.map((x) => x.accion).sort()).toEqual(["asignacion.agregada", "asignacion.quitada"]);
    for (const x of filas) expect([x.actor_tipo, x.usuario_id, x.cliente_id, x.entidad, x.entidad_id]).toEqual(["usuario", ux, cli.id, "asignacion", aid]);
    expect(filas.find((x) => x.accion === "asignacion.quitada")?.datos).toEqual({ tipo: "colaborador", usuarioId: u1 });
    expect(filas.find((x) => x.accion === "asignacion.agregada")?.datos).toEqual({ tipo: "colaborador", usuarioId: u2 });
  });

  it("UPDATE de asignacion.cliente_id (el usuario pasa a otro cliente): quitada en el cliente viejo y agregada en el nuevo", async () => {
    const [c1, c2] = [await ec.cliente(X), await ec.cliente(X)];
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, c1.id, u, "responsable");
    const filas = await nuevas(() =>
      backend((tx) => tx.query("update asignacion set cliente_id = $2 where cliente_id = $1 and usuario_id = $3", [c1.id, c2.id, u])),
    );
    const quitada = filas.find((x) => x.accion === "asignacion.quitada");
    const agregada = filas.find((x) => x.accion === "asignacion.agregada");
    expect(filas).toHaveLength(2);
    expect([quitada?.cliente_id, agregada?.cliente_id]).toEqual([c1.id, c2.id]);
    expect([quitada?.datos, agregada?.datos]).toEqual([
      { tipo: "responsable", usuarioId: u },
      { tipo: "responsable", usuarioId: u },
    ]);
  });

  it("UPDATE directo de asignacion.tipo (sin pasar por `asignar`) deja asignacion.tipo_cambiado; tocar solo `updated_at` no deja nada", async () => {
    const cli = await ec.cliente(X);
    const u = (await ec.miembro(X, "contador")).id;
    await ec.asignar(X, cli.id, u, "colaborador");
    const aid = await asignacionId(cli.id, u);
    const solo = await nuevas(() => backend((tx) => tx.query("update asignacion set updated_at = now() where id = $1", [aid])));
    expect(solo).toEqual([]);
    const filas = await nuevas(() => backend((tx) => tx.query("update asignacion set tipo = 'responsable' where id = $1", [aid])));
    unaFila(filas, TIPO_CAMBIADO, comoUsuario(cli.id, aid, { de: "colaborador", a: "responsable", usuarioId: u }));
  });

  it("UPDATE de invitacion.rol (asistente -> admin): invitacion.modificada {campos: ['rol'], de, a}", async () => {
    const dueno = (await ec.miembro(X, "dueno")).id;
    const inv = await ec.ea.invitacion(X, { invitadoPor: dueno, rol: "asistente" });
    const filas = await nuevas(() => backend((tx) => tx.query("update invitacion set rol = 'admin' where id = $1", [inv.id])));
    unaFila(filas, "invitacion.modificada", {
      actorTipo: "usuario",
      usuarioId: ux,
      trabajoId: null,
      clienteId: null,
      entidad: "invitacion",
      entidadId: inv.id,
      datos: { campos: ["rol"], de: "asistente", a: "admin" },
    });
  });

  it("UPDATE de invitacion.correo: invitacion.modificada {campos: ['correo']} y ni el correo viejo ni el nuevo aparecen en ninguna fila de auditoría (D-5)", async () => {
    const dueno = (await ec.miembro(X, "dueno")).id;
    const inv = await ec.ea.invitacion(X, { invitadoPor: dueno });
    const nuevo = `r1-${randomUUID().slice(0, 8)}@correcciones.test`;
    const filas = await nuevas(() => backend((tx) => tx.query("update invitacion set correo = $2 where id = $1", [inv.id, nuevo])));
    unaFila(filas, "invitacion.modificada", {
      actorTipo: "usuario",
      usuarioId: ux,
      trabajoId: null,
      clienteId: null,
      entidad: "invitacion",
      entidadId: inv.id,
      datos: { campos: ["correo"] },
    });
    const volcado = (await admin.query("select to_jsonb(a)::text as t from auditoria a where tenant_id = $1", [X])).rows.map((r) => r.t as string);
    for (const t of volcado) {
      expect(t).not.toContain(inv.correo);
      expect(t).not.toContain(nuevo);
    }
  });

  it("UPDATE de invitacion.vence_en: invitacion.modificada {campos: ['vence_en']} sin la fecha", async () => {
    const dueno = (await ec.miembro(X, "dueno")).id;
    const inv = await ec.ea.invitacion(X, { invitadoPor: dueno });
    const filas = await nuevas(() =>
      backend((tx) => tx.query("update invitacion set vence_en = vence_en + interval '30 days' where id = $1", [inv.id])),
    );
    unaFila(filas, "invitacion.modificada", {
      actorTipo: "usuario",
      usuarioId: ux,
      trabajoId: null,
      clienteId: null,
      entidad: "invitacion",
      entidadId: inv.id,
      datos: { campos: ["vence_en"] },
    });
  });

  it("un UPDATE que cambia rol, correo y vence_en a la vez deja UNA fila con los tres campos en orden alfabético", async () => {
    const dueno = (await ec.miembro(X, "dueno")).id;
    const inv = await ec.ea.invitacion(X, { invitadoPor: dueno, rol: "lectura" });
    const filas = await nuevas(() =>
      backend((tx) =>
        tx.query("update invitacion set rol = 'contador', correo = $2, vence_en = vence_en + interval '1 day' where id = $1", [
          inv.id,
          `r1-${randomUUID().slice(0, 8)}@correcciones.test`,
        ]),
      ),
    );
    expect(filas.map((x) => x.accion)).toEqual(["invitacion.modificada"]);
    expect(filas[0]?.datos).toEqual({ campos: ["correo", "rol", "vence_en"], de: "lectura", a: "contador" });
  });

  it("revocar una invitación sigue dejando solo invitacion.revocada, y un UPDATE que no cambia valores no deja fila", async () => {
    const dueno = (await ec.miembro(X, "dueno")).id;
    const inv = await ec.ea.invitacion(X, { invitadoPor: dueno });
    const igual = await nuevas(() => backend((tx) => tx.query("update invitacion set rol = rol, correo = correo where id = $1", [inv.id])));
    expect(igual).toEqual([]);
    const filas = await nuevas(() => backend((tx) => tx.query("update invitacion set revocada_en = now() where id = $1", [inv.id])));
    expect(filas.map((x) => x.accion)).toEqual(["invitacion.revocada"]);
  });
});
