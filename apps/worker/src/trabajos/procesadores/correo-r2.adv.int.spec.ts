/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y proxies de prueba */
// Spec 028 · T18 (ronda adversarial 2, adversario · opus). Worker con PostgreSQL y Redis reales. Ataca lo que cambió en T17 (0075):
// candado de 90 s renovado tras cada estudio y `dbCandado` de `iniciarTrabajos`, diferidos de un resumen omitido que vuelven a diferidos,
// ventana y tope que cuentan solo lo enviado o en curso, política RESTRICTIVE de `job_registro` y UPDATE acotado de `contapp_auth`; y la
// superficie de la ronda 2 (inundación, borde de la medianoche de Lima, U-16, contenido). Solo pruebas: cada fallo es un hallazgo
// H-028-2-n (tasks.md, T18). Los avisos nacen por su camino real (crítico insertado como el worker → triggers de 0056 →
// `interno.notificar`); el relleno del tope es lo único de `correo_envio` que se siembra directo (como `sembrarEnviados`). Los «estudios
// lentos» se simulan envolviendo la BD que recibe el programador y haciendo pasar el tiempo del candado como `contapp_migrator`.
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { crearColaSistema } from "@contapp/queue/worker";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ORIGIN,
  CorreoMemoria,
  CorreoQueMuere,
  EscenarioCorreo,
  ProgramacionCorreo,
  ctxEnvio,
  soloMisEstudios,
} from "../../../test/correo.js";
import { loggerEspia } from "../../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  limpiarPrefijo,
  nuevoPrefijo,
  opcionesBull,
} from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import { enviarCorreo } from "./enviar-correo.js";
import { programarCorreo, type ResultadoCicloCorreo } from "./programar-correo.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;
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
  await prog.restaurar();
});

