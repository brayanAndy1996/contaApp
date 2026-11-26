import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  EscenarioCorreo,
  ProgramacionCorreo,
  soloMisEstudios,
} from "../../../test/correo.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  limpiarPrefijo,
  nuevoPrefijo,
} from "../../../test/trabajos.js";
import {
  programarCorreo,
  type ResultadoCicloCorreo,
} from "./programar-correo.js";

// Spec 028, T22a (D-1 de la prueba manual T22; decisión U-19: un estudio sin plan no recibe nada). Un envío de avisos registrado
// mientras el estudio tenía plan y que vence cuando ya no lo tiene (suscripción borrada, prueba vencida o `correo_avisos: false`)
// no puede quedar `pendiente` para salir junto con los demás cuando vuelva el plan: el ciclo lo cierra `omitido` `sin_plan`, sin
// encolarlo ni enviarlo. Lo que aún no vence, lo que ya tiene un trabajo vivo (ese trabajo lo cierra al tomarlo) y lo de un estudio
// con plan no se tocan.

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  prog = new ProgramacionCorreo(admin);
  await prog.guardar();
});

beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  e = new EscenarioCorreo(admin, backend, worker);
});

afterEach(async () => {
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

const tick = (): Promise<ResultadoCicloCorreo> =>
  programarCorreo({
    db: soloMisEstudios(worker, () => e.estudios),
    redis,
    prefijo,
  })();

async function estudioConAviso(o: { estado?: "activa" | "prueba" } = {}) {
  const T = await e.estudioPlan(
    o.estado === undefined ? {} : { estado: o.estado },
  );
  const dueno = await e.usuario(T, "dueno");
  const c = await e.clienteCon(T, `Cliente ${randomUUID().slice(0, 6)} SAC`);
  await e.capturar(T, c);
  const envio = await e.envioDe(T, { usuarioId: dueno, tipo: "buzon_critico" });
  return { T, dueno, envio };
}

const sinSuscripcion = (T: string) =>
  admin.pool.query("delete from suscripcion where tenant_id = $1", [T]);
const vencerPrueba = (T: string) =>
  admin.pool.query(
    "update suscripcion set prueba_vence_en = clock_timestamp() - interval '1 minute' where tenant_id = $1",
    [T],
  );
const renovarPrueba = (T: string) =>
  admin.pool.query(
    "update suscripcion set prueba_vence_en = clock_timestamp() + interval '14 days' where tenant_id = $1",
    [T],
  );
const avisosDelPlan = (T: string, activo: boolean) =>
  admin.pool.query(
    `update plan set features = features || jsonb_build_object('correo_avisos', $2::boolean)
      where id = (select plan_id from suscripcion where tenant_id = $1)`,
    [T, activo],
  );

describe("D-1 (T22a, U-19): los avisos pendientes de un estudio que perdió el plan se cierran `omitido` `sin_plan`", () => {
  it("prueba vencida: el ciclo lo cierra sin encolarlo y, al renovarla, no sale nada viejo", async () => {
    const { T, envio } = await estudioConAviso({ estado: "prueba" });
    await vencerPrueba(T);
    await prog.listoParaTomar();
    const r = await tick();
    expect(r.avisosEncolados).toBe(0);
    expect(await e.envio(envio.id)).toMatchObject({
      estado: "omitido",
      motivo: "sin_plan",
      enviado_en: null,
    });
    expect(await e.trabajosEnviar(T)).toHaveLength(0);

    await renovarPrueba(T);
    await prog.listoParaTomar();
    expect(
      (await tick()).avisosEncolados,
      "nada viejo sale al volver el plan",
    ).toBe(0);
    expect(await e.trabajosEnviar(T)).toHaveLength(0);
    expect(await e.envio(envio.id)).toMatchObject({
      estado: "omitido",
      motivo: "sin_plan",
    });
  });

  it("sin suscripción y con `correo_avisos: false` en el plan: también `omitido` `sin_plan`", async () => {
    const perdio = await estudioConAviso();
    const apagado = await estudioConAviso();
    await sinSuscripcion(perdio.T);
    await avisosDelPlan(apagado.T, false);
    await prog.listoParaTomar();
    await tick();
    for (const x of [perdio, apagado]) {
      expect(await e.envio(x.envio.id)).toMatchObject({
        estado: "omitido",
        motivo: "sin_plan",
      });
      expect(await e.trabajosEnviar(x.T)).toHaveLength(0);
    }
    await avisosDelPlan(apagado.T, true);
    await prog.listoParaTomar();
    expect((await tick()).avisosEncolados).toBe(0);
    expect(await e.trabajosEnviar(apagado.T)).toHaveLength(0);
  });

  it("no toca lo que aún no vence, lo que ya tiene su trabajo vivo ni lo de un estudio con plan", async () => {
    const futuro = await estudioConAviso();
    const conTrabajo = await estudioConAviso();
    const conPlan = await estudioConAviso();
    await e.programarPara(futuro.envio.id, "10 minutes");
    await prog.listoParaTomar();
    // El de `conTrabajo` (y el de `conPlan`) quedan encolados mientras hay plan.
    expect((await tick()).avisosEncolados).toBe(2);
    await sinSuscripcion(futuro.T);
    await sinSuscripcion(conTrabajo.T);
    await prog.listoParaTomar();
    await tick();
    expect(await e.envio(futuro.envio.id), "aún no vence").toMatchObject({
      estado: "pendiente",
      motivo: null,
    });
    expect(
      await e.envio(conTrabajo.envio.id),
      "lo cierra su trabajo al tomarlo",
    ).toMatchObject({
      estado: "pendiente",
      motivo: null,
    });
    expect(await e.envio(conPlan.envio.id)).toMatchObject({
      estado: "pendiente",
      motivo: null,
    });
    expect(await e.trabajosEnviar(conPlan.T)).toHaveLength(1);

    // Vencido ya sin plan: se cierra en el ciclo siguiente.
    await e.programarPara(futuro.envio.id, "-1 minute");
    await prog.listoParaTomar();
    await tick();
    expect(await e.envio(futuro.envio.id)).toMatchObject({
      estado: "omitido",
      motivo: "sin_plan",
    });
    expect(await e.trabajosEnviar(futuro.T)).toHaveLength(0);
  });
});
