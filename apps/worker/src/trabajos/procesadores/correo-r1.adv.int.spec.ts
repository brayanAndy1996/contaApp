// Spec 028 · T15 (ronda adversarial 1, adversario · opus). Worker con PostgreSQL y Redis reales: ciclo `correo.programar` (candado,
// cierre del worker, volumen), cola sin cliente, diferidos y contenido. Solo pruebas: cada fallo es un hallazgo H-028-1-n (tasks.md,
// T15). Los estudios de volumen se siembran por SQL como superusuario (solo filas de soporte: estudio, plan vigente, Dueño con el
// resumen activo); los avisos nacen por su camino real (crítico insertado como el worker → triggers de 0056 → `interno.notificar`).
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { crearColaSistema } from "@contapp/queue/worker";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ORIGIN,
  CorreoMemoria,
  EscenarioCorreo,
  ProgramacionCorreo,
  ctxEnvio,
} from "../../../test/correo.js";
import { canario, loggerEspia, volcado } from "../../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  limpiarPrefijo,
  nuevoPrefijo,
  opcionesBull,
  rucNuevo,
} from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import { enviarCorreo } from "./enviar-correo.js";
import { programarCorreo } from "./programar-correo.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;
const usuariosMasivos: string[] = [];
const planesMasivos: string[] = [];
const prefijos: string[] = [];

const silencio = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as LoggerTrabajos;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  prog = new ProgramacionCorreo(admin);
  await prog.guardar();
});

beforeEach(() => {
  process.env.CORREO_PROGRAMADOR = "off";
  e = new EscenarioCorreo(admin, backend, worker);
});

afterEach(async () => {
  await e.limpiar();
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query("delete from usuario where id = any($1::uuid[])", [usuariosMasivos]);
    await c.query("delete from plan where codigo = any($1::text[])", [planesMasivos]);
  } finally {
    c.release(true);
  }
  usuariosMasivos.length = 0;
  planesMasivos.length = 0;
  await prog.restaurar();
});

