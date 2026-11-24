import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { crearColaSistema } from "@contapp/queue/worker";
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
  APP_ORIGIN,
  CorreoMemoria,
  EscenarioCorreo,
  ProgramacionCorreo,
  soloMisEstudios,
} from "../../../test/correo.js";
import { canario, loggerEspia } from "../../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  esperarHasta,
  nuevoPrefijo,
  opcionesBull,
  limpiarPrefijo,
  volcarPrefijo,
} from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import {
  programarCorreo,
  type ResultadoCicloCorreo,
} from "./programar-correo.js";

// Spec 028, T5 (rojo; integración con PostgreSQL y Redis reales): el ciclo `correo.programar` (R-1, R-5, R-12, R-14; CA-4, CA-9, CA-10,
// CA-11, CA-14). El tiempo sale de la BD: las pruebas lo fijan con filas de `correo_programacion` y `correo_envio` (como superusuario),
// sin dormir. CONTRATO que fija (T11): el de test/correo.ts (cabecera): `programarCorreo(deps)` devuelve la función de un tick con
// `ResultadoCicloCorreo = {tomado, estudios, avisosEncolados, resumenesCreados, resumenDia, diaCerrado, perdioCandado}`, más el caso
// `correo.programar` de `procesarSistema` y `CORREO_PROGRAMADOR=off` en `iniciarTrabajos`. Lo encolado: `notificacion.enviar`, cola
// `notificaciones`, sin solicitante ni cliente y con `parametros = {envioId}` y nada más.

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

type Tick = () => Promise<ResultadoCicloCorreo>;

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let entornoAnterior: string | undefined;

beforeAll(async () => {
  entornoAnterior = process.env.CORREO_PROGRAMADOR;
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  prog = new ProgramacionCorreo(admin);
  await prog.guardar();
});

beforeEach(() => {
  process.env.CORREO_PROGRAMADOR = "off";
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  e = new EscenarioCorreo(admin, backend, worker);
});

