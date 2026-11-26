// Spec 028 · T16 (correcciones de la ronda adversarial 1, rojo; tester · sonnet). Worker con PostgreSQL real: candado del ciclo de 90 s con
// renovación (H-028-1-2), `notificacion.enviar` solo por la BD (H-028-1-3), diferidos de un resumen apagado (H-028-1-4) y tope de 30 que
// cuenta solo lo enviado o en curso (H-028-1-8). H-028-1-1 la fija T15 (`correo-r1.adv.int.spec.ts`, «detener el worker con un tick en
// curso»). Decisiones del 2026-11-24 (tasks.md, resultado de T16). Solo pruebas: sin código de producción; las filas de relleno del
// tope se siembran como superusuario (único camino directo, como `sembrarEnviados`) y todo lo demás nace por las funciones reales.
import { renovarCicloCorreo, tomarCicloCorreo, type ContappDb } from "@contapp/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ORIGIN, CorreoMemoria, EscenarioCorreo, ProgramacionCorreo, ctxEnvio } from "../../../test/correo.js";
import { crearDbAdmin, crearDbRol, rucNuevo } from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import { enviarCorreo } from "./enviar-correo.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Duración del candado del ciclo `correo.programar` (H-028-1-2: R-14 pide aviso en ≤ 1 min y ≤ 2 min tras una caída). */
const CANDADO_S = 90;

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;

const silencio = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as LoggerTrabajos;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 4);
  prog = new ProgramacionCorreo(admin);
  await prog.guardar();
});

beforeEach(() => {
  process.env.CORREO_PROGRAMADOR = "off";
  e = new EscenarioCorreo(admin, backend, worker);
});

afterEach(async () => {
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

const tomar = (dueno: string) => worker.withSistema((tx) => tomarCicloCorreo(tx, dueno));
const renovar = (dueno: string) => worker.withSistema((tx) => renovarCicloCorreo(tx, dueno));
/** Segundos que le quedan al candado según el reloj de la BD (null = libre). */
const restanteS = async (): Promise<number | null> => {
  const { rows } = await admin.pool.query(
    "select extract(epoch from ciclo_hasta - clock_timestamp())::float8 as s from correo_programacion",
  );
  return rows[0].s === null ? null : Number(rows[0].s);
};
/** Hace pasar `s` segundos para el candado: es lo que verían los demás workers si su dueño dejara de renovarlo ese tiempo. */
const envejecerCandado = (s: number) =>
  admin.pool.query(
    `update correo_programacion set ciclo_hasta = ciclo_hasta - make_interval(secs => $1::float8),
            ultimo_ciclo_inicio = ultimo_ciclo_inicio - make_interval(secs => $1::float8)`,
    [s],
  );

describe("T16 · H-028-1-2: candado del ciclo de 90 s, renovado en cada paso", () => {
  it("tomar el ciclo deja el candado a 90 s (no a 5 min)", async () => {
    await prog.listoParaTomar();
    expect(await tomar("worker-a")).not.toBeNull();
    const s = (await restanteS())!;
    expect(s, `candado restante: ${s.toFixed(1)} s`).toBeGreaterThan(CANDADO_S - 5);
    expect(s, `candado restante: ${s.toFixed(1)} s (un worker muerto bloquearía el ciclo hasta ese tiempo)`).toBeLessThanOrEqual(CANDADO_S);
  });

  it("renovar devuelve el candado a 90 s desde ahora: ni lo alarga más allá ni lo deja corto", async () => {
    await prog.listoParaTomar();
    expect(await tomar("worker-a")).not.toBeNull();
    await envejecerCandado(CANDADO_S - 10); // el worker lleva casi 90 s sin renovar
    expect(await renovar("worker-a")).toBe(true);
    const s = (await restanteS())!;
    expect(s, `candado tras renovar: ${s.toFixed(1)} s`).toBeGreaterThan(CANDADO_S - 5);
    expect(s, `candado tras renovar: ${s.toFixed(1)} s`).toBeLessThanOrEqual(CANDADO_S);
  });

  it("un worker vivo que renueva conserva el ciclo más de 90 s; el que murió hace 100 s sin renovar lo cede a otro (R-14: ≤ 2 min tras una caída)", async () => {
    await prog.listoParaTomar();
    expect(await tomar("worker-a")).not.toBeNull();
    // 80 s después sigue vigente para los demás.
    await envejecerCandado(80);
    expect(await tomar("worker-b"), "a los 80 s el candado de A sigue vigente").toBeNull();
    // A renueva (sigue vivo, estudio a estudio) y otros 80 s después, 160 s desde que lo tomó, B aún no lo puede tomar.
    expect(await renovar("worker-a")).toBe(true);
    await envejecerCandado(80);
    expect(await tomar("worker-b"), "A renovó: a los 160 s desde que lo tomó sigue siendo suyo").toBeNull();
    // A muere sin renovar: 20 s más (100 s desde su última renovación) y el candado venció.
    await envejecerCandado(20);
    const b = await tomar("worker-b");
    expect(b, `a los 100 s sin renovar B debe poder tomar el ciclo (candado restante ${((await restanteS()) ?? 0).toFixed(0)} s)`).not.toBeNull();
    expect(await renovar("worker-a"), "el dueño anterior ya no puede renovar un candado que perdió").toBe(false);
  });
});

describe("T16 · H-028-1-3: solo la BD encola notificacion.enviar (R-1, R-11)", () => {
  it("el rol del backend no inserta un notificacion.enviar ni siquiera con un cliente real del estudio, y la cola no lo recibe", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente del trabajo");
    const insertar = (tipo: string, cliente: { id: string; ruc: string } | null) =>
      backend
        .withTenant({ tenantId: T, userId: d }, (tx) =>
          tx.query(
            `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por,
                                       max_intentos)
             values ($1, $2, $3, 'notificaciones', 'ninguno', 'interactivo', 'en_cola', jsonb_build_object('envioId', gen_random_uuid()),
                     sha256(gen_random_uuid()::text::bytea), $4, 3) returning id`,
            [cliente?.id ?? null, cliente?.ruc ?? null, tipo, d],
          ),
        )
        .then(
          () => "insertado",
          (err: { code?: string }) => err.code ?? "error",
        );
    const resultado = {
      sinCliente: await insertar("notificacion.enviar", null),
      conCliente: await insertar("notificacion.enviar", c),
    };
    expect(resultado, "el backend no debe poder crear trabajos notificacion.enviar: solo la BD (funciones acotadas) los encola").toEqual({
      sinCliente: expect.not.stringMatching(/^insertado$/),
      conCliente: expect.not.stringMatching(/^insertado$/),
    });
    expect(await e.trabajosEnviar(T)).toEqual([]);
  });

  it("el camino legítimo sigue: el ciclo del worker encola el envío del aviso por la función acotada", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente legítimo", rucNuevo());
    await e.responsable(T, c, d);
    await e.capturar(T, c, 1);
    const n = await worker.withTenant({ tenantId: T }, (tx) => tx.query("select encolar_correo_avisos(1000) as n"));
    expect(Number(n.rows[0].n)).toBe(1);
    expect((await e.trabajosEnviar(T)).length).toBe(1);
  });
});