afterAll(async () => {
  for (const p of prefijos) await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

/**
 * `n` estudios como los que deja la E2E con `E2E_CONSERVAR_BD=1`: plan vigente, un Dueño con el resumen activo y «todos los
 * clientes», y un cliente. Se registran en el escenario para que su limpieza los borre.
 */
async function estudiosMasivos(n: number): Promise<string[]> {
  const codigo = `adv028_${randomUUID().slice(0, 8)}`;
  planesMasivos.push(codigo);
  const plan = await admin.pool.query(
    `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra, max_rucs_extra,
                       frecuencia_buzon_min, features, activo)
     values ($1, $1, '10.00', null, 1000, 1000, '1.00', 0, 1440, '{}'::jsonb, true) returning id`,
    [codigo],
  );
  const { rows } = await admin.pool.query(
    `insert into tenant (id, nombre)
     select gen_random_uuid(), 'Estudio masivo ' || g from generate_series(1, $1::int) g returning id`,
    [n],
  );
  const ids = rows.map((r: { id: string }) => r.id);
  e.estudios.push(...ids);
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query(
      `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
       select t, $2, 'activa', null, 0 from unnest($1::uuid[]) t`,
      [ids, plan.rows[0].id],
    );
    const us = await c.query(
      `insert into usuario (id, email, nombre)
       select gen_random_uuid(), 'adv028-' || gen_random_uuid() || '@prueba.contapp.test', 'Masivo'
         from unnest($1::uuid[]) returning id`,
      [ids],
    );
    const uids = us.rows.map((r: { id: string }) => r.id);
    usuariosMasivos.push(...uids);
    await c.query(
      `insert into membresia (tenant_id, usuario_id, rol) select t, u, 'dueno' from unnest($1::uuid[], $2::uuid[]) x(t, u)`,
      [ids, uids],
    );
    await c.query(
      `insert into correo_preferencia (tenant_id, usuario_id, tipo, activo, todos_clientes)
       select t, u, tp, true, tp = 'resumen'
         from unnest($1::uuid[], $2::uuid[]) x(t, u)
         cross join unnest(array['buzon_critico','credencial_invalida','plan_limite','resumen']) tp`,
      [ids, uids],
    );
    await c.query(
      `insert into cliente (tenant_id, ruc, razon_social)
       select t, '20' || lpad((row_number() over ())::text, 9, '0'), 'Cliente masivo' from unnest($1::uuid[]) t`,
      [ids],
    );
  } finally {
    c.release(true);
  }
  return ids;
}

/** Estudio con un Dueño responsable de un cliente con un crítico nuevo (envío de aviso pendiente y vencido). */
async function avisoPendiente(): Promise<{ T: string; d: string }> {
  const T = await e.estudioPlan();
  const d = await e.usuario(T, "dueno");
  const c = await e.clienteCon(T, "Cliente medido");
  await e.responsable(T, c, d);
  await e.capturar(T, c, 1);
  return { T, d };
}

const candado = async (): Promise<{ dueno: string | null; restanteS: number | null }> => {
  const { rows } = await admin.pool.query(
    "select ciclo_dueno, extract(epoch from ciclo_hasta - clock_timestamp())::float8 as s from correo_programacion",
  );
  return { dueno: rows[0].ciclo_dueno, restanteS: rows[0].s === null ? null : Number(rows[0].s) };
};

describe("T15 · ciclo correo.programar: volumen, candado y cierre del worker", () => {
  it("con 1 200 estudios, el aviso del estudio más nuevo se encola en un tick de menos de 60 s (R-14: ≤ 1 min)", async () => {
    await estudiosMasivos(1200);
    const { T } = await avisoPendiente(); // el más nuevo, como el de la corrida E2E en curso
    await prog.listoParaTomar();
    await prog.resumenYaToca();
    await admin.pool.query("update correo_programacion set resumen_cerrado = null");
    const tick = programarCorreo({ db: worker, logger: silencio, dueno: `adv-${randomUUID()}` });

    const t0 = Date.now();
    const r1 = await tick();
    const ms1 = Date.now() - t0;
    const t1 = Date.now();
    const r2 = await tick();
    const ms2 = Date.now() - t1;

    expect(r1.tomado).toBe(true);
    expect(r1.diaCerrado).toBe(true);
    expect(r2.tomado).toBe(true);
    expect((await e.trabajosEnviar(T)).length).toBe(1);
    expect(ms1, `tick con resúmenes: ${ms1} ms`).toBeLessThan(60_000);
    expect(ms2, `tick sin resúmenes: ${ms2} ms`).toBeLessThan(60_000);
    expect((await candado()).restanteS).toBeNull(); // cada tick suelta el candado
  });

  it("H-028-1-1: detener el worker con un tick en curso (más de 5 s) suelta el candado; el worker siguiente toma el ciclo enseguida", async () => {
    const { T } = await avisoPendiente();
    await prog.listoParaTomar();
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const espia = loggerEspia();
    const terminado = () =>
      espia.llamadas.some((l) => /correo_ciclo_terminado/.test(JSON.stringify(l.args)));
    // Un tick lento (p. ej. 1 200 estudios bajo carga): la tabla de envíos queda bloqueada hasta que el worker empieza a cerrar.
    const bloqueo = await admin.pool.connect();
    let liberado = false;
    const liberar = async () => {
      if (liberado) return;
      liberado = true;
      await bloqueo.query("commit").catch(() => undefined);
      bloqueo.release();
    };
    const w = await arrancar({ prefijo, logger: espia.logger as unknown as LoggerTrabajos });
    const cola = crearColaSistema({ conexion: opcionesBull(), prefijo });
    try {
      await bloqueo.query("begin");
      await bloqueo.query("lock table correo_envio in access exclusive mode");
      await cola.encolar({ tipo: "correo.programar" });
      await esperarHasta(async () => (await candado()).dueno !== null && ((await candado()).restanteS ?? 0) > 0, "el tick tomó el candado");
      // Cierre ordenado (SIGTERM de un despliegue o del teardown de la E2E) mientras el tick sigue en curso.
      await w.en.detener({ esperaMs: 10_000 });
      await liberar();
      await esperarHasta(terminado, "el tick en curso terminó", { timeoutMs: 30_000 });

      const c = await candado();
      // Esperado: el candado se soltó (ciclo_hasta NULL) y el siguiente worker atiende el aviso en su primer tick.
      const siguiente = await programarCorreo({ db: worker, logger: silencio, dueno: `nuevo-${randomUUID()}` })();
      expect(
        { candadoRestanteS: c.restanteS === null ? null : Math.round(c.restanteS), siguienteTomado: siguiente.tomado },
        "el worker que se detuvo dejó el candado tomado: el siguiente no puede tomar el ciclo hasta que venza (≈5 min)",
      ).toEqual({ candadoRestanteS: null, siguienteTomado: true });
      expect((await e.trabajosEnviar(T)).length).toBe(1);
    } finally {
      await liberar();
      await cola.cerrar();
      await w.detener({ esperaMs: 2_000 }).catch(() => undefined);
    }
  });

  it("H-028-1-2: si el dueño del candado murió hace 2 min sin renovarlo, otro worker toma el ciclo (R-14: aviso en ≤ 1 min)", async () => {
    const { T } = await avisoPendiente();
    // Candado tomado hace 2 min por un proceso que murió (kill -9) sin renovar: vence a los 5 min de tomado.
    await admin.pool.query(
      `update correo_programacion set ciclo_dueno = 'muerto', ultimo_ciclo_inicio = clock_timestamp() - interval '2 minutes',
              ciclo_hasta = clock_timestamp() + interval '3 minutes'`,
    );
    const r = await programarCorreo({ db: worker, logger: silencio, dueno: `vivo-${randomUUID()}` })();
    expect(r.tomado, "un candado sin renovar por 2 min sigue vigente 3 min más: avisos detenidos hasta 5 min").toBe(true);
    expect((await e.trabajosEnviar(T)).length).toBe(1);
  });
});

describe("T15 · cola sin cliente: solo la BD encola notificacion.enviar", () => {
  it("H-028-1-3: el rol del backend no puede insertar un trabajo notificacion.enviar (R-1, R-11: lo encola solo la BD)", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const insertar = (tipo: string, conCliente: boolean) =>
      backend
        .withTenant({ tenantId: T, userId: d }, (tx) =>
          tx.query(
            `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por,
                                       max_intentos)
             values ($1, $2, $3, 'notificaciones', 'ninguno', 'interactivo', 'en_cola', jsonb_build_object('envioId', gen_random_uuid()),
                     sha256(gen_random_uuid()::text::bytea), $4, 3) returning id`,
            [conCliente ? randomUUID() : null, conCliente ? rucNuevo() : null, tipo, d],
          ),
        )
        .then(
          () => "insertado",
          (err: { code?: string }) => err.code ?? "error",
        );
    // Control: otro tipo sin cliente lo rechaza el CHECK de 0073 (el despachador no lo revalidaría).
    expect(await insertar("sire.propuesta.descargar", false)).toBe("23514");
    // Hallazgo si se inserta: el despachador lo pasa sin revalidar (cliente nulo) y el worker manda antes de cerrar la ventana.
    expect(await insertar("notificacion.enviar", false)).not.toBe("insertado");
  });

  it("un notificacion.enviar del estudio A con el envioId de un envío del estudio B no toca ni manda el de B", async () => {
    const a = await avisoPendiente();
    const b = await avisoPendiente();
    const [envioB] = await e.envios(b.T, { origen: "aviso" });
    const correo = new CorreoMemoria();
    const procesar = enviarCorreo({ db: worker, correo, appOrigin: APP_ORIGIN, logger: silencio });
    await expect(procesar(ctxEnvio(a.T, envioB!.id))).rejects.toBeTruthy();
    expect(correo.enviados).toHaveLength(0);
    const despues = await e.envio(envioB!.id);
    expect({ estado: despues.estado, intentos: despues.intentos, tomado: despues.tomado_en }).toEqual({
      estado: "pendiente",
      intentos: 0,
      tomado: null,
    });
  });
});

