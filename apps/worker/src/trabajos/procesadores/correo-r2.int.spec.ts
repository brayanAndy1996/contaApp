// Spec 028 · T19 (correcciones de la ronda adversarial 2, rojo; tester · sonnet). Worker con PostgreSQL real: candado vencido que su dueño
// renueva (H-028-2-1), ventana de 10 min desde el último correo enviado o pendiente, nunca desde un omitido (H-028-2-3), textos de
// usuario sin URL ni dominio enlazable (H-028-2-6) y resumen atrasado `fuera_de_dia` (H-028-2-7). Las demás las fijan las pruebas de T18
// (`correo-r2.adv.int.spec.ts`): H-2 «cierre real», H-4 (ajustada por T19: el duplicado se acepta) y H-5 «40 clientes».
// Decisiones del 2026-11-24 (tasks.md, resultado de T19). Solo pruebas: sin código de producción; los avisos nacen por su camino real
// (críticos insertados como el worker → triggers de 0056 → `interno.notificar`) y las marcas de tiempo se mueven como superusuario.
import { renovarCicloCorreo, tomarCicloCorreo, type ContappDb } from "@contapp/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ORIGIN, CorreoMemoria, EscenarioCorreo, ProgramacionCorreo, ctxEnvio } from "../../../test/correo.js";
import { crearDbAdmin, crearDbRol } from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import { enviarCorreo } from "./enviar-correo.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const CANDADO_S = 90;
const HORA = 3_600_000;

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

const procesador = (correo: CorreoMemoria) => enviarCorreo({ db: worker, correo, appOrigin: APP_ORIGIN, logger: silencio });
const tomar = (dueno: string) => worker.withSistema((tx) => tomarCicloCorreo(tx, dueno));
const renovar = (dueno: string) => worker.withSistema((tx) => renovarCicloCorreo(tx, dueno));
const candado = async (): Promise<{ dueno: string | null; restanteS: number | null }> => {
  const { rows } = await admin.pool.query(
    "select ciclo_dueno, extract(epoch from ciclo_hasta - clock_timestamp())::float8 as s from correo_programacion",
  );
  return { dueno: rows[0].ciclo_dueno, restanteS: rows[0].s === null ? null : Number(rows[0].s) };
};
/** Hace pasar `s` segundos para el candado: lo que verían los demás si su dueño tardara ese tiempo sin renovar. */
const envejecerCandado = (s: number) =>
  admin.pool.query(
    `update correo_programacion set ciclo_hasta = ciclo_hasta - make_interval(secs => $1::float8),
            ultimo_ciclo_inicio = ultimo_ciclo_inicio - make_interval(secs => $1::float8)`,
    [s],
  );

describe("T19 · H-028-2-1: el dueño renueva su candado aunque haya vencido, si nadie más lo tomó", () => {
  it.each([100, 3_600])(
    "candado vencido hace %i s y sin otro dueño: renovar devuelve true, lo deja a 90 s y nadie más puede tomarlo",
    async (vencidoHaceS) => {
      await prog.listoParaTomar();
      expect(await tomar("worker-a")).not.toBeNull();
      await envejecerCandado(CANDADO_S + vencidoHaceS);
      expect((await candado()).restanteS!, "el candado está vencido").toBeLessThan(0);
      expect(await renovar("worker-a"), "el dueño sigue siendo el mismo y nadie lo tomó: puede renovar").toBe(true);
      const k = await candado();
      expect(k.dueno).toBe("worker-a");
      expect(k.restanteS!).toBeGreaterThan(CANDADO_S - 5);
      expect(k.restanteS!).toBeLessThanOrEqual(CANDADO_S);
      expect(await tomar("worker-b"), "tras renovar, el candado vuelve a ser vigente para los demás").toBeNull();
    },
  );

  it("si otro worker ya lo tomó, el dueño anterior no renueva (devuelve false) y el candado del otro queda intacto", async () => {
    await prog.listoParaTomar();
    expect(await tomar("worker-a")).not.toBeNull();
    await envejecerCandado(CANDADO_S + 10);
    expect(await tomar("worker-b"), "vencido: otro puede tomarlo").not.toBeNull();
    expect(await renovar("worker-a"), "A perdió el candado: solo falla cuando otro lo tomó").toBe(false);
    const k = await candado();
    expect(k.dueno).toBe("worker-b");
    expect(k.restanteS!).toBeGreaterThan(CANDADO_S - 5);
    expect(await renovar("worker-b")).toBe(true);
  });

  it("un candado liberado (sin dueño) no se renueva: devuelve false", async () => {
    await prog.listoParaTomar();
    expect(await renovar("worker-a"), "nadie lo tiene: no hay candado que renovar").toBe(false);
    expect((await candado()).dueno).toBeNull();
  });
});

