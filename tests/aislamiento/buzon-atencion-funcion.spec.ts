// Spec 024 (T2, rojo): funcion acotada buzon_atencion_aplicar en BD real (D-5 a D-8, U-1, U-2, U-3; CA-4, CA-5, CA-7, CA-10).
// Quien llama (42501), validacion (22023), ids ajenos (P0002), cliente archivado (55000), critico sin comentario (22004), marcar,
// deshacer y volver a marcar, historico (U-2), ya atendido, auditoria sin el comentario, cero efectos sobre notificaciones, estado
// del cliente y trabajos, y leido_sunat intacto. Falla hoy porque la migracion 0060 aun no existe. Contrato en buzon-atencion-soporte.ts.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import {
  abrirAdmin,
  aplicar,
  aplicarRevierte,
  comoRol,
  conExecute,
  crearDb,
  EscenarioAtencion,
  estadoMensaje,
  eventosDe,
  FIRMA_APLICAR,
  idsNuevos,
  infoFuncion,
  insertarMensaje,
  ROLES_EXEC,
  type ClientePrueba,
} from "./buzon-atencion-soporte";

let admin: Pool;
let ea: EscenarioAtencion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let uC: string; // contador de X
let uO: string; // asistente de X
let uD: string; // miembro desactivado de X
let uY: string; // contador de Y
let c1: ClientePrueba;
let c2: ClientePrueba;
let cArch: ClientePrueba; // archivado
let cy: ClientePrueba;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ea = new EscenarioAtencion(admin);
  X = (await ea.estudio()).id;
  Y = (await ea.estudio()).id;
  uC = (await ea.et.miembro(X, "contador")).id;
  uO = (await ea.et.miembro(X, "asistente")).id;
  uD = (await ea.et.miembro(X, "contador", { desactivada: true })).id;
  uY = (await ea.et.miembro(Y, "contador")).id;
  c1 = await ea.et.cliente(X);
  c2 = await ea.et.cliente(X);
  cArch = await ea.clienteCon(X, { cred: null, archivado: true });
  cy = await ea.et.cliente(Y);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 2);
});
afterAll(async () => {
  await ea?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const ctx = (userId: string = uC) => ({ tenantId: X, userId });
const msg = (
  clienteId: string,
  o: Parameters<typeof insertarMensaje>[3] = {},
) => insertarMensaje(admin, X, clienteId, o);
const critico = (clienteId: string) =>
  msg(clienteId, { critico: true, avisado: true, categoria: "coactiva" });
const revierte = (
  cliente: string | null,
  ids: unknown[],
  accion: string,
  comentario: string | null = null,
  userId: string = uC,
) => aplicarRevierte(backend, ctx(userId), cliente, ids, accion, comentario);
const rechazo = (
  r: { ok: boolean; code?: string },
  code: string,
  nombre = "",
) => {
  expect(r.ok, `${nombre}: debia fallar`).toBe(false);
  if (!r.ok) expect((r as { code: string }).code, nombre).toBe(code);
};

describe("la funcion en el catalogo (CA-10)", () => {
  it("existe, es SECURITY DEFINER de contapp_migrator, con search_path fijo, y solo contapp_backend la ejecuta", async () => {
    const i = await infoFuncion(admin, FIRMA_APLICAR);
    expect(i).toEqual({
      secdef: true,
      config: ["search_path=pg_catalog, pg_temp"],
      dueno: "contapp_migrator",
      duenoSuper: false,
      duenoBypass: false,
    });
    expect(await conExecute(admin, FIRMA_APLICAR, ROLES_EXEC)).toEqual([
      "contapp_backend",
    ]);
  });

  it("el worker no puede llamarla (42501) y contapp_app tampoco", async () => {
    const m = await msg(c1.id);
    const r = await aplicarRevierte(
      worker,
      { tenantId: X },
      c1.id,
      [m],
      "marcar",
      null,
    );
    rechazo(r, "42501", "worker");
    const app = await comoRol(admin, "contapp_app", X, async (c) => {
      await c.query("SAVEPOINT s");
      try {
        await c.query(
          "select * from buzon_atencion_aplicar($1::uuid, $2::uuid[], 'marcar', null)",
          [c1.id, [m]],
        );
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(app).toBe("42501");
  });
});

describe("quien llama: estudio, usuario y membresia activa (42501)", () => {
  it("sin estudio en la sesion", async () => {
    const m = await msg(c1.id);
    const r = await comoRol(admin, "contapp_backend", null, async (c) => {
      await c.query("select set_config('app.user_id', $1, true)", [uC]);
      await c.query("SAVEPOINT s");
      try {
        await c.query(
          "select * from buzon_atencion_aplicar($1::uuid, $2::uuid[], 'marcar', null)",
          [c1.id, [m]],
        );
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(r).toBe("42501");
    expect((await estadoMensaje(admin, m)).atendido_en).toBeNull();
  });

  it("sin usuario en la sesion", async () => {
    const m = await msg(c1.id);
    const r = await aplicarRevierte(
      backend,
      { tenantId: X },
      c1.id,
      [m],
      "marcar",
      null,
    );
    rechazo(r, "42501");
  });

  it("miembro desactivado, usuario sin membresia en el estudio y usuario de otro estudio", async () => {
    const m = await msg(c1.id);
    rechazo(
      await revierte(c1.id, [m], "marcar", null, uD),
      "42501",
      "desactivado",
    );
    rechazo(
      await revierte(c1.id, [m], "marcar", null, uY),
      "42501",
      "de otro estudio",
    );
    rechazo(
      await revierte(c1.id, [m], "marcar", null, randomUUID()),
      "42501",
      "inexistente",
    );
    expect((await estadoMensaje(admin, m)).atendido_en).toBeNull();
    expect(await eventosDe(admin, m)).toEqual([]);
  });
});

describe("validacion de la entrada (22023)", () => {
  let m: string;
  beforeAll(async () => {
    m = await msg(c1.id);
  });

  it("accion distinta de marcar o deshacer", async () => {
    for (const accion of ["borrar", "", "MARCAR", "atendido"])
      rechazo(
        await revierte(c1.id, [m], accion),
        "22023",
        `accion '${accion}'`,
      );
  });

  it("0 ids, 101 ids, arreglo nulo, ids nulos o repetidos", async () => {
    rechazo(await revierte(c1.id, [], "marcar"), "22023", "0 ids");
    rechazo(
      await revierte(c1.id, idsNuevos(101), "marcar"),
      "22023",
      "101 ids",
    );
    rechazo(
      await revierte(c1.id, null as unknown as unknown[], "marcar"),
      "22023",
      "arreglo nulo",
    );
    rechazo(await revierte(c1.id, [m, null], "marcar"), "22023", "id nulo");
    rechazo(await revierte(c1.id, [m, m], "marcar"), "22023", "repetido");
  });

  it("comentario no nulo e invalido: vacio, solo espacios, de 501, con control o con bidi", async () => {
    const malos: [string, string][] = [
      ["vacio", ""],
      ["solo espacios", "   \n  "],
      ["501 caracteres", "a".repeat(501)],
      ["control BEL", "hola\u0007"],
      ["bidi U+202E", "hola\u202Emundo"],
      ["bidi U+2067", "hola\u2067mundo"],
      ["marca U+200F", "hola\u200Fmundo"],
      ["marca U+061C", "hola\u061Cmundo"],
    ];
    for (const [nombre, c] of malos)
      rechazo(await revierte(c1.id, [m], "marcar", c), "22023", nombre);
    rechazo(
      await revierte(c1.id, [m], "deshacer", "a".repeat(501)),
      "22023",
      "deshacer 501",
    );
  });

  it("deshacer en lote (p_cliente nulo) no existe (U-3)", async () => {
    rechazo(await revierte(null, [m], "deshacer"), "22023");
  });

  it("la validacion de 22023 llega antes que la busqueda de ids (ids al azar no dan P0002)", async () => {
    rechazo(await revierte(c1.id, idsNuevos(101), "marcar"), "22023");
  });
});

describe("ids que no corresponden (P0002) y cliente archivado (55000, U-1)", () => {
  it("un id inexistente da P0002 y no cambia nada", async () => {
    const m = await msg(c1.id);
    rechazo(await revierte(c1.id, [m, randomUUID()], "marcar"), "P0002");
    rechazo(await revierte(null, [m, randomUUID()], "marcar"), "P0002");
    expect(await eventosDe(admin, m)).toEqual([]);
    expect((await estadoMensaje(admin, m)).atendido_en).toBeNull();
  });

  it("un mensaje de otro estudio da P0002 (lote y individual) y los demas del lote quedan sin cambios", async () => {
    const propio = await msg(c1.id);
    const ajeno = await insertarMensaje(admin, Y, cy.id, {});
    rechazo(await revierte(null, [propio, ajeno], "marcar"), "P0002", "lote");
    rechazo(
      await revierte(c1.id, [ajeno], "marcar"),
      "P0002",
      "individual con su cliente",
    );
    rechazo(
      await revierte(cy.id, [ajeno], "marcar"),
      "P0002",
      "con el cliente de otro estudio",
    );
    expect(await eventosDe(admin, propio)).toEqual([]);
    expect(await eventosDe(admin, ajeno)).toEqual([]);
    expect((await estadoMensaje(admin, ajeno)).atendido_en).toBeNull();
  });

  it("un mensaje de otro cliente que p_cliente da P0002 y no cambia el resto", async () => {
    const a = await msg(c1.id);
    const b = await msg(c2.id);
    rechazo(await revierte(c1.id, [a, b], "marcar"), "P0002");
    expect(await eventosDe(admin, a)).toEqual([]);
    expect(await eventosDe(admin, b)).toEqual([]);
    // Sin p_cliente (lote) los dos clientes del mismo estudio si se admiten juntos.
    const ok = await revierte(null, [a, b], "marcar");
    expect(ok.ok).toBe(true);
  });

  it("un cliente archivado da 55000 (marcar y deshacer), por p_cliente o dentro de un lote, y no cambia nada", async () => {
    const a = await msg(cArch.id);
    const normal = await msg(c1.id);
    // atendido antes de archivar el cliente (siembra del superusuario) para poder probar deshacer
    const previo = await msg(cArch.id);
    await admin.query(
      "update buzon_mensaje set atendido_en = now(), atendido_por = $2 where id = $1",
      [previo, uC],
    );
    rechazo(
      await revierte(cArch.id, [a], "marcar"),
      "55000",
      "marcar individual",
    );
    rechazo(
      await revierte(null, [normal, a], "marcar"),
      "55000",
      "lote con uno archivado",
    );
    rechazo(
      await revierte(cArch.id, [previo], "deshacer"),
      "55000",
      "deshacer",
    );
    expect(await eventosDe(admin, a)).toEqual([]);
    expect(await eventosDe(admin, normal)).toEqual([]);
    expect((await estadoMensaje(admin, previo)).atendido_en).not.toBeNull();
  });
});

describe("comentario obligatorio en un critico (22004, D-7)", () => {
  it("marcar un critico sin comentario da 22004; con comentario, funciona; deshacer no lo exige", async () => {
    const k = await critico(c1.id);
    rechazo(await revierte(c1.id, [k], "marcar", null), "22004");
    expect(await eventosDe(admin, k)).toEqual([]);
    const ok = await aplicar(
      backend,
      ctx(),
      c1.id,
      [k],
      "marcar",
      "Se presento el descargo",
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.aplicado).toBe(true);
    const des = await aplicar(backend, ctx(), c1.id, [k], "deshacer", null);
    expect(des[0]!.aplicado).toBe(true);
    expect((await estadoMensaje(admin, k)).atendido_en).toBeNull();
  });

  it("un lote con un critico y sin comentario da 22004 a TODO el lote: ningun mensaje queda atendido", async () => {
    const a = await msg(c1.id);
    const b = await msg(c1.id);
    const k = await critico(c1.id);
    rechazo(await revierte(null, [a, k, b], "marcar", null), "22004");
    rechazo(
      await revierte(c1.id, [a, k, b], "marcar", null),
      "22004",
      "con p_cliente",
    );
    for (const id of [a, b, k]) {
      expect((await estadoMensaje(admin, id)).atendido_en, id).toBeNull();
      expect(await eventosDe(admin, id), id).toEqual([]);
    }
    const ok = await aplicar(
      backend,
      ctx(),
      null,
      [a, k, b],
      "marcar",
      "Revisado en lote",
    );
    expect(ok.map((x) => x.aplicado)).toEqual([true, true, true]);
  });

  it("un lote sin criticos no necesita comentario", async () => {
    const a = await msg(c1.id);
    const b = await msg(c2.id);
    const r = await aplicar(backend, ctx(), null, [a, b], "marcar", null);
    expect(r.every((x) => x.aplicado)).toBe(true);
  });
});

describe("marcar, deshacer y volver a marcar (D-5, CA-4, CA-5)", () => {
  it("deja tres eventos en orden y el estado correcto, con el usuario de cada paso", async () => {
    const m = await msg(c1.id);
    const marcar1 = await aplicar(
      backend,
      ctx(uC),
      c1.id,
      [m],
      "marcar",
      "  Primera revision  ",
    );
    expect(marcar1).toHaveLength(1);
    expect(marcar1[0]).toMatchObject({
      mensaje_id: m,
      aplicado: true,
      atendido_por: uC,
    });
    expect(marcar1[0]!.atendido_en).toBeInstanceOf(Date);
    let e = await estadoMensaje(admin, m);
    expect(e.atendido_por).toBe(uC);
    expect(e.atendido_en).not.toBeNull();

    // Deshace OTRA persona (D-5): cualquiera con el permiso sobre el cliente.
    const des = await aplicar(
      backend,
      ctx(uO),
      c1.id,
      [m],
      "deshacer",
      "Era de otro cliente",
    );
    expect(des[0]).toMatchObject({
      mensaje_id: m,
      aplicado: true,
      atendido_por: null,
      atendido_en: null,
    });
    e = await estadoMensaje(admin, m);
    expect(e.atendido_en).toBeNull();
    expect(e.atendido_por).toBeNull();

    const marcar2 = await aplicar(backend, ctx(uO), c1.id, [m], "marcar", null);
    expect(marcar2[0]).toMatchObject({ aplicado: true, atendido_por: uO });
    e = await estadoMensaje(admin, m);
    expect(e.atendido_por).toBe(uO);

    const ev = await eventosDe(admin, m);
    expect(
      ev.map((x) => [
        x.accion,
        x.usuario_id,
        x.comentario,
        x.tenant_id,
        x.cliente_id,
      ]),
    ).toEqual([
      ["atendido", uC, "Primera revision", X, c1.id], // recortado
      ["deshecho", uO, "Era de otro cliente", X, c1.id],
      ["atendido", uO, null, X, c1.id],
    ]);
    expect(ev[0]!.creado_en.getTime()).toBeLessThanOrEqual(
      ev[1]!.creado_en.getTime(),
    );
    expect(ev[1]!.creado_en.getTime()).toBeLessThanOrEqual(
      ev[2]!.creado_en.getTime(),
    );
  });

  it("el comentario admite saltos de linea y se guarda tal cual, sin interpretarlo", async () => {
    const m = await msg(c1.id);
    const texto = '<img src=x onerror=alert(1)>\nSegunda linea & "comillas"';
    await aplicar(backend, ctx(), c1.id, [m], "marcar", texto);
    expect((await eventosDe(admin, m))[0]!.comentario).toBe(texto);
  });

  it("un lote por p_cliente nulo marca mensajes de dos clientes y devuelve una fila por id", async () => {
    const a = await msg(c1.id);
    const b = await msg(c2.id);
    const r = await aplicar(backend, ctx(), null, [b, a], "marcar", "Lote");
    expect(r.map((x) => x.mensaje_id).sort()).toEqual([a, b].sort());
    expect(r.every((x) => x.aplicado && x.atendido_por === uC)).toBe(true);
    for (const id of [a, b]) expect(await eventosDe(admin, id)).toHaveLength(1);
  });

  it("la fecha del estado es la del evento y la devuelve la funcion", async () => {
    const m = await msg(c1.id);
    const r = await aplicar(backend, ctx(), c1.id, [m], "marcar");
    const e = await estadoMensaje(admin, m);
    const ev = await eventosDe(admin, m);
    expect(e.atendido_en!.getTime()).toBe(r[0]!.atendido_en!.getTime());
    expect(
      Math.abs(ev[0]!.creado_en.getTime() - e.atendido_en!.getTime()),
    ).toBeLessThan(2000);
  });
});

describe("ya atendido o no atendido (aplicado = false, sin evento; D-6)", () => {
  it("marcar uno ya atendido devuelve aplicado = false con el estado vigente y no deja evento", async () => {
    const m = await msg(c1.id);
    await aplicar(backend, ctx(uC), c1.id, [m], "marcar", "Primero");
    const r = await aplicar(backend, ctx(uO), c1.id, [m], "marcar", "Segundo");
    expect(r[0]).toMatchObject({
      mensaje_id: m,
      aplicado: false,
      atendido_por: uC,
    });
    expect(r[0]!.atendido_en).not.toBeNull();
    const ev = await eventosDe(admin, m);
    expect(ev).toHaveLength(1);
    expect((await estadoMensaje(admin, m)).atendido_por).toBe(uC);
  });

  it("deshacer uno que no esta atendido devuelve aplicado = false y no deja evento", async () => {
    const m = await msg(c1.id);
    const r = await aplicar(backend, ctx(), c1.id, [m], "deshacer");
    expect(r[0]).toMatchObject({
      mensaje_id: m,
      aplicado: false,
      atendido_por: null,
      atendido_en: null,
    });
    expect(await eventosDe(admin, m)).toEqual([]);
  });

  it("en un lote mezclado marca los pendientes y omite los ya atendidos, un evento y una auditoria solo por los marcados", async () => {
    const hecho = await msg(c1.id);
    const a = await msg(c1.id);
    const b = await msg(c2.id);
    await aplicar(backend, ctx(uO), c1.id, [hecho], "marcar", "Antes");
    const r = await aplicar(
      backend,
      ctx(uC),
      null,
      [a, hecho, b],
      "marcar",
      "Lote",
    );
    const por = Object.fromEntries(r.map((x) => [x.mensaje_id, x]));
    expect(por[a]!.aplicado).toBe(true);
    expect(por[b]!.aplicado).toBe(true);
    expect(por[hecho]).toMatchObject({ aplicado: false, atendido_por: uO });
    expect(await eventosDe(admin, hecho)).toHaveLength(1);
    expect(await eventosDe(admin, a)).toHaveLength(1);
  });
});

describe("historicos (U-2, D-12): deshacer un historico atendido lo deja historico", () => {
  it("un historico se puede atender; al deshacer vuelve a historico y no a pendiente", async () => {
    const c = await ea.et.cliente(X); // primera sincronizacion: sin estado
    const h = await insertarMensaje(admin, X, c.id, { fechaHace: "45 days" });
    expect((await estadoMensaje(admin, h)).historico).toBe(true);
    const r = await aplicar(backend, ctx(), c.id, [h], "marcar", null);
    expect(r[0]!.aplicado).toBe(true);
    let e = await estadoMensaje(admin, h);
    expect(e.historico, "sigue siendo historico").toBe(true);
    expect(e.atendido_en).not.toBeNull();
    const d = await aplicar(backend, ctx(uO), c.id, [h], "deshacer", null);
    expect(d[0]!.aplicado).toBe(true);
    e = await estadoMensaje(admin, h);
    expect(e.historico, "vuelve a Historicos, no a Pendientes").toBe(true);
    expect(e.atendido_en).toBeNull();
    expect(e.atendido_por).toBeNull();
    expect(await eventosDe(admin, h)).toHaveLength(2);
  });
});

describe("auditoria (D-8, CA-5): una por mensaje, sin el texto del comentario", () => {
  const CANARIO = "CANARIO-ATENCION-7f3a91c2";

  const auditoria = async (accion: string, mensajeIds: string[]) =>
    (
      await admin.query(
        `select * from auditoria where tenant_id = $1 and accion = $2 and entidad_id = any($3::uuid[]) order by ocurrida_en, id`,
        [X, accion, mensajeIds],
      )
    ).rows;

  it("marcar y deshacer individuales dejan buzon.atendido y buzon.atencion_deshecha con actor usuario y datos solo de ids", async () => {
    const m = await msg(c1.id);
    await aplicar(backend, ctx(uC), c1.id, [m], "marcar", `Nota ${CANARIO}`);
    await aplicar(backend, ctx(uO), c1.id, [m], "deshacer", null);
    const [at] = await auditoria("buzon.atendido", [m]);
    const [de] = await auditoria("buzon.atencion_deshecha", [m]);
    expect(at).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: uC,
      entidad: "buzon_mensaje",
      entidad_id: m,
    });
    expect(at.datos).toEqual({
      mensajeId: m,
      clienteId: c1.id,
      conComentario: true,
      lote: false,
    });
    expect(de).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: uO,
      entidad: "buzon_mensaje",
      entidad_id: m,
    });
    expect(de.datos).toEqual({
      mensajeId: m,
      clienteId: c1.id,
      conComentario: false,
      lote: false,
    });
  });

  it("un lote deja una auditoria por mensaje marcado con lote = true, y ninguna por los omitidos", async () => {
    const hecho = await msg(c1.id);
    const a = await msg(c1.id);
    const b = await msg(c2.id);
    await aplicar(backend, ctx(uO), c1.id, [hecho], "marcar", null);
    await aplicar(
      backend,
      ctx(uC),
      null,
      [a, hecho, b],
      "marcar",
      `Lote ${CANARIO}`,
    );
    const filas = await auditoria("buzon.atendido", [a, hecho, b]);
    expect(filas.map((f) => f.entidad_id).sort()).toEqual([a, b, hecho].sort());
    const delLote = filas.filter((f) => f.datos.lote === true);
    expect(delLote.map((f) => f.entidad_id).sort()).toEqual([a, b].sort());
    for (const f of delLote) {
      expect(f.datos).toEqual({
        mensajeId: f.entidad_id,
        clienteId: f.entidad_id === a ? c1.id : c2.id,
        conComentario: true,
        lote: true,
      });
      expect(f.usuario_id).toBe(uC);
    }
    expect(filas.filter((f) => f.entidad_id === hecho)).toHaveLength(1); // solo la individual de antes
  });

  it("el canario del comentario no aparece en ninguna fila de auditoria del estudio", async () => {
    const m = await msg(c1.id);
    await aplicar(
      backend,
      ctx(),
      c1.id,
      [m],
      "marcar",
      `Dato personal ${CANARIO}`,
    );
    const r = await admin.query(
      "select count(*)::int as n from auditoria a where a.tenant_id = $1 and a::text like $2",
      [X, `%${CANARIO}%`],
    );
    expect(r.rows[0].n).toBe(0);
    // En cambio el historial si lo conserva (unico lugar permitido).
    expect((await eventosDe(admin, m))[0]!.comentario).toContain(CANARIO);
  });

  it("una llamada rechazada (22004, P0002, 55000) no deja auditoria ni evento", async () => {
    const k = await critico(c1.id);
    const antes = (
      await admin.query(
        "select count(*)::int as n from auditoria where tenant_id = $1 and accion in ('buzon.atendido', 'buzon.atencion_deshecha')",
        [X],
      )
    ).rows[0].n;
    await revierte(c1.id, [k], "marcar", null);
    await revierte(c1.id, [randomUUID()], "marcar");
    const despues = (
      await admin.query(
        "select count(*)::int as n from auditoria where tenant_id = $1 and accion in ('buzon.atendido', 'buzon.atencion_deshecha')",
        [X],
      )
    ).rows[0].n;
    expect(despues).toBe(antes);
  });
});

describe("sin efectos laterales (D-14, CA-4): ni notificaciones, ni estado del cliente, ni trabajos, ni leido_sunat", () => {
  it("marcar, deshacer y un lote no crean filas en notificacion, buzon_estado_cliente ni job_registro", async () => {
    const c = await ea.clienteCon(X, { cred: "configurada" });
    const k = await critico(c.id);
    const a = await msg(c.id);
    const antes = {
      notificacion: await ea.contar(X, "notificacion"),
      estado: await ea.contar(X, "buzon_estado_cliente"),
      jobs: await ea.contar(X, "job_registro"),
    };
    await aplicar(backend, ctx(), c.id, [k], "marcar", "Atendido");
    await aplicar(backend, ctx(uO), c.id, [k], "deshacer", null);
    await aplicar(backend, ctx(), null, [k, a], "marcar", "Lote");
    const despues = {
      notificacion: await ea.contar(X, "notificacion"),
      estado: await ea.contar(X, "buzon_estado_cliente"),
      jobs: await ea.contar(X, "job_registro"),
    };
    expect(despues).toEqual(antes);
  });

  it("no cambia leido_sunat (ni a true ni a false), ni ultima_captura_en ni el contenido", async () => {
    const noLeido = await msg(c1.id, { leido: false });
    const leido = await msg(c1.id, { leido: true });
    const foto = async (id: string) =>
      (
        await admin.query(
          "select leido_sunat, ultima_captura_en, contenido_ruta, avisado, critico, categoria from buzon_mensaje where id = $1",
          [id],
        )
      ).rows[0];
    const antes = [await foto(noLeido), await foto(leido)];
    await aplicar(backend, ctx(), c1.id, [noLeido], "marcar");
    await aplicar(backend, ctx(), c1.id, [leido], "marcar");
    await aplicar(backend, ctx(uO), c1.id, [noLeido], "deshacer");
    expect([await foto(noLeido), await foto(leido)]).toEqual(antes);
    expect(antes[0].leido_sunat).toBe(false);
    expect(antes[1].leido_sunat).toBe(true);
  });
});
