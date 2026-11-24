// Spec 028 (T3, rojo): `interno.notificar` ampliada en BD real (R-2, R-4, R-12, R-14, D-2; CA-2, CA-5, CA-9, CA-11). Cada notificacion nueva
// de buzon_critico, credencial_invalida o plan_limite deja su aviso para correo en la misma transaccion, si el destinatario lo tiene
// activado; la ventana de 10 minutos junta los avisos de un (usuario, estudio, tipo) y el tope de 30 correos por dia de Lima difiere el
// resto. Los hechos entran por su camino real (criticos insertados como el worker, UPDATE de la credencial, cruce del 90 % de RUCs).
// Falla hoy porque las migraciones 0073-0074 aun no existen (y la `interno.notificar` vieja no registra avisos).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import {
  abrirAdmin,
  conExecute,
  crearDb,
  EscenarioCorreo,
  ROLES_EXEC,
  sqlMensaje,
  type ClientePrueba,
} from "./correo-soporte";

let admin: Pool;
let ec: EscenarioCorreo;
let worker: ContappDb;
let E: string; // estudio principal (plan sin features: todo habilitado)
let E2: string; // segundo estudio (usuario en dos estudios)
let F: string; // plan con correo_avisos: false
let P: string; // prueba vigente
let uDueno: string;
let uAdmin: string;
let uConta: string; // responsable de c1
let c1: ClientePrueba;
let c2: ClientePrueba; // sin responsable
const ASUNTO = "ASUNTO-SECRETO-5521";
const RAZON = "RAZON-SOCIAL-SECRETA-5521 S.A.C.";

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioCorreo(admin);
  await ec.guardarProgramacionCorreo();
  E = await ec.estudioPlan();
  E2 = await ec.estudioPlan();
  F = await ec.estudioPlan({ features: { correo_avisos: false } });
  P = await ec.estudioPlan({ estado: "prueba", venceEn: "10 days" });
  uDueno = (await ec.et.miembro(E, "dueno")).id;
  uAdmin = (await ec.et.miembro(E, "admin")).id;
  uConta = (await ec.et.miembro(E, "contador")).id;
  c1 = await ec.et.cliente(E);
  c2 = await ec.et.cliente(E);
  await ec.et.asignar(E, c1.id, uConta, "responsable");
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

/** Contador nuevo con un cliente suyo como responsable: sus avisos no se mezclan con los de otras pruebas. */
async function usuarioConCliente(tenant = E, rol: "contador" | "dueno" | "admin" = "contador") {
  const u = (await ec.et.miembro(tenant, rol)).id;
  const c = await ec.et.cliente(tenant);
  await ec.et.asignar(tenant, c.id, u, "responsable");
  return { u, c };
}
const ahoraBd = async (): Promise<number> =>
  new Date((await admin.query("select clock_timestamp() as t")).rows[0].t as Date).getTime();
const ms = (d: Date | string): number => new Date(d).getTime();
const tomar = (tenant: string, envioId: string) =>
  worker.withTenant({ tenantId: tenant }, async (tx) => (await tx.query("select correo_envio_tomar($1::uuid) as r", [envioId])).rows[0].r);

describe("interno.notificar no cambia de firma ni se abre a la app (R-2)", () => {
  it("ningun rol de la app la ejecuta", async () => {
    expect(await conExecute(admin, "interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)", ROLES_EXEC)).toEqual([]);
  });
});