describe("T19 · H-028-2-3: la ventana de 10 min se cuenta desde el último envío enviado o pendiente, nunca desde un omitido", () => {
  it("el único envío anterior quedó omitido (apagar y encender el tipo): el aviso siguiente sale al momento, no a +10 min", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente ventana omitida");
    await e.responsable(T, c, d);
    await e.capturar(T, c, 1);
    const e1 = await e.envioDe(T, { usuarioId: d, origen: "aviso" });
    await e.fijar(T, d, { buzonCritico: false });
    await e.fijar(T, d, { buzonCritico: true });
    expect((await e.envio(e1.id)).estado).toBe("omitido");
    await e.capturar(T, c, 1);
    const e2 = await e.envioDe(T, { usuarioId: d, origen: "aviso", estado: "pendiente" });
    const segundos = (new Date(e2.programado_para).getTime() - new Date(e2.creado_en).getTime()) / 1_000;
    expect(segundos, "sin un correo enviado ni pendiente en los últimos 10 min no hay ventana que respetar").toBeLessThan(60);
  });

  it("una cadena de omitidos no suma ventanas: tras tres omitidos seguidos el aviso nuevo sigue siendo inmediato", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente cadena de omitidos");
    await e.responsable(T, c, d);
    for (let i = 0; i < 3; i++) {
      await e.capturar(T, c, 1);
      await e.fijar(T, d, { buzonCritico: false });
      await e.fijar(T, d, { buzonCritico: true });
    }
    expect((await e.envios(T, { usuarioId: d, origen: "aviso", estado: "omitido" })).length).toBeGreaterThanOrEqual(1);
    await e.capturar(T, c, 1);
    const vivo = await e.envioDe(T, { usuarioId: d, origen: "aviso", estado: "pendiente" });
    const segundos = (new Date(vivo.programado_para).getTime() - new Date(vivo.creado_en).getTime()) / 1_000;
    expect(segundos).toBeLessThan(60);
  });

  it("control: un correo enviado sí cuenta: el segundo aviso, dentro de los 10 min, queda a +10 min del primero", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente ventana enviada");
    await e.responsable(T, c, d);
    await e.capturar(T, c, 1);
    const e1 = await e.envioDe(T, { usuarioId: d, origen: "aviso" });
    expect(await procesador(new CorreoMemoria())(ctxEnvio(T, e1.id))).toMatchObject({ estado: "enviado" });
    await e.capturar(T, c, 1);
    const e2 = await e.envioDe(T, { usuarioId: d, origen: "aviso", estado: "pendiente" });
    const min = (new Date(e2.programado_para).getTime() - new Date((await e.envio(e1.id)).programado_para).getTime()) / 60_000;
    expect(Math.round(min)).toBe(10);
  });
});

// ---- H-028-2-6: lo que parezca URL o dominio no llega enlazable al correo ---------------------------------------------------------

/** Lo que un cliente de correo convierte en enlace: `esquema://…`, `www.…` o un dominio con TLD de 2+ letras (también tras «@»). */
const ENLAZABLE =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b/giu;
const enlazables = (t: string, propios: readonly string[]): string[] =>
  (propios.reduce((acc, p) => acc.split(p).join(" "), t).match(ENLAZABLE) ?? []).filter((x) => x !== "");
const visible = (html: string): string =>
  html.replace(/<head[\s\S]*?<\/head>/giu, " ").replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/giu, " ").replace(/<[^>]*>/gu, " ");
const enlacesDelCorreo = (m: { texto: string; html?: string }): string[] =>
  [...(m.texto.match(/https?:\/\/\S+/gu) ?? []), ...[...(m.html ?? "").matchAll(/href="([^"]+)"/gu)].map((x) => x[1]!.replace(/&amp;/gu, "&"))].filter(
    (u) => u.startsWith(`${APP_ORIGIN}/`),
  );

describe("T19 · H-028-2-6: URL y dominios de textos de usuario neutralizados en asunto, texto y HTML", () => {
  it("razón social y nombre del estudio con URL o dominio: el aviso agrupado y el resumen salen sin nada enlazable; los enlaces de la app siguen", async () => {
    const T = await e.estudioPlan();
    await admin.pool.query("update tenant set nombre = $2 where id = $1", [T, "Contadores www.estudio-ejemplo.com SAC"]);
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "PAGUE EN https://sunat-pagos.example/pagar O www.sunat-pagos.example");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    await e.capturar(T, c, 1);
    const aviso = await e.envioDe(T, { usuarioId: d, origen: "aviso" });
    await e.crearResumenes(T, await e.diaLima(0));
    const resumen = await e.envioDe(T, { usuarioId: d, origen: "resumen" });
    const correo = new CorreoMemoria();
    expect(await procesador(correo)(ctxEnvio(T, aviso.id))).toMatchObject({ estado: "enviado" });
    expect(await procesador(correo)(ctxEnvio(T, resumen.id))).toMatchObject({ estado: "enviado" });
    expect(correo.enviados).toHaveLength(2);
    for (const m of correo.enviados) {
      const propios = enlacesDelCorreo(m);
      expect(propios.length, "los dos enlaces de la app siguen en el correo").toBeGreaterThanOrEqual(2);
      expect(
        { asunto: enlazables(m.asunto, []), texto: enlazables(m.texto, propios), html: enlazables(visible(m.html ?? ""), propios) },
        `ninguna URL ni dominio enlazable fuera de ${APP_ORIGIN}`,
      ).toEqual({ asunto: [], texto: [], html: [] });
      // El nombre sigue legible (no se borra), solo deja de ser enlazable.
      expect(m.texto).toContain("www[.]estudio-ejemplo[.]com");
    }
    expect(correo.enviados[0]!.texto).toContain("https[:]//sunat-pagos[.]example/pagar");
  });
});