describe("T15 · diferidos por el tope (R-14: ninguno se pierde)", () => {
  it("H-028-1-4: si el usuario apaga el resumen que ya llevaba sus diferidos, esos avisos salen en «Avisos pendientes»", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente diferido");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    await e.sembrarEnviados(T, d, 30); // tope del día agotado
    await e.capturar(T, c, 2);
    const diferidos = (await e.avisosDe(T, { usuarioId: d })).filter((x) => x.envio_id === null);
    expect(diferidos).toHaveLength(2);

    const hoy = await e.diaLima(0);
    expect(await e.crearResumenes(T, hoy)).toBe(1); // el resumen de hoy lleva los dos diferidos
    await e.fijar(T, d, { resumen: false }); // D-7: el resumen pendiente queda omitido (preferencia_apagada)
    const resumen = await e.envioDe(T, { usuarioId: d, origen: "resumen" });
    expect(resumen.estado).toBe("omitido");

    // Siguiente día de resumen: sin resumen activo, los diferidos van a «Avisos pendientes» (U-17).
    await e.crearResumenes(T, await e.diaLima(-1));
    const filas = await e.avisosDe(T, { usuarioId: d });
    const vivos = [];
    for (const f of filas.filter((x) => diferidos.some((y) => y.notificacion_id === x.notificacion_id))) {
      const env = f.envio_id === null ? null : await e.envio(f.envio_id);
      vivos.push(env !== null && env.estado !== "omitido" ? env.origen : env === null ? "sin_envio" : `omitido:${env.origen}`);
    }
    expect(vivos, "los diferidos quedaron unidos a un resumen omitido: nunca salen por correo").toEqual(["pendientes", "pendientes"]);
  });
});