describe("CA-2 · el aviso nace con el hecho, para cada destinatario con el correo activado", () => {
  it("una coactiva nueva con responsable deja exactamente un aviso para el, unido a un envio pendiente de origen aviso", async () => {
    const antes = await ahoraBd();
    const [id] = await ec.capturar(worker, E, c1, 1);
    const notifs = await ec.notifs(E, { tipo: "buzon_critico", clienteId: c1.id });
    expect(notifs.map((n) => n.usuario_id)).toEqual([uConta]);
    const avisos = await ec.avisosDe(E, { usuarioId: uConta });
    expect(avisos).toHaveLength(1);
    const envios = await ec.envios(E, { usuarioId: uConta });
    expect(envios).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ notificacion_id: notifs[0]!.id, usuario_id: uConta, tipo: "buzon_critico", envio_id: envios[0]!.id, diferido_en: null });
    expect(envios[0]).toMatchObject({
      origen: "aviso",
      tipo: "buzon_critico",
      estado: "pendiente",
      motivo: null,
      tomado_en: null,
      intentos: 0,
      total_avisos: 1,
      corte_hasta: null,
    });
    expect(envios[0]!.clave.startsWith(`aviso:${uConta}:buzon_critico:`)).toBe(true);
    // el primero sale en el siguiente ciclo: programado para ahora, no para dentro de una ventana
    expect(ms(envios[0]!.programado_para)).toBeGreaterThanOrEqual(antes - 2000);
    expect(ms(envios[0]!.programado_para)).toBeLessThanOrEqual((await ahoraBd()) + 1000);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sin responsable, un aviso para cada Dueño y Administrador activo, cada uno con su envio", async () => {
    await ec.capturar(worker, E, c2, 1, { categoria: "resolucion_multa" });
    const notifs = await ec.notifs(E, { tipo: "buzon_critico", clienteId: c2.id });
    expect(notifs.map((n) => n.usuario_id).sort()).toEqual([uDueno, uAdmin].sort());
    for (const u of [uDueno, uAdmin]) {
      const avisos = await ec.avisosDe(E, { usuarioId: u });
      expect(avisos, u).toHaveLength(1);
      expect(avisos[0]!.notificacion_id).toBe(notifs.find((n) => n.usuario_id === u)!.id);
    }
    const envios = [...(await ec.envios(E, { usuarioId: uDueno })), ...(await ec.envios(E, { usuarioId: uAdmin }))];
    expect(new Set(envios.map((e) => e.id)).size).toBe(2);
  });

  it("con la preferencia apagada hay notificacion en la app pero ningun aviso; el otro destinatario sigue recibiendo el suyo", async () => {
    const t = await ec.estudioPlan();
    const d = (await ec.et.miembro(t, "dueno")).id;
    const a = (await ec.et.miembro(t, "admin")).id;
    const c = await ec.et.cliente(t);
    await ec.preferencia(t, d, "buzon_critico", false);
    await ec.capturar(worker, t, c, 1);
    expect((await ec.notifs(t, { tipo: "buzon_critico" })).map((n) => n.usuario_id).sort()).toEqual([d, a].sort());
    expect(await ec.avisosDe(t, { usuarioId: d })).toEqual([]);
    expect(await ec.envios(t, { usuarioId: d })).toEqual([]);
    expect(await ec.avisosDe(t, { usuarioId: a })).toHaveLength(1);
  });

  it("un plan con correo_avisos: false deja la notificacion y ningun aviso ni envio; con true o ausente, si (CA-11)", async () => {
    const { u, c } = await usuarioConCliente(F);
    await ec.capturar(worker, F, c, 1);
    expect(await ec.notifs(F, { tipo: "buzon_critico", clienteId: c.id })).toHaveLength(1);
    expect(await ec.avisosDe(F, { usuarioId: u })).toEqual([]);
    expect(await ec.envios(F, { usuarioId: u })).toEqual([]);
    const explicito = await ec.estudioPlan({ features: { correo_avisos: true, correo_resumen: false } });
    const x = await usuarioConCliente(explicito);
    await ec.capturar(worker, explicito, x.c, 1);
    expect(await ec.avisosDe(explicito, { usuarioId: x.u })).toHaveLength(1);
  });

  it("un estudio en Prueba vigente recibe avisos (CA-11, R-12)", async () => {
    const { u, c } = await usuarioConCliente(P);
    await ec.capturar(worker, P, c, 1);
    expect(await ec.avisosDe(P, { usuarioId: u })).toHaveLength(1);
  });

  it("si la transaccion del hecho se revierte no queda mensaje, notificacion, aviso ni envio", async () => {
    const { u, c } = await usuarioConCliente();
    const m = sqlMensaje(E, c.id, { critico: true, avisado: true });
    await worker
      .withTenant({ tenantId: E }, async (tx) => {
        await tx.query(m.text, m.values);
        throw new Error("revertir");
      })
      .catch(() => undefined);
    expect(await ec.notifs(E, { usuarioId: u })).toEqual([]);
    expect(await ec.avisosDe(E, { usuarioId: u })).toEqual([]);
    expect(await ec.envios(E, { usuarioId: u })).toEqual([]);
  });

  it("repetir la captura (ON CONFLICT DO NOTHING) o reclasificarla no crea otro aviso", async () => {
    const { u, c } = await usuarioConCliente();
    const idSunat = `REPE-${randomUUID().slice(0, 8)}`;
    const insertar = (conflicto: boolean) => {
      const m = sqlMensaje(E, c.id, { idSunat, critico: true, avisado: true, conflicto });
      return worker.withTenant({ tenantId: E }, async (tx) => (await tx.query(m.text, m.values)).rows[0]?.id as string | undefined);
    };
    const id = (await insertar(false))!;
    expect(await insertar(true)).toBeUndefined();
    await admin.query("update buzon_mensaje set categoria = 'resolucion_determinacion' where id = $1", [id]);
    expect(await ec.notifs(E, { usuarioId: u })).toHaveLength(1);
    expect(await ec.avisosDe(E, { usuarioId: u })).toHaveLength(1);
    expect((await ec.envios(E, { usuarioId: u }))[0]!.total_avisos).toBe(1);
  });

  it("trabajo_terminado nunca registra aviso", async () => {
    const { u, c } = await usuarioConCliente();
    const job = await ec.et.job(E, c, { estado: "ejecutando", prioridad: "interactivo", creadoPor: u, tipo: "prueba.eco", cola: "sire", canal: "sire" });
    await admin.query("update job_registro set estado = 'completado', terminado_en = now(), resultado = '{}'::jsonb where id = $1", [job]);
    const notifs = await ec.notifs(E, { usuarioId: u, tipo: "trabajo_terminado" });
    expect(notifs, "control: la notificacion en la app si existe").toHaveLength(1);
    expect(await ec.avisosDe(E, { usuarioId: u })).toEqual([]);
    expect(await ec.envios(E, { usuarioId: u })).toEqual([]);
  });

  it("credencial_invalida: un aviso por cada destinatario de 017 (P-4), del tipo credencial_invalida", async () => {
    const t = await ec.estudioPlan();
    const d = (await ec.et.miembro(t, "dueno")).id;
    const a = (await ec.et.miembro(t, "admin")).id;
    const resp = (await ec.et.miembro(t, "contador")).id;
    const sinResp = await ec.et.cliente(t);
    const conResp = await ec.et.cliente(t);
    await ec.et.asignar(t, conResp.id, resp, "responsable");
    for (const c of [sinResp, conResp]) {
      await ec.et.credencial(t, c.id, "sol");
      await admin.query("update credencial set estado = 'invalida' where tenant_id = $1 and cliente_id = $2 and tipo = 'sol'", [t, c.id]);
    }
    const notifs = await ec.notifs(t, { tipo: "credencial_invalida" });
    expect(notifs.map((n) => n.usuario_id).sort()).toEqual([d, a, resp].sort());
    const avisos = await ec.avisosDe(t, { tipo: "credencial_invalida" });
    expect(avisos.map((x) => x.notificacion_id).sort()).toEqual(notifs.map((n) => n.id).sort());
    expect(avisos.every((x) => x.envio_id !== null && x.diferido_en === null)).toBe(true);
    expect((await ec.envios(t, { tipo: "credencial_invalida" })).every((e) => e.origen === "aviso")).toBe(true);
  });

  it("plan_limite: solo los Dueños reciben la notificacion y su aviso (preferencia inicial solo para Dueños); un Administrador no", async () => {
    const plan = await ec.ep.plan({ maxRucs: 10, maxUsuarios: null });
    const x = await ec.estudio();
    await ec.ep.suscribir(x.id, plan.id, { estado: "activa" });
    const d1 = (await ec.et.miembro(x.id, "dueno")).id;
    const d2 = (await ec.et.miembro(x.id, "dueno")).id;
    const adm = (await ec.et.miembro(x.id, "admin")).id;
    await ec.clientes(x.id, 9); // 9 de 10 = 90 %
    const notifs = await ec.avisosPlan(x.id, "rucs", 90);
    expect(notifs.map((n) => n.usuario_id).sort()).toEqual([d1, d2].sort());
    const avisos = await ec.avisosDe(x.id, { tipo: "plan_limite" });
    expect(avisos.map((a) => a.usuario_id).sort()).toEqual([d1, d2].sort());
    // La preferencia efectiva, por rol y sin filas (R-15): el Administrador la tiene apagada aunque se le avisara en la app.
    await ec.notificarDirecto(admin, x.id, [adm], "plan_limite");
    expect(await ec.avisosDe(x.id, { usuarioId: adm })).toEqual([]);
    expect(await ec.notifs(x.id, { usuarioId: adm, tipo: "plan_limite" }), "control: la notificacion si existe").toHaveLength(1);
    // Una fila explicita gana al valor inicial: el Administrador la activa y recibe el aviso.
    await ec.preferencia(x.id, adm, "plan_limite", true);
    await ec.notificarDirecto(admin, x.id, [adm], "plan_limite");
    expect(await ec.avisosDe(x.id, { usuarioId: adm })).toHaveLength(1);
    // Y un Dueño puede apagarla.
    await ec.preferencia(x.id, d1, "plan_limite", false);
    await ec.notificarDirecto(admin, x.id, [d1], "plan_limite");
    expect(await ec.avisosDe(x.id, { usuarioId: d1 })).toHaveLength(1); // solo el del cruce del 90 %
  });

  it("no hay texto del correo, de los mensajes ni del cliente en los envios, avisos ni auditoria (R-6, R-8)", async () => {
    const t = await ec.estudioPlan();
    const u = (await ec.et.miembro(t, "contador")).id;
    const cid = await ec.et.ea.cliente(t, RAZON);
    const c: ClientePrueba = { id: cid, ruc: (await admin.query("select ruc from cliente where id = $1", [cid])).rows[0].ruc as string };
    await ec.et.asignar(t, c.id, u, "responsable");
    await ec.capturar(worker, t, c, 2, { asunto: ASUNTO, remitente: "REMITENTE-SECRETO-5521" });
    const correo = (await admin.query("select email from usuario where id = $1", [u])).rows[0].email as string;
    const volcado = JSON.stringify([
      await ec.envios(t),
      await ec.avisosDe(t),
      (await admin.query("select * from auditoria where tenant_id = $1 and accion like 'correo.%'", [t])).rows,
      (await admin.query("select * from correo_baja_token where tenant_id = $1", [t])).rows,
    ]);
    for (const canario of [ASUNTO, RAZON, c.ruc, correo, "REMITENTE-SECRETO-5521"]) expect(volcado, canario).not.toContain(canario);
    expect(await ec.envios(t)).toHaveLength(1);
  });
});