// ---- H-028-2-7: un resumen atrasado no se envía -----------------------------------------------------------------------------------

describe("T19 · H-028-2-7: resumen que ya no es de su día de Lima", () => {
  it("el de ayer, tomado hoy, queda omitido `fuera_de_dia` sin avanzar el corte; su contenido entra en el resumen de hoy, que sale con el asunto de hoy", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente resumen atrasado");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    const hace = (ms: number) => new Date(Date.now() - ms);
    // Último resumen ENVIADO hace 72 h (ciclo real); un mensaje nuevo de hace 48 h, que pasa de las 24 h de un primer resumen.
    await e.resumenAnterior(T, d, await e.diaLima(3), hace(72 * HORA));
    await e.sembrarMensajes(T, d, [{ clienteId: c.id, critico: false, historico: false, atendido: false, capturadoEn: hace(48 * HORA) }]);
    // El resumen de ayer se creó a tiempo, pero la cola lo toma ya en el día siguiente.
    expect(await e.crearResumenes(T, await e.diaLima(1))).toBe(1);
    const ayer = await e.envioDe(T, { usuarioId: d, origen: "resumen", estado: "pendiente" });
    const atrasado = new CorreoMemoria();
    expect(await procesador(atrasado)(ctxEnvio(T, ayer.id))).toEqual({ estado: "omitido", motivo: "fuera_de_dia" });
    expect(atrasado.enviados).toHaveLength(0);
    const fila = await e.envio(ayer.id);
    expect({ estado: fila.estado, motivo: fila.motivo, corte: fila.corte_hasta }, "no avanza el corte: lo no enviado vuelve a contar").toEqual({
      estado: "omitido",
      motivo: "fuera_de_dia",
      corte: null,
    });
    // El resumen de hoy cuenta desde el último resumen enviado (hace 72 h): trae el mensaje de hace 48 h.
    const hoy = (await e.hoyLima()).dia;
    expect(await e.crearResumenes(T, hoy)).toBe(1);
    const deHoy = await e.envioDe(T, { usuarioId: d, origen: "resumen", estado: "pendiente" });
    const bueno = new CorreoMemoria();
    expect(await procesador(bueno)(ctxEnvio(T, deHoy.id))).toMatchObject({ estado: "enviado" });
    expect(bueno.enviados).toHaveLength(1);
    expect(bueno.enviados[0]!.texto).toMatch(/\b1 nuevo,/);
    expect(bueno.enviados[0]!.asunto).toContain(hoy.split("-").reverse().join("/"));
  });

  it("el resumen de ayer omitido no deja diferidos huérfanos: sus avisos diferidos pasan al resumen de hoy, que sale (R-14, H-028-1-4)", async () => {
    const T = await e.estudioPlan();
    const d = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente diferidos atrasados");
    await e.responsable(T, c, d);
    await e.fijar(T, d, { resumen: true });
    await e.sembrarEnviados(T, d, 30);
    await e.capturar(T, c, 2);
    const diferidos = (await e.avisosDe(T, { usuarioId: d })).filter((x) => x.envio_id === null).map((x) => x.notificacion_id as string);
    expect(diferidos).toHaveLength(2);
    expect(await e.crearResumenes(T, await e.diaLima(1))).toBe(1);
    const ayer = await e.envioDe(T, { usuarioId: d, origen: "resumen", estado: "pendiente" });
    expect(await procesador(new CorreoMemoria())(ctxEnvio(T, ayer.id))).toEqual({ estado: "omitido", motivo: "fuera_de_dia" });
    // El resumen de hoy (R-14, H-028-1-4): los dos diferidos del omitido vuelven a diferidos y salen en el nuevo.
    expect(await e.crearResumenes(T, (await e.hoyLima()).dia)).toBe(1);
    const deHoy = await e.envioDe(T, { usuarioId: d, origen: "resumen", estado: "pendiente" });
    const filas = (await e.avisosDe(T, { usuarioId: d })).filter((x) => diferidos.includes(x.notificacion_id));
    expect(filas.map((f) => f.envio_id), "los diferidos no se quedan unidos al resumen omitido").toEqual([deHoy.id, deHoy.id]);
    const correo = new CorreoMemoria();
    expect(await procesador(correo)(ctxEnvio(T, deHoy.id))).toMatchObject({ estado: "enviado" });
    expect(correo.enviados[0]!.texto).toContain("Coactivas y avisos críticos del buzón: 2");
  });
});
