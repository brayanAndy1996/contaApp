// Spec 023 (T4, rojo): aviso del mensaje critico y auditoria del buzon en BD real (D-9, P-5, P-8; CA-6, CA-13). Destinatarios
// (responsable activo; si no, Duenos y Administradores activos, igual que 0043), trigger que exige el aviso de un critico reciente
// o de un cliente ya sincronizado, aviso en la misma transaccion, dedupe por mensaje y las cinco acciones de auditoria. Falla hoy
// porque las migraciones 0054-0056 aun no existen. El contrato esta en la cabecera de buzon-soporte.ts.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  ACCIONES_BUZON,
  conExecute,
  crearDb,
  EscenarioBuzon,
  insertarAdjunto,
  insertarMensaje,
  ROLES_EXEC,
  sqlMensaje,
  infoFuncion,
  upsertEstado,
  UUID,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let backend: ContappDb;
let worker: ContappDb;
let E: string; // estudio principal
let E2: string; // otro estudio (pertenencia en la auditoria)
let uDueno: string;
let uAdmin: string;
let uAdminOff: string;
let uConta: string; // responsable de c1
let uLect: string; // colaborador de c1
let uResOff: string; // responsable DESACTIVADO de c3
let c1: ClientePrueba; // responsable activo + colaborador
let c2: ClientePrueba; // sin responsable
let c3: ClientePrueba; // responsable desactivado
let cE2: ClientePrueba;

const ASUNTO = "ASUNTO-SECRETO-8841";
const NOMBRE_ADJ = "NOMBRE-ADJUNTO-8841.pdf";