describe("CA-9, D-2 · ventana de 10 minutos desde el correo anterior", () => {
  it("50 criticos nuevos de un cliente en una captura: un solo envio con 50 avisos", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.capturar(worker, E, c, 50);
    expect(await ec.notifs(E, { usuarioId: u, tipo: "buzon_critico" })).toHaveLength(50);
    const envios = await ec.envios(E, { usuarioId: u });
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ estado: "pendiente", total_avisos: 50, tomado_en: null });
    const avisos = await ec.avisosDe(E, { usuarioId: u });
    expect(avisos).toHaveLength(50);
    expect(avisos.every((a) => a.envio_id === envios[0]!.id && a.diferido_en === null)).toBe(true);
  });

  it("mientras el envio no se toma, las capturas siguientes se suman a el", async () => {
    const { u, c } = await usuarioConCliente();
    for (let i = 0; i < 3; i++) await ec.capturar(worker, E, c, 1);
    const envios = await ec.envios(E, { usuarioId: u });
    expect(envios).toHaveLength(1);
    expect(envios[0]!.total_avisos).toBe(3);
    expect(await ec.avisosDe(E, { usuarioId: u, envioId: envios[0]!.id })).toHaveLength(3);
  });

  it("5 criticos en tres capturas dentro de 10 min dan dos envios: el primero y uno agrupado a +10 min del primero", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.capturar(worker, E, c, 2);
    const [e1] = await ec.envios(E, { usuarioId: u });
    expect((await tomar(E, e1!.id)) as unknown).toBeTruthy(); // el ciclo toma el primero
    await ec.capturar(worker, E, c, 2);
    await ec.capturar(worker, E, c, 1);
    const envios = await ec.envios(E, { usuarioId: u });
    expect(envios).toHaveLength(2);
    const [a, b] = envios as [typeof e1, typeof e1];
    expect(ms(b!.programado_para) - ms(a!.programado_para)).toBeGreaterThan(599_000);
    expect(ms(b!.programado_para) - ms(a!.programado_para)).toBeLessThan(601_000);
    expect(b!.estado).toBe("pendiente");
    expect([a!.total_avisos, b!.total_avisos]).toEqual([2, 3]);
    expect((await ec.avisosDe(E, { usuarioId: u, envioId: a!.id })).length).toBe(2);
    expect((await ec.avisosDe(E, { usuarioId: u, envioId: b!.id })).length).toBe(3);
    expect(envios.reduce((s, e) => s + e.total_avisos, 0)).toBe((await ec.notifs(E, { usuarioId: u })).length);
  });

  it("si el correo anterior salio hace mas de una ventana, el siguiente se programa para ahora, no para +10 min", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.capturar(worker, E, c, 1);
    const [e1] = await ec.envios(E, { usuarioId: u });
    await tomar(E, e1!.id);
    await admin.query("update correo_envio set programado_para = programado_para - interval '15 minutes' where id = $1", [e1!.id]);
    await ec.capturar(worker, E, c, 1);
    const envios = await ec.envios(E, { usuarioId: u });
    expect(envios).toHaveLength(2);
    expect(Math.abs(ms(envios[1]!.programado_para) - (await ahoraBd()))).toBeLessThan(5000);
  });

  it("la ventana sale de correo_programacion.ventana_min y rige en la captura siguiente", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.fijarProgramacionCorreo({ ventana_min: 3 });
    try {
      await ec.capturar(worker, E, c, 1);
      const [e1] = await ec.envios(E, { usuarioId: u });
      await tomar(E, e1!.id);
      await ec.capturar(worker, E, c, 1);
      const envios = await ec.envios(E, { usuarioId: u });
      expect(ms(envios[1]!.programado_para) - ms(envios[0]!.programado_para)).toBeGreaterThan(179_000);
      expect(ms(envios[1]!.programado_para) - ms(envios[0]!.programado_para)).toBeLessThan(181_000);
    } finally {
      await ec.restaurarProgramacionCorreo();
    }
  });

  it("la ventana es por tipo y por usuario: otro tipo u otro usuario abre su propio envio", async () => {
    const { u, c } = await usuarioConCliente();
    const otro = await usuarioConCliente();
    await ec.capturar(worker, E, c, 1);
    await ec.notificarDirecto(admin, E, [u], "credencial_invalida");
    await ec.capturar(worker, E, otro.c, 1);
    const mios = await ec.envios(E, { usuarioId: u });
    expect(mios.map((e) => e.tipo).sort()).toEqual(["buzon_critico", "credencial_invalida"]);
    expect(await ec.envios(E, { usuarioId: otro.u })).toHaveLength(1);
  });
});