afterEach(async () => {
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.CORREO_PROGRAMADOR;
  else process.env.CORREO_PROGRAMADOR = entornoAnterior;
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

/** Una instancia del programador (un «proceso» con su dueño propio) que solo atiende los estudios de la prueba. */
function instancia(
  o: { db?: ContappDb; logger?: LoggerTrabajos; dueno?: string; redis?: boolean } = {},
): Tick {
  return programarCorreo({
    db: soloMisEstudios(o.db ?? worker, () => e.estudios),
    ...(o.redis === false ? {} : { redis, prefijo }),
    ...(o.logger === undefined ? {} : { logger: o.logger }),
    ...(o.dueno === undefined ? {} : { dueno: o.dueno }),
  });
}

/** Estudio con un Dueño y un cliente con un crítico capturado: deja un envío `buzon_critico` vencido. */
async function estudioConAviso(
  o: { razon?: string; estado?: "activa" | "prueba" | null; features?: Record<string, unknown> } = {},
) {
  const T = await e.estudioPlan({
    ...(o.estado === undefined ? {} : { estado: o.estado }),
    ...(o.features === undefined ? {} : { features: o.features }),
  });
  const dueno = await e.usuario(T, "dueno");
  const c = await e.clienteCon(T, o.razon ?? `Cliente ${randomUUID().slice(0, 6)} SAC`);
  await e.capturar(T, c);
  return { T, dueno, c };
}

const diaDe = async (envioId: string): Promise<string> =>
  (
    await admin.pool.query("select dia_lima::text as d from correo_envio where id = $1", [envioId])
  ).rows[0].d as string;

// ---------------------------------------------------------------------------------------------------------------
// CA-9, R-14: los avisos vencidos pasan a la cola
// ---------------------------------------------------------------------------------------------------------------

describe("R-14, R-1: el ciclo encola los envíos de aviso vencidos y solo esos", () => {
  it("encola el vencido y no el que aún no vence; repetir no duplica; la cola lleva solo {envioId}", async () => {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const c1 = await e.clienteCon(T, "Cliente Uno SAC");
    const c2 = await e.clienteCon(T, "Cliente Dos SAC");
    await e.capturar(T, c1);
    await e.invalidarCredencial(T, c2);
    const critico = await e.envioDe(T, { usuarioId: dueno, tipo: "buzon_critico" });
    const credencial = await e.envioDe(T, { usuarioId: dueno, tipo: "credencial_invalida" });
    await e.programarPara(credencial.id, "10 minutes");
    await prog.listoParaTomar();

    const ciclo = instancia();
    const r = await ciclo();
    expect(r).toMatchObject({ tomado: true, perdioCandado: false, avisosEncolados: 1 });
    const jobs = await e.trabajosEnviar(T);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      tipo: "notificacion.enviar",
      cola: "notificaciones",
      estado: "en_cola",
      creado_por: null,
      cliente_id: null,
      parametros: { envioId: critico.id },
    });
    expect(Object.keys(jobs[0].parametros)).toEqual(["envioId"]);
    expect((await e.envio(critico.id)).estado, "se envía en el procesador, no aquí").toBe("pendiente");
    expect((await e.envio(credencial.id)).estado).toBe("pendiente");

    await prog.listoParaTomar();
    expect((await ciclo()).avisosEncolados, "repetirlo da 0").toBe(0);
    expect(await e.trabajosEnviar(T)).toHaveLength(1);

    // El que faltaba vence: el siguiente ciclo lo encola.
    await e.programarPara(credencial.id, "-1 minute");
    await prog.listoParaTomar();
    expect((await ciclo()).avisosEncolados).toBe(1);
    const ids = (await e.trabajosEnviar(T)).map((j) => j.parametros.envioId).sort();
    expect(ids).toEqual([critico.id, credencial.id].sort());
  });

  it("publica la pista de cada trabajo encolado en Redis (si se pierde, lo repone el reconciliador)", async () => {
    const { T } = await estudioConAviso();
    await prog.listoParaTomar();
    expect((await instancia()()).avisosEncolados).toBe(1);
    const [job] = await e.trabajosEnviar(T);
    expect(await volcarPrefijo(redis, prefijo)).toContain(job.id);
  });

  it("un estudio que perdió la suscripción no se atiende (R-12, U-19) y uno sin `correo_avisos` nunca registró el aviso (CA-11)", async () => {
    const perdio = await estudioConAviso();
    await admin.pool.query("delete from suscripcion where tenant_id = $1", [perdio.T]);
    const sinAvisos = await estudioConAviso({ features: { correo_avisos: false } });
    const normal = await estudioConAviso({ estado: "prueba" });
    expect(await e.envios(sinAvisos.T), "el plan lo apaga: ni siquiera se registra").toHaveLength(0);
    expect(await e.envios(perdio.T)).toHaveLength(1);

    await prog.listoParaTomar();
    const r = await instancia()();
    expect(r.avisosEncolados, "solo el estudio en prueba vigente").toBe(1);
    expect(r.estudios).toBe(2);
    expect(await e.trabajosEnviar(perdio.T)).toHaveLength(0);
    expect(await e.trabajosEnviar(normal.T)).toHaveLength(1);
  });

  it("los logs llevan solo ids de estudio, conteos y códigos: nunca correo, razón social ni nombre del estudio (R-8)", async () => {
    const razon = canario("razon");
    const { T, dueno } = await estudioConAviso({ razon });
    const espia = loggerEspia();
    await prog.listoParaTomar();
    expect(
      (await instancia({ logger: espia.logger as unknown as LoggerTrabajos })()).avisosEncolados,
    ).toBe(1);
    const texto = JSON.stringify(espia.llamadas);
    for (const prohibido of [razon, await e.emailDe(dueno), await e.nombreEstudio(T)])
      expect(texto).not.toContain(prohibido);
    for (const llamada of espia.llamadas)
      for (const arg of llamada.args)
        for (const v of Object.values(arg as Record<string, unknown>))
          expect(["string", "number", "boolean", "undefined"].includes(typeof v) || v === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R-5, CA-4: el resumen del día
// ---------------------------------------------------------------------------------------------------------------

describe("R-5, CA-4: el resumen sale una vez por día, a la hora de la BD", () => {
  async function estudioConResumen() {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const activo = await e.usuario(T, "contador");
    const apagado = await e.usuario(T, "contador");
    const c = await e.clienteCon(T, "Cliente Resumen SAC");
    await e.responsable(T, c, activo);
    await e.fijar(T, activo, { resumen: true });
    return { T, dueno, activo, apagado, c };
  }

  it("a la hora crea un resumen por usuario con el resumen activo, lo encola y cierra el día; el siguiente ciclo no lo repite", async () => {
    const { T, activo, apagado } = await estudioConResumen();
    const hoy = (await e.hoyLima()).dia;
    await prog.resumenYaToca();
    await prog.listoParaTomar();
    const ciclo = instancia();

    const r = await ciclo();
    expect(r).toMatchObject({ tomado: true, resumenDia: hoy, resumenesCreados: 1, diaCerrado: true, perdioCandado: false });
    const resumen = await e.envioDe(T, { usuarioId: activo, origen: "resumen" });
    expect(resumen).toMatchObject({ tipo: "resumen", estado: "pendiente", clave: `resumen:${activo}:${hoy}` });
    expect(await diaDe(resumen.id)).toBe(hoy);
    expect(await e.envios(T, { usuarioId: apagado, origen: "resumen" }), "sin suscripción al resumen, nada").toHaveLength(0);
    const jobs = await e.trabajosEnviar(T);
    expect(jobs.map((j) => j.parametros)).toEqual([{ envioId: resumen.id }]);

    await prog.listoParaTomar();
    const otra = await ciclo();
    expect(otra).toMatchObject({ tomado: true, resumenDia: null, resumenesCreados: 0, diaCerrado: false });
    expect(await e.trabajosEnviar(T)).toHaveLength(1);
  });

  it("antes de la hora o en un día fuera de `dias_resumen` no crea nada; el cambio de la BD rige en el ciclo siguiente, sin reiniciar", async () => {
    const { T, activo } = await estudioConResumen();
    const { dia, isodow } = await e.hoyLima();
    const ciclo = instancia();

    await prog.antesDeLaHora();
    await prog.listoParaTomar();
    expect(await ciclo()).toMatchObject({ tomado: true, resumenDia: null, resumenesCreados: 0, diaCerrado: false });

    await prog.hoyNoEsDiaDeResumen(isodow);
    await prog.listoParaTomar();
    expect(await ciclo()).toMatchObject({ resumenDia: null, resumenesCreados: 0 });
    expect(await e.envios(T, { usuarioId: activo, origen: "resumen" })).toHaveLength(0);

    // Sin worker a la hora: sale en el primer ciclo posterior del mismo día de Lima.
    await prog.resumenYaToca();
    await prog.listoParaTomar();
    expect(await ciclo()).toMatchObject({ resumenDia: dia, resumenesCreados: 1, diaCerrado: true });
    expect(await e.envios(T, { usuarioId: activo, origen: "resumen" })).toHaveLength(1);
  });

  it("un plan con `correo_resumen: false` no recibe resumen (sí avisos) y atender ese estudio no deja el día abierto (CA-11)", async () => {
    const T = await e.estudioPlan({ features: { correo_resumen: false } });
    const dueno = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente Sin Resumen SAC");
    await e.responsable(T, c, dueno);
    await e.fijar(T, dueno, { resumen: true });
    await e.capturar(T, c);
    await prog.resumenYaToca();
    await prog.listoParaTomar();

    const r = await instancia()();
    expect(r).toMatchObject({ avisosEncolados: 1, resumenesCreados: 0, estudios: 1, diaCerrado: true });
    expect(await e.envios(T, { origen: "resumen" })).toHaveLength(0);
  });

  it("el fallo de un estudio no tumba el ciclo ni llega al log, no cierra el día y el ciclo siguiente lo completa", async () => {
    const malo = await estudioConResumen();
    const bueno = await estudioConResumen();
    const hoy = (await e.hoyLima()).dia;
    const canarioFalla = canario("falla_pg");
    const conFalla = new Proxy(worker, {
      get(t, p, r) {
        if (p === "withTenant")
          return async (...args: unknown[]) => {
            if ((args[0] as { tenantId?: string })?.tenantId === malo.T)
              throw new Error(`falla simulada de pg: ${canarioFalla}`);
            return (t.withTenant as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as ContappDb;
    const espia = loggerEspia();
    await prog.resumenYaToca();
    await prog.listoParaTomar();

    const r = await instancia({ db: conFalla, logger: espia.logger as unknown as LoggerTrabajos })();
    expect(r).toMatchObject({ tomado: true, estudios: 1, resumenesCreados: 1, diaCerrado: false });
    expect(await e.envios(bueno.T, { origen: "resumen" }), "el otro estudio sí se atendió").toHaveLength(1);
    expect(await e.envios(malo.T, { origen: "resumen" })).toHaveLength(0);
    expect(JSON.stringify(espia.llamadas)).not.toContain(canarioFalla);
    const f = await prog.leer();
    expect(f.ciclo_hasta, "candado soltado").toBeNull();

    // Ya sano: el día no se cerró, así que el ciclo siguiente crea el que faltaba (el del otro ya existía: idempotente).
    await prog.listoParaTomar();
    expect(await instancia()()).toMatchObject({ resumenDia: hoy, resumenesCreados: 1, diaCerrado: true });
    expect(await e.envios(malo.T, { origen: "resumen" })).toHaveLength(1);
    expect(await e.envios(bueno.T, { origen: "resumen" })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-4, CA-14: varios workers y candado
// ---------------------------------------------------------------------------------------------------------------

describe("CA-4: varios workers", () => {
  it("con tres instancias y ticks simultáneos durante 10 ciclos, cada envío se encola una vez y el ciclo nunca corre dos veces", async () => {
    const T = await e.estudioPlan();
    await e.usuario(T, "dueno");
    const ciclos = [instancia(), instancia(), instancia()];
    for (let ronda = 1; ronda <= 10; ronda++) {
      // Un envío nuevo por ronda: usuario y cliente propios (si no, la captura se sumaría al envío pendiente de la ventana).
      const u = await e.usuario(T, "contador");
      const c = await e.clienteCon(T, `Cliente ronda ${ronda} SAC`);
      await e.responsable(T, c, u);
      await e.capturar(T, c);
      await prog.listoParaTomar();
      const rs = await Promise.all(ciclos.map((c1) => c1()));
      expect(rs.filter((r) => r.tomado), `ronda ${ronda}: un solo ciclo`).toHaveLength(1);
      expect(rs.reduce((n, r) => n + r.avisosEncolados, 0), `ronda ${ronda}: cada envío una vez`).toBe(1);
      expect(await e.trabajosEnviar(T), `ronda ${ronda}`).toHaveLength(ronda);
    }
    const ids = (await e.trabajosEnviar(T)).map((j) => j.parametros.envioId);
    expect(new Set(ids).size).toBe(10);
  });

  it("si el worker que tiene el ciclo muere, otro lo toma cuando vence el candado", async () => {
    await estudioConAviso();
    await prog.fijarCiclo("worker-muerto", new Date(Date.now() + 5 * 60_000), new Date(Date.now() - 3_600_000));
    const ciclos = [instancia(), instancia(), instancia()];

    const durante = await Promise.all(ciclos.map((c) => c()));
    expect(durante.filter((r) => r.tomado)).toHaveLength(0);
    expect(durante.reduce((n, r) => n + r.avisosEncolados, 0)).toBe(0);

    await admin.pool.query("update correo_programacion set ciclo_hasta = clock_timestamp() - interval '1 second'");
    const despues = await Promise.all(ciclos.map((c) => c()));
    expect(despues.filter((r) => r.tomado)).toHaveLength(1);
    expect(despues.reduce((n, r) => n + r.avisosEncolados, 0)).toBe(1);
    expect((await prog.leer()).ciclo_dueno).not.toBe("worker-muerto");
  });

  it("si pierde el candado en pleno ciclo, se detiene sin encolar más ni cerrar el día y no suelta el candado ajeno", async () => {
    const a = await estudioConAviso();
    const b = await estudioConAviso();
    await prog.resumenYaToca();
    await prog.listoParaTomar();
    let robado = false;
    const conGancho = new Proxy(worker, {
      get(t, p, r) {
        if (p === "withTenant")
          return async (...args: unknown[]) => {
            const v = await (t.withTenant as (...x: unknown[]) => Promise<unknown>)(...args);
            if (!robado && (await e.trabajosEnviar(a.T)).length + (await e.trabajosEnviar(b.T)).length > 0) {
              robado = true;
              // Pasó el vencimiento y otro worker tomó el ciclo.
              await admin.pool.query(
                "update correo_programacion set ciclo_dueno = 'otro-worker', ciclo_hasta = clock_timestamp() + interval '5 minutes'",
              );
            }
            return v;
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as ContappDb;

    const r = await instancia({ db: conGancho })();
    expect(r).toMatchObject({ tomado: true, perdioCandado: true, avisosEncolados: 1, diaCerrado: false });
    expect(
      (await e.trabajosEnviar(a.T)).length + (await e.trabajosEnviar(b.T)).length,
      "el segundo estudio no recibió nada",
    ).toBe(1);
    const f = await prog.leer();
    expect(f.ciclo_dueno).toBe("otro-worker");
    expect(f.ciclo_hasta, "no soltó el candado de otro").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Ensamblado en el worker
// ---------------------------------------------------------------------------------------------------------------

describe("R-5: el repetible y el tick en el worker", () => {
  it("registra `correo.programar` como repetible y `CORREO_PROGRAMADOR=off` no lo registra", async () => {
    delete process.env.CORREO_PROGRAMADOR;
    const conRepetible = nuevoPrefijo();
    prefijos.push(conRepetible);
    const w1 = await arrancar({ prefijo: conRepetible });
    try {
      await esperarHasta(
        async () => /correo\.programar/.test(await volcarPrefijo(redis, `${conRepetible}bull:programados`)),
        "correo.programar registrado como repetible",
      );
    } finally {
      await w1.detener({ esperaMs: 2000 });
    }

    process.env.CORREO_PROGRAMADOR = "off";
    const sinRepetible = nuevoPrefijo();
    prefijos.push(sinRepetible);
    const w2 = await arrancar({ prefijo: sinRepetible });
    try {
      await esperarHasta(
        async () => /auth\.purgar/.test(await volcarPrefijo(redis, `${sinRepetible}bull:programados`)),
        "el worker registró lo demás",
      );
      await dormir(300);
      expect(await volcarPrefijo(redis, `${sinRepetible}bull:programados`)).not.toMatch(/correo\.programar/);
    } finally {
      await w2.detener({ esperaMs: 2000 });
    }
  });

  it("el job de sistema `correo.programar` ejecuta un ciclo dentro del worker y el correo sale por el puerto inyectado", async () => {
    const { T, dueno } = await estudioConAviso({ razon: "Cliente Ensamblado SAC" });
    await prog.listoParaTomar();
    const correo = new CorreoMemoria();
    process.env.CORREO_PROGRAMADOR = "off";
    const w = await arrancar({ prefijo, correo, appOrigin: APP_ORIGIN } as Parameters<typeof arrancar>[0]);
    const cola = crearColaSistema({ conexion: opcionesBull(), prefijo });
    try {
      await cola.encolar({ tipo: "correo.programar" });
      await esperarHasta(async () => (await e.trabajosEnviar(T)).length > 0, "el tick encoló el envío");
      await esperarHasta(
        async () => (await e.envios(T, { usuarioId: dueno, estado: "enviado" })).length === 1,
        "el procesador de notificacion.enviar entregó el correo",
      );
      expect(correo.enviados).toHaveLength(1);
      expect(correo.enviados[0]).toMatchObject({ para: await e.emailDe(dueno) });
      expect(correo.enviados[0]!.texto).toContain("Cliente Ensamblado SAC");
    } finally {
      await cola.cerrar();
      await w.detener({ esperaMs: 2000 });
    }
  });
});