afterAll(async () => {
  for (const p of prefijos) await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

// ---- Soporte de la ronda -------------------------------------------------------------------------------------------------------

interface Diferida<T = void> {
  promesa: Promise<T>;
  cumplir: (v: T) => void;
}
function diferida<T = void>(): Diferida<T> {
  let cumplir!: (v: T) => void;
  const promesa = new Promise<T>((r) => (cumplir = r));
  return { promesa, cumplir };
}

/** La BD del programador con un gancho que corre antes de la transacción de cada estudio (`n` = orden de llegada, desde 1). */
function conGancho(base: ContappDb, gancho: (tenantId: string, n: number) => Promise<void>): ContappDb {
  let n = 0;
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "withTenant")
        return async (ctx: { tenantId: string }, fn: unknown) => {
          n += 1;
          await gancho(ctx.tenantId, n);
          return (t.withTenant as any)(ctx, fn);
        };
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** Hace pasar `s` segundos para el candado del ciclo (lo que vería el resto si su dueño tardara ese tiempo sin renovarlo). */
const envejecerCandado = (s: number) =>
  admin.pool.query(
    `update correo_programacion set ciclo_hasta = ciclo_hasta - make_interval(secs => $1::float8),
            ultimo_ciclo_inicio = ultimo_ciclo_inicio - make_interval(secs => $1::float8)
      where ciclo_hasta is not null`,
    [s],
  );

const candado = async (): Promise<{ dueno: string | null; restanteS: number | null }> => {
  const { rows } = await admin.pool.query(
    "select ciclo_dueno, extract(epoch from ciclo_hasta - clock_timestamp())::float8 as s from correo_programacion",
  );
  return { dueno: rows[0].ciclo_dueno, restanteS: rows[0].s === null ? null : Number(rows[0].s) };
};

/** Estudio con un Dueño responsable de un cliente con un crítico nuevo (envío de aviso pendiente y vencido). */
async function avisoPendiente(nombre = "Cliente r2"): Promise<{ T: string; d: string }> {
  const T = await e.estudioPlan();
  const d = await e.usuario(T, "dueno");
  const c = await e.clienteCon(T, nombre);
  await e.responsable(T, c, d);
  await e.capturar(T, c, 1);
  return { T, d };
}

const procesador = (correo: CorreoMemoria) => enviarCorreo({ db: worker, correo, appOrigin: APP_ORIGIN, logger: silencio });

// ---- Candado del ciclo (0075: 90 s renovado tras cada estudio; `dbCandado` de iniciarTrabajos) -----------------------------------

describe("T18 · candado de 90 s: estudio lento, dos workers y cierre real del proceso", () => {
  it("un estudio que tarda más de 90 s corta el ciclo aunque ningún otro worker lo tomó: los estudios siguientes y el cierre del día nunca llegan (3 ticks)", async () => {
    const a = await avisoPendiente("Cliente estudio A");
    const b = await avisoPendiente("Cliente estudio B");
    await prog.listoParaTomar();
    await prog.resumenYaToca();
    const mios = [a.T, b.T];
    let lento: string | null = null;
    // El primer estudio que atiende el tick es «lento»: 100 s (consulta bloqueada, estudio grande, BD cargada). Un solo worker vivo.
    const db = conGancho(soloMisEstudios(worker, () => mios), async (tenantId) => {
      lento ??= tenantId;
      if (tenantId === lento) await envejecerCandado(100);
    });
    const tick = programarCorreo({ db, dueno: `unico-${randomUUID()}`, logger: silencio });
    const resultados: ResultadoCicloCorreo[] = [];
    for (let i = 0; i < 3; i++) {
      resultados.push(await tick());
      const k = await candado();
      expect(k.dueno === null || (k.restanteS ?? 0) <= 0, "nadie más tiene el ciclo entre ticks").toBe(true);
    }
    const otro = mios.find((t) => t !== lento)!;
    const fila = await prog.leer();
    expect(
      {
        perdioCandado: resultados.map((r) => r.perdioCandado),
        estudiosAtendidos: resultados.map((r) => r.estudios),
        trabajosDelOtroEstudio: (await e.trabajosEnviar(otro)).length,
        diaCerrado: fila.resumen_cerrado !== null,
      },
      "con un único worker vivo, el candado «vencido» por un estudio lento no lo tomó nadie: renovar debería seguir siendo posible para su dueño",
    ).toEqual({
      perdioCandado: [false, false, false],
      estudiosAtendidos: [2, 2, 2],
      trabajosDelOtroEstudio: 1,
      diaCerrado: true,
    });
  });

  it("dos workers: si B toma el ciclo mientras A sigue en un estudio lento, A no suelta el candado de B, no cierra el día ni duplica trabajos", async () => {
    const a = await avisoPendiente("Cliente dos workers A");
    const b = await avisoPendiente("Cliente dos workers B");
    await prog.listoParaTomar();
    await prog.resumenYaToca();
    const mios = [a.T, b.T];
    const base = soloMisEstudios(worker, () => mios);
    const duenoA = `A-${randomUUID()}`;
    const duenoB = `B-${randomUUID()}`;
    const bEnSegundo = diferida();
    const sueltaB = diferida();
    const dbB = conGancho(base, async (_t, n) => {
      if (n === 2) {
        bEnSegundo.cumplir();
        await sueltaB.promesa;
      }
    });
    const tickB = programarCorreo({ db: dbB, dueno: duenoB, logger: silencio });
    let pB: Promise<ResultadoCicloCorreo> | undefined;
    const dbA = conGancho(base, async (_t, n) => {
      if (n !== 1) return;
      // A lleva 100 s en su primer estudio; B arranca, toma el ciclo, atiende un estudio y queda en el segundo.
      await envejecerCandado(100);
      pB = tickB();
      await bEnSegundo.promesa;
    });
    const rA = await programarCorreo({ db: dbA, dueno: duenoA, logger: silencio })();
    const mientras = await candado();
    sueltaB.cumplir();
    const rB = await pB!;
    expect({
      candadoMientrasBTrabaja: { dueno: mientras.dueno, vigente: (mientras.restanteS ?? 0) > 0 },
      a: { perdioCandado: rA.perdioCandado, diaCerrado: rA.diaCerrado },
      b: { tomado: rB.tomado, estudios: rB.estudios, diaCerrado: rB.diaCerrado },
      trabajos: [(await e.trabajosEnviar(a.T)).length, (await e.trabajosEnviar(b.T)).length],
      candadoFinalLibre: await candado().then((k) => k.dueno === null || (k.restanteS ?? 0) <= 0),
    }).toEqual({
      candadoMientrasBTrabaja: { dueno: duenoB, vigente: true },
      a: { perdioCandado: true, diaCerrado: false },
      b: { tomado: true, estudios: 2, diaCerrado: true },
      trabajos: [1, 1],
      candadoFinalLibre: true,
    });
  });

  it("cierre real del proceso (detener + cierre del pool, como TrabajosModule) con un tick en curso: el candado se suelta y el siguiente worker toma el ciclo", async () => {
    const { T } = await avisoPendiente("Cliente cierre real");
    await prog.listoParaTomar();
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const espia = loggerEspia();
    const hay = (evento: string) => () => espia.llamadas.some((l) => JSON.stringify(l.args).includes(evento));
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
      await esperarHasta(async () => (await candado()).dueno !== null, "el tick tomó el candado");
      // SIGTERM: `onApplicationShutdown` hace `detener` y enseguida cierra el pool de la BD (worker/trabajos.module.ts).
      const cierre = w.detener({ esperaMs: 6_000 });
      await esperarHasta(hay("trabajos_detenidos"), "detener terminó", { timeoutMs: 30_000 });
      await liberar();
      await cierre;
      await esperarHasta(hay("correo_ciclo_terminado"), "el tick en curso terminó", { timeoutMs: 30_000 });
      const c = await candado();
      const siguiente = await programarCorreo({ db: worker, logger: silencio, dueno: `nuevo-${randomUUID()}` })();
      expect(
        { candadoRestanteS: c.restanteS === null ? null : Math.round(c.restanteS), siguienteTomado: siguiente.tomado },
        "con el pool ya cerrado, `dbCandado` no puede soltar: el candado queda hasta que vence",
      ).toEqual({ candadoRestanteS: null, siguienteTomado: true });
      expect((await e.trabajosEnviar(T)).length).toBe(1);
    } finally {
      await liberar();
      await cola.cerrar();
      await w.detener({ esperaMs: 2_000 }).catch(() => undefined);
    }
  });
});

// ---- Ventana, tope y diferidos (0075: tope con enviados y pendientes; diferidos de un resumen omitido) ---------------------------

describe("T18 · ventana, tope y diferidos", () => {
  it("D-2: la ventana de 10 min corre desde el último correo, no desde un envío omitido (apagar y encender el tipo no retrasa el siguiente aviso)", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente ventana");
    await e.responsable(T, c, d);
    await e.capturar(T, c, 1);
    const e1 = await e.envioDe(T, { usuarioId: d, origen: "aviso" });
    expect(await procesador(new CorreoMemoria())(ctxEnvio(T, e1.id))).toMatchObject({ estado: "enviado" });
    // Un segundo crítico abre la ventana (programado a +10 min); el usuario apaga y enciende el tipo: ese envío queda omitido.
    await e.capturar(T, c, 1);
    const e2 = await e.envioDe(T, { usuarioId: d, origen: "aviso", estado: "pendiente" });
    await e.fijar(T, d, { buzonCritico: false });
    await e.fijar(T, d, { buzonCritico: true });
    expect((await e.envio(e2.id)).estado).toBe("omitido");
    await e.capturar(T, c, 1);
    const e3 = await e.envioDe(T, { usuarioId: d, origen: "aviso", estado: "pendiente" });
    const minDesdeCorreo = (new Date(e3.programado_para).getTime() - new Date(e1.programado_para).getTime()) / 60_000;
    expect(
      Math.round(minDesdeCorreo),
      "el aviso siguiente quedó a 20 min del único correo que salió (la ventana se contó desde el envío omitido)",
    ).toBeLessThanOrEqual(10);
  });

  it("cruce del tope desde dos transacciones a la vez (crítico ∥ clave inválida con 29 enviados): 30 correos inmediatos como máximo y el otro aviso diferido", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c1 = await e.clienteCon(T, "Cliente tope 1");
    const c2 = await e.clienteCon(T, "Cliente tope 2");
    await e.responsable(T, c1, d);
    await e.responsable(T, c2, d);
    await e.sembrarEnviados(T, d, 29);
    await Promise.all([e.capturar(T, c1, 1), e.invalidarCredencial(T, c2)]);
    const vivos = (await e.envios(T, { usuarioId: d, origen: "aviso" })).filter((x) => ["enviado", "pendiente"].includes(x.estado));
    const avisos = await e.avisosDe(T, { usuarioId: d });
    expect({
      inmediatos: vivos.length,
      avisos: avisos.length,
      diferidos: avisos.filter((x) => x.envio_id === null).length,
    }).toEqual({ inmediatos: 30, avisos: 2, diferidos: 1 });
  });

  // T19 (2026-11-24) ajustó esta prueba: T18 exigía «ningún envío nuevo» (H-028-2-4), pero el usuario decidió ACEPTAR el duplicado
  // (U-16 «al menos una vez»). Ahora fija lo único que se exige: el contenido no se pierde (los dos avisos salen en «Avisos pendientes»).
  it("U-16 + H-028-1-4 (H-028-2-4, duplicado aceptado): resumen entregado al SMTP, worker muerto antes de marcar y el usuario lo apaga: el reintento lo deja omitido y los dos avisos no se pierden", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente U-16");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    await e.sembrarEnviados(T, d, 30);
    await e.capturar(T, c, 2);
    const diferidos = (await e.avisosDe(T, { usuarioId: d })).filter((x) => x.envio_id === null).map((x) => x.notificacion_id);
    expect(diferidos).toHaveLength(2);
    expect(await e.crearResumenes(T, await e.diaLima(0))).toBe(1);
    const r = await e.envioDe(T, { usuarioId: d, origen: "resumen" });
    // Entrega al SMTP y el proceso muere antes de marcar `enviado` (CA-10).
    const muere = new CorreoQueMuere("despues");
    void procesador(muere)(ctxEnvio(T, r.id));
    await muere.enEnvio;
    expect(muere.enviados).toHaveLength(1);
    expect(muere.enviados[0]!.texto).toContain("Avisos que no te enviamos al momento");
    // Al leerlo, el usuario apaga el resumen; luego el reintento de 008 revalida (R-3).
    await e.fijar(T, d, { resumen: false });
    const reintento = new CorreoMemoria();
    expect(await procesador(reintento)(ctxEnvio(T, r.id, 2))).toMatchObject({ estado: "omitido" });
    expect(reintento.enviados).toHaveLength(0);
    // Siguiente día de resumen: los diferidos del resumen omitido salen en «Avisos pendientes» (puede repetirse lo ya entregado).
    await e.crearResumenes(T, await e.diaLima(-1));
    const pendientes = await e.envios(T, { usuarioId: d, origen: "pendientes" });
    expect(pendientes, "el contenido no se pierde: un correo «Avisos pendientes» con los dos avisos").toHaveLength(1);
    expect(pendientes[0]!.total_avisos).toBe(2);
    const otra = new CorreoMemoria();
    for (const p of pendientes) await procesador(otra)(ctxEnvio(T, p.id));
    expect(otra.enviados).toHaveLength(1);
    expect(otra.enviados[0]!.texto).toContain("Coactivas y avisos críticos del buzón: 2");
  });
});