describe("CA-9, R-14 · tope de 30 correos inmediatos por (usuario, estudio, dia de Lima)", () => {
  const diferidos = (u: string, t = E) => ec.diferidosDe(t, u);

  it("con 30 envios ya hechos hoy, el aviso nuevo queda diferido: sin envio, con instante de diferido, y la notificacion existe", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.sembrarEnviados(E, u, 30);
    await ec.capturar(worker, E, c, 1);
    expect(await ec.notifs(E, { usuarioId: u, tipo: "buzon_critico" })).toHaveLength(1);
    const avisos = await ec.avisosDe(E, { usuarioId: u });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.envio_id).toBeNull();
    expect(avisos[0]!.diferido_en).not.toBeNull();
    expect(await ec.envios(E, { usuarioId: u })).toHaveLength(30); // ninguno nuevo
    expect(await ec.envios(E, { usuarioId: u, estado: "pendiente" })).toEqual([]);
    await ec.capturar(worker, E, c, 3); // los siguientes tambien se difieren
    expect(await diferidos(u)).toHaveLength(4);
    expect(await ec.envios(E, { usuarioId: u })).toHaveLength(30);
  });

  it("el 30.º correo todavia sale y el 31.º se difiere; ninguno se pierde (suma de avisos en envios y diferidos = notificaciones)", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.sembrarEnviados(E, u, 29);
    await ec.capturar(worker, E, c, 2);
    const treinta = await ec.envios(E, { usuarioId: u });
    expect(treinta).toHaveLength(30);
    const nuevo = treinta.find((e) => e.estado === "pendiente")!;
    expect(nuevo.total_avisos).toBe(2); // el segundo aviso se suma al pendiente: no es otro correo
    await tomar(E, nuevo.id);
    await ec.capturar(worker, E, c, 1); // ahora haria falta el 31.º correo: se difiere
    expect(await ec.envios(E, { usuarioId: u })).toHaveLength(30);
    expect(await diferidos(u)).toHaveLength(1);
    const notifs = (await ec.notifs(E, { usuarioId: u, tipo: "buzon_critico" })).length;
    const enEnvios = (await ec.avisosDe(E, { usuarioId: u })).filter((a) => a.envio_id !== null).length;
    expect(enEnvios + (await diferidos(u)).length).toBe(notifs);
    expect(notifs).toBe(3);
  });

  it("el tope cuenta correos de todos los tipos del usuario en el estudio, no solo el del aviso", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.sembrarEnviados(E, u, 30, { tipo: "credencial_invalida" });
    await ec.capturar(worker, E, c, 1);
    expect(await diferidos(u)).toHaveLength(1);
  });

  it("no cuentan los envios de ayer ni los de origen resumen o pendientes", async () => {
    const ayer = await usuarioConCliente();
    await ec.sembrarEnviados(E, ayer.u, 30, { hace: "1 day" });
    await ec.capturar(worker, E, ayer.c, 1);
    expect(await diferidos(ayer.u), "ayer no cuenta").toEqual([]);
    expect(await ec.envios(E, { usuarioId: ayer.u, estado: "pendiente" })).toHaveLength(1);
    const resumenes = await usuarioConCliente();
    await ec.sembrarEnviados(E, resumenes.u, 30, { origen: "resumen", tipo: "resumen" });
    await ec.capturar(worker, E, resumenes.c, 1);
    expect(await diferidos(resumenes.u), "los resumenes no cuentan").toEqual([]);
  });

  it("el tope de otro estudio no cuenta (CA-5), ni el de otro usuario del mismo estudio", async () => {
    const x = await ec.et.ea.cuenta();
    await ec.et.ea.membresia(E, x.id, "contador");
    await ec.et.ea.membresia(E2, x.id, "contador");
    const cE = await ec.et.cliente(E);
    const cE2 = await ec.et.cliente(E2);
    await ec.et.asignar(E, cE.id, x.id, "responsable");
    await ec.et.asignar(E2, cE2.id, x.id, "responsable");
    await ec.sembrarEnviados(E, x.id, 30);
    await ec.capturar(worker, E, cE, 1);
    await ec.capturar(worker, E2, cE2, 1);
    expect(await diferidos(x.id, E), "en E ya agoto el tope").toHaveLength(1);
    expect(await diferidos(x.id, E2), "en E2 no").toEqual([]);
    expect(await ec.envios(E2, { usuarioId: x.id, estado: "pendiente" })).toHaveLength(1);
    const otro = await usuarioConCliente();
    await ec.capturar(worker, E, otro.c, 1);
    expect(await diferidos(otro.u)).toEqual([]);
    // cada estudio abre su propio envio, con su propio conteo y sin mezclar avisos (R-4)
    expect((await ec.envios(E2, { usuarioId: x.id }))[0]!.total_avisos).toBe(1);
  });

  it("el tope sale de correo_programacion.tope_diario", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.fijarProgramacionCorreo({ tope_diario: 2 });
    try {
      await ec.sembrarEnviados(E, u, 2);
      await ec.capturar(worker, E, c, 1);
      expect(await diferidos(u)).toHaveLength(1);
    } finally {
      await ec.restaurarProgramacionCorreo();
    }
  });

  it("con la preferencia apagada no se difiere nada: no hay aviso", async () => {
    const { u, c } = await usuarioConCliente();
    await ec.preferencia(E, u, "buzon_critico", false);
    await ec.sembrarEnviados(E, u, 30);
    await ec.capturar(worker, E, c, 1);
    expect(await ec.avisosDe(E, { usuarioId: u })).toEqual([]);
  });
});

describe("CA-5, R-4 · un usuario en dos estudios: avisos y preferencias separados", () => {
  it("cada estudio registra el suyo, con su envio, y la preferencia de uno no apaga la del otro", async () => {
    const x = await ec.et.ea.cuenta();
    await ec.et.ea.membresia(E, x.id, "contador");
    await ec.et.ea.membresia(E2, x.id, "contador");
    const cE = await ec.et.cliente(E);
    const cE2 = await ec.et.cliente(E2);
    await ec.et.asignar(E, cE.id, x.id, "responsable");
    await ec.et.asignar(E2, cE2.id, x.id, "responsable");
    await ec.preferencia(E, x.id, "buzon_critico", false);
    await ec.capturar(worker, E, cE, 1);
    await ec.capturar(worker, E2, cE2, 2);
    expect(await ec.avisosDe(E, { usuarioId: x.id })).toEqual([]);
    const enE2 = await ec.envios(E2, { usuarioId: x.id });
    expect(enE2).toHaveLength(1);
    expect(enE2[0]!.total_avisos).toBe(2);
    expect((await ec.avisosDe(E2, { usuarioId: x.id })).every((a) => a.tenant_id === E2 && a.envio_id === enE2[0]!.id)).toBe(true);
  });
});