beforeAll(async () => {
  admin = abrirAdmin(8);
  eb = new EscenarioBuzon(admin);
  E = (await eb.estudio()).id;
  E2 = (await eb.estudio()).id;
  uDueno = (await eb.et.miembro(E, "dueno")).id;
  uAdmin = (await eb.et.miembro(E, "admin")).id;
  uAdminOff = (await eb.et.miembro(E, "admin", { desactivada: true })).id;
  uConta = (await eb.et.miembro(E, "contador")).id;
  uLect = (await eb.et.miembro(E, "lectura")).id;
  uResOff = (await eb.et.miembro(E, "contador", { desactivada: true })).id;
  c1 = await eb.et.cliente(E);
  c2 = await eb.et.cliente(E);
  c3 = await eb.et.cliente(E);
  cE2 = await eb.et.cliente(E2);
  await eb.et.asignar(E, c1.id, uConta, "responsable");
  await eb.et.asignar(E, c1.id, uLect, "colaborador");
  await eb.et.asignar(E, c3.id, uResOff, "responsable");
  backend = crearDb("contapp_backend", 3);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await eb?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const ctxW = (trabajoId?: string) => ({
  tenantId: E,
  ...(trabajoId ? { trabajoId } : {}),
});
const ctxB = () => ({ tenantId: E, userId: uConta });
const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};

/** Inserta un mensaje con el rol del worker (confirmado). Devuelve el id, o undefined si ON CONFLICT no inserto. */
async function comoWorker(
  c: ClientePrueba,
  o: Parameters<typeof sqlMensaje>[2] = {},
  trabajoId?: string,
): Promise<string | undefined> {
  const m = sqlMensaje(E, c.id, o);
  return worker.withTenant(
    ctxW(trabajoId),
    async (tx) =>
      (await tx.query(m.text, m.values)).rows[0]?.id as string | undefined,
  );
}
const nuevoCliente = () => eb.clienteCon(E, { cred: null });

describe("destinatarios del aviso: responsable activo; si no, Duenos y Administradores activos (P-8, 0056)", () => {
  it("interno.destinatarios_cliente no es ejecutable por ningun rol de la app", async () => {
    expect(
      await conExecute(
        admin,
        "interno.destinatarios_cliente(uuid, uuid)",
        ROLES_EXEC,
      ),
    ).toEqual([]);
    const f = await infoFuncion(
      admin,
      "interno.destinatarios_cliente(uuid, uuid)",
    );
    expect(f.secdef).toBe(true);
    expect(f.duenoSuper).toBe(false);
    expect(f.duenoBypass).toBe(false);
  });

  const destinatarios = async (
    c: ClientePrueba,
    tenant = E,
  ): Promise<string[]> => {
    const r = await admin.query(
      "select interno.destinatarios_cliente($1::uuid, $2::uuid) as u",
      [tenant, c.id],
    );
    return ((r.rows[0].u as string[] | null) ?? []).sort();
  };

  it("con responsable activo: solo el responsable (no el colaborador ni los Duenos)", async () => {
    expect(await destinatarios(c1)).toEqual([uConta]);
  });

  it("sin responsable: Duenos y Administradores activos; no el administrador desactivado, el contador ni el de lectura", async () => {
    expect(await destinatarios(c2)).toEqual([uDueno, uAdmin].sort());
  });

  it("con responsable desactivado: cae a Duenos y Administradores activos", async () => {
    expect(await destinatarios(c3)).toEqual([uDueno, uAdmin].sort());
  });

  it("es la misma regla que el aviso de credencial invalida de 0043 (con responsable, sin responsable y con responsable desactivado)", async () => {
    for (const c of [c1, c2, c3]) {
      await eb.et.credencial(E, c.id, "sol");
      await admin.query(
        "update credencial set estado = 'invalida' where tenant_id = $1 and cliente_id = $2 and tipo = 'sol'",
        [E, c.id],
      );
      const de0043 = (
        await eb.notifs(E, { tipo: "credencial_invalida", clienteId: c.id })
      )
        .map((n) => n.usuario_id)
        .sort();
      expect(de0043.length, "0043 avisa a alguien").toBeGreaterThan(0);
      expect(await destinatarios(c), c.id).toEqual(de0043);
    }
  });

  it("un estudio sin responsable ni Duenos o Administradores activos no tiene destinatarios (y el mensaje se guarda igual)", async () => {
    const solo = await eb.estudio();
    await eb.et.miembro(solo.id, "contador");
    const c = await eb.et.cliente(solo.id);
    expect(await destinatarios(c, solo.id)).toEqual([]);
    const m = sqlMensaje(solo.id, c.id, { critico: true, avisado: true });
    const id = await worker.withTenant(
      { tenantId: solo.id },
      async (tx) => (await tx.query(m.text, m.values)).rows[0].id as string,
    );
    expect(id).toMatch(UUID);
    expect(await eb.notifs(solo.id, { tipo: "buzon_critico" })).toEqual([]);
  });
});

describe("aviso en la misma transaccion del mensaje (CA-6)", () => {
  it("un critico avisado crea una notificacion buzon_critico por destinatario, con {categoria, mensajeId} y sin asunto ni RUC", async () => {
    const c = c1;
    const id = (await comoWorker(c, {
      critico: true,
      avisado: true,
      categoria: "coactiva",
      asunto: ASUNTO,
    }))!;
    const ns = await eb.notifs(E, { tipo: "buzon_critico", clienteId: c.id });
    expect(ns).toHaveLength(1);
    const n = ns[0]!;
    expect(n).toMatchObject({
      usuario_id: uConta,
      cliente_id: c.id,
      trabajo_id: null,
      clave_dedupe: `buzon_critico:${id}`,
      params: { categoria: "coactiva", mensajeId: id },
    });
    expect(Object.keys(n.params).sort()).toEqual(["categoria", "mensajeId"]);
    expect(JSON.stringify(n)).not.toContain(ASUNTO);
    expect(JSON.stringify(n)).not.toContain(c.ruc);
    expect(n.leida_en).toBeNull();
  });

  it("sin responsable avisa a cada Dueño y Administrador activo, una notificacion a cada uno", async () => {
    const id = (await comoWorker(c2, {
      critico: true,
      avisado: true,
      categoria: "resolucion_multa",
    }))!;
    const ns = await eb.notifs(E, { tipo: "buzon_critico", clienteId: c2.id });
    expect(ns.map((n) => n.usuario_id).sort()).toEqual([uDueno, uAdmin].sort());
    for (const n of ns)
      expect(n.params).toEqual({
        categoria: "resolucion_multa",
        mensajeId: id,
      });
  });

  it("con responsable desactivado avisa a Duenos y Administradores activos", async () => {
    await comoWorker(c3, {
      critico: true,
      avisado: true,
      categoria: "requerimiento_fiscalizacion",
    });
    expect(await eb.avisados(E, c3.id)).toEqual([uDueno, uAdmin].sort());
  });

  it("un mensaje no critico (o critico sin aviso por antiguo) no notifica a nadie", async () => {
    const c = await nuevoCliente();
    await comoWorker(c, { critico: false });
    await comoWorker(c, {
      critico: true,
      avisado: false,
      fechaHace: "45 days",
    });
    expect(await eb.notifs(E, { clienteId: c.id })).toEqual([]);
  });

  it("el trabajo del contexto, si es del estudio, queda en la notificacion; el de otro estudio no", async () => {
    const c = await nuevoCliente();
    const trabajo = await eb.et.job(E, c, {
      estado: "ejecutando",
      tipo: "sol.buzon.revisar",
      cola: "sol",
      canal: "sol",
      creadoPor: uConta,
    });
    const ajeno = await eb.et.job(E2, cE2, {
      estado: "ejecutando",
      tipo: "sol.buzon.revisar",
      cola: "sol",
      canal: "sol",
    });
    await comoWorker(c, { critico: true, avisado: true }, trabajo);
    const c4 = await nuevoCliente();
    await comoWorker(c4, { critico: true, avisado: true }, ajeno);
    expect(
      (await eb.notifs(E, { tipo: "buzon_critico", clienteId: c.id })).every(
        (n) => n.trabajo_id === trabajo,
      ),
    ).toBe(true);
    const sinTrabajo = await eb.notifs(E, {
      tipo: "buzon_critico",
      clienteId: c4.id,
    });
    expect(sinTrabajo.length).toBeGreaterThan(0);
    expect(sinTrabajo.every((n) => n.trabajo_id === null)).toBe(true);
  });

  it("si la transaccion se revierte no existe ni el mensaje ni la notificacion", async () => {
    const c = await nuevoCliente();
    const m = sqlMensaje(E, c.id, {
      idSunat: "ROLLBACK-1",
      critico: true,
      avisado: true,
    });
    await worker
      .withTenant(ctxW(), async (tx) => {
        await tx.query(m.text, m.values);
        throw new Error("revertir");
      })
      .catch(() => undefined);
    expect(
      (
        await admin.query("select 1 from buzon_mensaje where cliente_id = $1", [
          c.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await eb.notifs(E, { clienteId: c.id })).toEqual([]);
  });

  it("repetir el INSERT con ON CONFLICT DO NOTHING no inserta ni notifica otra vez (una notificacion por destinatario)", async () => {
    const c = await nuevoCliente();
    const id = (await comoWorker(c, {
      idSunat: "REPE-1",
      critico: true,
      avisado: true,
    }))!;
    const otra = await comoWorker(c, {
      idSunat: "REPE-1",
      critico: true,
      avisado: true,
      conflicto: true,
    });
    expect(id).toMatch(UUID);
    expect(otra).toBeUndefined();
    expect(await eb.avisados(E, c.id)).toEqual([uDueno, uAdmin].sort());
  });

  it("reclasificar (UPDATE de la categoria) no vuelve a avisar", async () => {
    const c = await nuevoCliente();
    const id = (await comoWorker(c, {
      critico: true,
      avisado: true,
      categoria: "coactiva",
    }))!;
    const antes = (
      await eb.notifs(E, { tipo: "buzon_critico", clienteId: c.id })
    ).length;
    await admin.query(
      "update buzon_mensaje set categoria = 'resolucion_determinacion' where id = $1",
      [id],
    );
    expect(
      (await eb.notifs(E, { tipo: "buzon_critico", clienteId: c.id })).length,
    ).toBe(antes);
    expect(antes).toBe(2);
  });
});

describe("la BD exige el aviso de un critico reciente o de un cliente ya sincronizado (CA-6, P-5)", () => {
  const insertar = (c: ClientePrueba, o: Parameters<typeof sqlMensaje>[2]) => {
    const m = sqlMensaje(E, c.id, o);
    return intentar(worker, ctxW(), m.text, m.values);
  };

  it("critico reciente (1 dia) sin aviso, en un cliente sin sincronizar: 42501", async () => {
    const c = await nuevoCliente();
    rechazo(
      await insertar(c, { critico: true, avisado: false, fechaHace: "1 day" }),
      "42501",
    );
  });

  it("el limite son 30 dias: de 29 dias se rechaza sin aviso; de 31 dias se acepta (guardado como critico sin aviso)", async () => {
    const c = await nuevoCliente();
    rechazo(
      await insertar(c, {
        critico: true,
        avisado: false,
        fechaHace: "29 days",
      }),
      "42501",
    );
    expect(
      await insertar(c, {
        critico: true,
        avisado: false,
        fechaHace: "31 days",
      }),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("critico antiguo en la primera sincronizacion (sin estado, o con cursor pendiente y sin sincronizado_en): se acepta y no notifica", async () => {
    const c = await nuevoCliente();
    expect(
      await insertar(c, {
        critico: true,
        avisado: false,
        fechaHace: "90 days",
      }),
    ).toEqual({ ok: true, rowCount: 1 });
    await upsertEstado(admin, E, c.id, {
      cursor: "pagina-3",
      capturaHace: "1 hour",
    });
    expect(
      await insertar(c, {
        critico: true,
        avisado: false,
        fechaHace: "120 days",
      }),
    ).toEqual({ ok: true, rowCount: 1 });
    // y de verdad no hay aviso: se confirma uno y se mira.
    await comoWorker(c, {
      critico: true,
      avisado: false,
      fechaHace: "200 days",
    });
    expect(await eb.notifs(E, { clienteId: c.id })).toEqual([]);
  });

  it("critico antiguo sin aviso en un cliente ya sincronizado: 42501", async () => {
    const c = await nuevoCliente();
    await upsertEstado(admin, E, c.id, {
      sincronizadoHace: "1 hour",
      capturaHace: "1 hour",
    });
    rechazo(
      await insertar(c, {
        critico: true,
        avisado: false,
        fechaHace: "400 days",
      }),
      "42501",
    );
  });

  it("un critico antiguo si puede avisarse; uno no critico nunca exige aviso y no puede llevarlo (CHECK 23514)", async () => {
    const c = await nuevoCliente();
    await upsertEstado(admin, E, c.id, { sincronizadoHace: "1 hour" });
    expect(
      await insertar(c, {
        critico: true,
        avisado: true,
        fechaHace: "400 days",
      }),
    ).toEqual({ ok: true, rowCount: 1 });
    expect(
      await insertar(c, { critico: false, avisado: false, fechaHace: "1 day" }),
    ).toEqual({ ok: true, rowCount: 1 });
    rechazo(await insertar(c, { critico: false, avisado: true }), "23514");
  });

  it("la regla vale tambien para el superusuario (el trigger no depende del rol)", async () => {
    const c = await nuevoCliente();
    const m = sqlMensaje(E, c.id, {
      critico: true,
      avisado: false,
      fechaHace: "1 day",
    });
    const r = await admin.query(m.text, m.values).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(r).toBe("42501");
  });
});

describe("auditoria del buzon: cinco acciones con actor y sin datos sensibles (D-9, 0056)", () => {
  let m1: string;
  let adjuntoGuardado: string;
  let omitido: string;
  let cAud: ClientePrueba;
  let mOtroCliente: string;
  let mE2: string;
  let sembrado: Promise<void> | undefined;
  const sembrar = () =>
    (sembrado ??= (async () => {
      cAud = await eb.clienteCon(E, { cred: null });
      await eb.et.asignar(E, cAud.id, uConta, "responsable");
      m1 = await insertarMensaje(admin, E, cAud.id, {
        asunto: ASUNTO,
        declarados: 2,
      });
      adjuntoGuardado = await insertarAdjunto(admin, E, cAud.id, m1, {
        nombre: NOMBRE_ADJ,
      });
      omitido = await insertarAdjunto(admin, E, cAud.id, m1, {
        nombre: "grande.zip",
        omitido: "tamano",
      });
      mOtroCliente = await insertarMensaje(admin, E, c2.id, {});
      mE2 = await insertarMensaje(admin, E2, cE2.id, {});
    })());

  const idsPrevios = async (accion: string) =>
    new Set((await eb.auditoriaDe(E, accion)).map((f) => f.id as string));
  /** Llama a buzon_auditar como el backend (confirmado) y devuelve solo las filas nuevas de `accion`. */
  async function auditar(
    accion: string,
    cliente: string,
    mensaje: string | null,
    adjunto: string | null,
  ) {
    const previos = await idsPrevios(accion);
    await backend.withTenant(ctxB(), async (tx) => {
      await tx.query(
        "select buzon_auditar($1::text, $2::uuid, $3::uuid, $4::uuid)",
        [accion, cliente, mensaje, adjunto],
      );
    });
    return (await eb.auditoriaDe(E, accion)).filter(
      (f) => !previos.has(f.id as string),
    );
  }

  it("buzon.captura_solicitada: actor usuario, entidad cliente y datos vacios", async () => {
    await sembrar();
    const filas = await auditar(
      "buzon.captura_solicitada",
      cAud.id,
      null,
      null,
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: uConta,
      cliente_id: cAud.id,
      entidad: "cliente",
      entidad_id: cAud.id,
      datos: {},
    });
  });

  it("buzon.apertura_solicitada y buzon.contenido_visto: entidad buzon_mensaje y datos {mensajeId}", async () => {
    await sembrar();
    for (const accion of [
      "buzon.apertura_solicitada",
      "buzon.contenido_visto",
    ]) {
      const filas = await auditar(accion, cAud.id, m1, null);
      expect(filas, accion).toHaveLength(1);
      expect(filas[0], accion).toMatchObject({
        actor_tipo: "usuario",
        usuario_id: uConta,
        cliente_id: cAud.id,
        entidad: "buzon_mensaje",
        entidad_id: m1,
        datos: { mensajeId: m1 },
      });
    }
  });

  it("buzon.adjunto_descargado: entidad buzon_adjunto y datos {mensajeId, adjuntoId}", async () => {
    await sembrar();
    const filas = await auditar(
      "buzon.adjunto_descargado",
      cAud.id,
      m1,
      adjuntoGuardado,
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: uConta,
      cliente_id: cAud.id,
      entidad: "buzon_adjunto",
      entidad_id: adjuntoGuardado,
      datos: { mensajeId: m1, adjuntoId: adjuntoGuardado },
    });
  });

  it("buzon_auditar rechaza un mensaje o adjunto que no es del cliente o del estudio (23503) y una accion ajena al buzon (22023)", async () => {
    await sembrar();
    const llamar = (
      accion: string,
      cliente: string,
      mensaje: string | null,
      adjunto: string | null,
    ) =>
      intentar(
        backend,
        ctxB(),
        "select buzon_auditar($1::text, $2::uuid, $3::uuid, $4::uuid)",
        [accion, cliente, mensaje, adjunto],
      );
    rechazo(await llamar("buzon.contenido_visto", cAud.id, mE2, null), "23503"); // mensaje de otro estudio
    rechazo(
      await llamar("buzon.contenido_visto", cAud.id, mOtroCliente, null),
      "23503",
    ); // mensaje de otro cliente
    rechazo(
      await llamar("buzon.captura_solicitada", cE2.id, null, null),
      "23503",
    ); // cliente de otro estudio
    rechazo(
      await llamar(
        "buzon.adjunto_descargado",
        c2.id,
        mOtroCliente,
        adjuntoGuardado,
      ),
      "23503",
    ); // adjunto de otro mensaje
    rechazo(await llamar("cliente.creado", cAud.id, null, null), "22023");
    rechazo(await llamar("buzon.inventada", cAud.id, null, null), "22023");
  });

  it("buzon_auditar sin estudio en la sesion o desde el worker: 42501", async () => {
    await sembrar();
    const r = await intentar(
      worker,
      ctxW(),
      "select buzon_auditar('buzon.captura_solicitada', $1::uuid, null, null)",
      [cAud.id],
    );
    rechazo(r, "42501");
    expect(
      await conExecute(
        admin,
        "public.buzon_auditar(text, uuid, uuid, uuid)",
        ROLES_EXEC,
      ),
    ).toEqual(["contapp_backend"]);
  });

  it("buzon.contenido_obtenido (trigger): actor trabajo, con el trabajo y su creador, y {mensajeId, marcoLeido, adjuntos, omitidos}", async () => {
    await sembrar();
    const c = await eb.clienteCon(E, { cred: null });
    const trabajo = await eb.et.job(E, c, {
      estado: "ejecutando",
      tipo: "sol.abrir",
      cola: "sol",
      canal: "sol",
      creadoPor: uConta,
    });
    const m = await insertarMensaje(admin, E, c.id, {
      asunto: ASUNTO,
      leido: false,
    });
    await insertarAdjunto(admin, E, c.id, m, { nombre: NOMBRE_ADJ });
    await insertarAdjunto(admin, E, c.id, m, {
      nombre: "otro.png",
      mime: "image/png",
      ext: "png",
    });
    await insertarAdjunto(admin, E, c.id, m, {
      nombre: "enorme.zip",
      omitido: "tamano",
    });
    const previos = await idsPrevios("buzon.contenido_obtenido");
    const ruta = `buzon/${E}/${c.id}/${"0190a000-0000-7000-8000-0000000000aa"}.txt`;
    await worker.withTenant(ctxW(trabajo), async (tx) => {
      await tx.query(
        "update buzon_mensaje set contenido_ruta = $2, contenido_bytes = 321, contenido_obtenido_en = now(), leido_sunat = true where id = $1",
        [m, ruta],
      );
    });
    const filas = (await eb.auditoriaDe(E, "buzon.contenido_obtenido")).filter(
      (f) => !previos.has(f.id as string),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "trabajo",
      trabajo_id: trabajo,
      usuario_id: uConta,
      cliente_id: c.id,
      entidad: "buzon_mensaje",
      entidad_id: m,
      datos: { mensajeId: m, marcoLeido: true, adjuntos: 2, omitidos: 1 },
    });
  });

  it("marcoLeido es false si el mensaje ya estaba leido o si el UPDATE no lo marca; actualizar leido_sunat a secas no audita", async () => {
    await sembrar();
    const c = await eb.clienteCon(E, { cred: null });
    const trabajo = await eb.et.job(E, c, {
      estado: "ejecutando",
      tipo: "sol.abrir",
      cola: "sol",
      canal: "sol",
      creadoPor: null,
    });
    const yaLeido = await insertarMensaje(admin, E, c.id, { leido: true });
    const sinMarcar = await insertarMensaje(admin, E, c.id, { leido: false });
    const soloLeido = await insertarMensaje(admin, E, c.id, { leido: false });
    const previos = await idsPrevios("buzon.contenido_obtenido");
    const poner = (id: string, extra: string) =>
      worker.withTenant(ctxW(trabajo), async (tx) => {
        await tx.query(
          `update buzon_mensaje set contenido_ruta = $2, contenido_bytes = 5, contenido_obtenido_en = now()${extra} where id = $1`,
          [id, `buzon/${E}/${c.id}/${randomUUID()}.txt`],
        );
      });
    await poner(yaLeido, "");
    await poner(sinMarcar, "");
    await worker.withTenant(ctxW(trabajo), async (tx) => {
      await tx.query(
        "update buzon_mensaje set leido_sunat = true, ultima_captura_en = now() where id = $1",
        [soloLeido],
      );
    });
    const filas = (await eb.auditoriaDe(E, "buzon.contenido_obtenido")).filter(
      (f) => !previos.has(f.id as string),
    );
    expect(filas.map((f) => f.datos)).toEqual(
      expect.arrayContaining([
        { mensajeId: yaLeido, marcoLeido: false, adjuntos: 0, omitidos: 0 },
        { mensajeId: sinMarcar, marcoLeido: false, adjuntos: 0, omitidos: 0 },
      ]),
    );
    expect(filas).toHaveLength(2);
    expect(filas[0]!.actor_tipo).toBe("trabajo");
  });

  it("ninguna fila de las cinco acciones lleva asunto, nombre de adjunto, ruta ni RUC", async () => {
    await sembrar();
    await auditar("buzon.adjunto_descargado", cAud.id, m1, adjuntoGuardado);
    const todas: any[] = [];
    for (const a of ACCIONES_BUZON) todas.push(...(await eb.auditoriaDe(E, a)));
    expect(todas.length).toBeGreaterThanOrEqual(4);
    const texto = JSON.stringify(todas.map((f) => f.datos));
    for (const prohibido of [
      ASUNTO,
      NOMBRE_ADJ,
      "grande.zip",
      "buzon/",
      cAud.ruc,
      "SUNAT",
    ])
      expect(texto, prohibido).not.toContain(prohibido);
    for (const f of todas) {
      for (const k of Object.keys(f.datos))
        expect(
          ["mensajeId", "adjuntoId", "marcoLeido", "adjuntos", "omitidos"],
          k,
        ).toContain(k);
    }
  });

  it("el CHECK auditoria_accion_valida admite las cinco acciones nuevas sin perder las anteriores", async () => {
    const r = await admin.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auditoria_accion_valida'",
    );
    const def = String(r.rows[0].def);
    for (const a of ACCIONES_BUZON) expect(def, a).toContain(`'${a}'`);
    for (const a of ACCIONES_PREVIAS) expect(def, a).toContain(`'${a}'`);
  });
});

const ACCIONES_PREVIAS = [
  "sesion.ingreso",
  "invitacion.creada",
  "invitacion.revocada",
  "invitacion.modificada",
  "miembro.alta",
  "miembro.rol_cambiado",
  "miembro.desactivado",
  "miembro.reactivado",
  "miembro.eliminado",
  "asignacion.agregada",
  "asignacion.quitada",
  "asignacion.tipo_cambiado",
  "cliente.creado",
  "cliente.editado",
  "cliente.archivado",
  "cliente.reactivado",
  "cliente.eliminado",
  "credencial.guardada",
  "credencial.verificada",
  "credencial.invalidada",
  "credencial.descifrada",
  "propuesta.cargada",
  "compra.operacion",
  "venta.agregada",
  "venta.excluida",
  "venta.restaurada",
  "venta.salto_justificado",
  "xml.subido",
  "periodo.estado_cambiado",
  "archivo.generado",
  "sunat.envio",
  "regla.creada",
  "regla.editada",
  "regla.activada",
  "regla.desactivada",
  "regla.eliminada",
  "estudio.regla_motor",
  "estudio.aporte_catalogo",
  "compra.historial",
];