// ---- Inundación y contenido ------------------------------------------------------------------------------------------------------

describe("T18 · inundación y contenido", () => {
  it("primera sincronización: 500 críticos de 40 clientes salen en UN correo con 20 líneas y «y 480 avisos más», y el asunto no nombra a un solo cliente", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    let total = 0;
    for (let i = 1; i <= 40; i++) {
      const c = await e.clienteCon(T, `Cliente inundado ${String(i).padStart(2, "0")}`);
      await e.responsable(T, c, d);
      const n = i <= 20 ? 13 : 12;
      await e.capturar(T, c, n); // una captura (transacción) por cliente, como `sol.buzon.revisar`
      total += n;
    }
    expect(total).toBe(500);
    const envios = await e.envios(T, { usuarioId: d, origen: "aviso" });
    expect(envios.map((x) => [x.estado, x.total_avisos])).toEqual([["pendiente", 500]]);
    const correo = new CorreoMemoria();
    expect(await procesador(correo)(ctxEnvio(T, envios[0]!.id))).toMatchObject({ estado: "enviado", avisos: 500 });
    expect(correo.enviados).toHaveLength(1);
    const m = correo.enviados[0]!;
    expect((m.texto.match(/^- /gmu) ?? []).length).toBe(20);
    expect(m.texto).toContain("y 480 avisos más");
    expect(
      m.asunto,
      "el asunto cuenta los clientes de las 20 líneas mostradas, no los 40 del correo (con un cliente de ≥ 20 avisos, nombra solo a ese)",
    ).toBe("Coactiva y avisos críticos del buzón · 40 clientes");
  });

  it("CA-7: una razón social con una URL no deja enlaces fuera de APP_ORIGIN en el HTML ni en el texto del correo", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "PAGUE SU COACTIVA EN https://sunat-pagos.example/pagar O www.sunat-pagos.example");
    await e.responsable(T, c, d);
    await e.capturar(T, c, 1);
    const env = await e.envioDe(T, { usuarioId: d, origen: "aviso" });
    const correo = new CorreoMemoria();
    expect(await procesador(correo)(ctxEnvio(T, env.id))).toMatchObject({ estado: "enviado" });
    const m = correo.enviados[0]!;
    const ajenas = (t: string) =>
      (t.match(/(?:https?:\/\/|www\.)[^\s"'<>]+/giu) ?? []).filter((u) => !u.startsWith(`${APP_ORIGIN}/`));
    expect(
      { html: ajenas(m.html ?? ""), texto: ajenas(m.texto), asunto: ajenas(m.asunto) },
      "los clientes de correo convierten en enlace una URL escrita en texto: el correo de ContApp llevaría un enlace de pago ajeno",
    ).toEqual({ html: [], texto: [], asunto: [] });
  });
});