describe("T16 · H-028-1-4: los diferidos de un resumen apagado no se pierden (R-14, CA-9)", () => {
  /** Dueño con el resumen activo, el tope agotado y dos críticos diferidos que ya se unieron al resumen de hoy. */
  async function conResumenDeDiferidos() {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente diferido");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    await e.sembrarEnviados(T, d, 30);
    await e.capturar(T, c, 2);
    const diferidos = (await e.avisosDe(T, { usuarioId: d })).filter((x) => x.envio_id === null).map((x) => x.notificacion_id as string);
    expect(diferidos).toHaveLength(2);
    expect(await e.crearResumenes(T, await e.diaLima(0))).toBe(1);
    return { T, d, diferidos };
  }

  it("si apaga el resumen y el día siguiente lo reactiva antes de un nuevo ciclo, los dos diferidos van al nuevo resumen, no al omitido", async () => {
    const { T, d, diferidos } = await conResumenDeDiferidos();
    const viejo = await e.envioDe(T, { usuarioId: d, origen: "resumen" });
    await e.fijar(T, d, { resumen: false }); // D-7: el resumen pendiente queda omitido
    expect((await e.envio(viejo.id)).estado).toBe("omitido");
    await e.fijar(T, d, { resumen: true });
    expect(await e.crearResumenes(T, await e.diaLima(-1))).toBe(1); // el resumen de mañana
    const destinos: string[] = [];
    for (const f of (await e.avisosDe(T, { usuarioId: d })).filter((x) => diferidos.includes(x.notificacion_id))) {
      const env = f.envio_id === null ? null : await e.envio(f.envio_id);
      destinos.push(env === null ? "sin_envio" : env.id === viejo.id ? "resumen_omitido" : `${env.origen}:${env.estado}`);
    }
    expect(destinos, "los diferidos quedaron unidos al resumen omitido y nunca saldrán por correo").toEqual(["resumen:pendiente", "resumen:pendiente"]);
  });

  it("si apaga el resumen, salen en UN «Avisos pendientes» (no en dos) y ese correo lista los dos; ningún aviso queda sin correo", async () => {
    const { T, d, diferidos } = await conResumenDeDiferidos();
    await e.fijar(T, d, { resumen: false });
    expect(await e.crearResumenes(T, await e.diaLima(-1))).toBe(1);
    const pendientes = await e.envios(T, { usuarioId: d, origen: "pendientes" });
    expect(pendientes, "los diferidos de un resumen omitido deben crear el correo «Avisos pendientes»").toHaveLength(1);
    expect(pendientes[0]!.total_avisos).toBe(2);
    // Repetir el cálculo (mismo día o el siguiente) no los vuelve a sacar ni crea otro correo.
    expect(await e.crearResumenes(T, await e.diaLima(-1))).toBe(0);
    expect(await e.crearResumenes(T, await e.diaLima(-2))).toBe(0);
    expect(await e.envios(T, { usuarioId: d, origen: "pendientes" })).toHaveLength(1);
    // El envío sale con los dos avisos y el resumen omitido no vuelve a salir.
    const correo = new CorreoMemoria();
    const procesar = enviarCorreo({ db: worker, correo, appOrigin: APP_ORIGIN, logger: silencio });
    expect(await procesar(ctxEnvio(T, pendientes[0]!.id))).toMatchObject({ estado: "enviado" });
    expect(correo.enviados).toHaveLength(1);
    const filas = (await e.avisosDe(T, { usuarioId: d })).filter((x) => diferidos.includes(x.notificacion_id));
    expect(filas.map((f) => f.envio_id)).toEqual([pendientes[0]!.id, pendientes[0]!.id]);
    expect((await e.envio(pendientes[0]!.id)).estado).toBe("enviado");
  });
});