describe("T15 · tope del día (R-14: 30 correos inmediatos)", () => {
  it("H-028-1-8: los envíos omitidos (no salió ningún correo) no consumen el tope: el aviso 31 del día sale al momento", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente ventanas");
    await e.responsable(T, c, d);
    // 30 ventanas cuyo envío queda omitido (el usuario apaga y vuelve a encender el tipo): ningún correo salió hoy.
    for (let i = 0; i < 30; i++) {
      await e.capturar(T, c, 1);
      await e.fijar(T, d, { buzonCritico: false });
      await e.fijar(T, d, { buzonCritico: true });
    }
    const hoy = await e.envios(T, { usuarioId: d, origen: "aviso" });
    expect(hoy).toHaveLength(30);
    expect(hoy.every((x) => x.estado === "omitido")).toBe(true);
    await e.capturar(T, c, 1);
    const sinEnvio = (await e.avisosDe(T, { usuarioId: d })).filter((x) => x.envio_id === null);
    expect(sinEnvio.length, "el aviso quedó diferido hasta el resumen aunque hoy no salió ningún correo inmediato").toBe(0);
  });
});

describe("T15 · contenido: «Avisos pendientes» con nombre del estudio y razón social hostiles", () => {
  it("asunto sin CR/LF ni controles, HTML escapado, sin RUC, asunto del mensaje ni token fuera de la baja; resultado y log limpios", async () => {
    const T = await e.estudioPlan();
    const hostil = `<img src=x onerror=alert(1)>\r\nBcc: x@evil.test\u0007‮${"Ñ".repeat(300)}`;
    await admin.pool.query("update tenant set nombre = $2 where id = $1", [T, hostil]);
    const d = await e.usuario(T, "dueno");
    const ruc = rucNuevo();
    const razon = `${canario("razon")}<script>alert(1)</script>\r\nX-Inyectada: 1`;
    const c = await e.clienteCon(T, razon, ruc);
    await e.responsable(T, c, d);
    await e.sembrarEnviados(T, d, 30);
    const asunto = canario("asunto");
    await e.capturar(T, c, 1, { asunto, remitente: canario("remitente") });
    await e.crearResumenes(T, await e.diaLima(0)); // sin resumen activo: «Avisos pendientes»
    const env = await e.envioDe(T, { usuarioId: d, origen: "pendientes" });

    const correo = new CorreoMemoria();
    const espia = loggerEspia();
    const procesar = enviarCorreo({ db: worker, correo, appOrigin: APP_ORIGIN, logger: espia.logger as unknown as LoggerTrabajos });
    const res = await procesar(ctxEnvio(T, env.id));
    expect(res).toMatchObject({ estado: "enviado" });
    expect(correo.enviados).toHaveLength(1);
    const m = correo.enviados[0]!;
    expect(m.asunto).not.toMatch(/[\r\n\u0000-\u001f\u007f‮]/);
    expect(m.asunto.length).toBeLessThanOrEqual(160);
    expect(m.html ?? "").not.toMatch(/<img|<script|<[a-z]+[^>]*\son[a-z]+=/i);
    const token = new URL(m.baja!.url).searchParams.get("t")!;
    for (const prohibido of [ruc, asunto, "X-Inyectada: 1\r\n"]) {
      expect(`${m.asunto}\n${m.texto}\n${m.html}`).not.toContain(prohibido);
    }
    const fuera = `${volcado(res)}\n${volcado(espia.llamadas)}\n${JSON.stringify(await e.envio(env.id))}`;
    for (const prohibido of [token, ruc, asunto, razon.slice(0, 20), "Bcc"]) expect(fuera).not.toContain(prohibido);
  });
});