// ---- Borde de la medianoche de Lima ----------------------------------------------------------------------------------------------

describe("T18 · medianoche de Lima", () => {
  it("R-5: el resumen del día D que se envía ya en D+1 (tick de las 23:59:59 o cola atascada) no sale «al día siguiente»", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente medianoche");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    await e.sembrarMensajes(T, d, [
      { clienteId: c.id, critico: true, historico: false, atendido: false, capturadoEn: new Date(Date.now() - 3_600_000) },
    ]);
    // El ciclo tomó `resumenDia` = ayer justo antes de medianoche y creó el resumen ya pasada (función real con el día del ciclo).
    const ayer = await e.diaLima(1);
    expect(await e.crearResumenes(T, ayer)).toBe(1);
    const r = await e.envioDe(T, { usuarioId: d, origen: "resumen" });
    const correo = new CorreoMemoria();
    const res = await procesador(correo)(ctxEnvio(T, r.id));
    expect(
      { estado: (res as { estado: string }).estado, correos: correo.enviados.map((x) => x.asunto) },
      "el resumen de ayer salió hoy; a la hora del resumen de hoy saldrá otro (dos resúmenes la misma mañana)",
    ).toEqual({ estado: "omitido", correos: [] });
  });
});

// ---- Permisos de 0075: job_registro y correo_baja_token ---------------------------------------------------------------------------