describe("T16 · H-028-1-8: el tope de 30 cuenta solo los envíos enviados o en curso", () => {
  /** Rellena el tope del día con envíos `aviso` en el estado dado (superusuario: es lo único de `correo_envio` que se siembra directo). */
  async function sembrar(T: string, usuarioId: string, n: number, estado: "enviado" | "pendiente" | "omitido" | "fallido", tipo = "buzon_critico") {
    await admin.pool.query(
      `insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, motivo, clave, programado_para, intentos, total_avisos,
                                 creado_en, enviado_en)
       select $1::uuid, $2::uuid, 'aviso', $3::text, $4::text,
              case $4::text when 'omitido' then 'preferencia_apagada' when 'fallido' then 'transporte' end,
              'aviso:' || $2::text || ':' || $3::text || ':' || gen_random_uuid()::text, clock_timestamp(),
              case $4::text when 'pendiente' then 0 else 1 end, 1, clock_timestamp(),
              case $4::text when 'enviado' then clock_timestamp() end
         from generate_series(1, $5::int)`,
      [T, usuarioId, tipo, estado, n],
    );
  }

  it("omitidos y fallidos no consumen el tope (el aviso 30.º sale al momento); los enviados y los en curso sí (el 31.º se difiere)", async () => {
    const T = await e.estudioPlan();
    const holgado = await e.usuario(T, "dueno"); // 29 enviados + 40 sin correo: queda 1
    const lleno = await e.usuario(T, "dueno"); // 30 enviados + 40 sin correo: agotado
    const enCurso = await e.usuario(T, "dueno"); // 29 enviados + 1 pendiente (en curso, de otro tipo): agotado
    // Un responsable por cliente: los tres reciben el aviso de su propio cliente, capturado en la misma tanda.
    const clientes = [];
    for (const u of [holgado, lleno, enCurso]) {
      const c = await e.clienteCon(T, "Cliente del tope");
      await e.responsable(T, c, u);
      clientes.push(c);
    }
    await sembrar(T, holgado, 29, "enviado");
    await sembrar(T, holgado, 20, "omitido");
    await sembrar(T, holgado, 20, "fallido");
    await sembrar(T, lleno, 30, "enviado");
    await sembrar(T, lleno, 20, "omitido");
    await sembrar(T, lleno, 20, "fallido");
    await sembrar(T, enCurso, 29, "enviado");
    await sembrar(T, enCurso, 1, "pendiente", "credencial_invalida");
    for (const c of clientes) await e.capturar(T, c, 1);
    const destino = async (u: string) => {
      const filas = await e.avisosDe(T, { usuarioId: u });
      return filas.length === 1 ? (filas[0].envio_id === null ? "diferido" : "inmediato") : `${filas.length} avisos`;
    };
    expect({ holgado: await destino(holgado), lleno: await destino(lleno), enCurso: await destino(enCurso) }).toEqual({
      holgado: "inmediato",
      lleno: "diferido",
      enCurso: "diferido",
    });
  });
});