describe("T18 · permisos de 0075", () => {
  it("job_registro: ni el backend (UPDATE de un trabajo existente, mayúsculas) ni otro rol meten un notificacion.enviar; el backend sigue encolando lo suyo", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente cola");
    await e.responsable(T, c, d);
    const legit = await e.descarga(T, c, "compras", await e.periodoAnterior(), d); // camino legítimo del backend (insertarTrabajo)
    const codigo = (p: Promise<unknown>) => p.then(() => "ok", (err: { code?: string }) => err.code ?? "error");
    const comoBackend = (texto: string, v: unknown[]) => codigo(backend.withTenant({ tenantId: T, userId: d }, (tx) => tx.query(texto, v)));
    const SQL_INSERTAR = `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por,
                                                    max_intentos)
       values (null, null, $1, 'notificaciones', 'ninguno', 'interactivo', 'en_cola', jsonb_build_object('envioId', gen_random_uuid()),
               sha256(gen_random_uuid()::text::bytea), null, 3)`;
    /** Como otro rol de la app (SET LOCAL ROLE desde el superusuario), con el estudio en el contexto. */
    const comoRol = async (rol: "contapp_worker" | "contapp_platform", tipo: string): Promise<string> => {
      const cx = await admin.pool.connect();
      try {
        await cx.query("begin");
        await cx.query(rol === "contapp_worker" ? "set local role contapp_worker" : "set local role contapp_platform");
        // eslint-disable-next-line sql-crudo/sin-sql-crudo -- prueba de permisos: el estudio en el contexto del rol, como withTenant
        await cx.query("select set_config('app.tenant_id', $1, true)", [T]);
        await cx.query(SQL_INSERTAR, [tipo]);
        await cx.query("rollback");
        return "ok";
      } catch (err) {
        await cx.query("rollback").catch(() => undefined);
        return (err as { code?: string }).code ?? "error";
      } finally {
        cx.release();
      }
    };
    const r = {
      updateTipo: await comoBackend("update job_registro set tipo = 'notificacion.enviar' where id = $1", [legit]),
      updateParametros: await comoBackend(
        "update job_registro set parametros = jsonb_build_object('envioId', gen_random_uuid()) where id = $1",
        [legit],
      ),
      backendMayusculas: await comoBackend(SQL_INSERTAR, ["NOTIFICACION.ENVIAR"]),
      worker: await comoRol("contapp_worker", "notificacion.enviar"),
      plataforma: await comoRol("contapp_platform", "notificacion.enviar"),
    };
    expect(r).toEqual({
      updateTipo: expect.not.stringMatching(/^ok$/),
      updateParametros: expect.not.stringMatching(/^ok$/),
      backendMayusculas: expect.not.stringMatching(/^ok$/),
      worker: expect.not.stringMatching(/^ok$/),
      plataforma: expect.not.stringMatching(/^ok$/),
    });
    expect(await e.trabajosEnviar(T)).toEqual([]);
    const fila = (await admin.pool.query("select tipo, estado from job_registro where id = $1", [legit])).rows[0];
    expect(fila).toEqual({ tipo: "sire.propuesta.descargar", estado: "completado" });
  });

  it("correo_baja_token: contapp_auth solo marca anulado_en (no desanula, no alarga el vencimiento ni cambia usuario o tipo)", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const otro = await e.usuario(T, "contador");
    const c = await e.clienteCon(T, "Cliente token");
    await e.responsable(T, c, d);
    await e.capturar(T, c, 1);
    const env = await e.envioDe(T, { usuarioId: d, origen: "aviso" });
    expect(await procesador(new CorreoMemoria())(ctxEnvio(T, env.id))).toMatchObject({ estado: "enviado" });
    const [tok] = await e.tokensDe(env.id);
    expect(tok).toBeDefined();
    const intento = async (sentencia: string, v: unknown[]): Promise<string> => {
      const cx = await admin.pool.connect();
      try {
        await cx.query("begin");
        await cx.query("set local role contapp_auth");
        const r = await cx.query(sentencia, v);
        await cx.query("commit");
        return `filas:${r.rowCount}`;
      } catch (err) {
        await cx.query("rollback").catch(() => undefined);
        return (err as { code?: string }).code ?? "error";
      } finally {
        cx.release();
      }
    };
    const h = tok!.hash;
    const r = {
      venceEn: await intento("update correo_baja_token set vence_en = vence_en + interval '10 years' where hash = $1", [h]),
      usuario: await intento("update correo_baja_token set usuario_id = $2 where hash = $1", [h, otro]),
      tipo: await intento("update correo_baja_token set tipo = 'resumen' where hash = $1", [h]),
      anularOtroValor: await intento(
        "update correo_baja_token set anulado_en = clock_timestamp() + interval '1 year' where hash = $1 returning hash",
        [h],
      ),
    };
    // Ya anulado (por lo que haya pasado arriba o ahora): no se puede desanular.
    await intento("update correo_baja_token set anulado_en = clock_timestamp() where hash = $1", [h]);
    const desanular = await intento("update correo_baja_token set anulado_en = null where hash = $1", [h]);
    const fila = (await admin.pool.query("select usuario_id, tipo, vence_en, anulado_en from correo_baja_token where hash = $1", [h])).rows[0];
    expect({ ...r, desanular, filaUsuario: fila.usuario_id, filaTipo: fila.tipo, anulado: fila.anulado_en !== null }).toEqual({
      venceEn: "42501",
      usuario: "42501",
      tipo: "42501",
      anularOtroValor: expect.any(String),
      desanular: expect.not.stringMatching(/^filas:1$/),
      filaUsuario: d,
      filaTipo: "buzon_critico",
      anulado: true,
    });
  });
});
