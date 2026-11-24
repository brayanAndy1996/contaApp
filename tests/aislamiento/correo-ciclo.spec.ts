// Spec 028 (T3, rojo): ciclo programado del correo en BD real (R-5, R-12, R-13, R-14, D-2; CA-4, CA-11). Candado del ciclo con vencimiento y
// reloj de la BD, dia del resumen (hora, dias habiles de Lima, cierre del dia), estudios con plan vigente, encolado de avisos vencidos,
// creacion idempotente de resumenes y avisos pendientes, tomar y cerrar un envio y el corte del resumen anterior. Falla hoy porque las
// migraciones 0073-0074 aun no existen. El contrato esta en la cabecera de correo-soporte.ts.
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  conSistema,
  crearDb,
  EscenarioCorreo,
  MOTIVOS_OMITIDO,
  type ClientePrueba,
} from "./correo-soporte";

type Sistema = ReturnType<typeof conSistema>;
let admin: Pool;
let ec: EscenarioCorreo;
let worker: ContappDb;
let w1: Sistema;
let w2: Sistema;
let w3: Sistema;
let backend: ContappDb;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioCorreo(admin);
  await ec.guardarProgramacionCorreo();
  worker = crearDb("contapp_worker", 6);
  backend = crearDb("contapp_backend", 3);
  w1 = conSistema("contapp_worker", 3);
  w2 = conSistema("contapp_worker", 3);
  w3 = conSistema("contapp_worker", 3);
});
afterAll(async () => {
  await ec?.limpiar();
  for (const d of [worker, backend, w1, w2, w3]) await d?.close().catch(() => undefined);
  await admin?.end();
});

const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};
const ms = (d: Date | string): number => new Date(d).getTime();
const ahoraBd = async (): Promise<number> => ms((await admin.query("select clock_timestamp() as t")).rows[0].t as Date);
type Ciclo = { resumenDia: string | null } | null;
const tomarCiclo = (w: Sistema, dueno: string): Promise<Ciclo> =>
  w.withSistema(async (tx) => (await tx.query("select sistema.correo_ciclo_tomar($1::text) as r", [dueno])).rows[0].r as Ciclo);
const renovar = (dueno: string) =>
  w1.withSistema(async (tx) => (await tx.query("select sistema.correo_ciclo_renovar($1::text) as r", [dueno])).rows[0].r as boolean);
const soltar = (dueno: string) => w1.withSistema((tx) => tx.query("select sistema.correo_ciclo_soltar($1::text)", [dueno]));
const cerrarDia = (dueno: string, dia: string) =>
  w1.withSistema((tx) => tx.query("select sistema.correo_resumen_cerrar($1::text, $2::date)", [dueno, dia]));
/** Dia de Lima (AAAA-MM-DD) de hoy menos `atras` dias, con el reloj de la BD. */
const diaLima = async (atras = 0): Promise<string> =>
  (await admin.query("select to_char((clock_timestamp() at time zone 'America/Lima')::date - $1::int, 'YYYY-MM-DD') as d", [atras])).rows[0].d as string;
const estadoCiclo = async () => ec.programacionCorreo();
/** Fija el candado con tiempos relativos al reloj de la BD (intervalos SQL; `null` = sin valor). */
const fijarCandado = (dueno: string | null, hasta: string | null) =>
  admin.query(
    `update correo_programacion set ciclo_dueno = $1,
       ciclo_hasta = case when $2::interval is null then null else clock_timestamp() + $2::interval end,
       ultimo_ciclo_inicio = null, ultimo_ciclo_fin = null`,
    [dueno, hasta],
  );

describe("candado del ciclo: un solo ciclo vivo, con vencimiento y reloj de BD (R-5)", () => {
  beforeEach(async () => {
    await ec.restaurarProgramacionCorreo();
  });

  it("tres workers por 10 rondas: en cada ronda exactamente uno toma el ciclo", async () => {
    await ec.fijarProgramacionCorreo({ hora_resumen: "23:59:59" }); // sin dia de resumen: solo importa el candado
    for (let ronda = 1; ronda <= 10; ronda++) {
      const r = await Promise.all([tomarCiclo(w1, `w1-${ronda}`), tomarCiclo(w2, `w2-${ronda}`), tomarCiclo(w3, `w3-${ronda}`)]);
      const ganadores = r.map((x, i) => (x === null ? null : `w${i + 1}-${ronda}`)).filter((x): x is string => x !== null);
      expect(ganadores, `ronda ${ronda}`).toHaveLength(1);
      expect((await estadoCiclo()).ciclo_dueno, `ronda ${ronda}`).toBe(ganadores[0]);
      await soltar(ganadores[0]!);
      await ec.fijarProgramacionCorreo({ ultimo_ciclo_inicio: null, ultimo_ciclo_fin: null });
    }
  });

  // Ajuste de T17 (0075, decisión H-028-1-2 del 2026-11-24): el candado pasa de 5 min a 90 s (mismas tolerancias de ±2 s).
  it("el primer ciclo lo toma el primero: devuelve un objeto con resumenDia y fija un candado de 90 s con el reloj de la BD", async () => {
    const antes = await ahoraBd();
    const r = await tomarCiclo(w1, "dueno-A");
    expect(r).not.toBeNull();
    expect(Object.keys(r!).sort()).toEqual(["resumenDia"]);
    const e = await estadoCiclo();
    expect(e.ciclo_dueno).toBe("dueno-A");
    expect(ms(e.ciclo_hasta) - antes).toBeGreaterThan(88_000);
    expect(ms(e.ciclo_hasta) - antes).toBeLessThan(92_000);
    expect(Math.abs(ms(e.ultimo_ciclo_inicio) - antes)).toBeLessThan(5000);
  });

  it("con el candado vivo de otro dueño no toma (NULL) y no cambia nada", async () => {
    await fijarCandado("dueno-A", "3 minutes");
    const antes = await estadoCiclo();
    expect(await tomarCiclo(w2, "dueno-B")).toBeNull();
    expect(await estadoCiclo()).toEqual(antes);
  });

  it("candado vencido: otro dueño lo toma y el candado vuelve a 90 s", async () => {
    await fijarCandado("dueno-A", "-1 minute");
    const antes = await ahoraBd();
    expect(await tomarCiclo(w2, "dueno-B")).not.toBeNull();
    const e = await estadoCiclo();
    expect(e.ciclo_dueno).toBe("dueno-B");
    expect(ms(e.ciclo_hasta) - antes).toBeGreaterThan(88_000);
  });

  it("renovar: solo el dueño con el candado vigente (true, +90 s); otro dueño o candado vencido: false y sin cambios", async () => {
    await fijarCandado("dueno-A", "1 minute");
    expect(await renovar("dueno-B")).toBe(false);
    expect((await estadoCiclo()).ciclo_dueno).toBe("dueno-A");
    const antes = await ahoraBd();
    expect(await renovar("dueno-A")).toBe(true);
    expect(ms((await estadoCiclo()).ciclo_hasta) - antes).toBeGreaterThan(88_000);
    await fijarCandado("dueno-A", "-1 minute");
    const e0 = await estadoCiclo();
    expect(await renovar("dueno-A")).toBe(false);
    expect(await estadoCiclo()).toEqual(e0);
  });

  it("soltar: el dueño libera el candado y anota el fin; otro dueño no hace nada", async () => {
    await fijarCandado("dueno-A", "2 minutes");
    await soltar("dueno-B");
    expect((await estadoCiclo()).ciclo_hasta).not.toBeNull();
    const antes = await ahoraBd();
    await soltar("dueno-A");
    const e = await estadoCiclo();
    expect(e.ciclo_hasta).toBeNull();
    expect(Math.abs(ms(e.ultimo_ciclo_fin) - antes)).toBeLessThan(5000);
  });

  it("dueño nulo o vacio: 22023 en las cuatro funciones", async () => {
    for (const sql of [
      "select sistema.correo_ciclo_tomar(null)",
      "select sistema.correo_ciclo_tomar('')",
      "select sistema.correo_ciclo_renovar(null)",
      "select sistema.correo_ciclo_renovar('')",
      "select sistema.correo_ciclo_soltar(null)",
      "select sistema.correo_ciclo_soltar('')",
      "select sistema.correo_resumen_cerrar(null, current_date)",
      "select sistema.correo_resumen_cerrar('', current_date)",
    ]) {
      const r = await w1.withSistema(async (tx) => {
        try {
          await tx.query(sql);
          return "ok";
        } catch (e) {
          return String((e as { code?: string }).code);
        }
      });
      expect(r, sql).toBe("22023");
    }
  });
});

describe("dia del resumen: hora y dias habiles de Lima, una vez por dia (R-5, CA-4)", () => {
  beforeEach(async () => {
    await ec.restaurarProgramacionCorreo();
  });
  const habil = (extra: Record<string, unknown> = {}) =>
    ec.fijarProgramacionCorreo({ hora_resumen: "00:00", dias_resumen: [1, 2, 3, 4, 5, 6, 7], ...extra });

  it("con la hora ya pasada y hoy dentro de los dias habiles, el ciclo trae el dia de Lima (no el de UTC)", async () => {
    await habil();
    const hoy = await ec.hoyLima();
    expect(await tomarCiclo(w1, "A")).toEqual({ resumenDia: hoy.dia });
  });

  it("un dia fuera de dias_resumen (sabado o domingo) no hay resumen; cambiar los dias rige en el siguiente ciclo, sin reiniciar", async () => {
    const hoy = await ec.hoyLima();
    await habil({ dias_resumen: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== hoy.isodow) });
    expect(await tomarCiclo(w1, "A")).toEqual({ resumenDia: null });
    await soltar("A");
    await habil();
    expect(await tomarCiclo(w1, "A")).toEqual({ resumenDia: hoy.dia });
  });

  it("antes de la hora del resumen no hay resumen; cambiar hora_resumen rige en el siguiente ciclo", async () => {
    await habil({ hora_resumen: "23:59:59" });
    expect(await tomarCiclo(w1, "A")).toEqual({ resumenDia: null });
    await soltar("A");
    await habil({ hora_resumen: "00:00" });
    expect((await tomarCiclo(w1, "A"))!.resumenDia).not.toBeNull();
  });

  it("si no hubo worker a la hora, el primer ciclo posterior del mismo dia lo trae (a las 09:30, no al dia siguiente)", async () => {
    // hora_resumen ya pasada hace horas y ningun ciclo previo: es el caso del worker caido de 06:00 a 09:30
    await habil({ hora_resumen: "00:00", ultimo_ciclo_inicio: null, ultimo_ciclo_fin: null });
    expect((await tomarCiclo(w1, "A"))!.resumenDia).toBe((await ec.hoyLima()).dia);
  });

  it("tras cerrar el dia con el candado vigente ya no hay resumen ese dia; sin cerrarlo (ciclo que no atendio a todos) sigue pendiente", async () => {
    await habil();
    const hoy = (await ec.hoyLima()).dia;
    expect(await tomarCiclo(w1, "A")).toEqual({ resumenDia: hoy });
    await soltar("A"); // el ciclo termino sin cerrar el dia
    expect(await tomarCiclo(w2, "B")).toEqual({ resumenDia: hoy });
    await cerrarDia("B", hoy);
    await soltar("B");
    expect(await tomarCiclo(w3, "C")).toEqual({ resumenDia: null });
  });

  it("solo el dueño con el candado vigente cierra el dia: otro dueño no lo cierra", async () => {
    await habil();
    const hoy = (await ec.hoyLima()).dia;
    await tomarCiclo(w1, "A");
    await cerrarDia("B", hoy); // no es el dueño
    await soltar("A");
    expect(await tomarCiclo(w2, "B")).toEqual({ resumenDia: hoy });
  });
});

describe("sistema.estudios_correo: estudios con suscripcion activa o prueba vigente, con lo que su plan habilita (R-12, CA-11)", () => {
  it("lista (tenant_id, avisos, resumen) solo de los estudios vigentes; features ausentes = habilitado, false lo apaga", async () => {
    const activa = await ec.estudioPlan();
    const prueba = await ec.estudioPlan({ estado: "prueba", venceEn: "10 days" });
    const vencida = await ec.estudioPlan({ estado: "prueba", venceEn: "-1 day" });
    const sin = await ec.estudioPlan({ estado: null });
    const sinAvisos = await ec.estudioPlan({ features: { correo_avisos: false } });
    const sinResumen = await ec.estudioPlan({ features: { correo_resumen: false } });
    const filas = await w1.withSistema(async (tx) => (await tx.query("select * from sistema.estudios_correo()")).rows);
    const propias = filas.filter((f) => [activa, prueba, vencida, sin, sinAvisos, sinResumen].includes(f.tenant_id));
    expect(propias.every((f) => Object.keys(f).sort().join() === "avisos,resumen,tenant_id")).toBe(true);
    const de = (t: string) => propias.find((f) => f.tenant_id === t);
    expect(de(activa)).toEqual({ tenant_id: activa, avisos: true, resumen: true });
    expect(de(prueba)).toEqual({ tenant_id: prueba, avisos: true, resumen: true });
    expect(de(vencida), "prueba vencida").toBeUndefined();
    expect(de(sin), "sin suscripcion").toBeUndefined();
    expect(de(sinAvisos)).toEqual({ tenant_id: sinAvisos, avisos: false, resumen: true });
    expect(de(sinResumen)).toEqual({ tenant_id: sinResumen, avisos: true, resumen: false });
    expect(new Set(propias.map((f) => f.tenant_id)).size, "sin repetidos").toBe(propias.length);
  });
});

// ---- envios sembrados por su camino real ------------------------------------------------------------------------------------------
/** Contador nuevo con un cliente suyo y un envio `pendiente` de aviso creado por una captura real. */
async function envioDeAviso(tenant: string): Promise<{ u: string; c: ClientePrueba; envioId: string }> {
  const u = (await ec.et.miembro(tenant, "contador")).id;
  const c = await ec.et.cliente(tenant);
  await ec.et.asignar(tenant, c.id, u, "responsable");
  await ec.capturar(worker, tenant, c, 1);
  const [e] = await ec.envios(tenant, { usuarioId: u });
  return { u, c, envioId: e!.id };
}
const enTenant = <T>(tenant: string, fn: (q: (sql: string, v?: unknown[]) => Promise<any[]>) => Promise<T>) =>
  worker.withTenant({ tenantId: tenant }, (tx) => fn(async (sql, v) => (await tx.query(sql, v)).rows));
const trabajosDe = async (tenant: string) =>
  (
    await admin.query(
      `select id, tipo, cola, canal, estado, parametros, creado_por, cliente_id, ruc, clave_dedupe
         from job_registro where tenant_id = $1 and tipo = 'notificacion.enviar' order by creado_en, id`,
      [tenant],
    )
  ).rows;

describe("encolar_correo_avisos: pone en la cola los avisos vencidos, una sola vez (R-1, R-14)", () => {
  it("encola los envios de aviso pendientes, sin tomar y vencidos; el futuro, el tomado y el enviado no; repetir da 0", async () => {
    const t = await ec.estudioPlan();
    const a = await envioDeAviso(t);
    const b = await envioDeAviso(t);
    const futuro = await envioDeAviso(t);
    const tomado = await envioDeAviso(t);
    await admin.query("update correo_envio set programado_para = clock_timestamp() + interval '5 minutes' where id = $1", [futuro.envioId]);
    await ec.tomarPendientes(t, tomado.u);
    await ec.sembrarEnviados(t, a.u, 1); // un envio ya enviado y vencido
    expect(await enTenant(t, async (q) => Number((await q("select encolar_correo_avisos(100) as n"))[0].n))).toBe(2);
    const jobs = await trabajosDe(t);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.parametros.envioId).sort()).toEqual([a.envioId, b.envioId].sort());
    for (const j of jobs) {
      expect(j).toMatchObject({ tipo: "notificacion.enviar", cola: "notificaciones", canal: "ninguno", estado: "en_cola", creado_por: null, cliente_id: null, ruc: null });
      expect(j.parametros).toEqual({ envioId: j.parametros.envioId }); // el pedido solo lleva el id del envio (R-2)
      expect(Buffer.byteLength(j.clave_dedupe)).toBe(32);
    }
    expect(new Set(jobs.map((j) => j.clave_dedupe.toString("hex"))).size).toBe(2);
    expect(await enTenant(t, async (q) => Number((await q("select encolar_correo_avisos(100) as n"))[0].n)), "repetir").toBe(0);
    expect(await trabajosDe(t)).toHaveLength(2);
  });

  it("respeta p_limite: con 1 encola de a uno hasta agotar", async () => {
    const t = await ec.estudioPlan();
    for (let i = 0; i < 3; i++) await envioDeAviso(t);
    const n = (lim: number) => enTenant(t, async (q) => Number((await q("select encolar_correo_avisos($1::int) as n", [lim]))[0].n));
    expect([await n(1), await n(1), await n(5), await n(5)]).toEqual([1, 1, 1, 0]);
    expect(await trabajosDe(t)).toHaveLength(3);
  });

  it("p_limite menor que 1 o nulo: 22023; solo ve los envios del estudio de la sesion", async () => {
    const t = await ec.estudioPlan();
    const otro = await ec.estudioPlan();
    await envioDeAviso(otro);
    for (const v of [0, -1, null]) {
      rechazo(await intentar(worker, { tenantId: t }, "select encolar_correo_avisos($1::int)", [v]), "22023");
    }
    expect(await enTenant(t, async (q) => Number((await q("select encolar_correo_avisos(100) as n"))[0].n))).toBe(0);
    expect(await trabajosDe(otro)).toEqual([]);
  });
});

describe("crear_correo_resumenes: uno por usuario y dia, con sus diferidos, idempotente (R-5, R-12, R-14; CA-4, CA-9, CA-11)", () => {
  let R: string;
  let u1: string; // resumen activo, sin diferidos
  let u2: string; // resumen apagado, sin diferidos
  let u3: string; // resumen apagado, con diferidos de dos tipos
  let u4: string; // resumen activo, con diferidos
  let DIA: string; // hoy en Lima
  let DIA2: string; // ayer en Lima
  const crear = (tenant: string, dia: string | null = DIA) =>
    enTenant(tenant, async (q) => Number((await q("select crear_correo_resumenes($1::date) as n", [dia]))[0].n));

  /** Un usuario con cliente propio y `n` envios `enviado` hoy (tope agotado) para que sus avisos queden diferidos. */
  async function conDiferidos(tenant: string, tipos: ("buzon_critico" | "credencial_invalida")[]): Promise<string> {
    const u = (await ec.et.miembro(tenant, "contador")).id;
    const c = await ec.et.cliente(tenant);
    await ec.et.asignar(tenant, c.id, u, "responsable");
    await ec.sembrarEnviados(tenant, u, 30);
    for (const tipo of tipos) {
      if (tipo === "buzon_critico") await ec.capturar(worker, tenant, c, 2);
      else await ec.notificarDirecto(admin, tenant, [u], "credencial_invalida");
    }
    expect((await ec.diferidosDe(tenant, u)).length, "control: avisos diferidos por el tope").toBeGreaterThan(0);
    return u;
  }

  beforeAll(async () => {
    DIA = await diaLima(0);
    DIA2 = await diaLima(1);
    R = await ec.estudioPlan();
    u1 = (await ec.et.miembro(R, "contador")).id;
    u2 = (await ec.et.miembro(R, "contador")).id;
    await ec.preferencia(R, u1, "resumen", true);
    u3 = await conDiferidos(R, ["buzon_critico", "credencial_invalida"]);
    u4 = await conDiferidos(R, ["buzon_critico"]);
    await ec.preferencia(R, u4, "resumen", true);
  });

  it("crea un envio resumen por usuario con el resumen activo y un envio pendientes por cada tipo diferido de quien lo tiene apagado", async () => {
    const antes = await ahoraBd();
    expect(await crear(R)).toBe(4); // u1, u4 (resumen) + u3 (pendientes de buzon_critico y de credencial_invalida)
    const nuevos = (await ec.envios(R)).filter((e) => e.origen !== "aviso");
    expect(nuevos).toHaveLength(4);
    const de = (u: string, origen: string) => nuevos.filter((e) => e.usuario_id === u && e.origen === origen);
    for (const u of [u1, u4]) {
      const [e] = de(u, "resumen");
      expect(de(u, "resumen")).toHaveLength(1);
      expect(e).toMatchObject({ tipo: "resumen", estado: "pendiente", tomado_en: null, corte_hasta: null, clave: `resumen:${u}:${DIA}` });
      expect(Math.abs(ms(e!.programado_para) - antes)).toBeLessThan(10_000);
    }
    expect(de(u2, "resumen").concat(de(u2, "pendientes"))).toEqual([]);
    expect(de(u3, "resumen")).toEqual([]);
    expect(de(u3, "pendientes").map((e) => e.tipo).sort()).toEqual(["buzon_critico", "credencial_invalida"]);
    for (const e of de(u3, "pendientes")) expect(e).toMatchObject({ estado: "pendiente", clave: `pendientes:${u3}:${e.tipo}:${DIA}` });
    const dias = (await admin.query("select to_char(dia_lima, 'YYYY-MM-DD') as d from correo_envio where tenant_id = $1 and origen <> 'aviso'", [R])).rows;
    expect(dias.map((x) => x.d)).toEqual([DIA, DIA, DIA, DIA]);
  });

  it("los diferidos quedan unidos al envio que los lleva (el resumen o el aviso pendiente del tipo), conservando su instante de diferido", async () => {
    const nuevos = (await ec.envios(R)).filter((e) => e.origen !== "aviso");
    const resumenU4 = nuevos.find((e) => e.usuario_id === u4 && e.origen === "resumen")!;
    const diferidosU4 = await ec.diferidosDe(R, u4);
    expect(diferidosU4.length).toBeGreaterThan(0);
    expect(diferidosU4.every((a) => a.envio_id === resumenU4.id)).toBe(true);
    for (const e of nuevos.filter((x) => x.usuario_id === u3 && x.origen === "pendientes")) {
      const deTipo = (await ec.diferidosDe(R, u3)).filter((a) => a.tipo === e.tipo);
      expect(deTipo.length, e.tipo).toBeGreaterThan(0);
      expect(deTipo.every((a) => a.envio_id === e.id), e.tipo).toBe(true);
    }
  });

  it("cada envio nuevo queda con su trabajo notificacion.enviar {envioId}, sin cliente ni solicitante, y encolar_correo_avisos no lo duplica", async () => {
    const nuevos = (await ec.envios(R)).filter((e) => e.origen !== "aviso");
    const jobs = (await trabajosDe(R)).filter((j) => nuevos.some((e) => e.id === j.parametros.envioId));
    expect(jobs).toHaveLength(4);
    for (const j of jobs) {
      expect(j).toMatchObject({ cola: "notificaciones", canal: "ninguno", estado: "en_cola", creado_por: null, cliente_id: null });
      expect(Object.keys(j.parametros)).toEqual(["envioId"]);
    }
    const total = (await trabajosDe(R)).length;
    expect(await enTenant(R, async (q) => Number((await q("select encolar_correo_avisos(100) as n"))[0].n))).toBe(0);
    expect(await trabajosDe(R)).toHaveLength(total);
    const dedupe = (await trabajosDe(R)).map((j) => String(j.parametros.envioId));
    expect(new Set(dedupe).size, "ningun envio con dos trabajos").toBe(dedupe.length);
  });

  it("dos ciclos el mismo dia no duplican: 0 envios nuevos y las mismas filas; otro dia crea los suyos", async () => {
    const antes = (await ec.envios(R)).map((e) => e.id).sort();
    expect(await crear(R)).toBe(0);
    expect((await ec.envios(R)).map((e) => e.id).sort()).toEqual(antes);
    expect(await crear(R, DIA2)).toBeGreaterThanOrEqual(2); // u1 y u4 tienen resumen todos los dias habiles
    const claves = (await ec.envios(R)).map((e) => e.clave);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("solo crea para el estudio de la sesion y rechaza el dia nulo (22023)", async () => {
    const otro = await ec.estudioPlan();
    const x = (await ec.et.miembro(otro, "contador")).id;
    await ec.preferencia(otro, x, "resumen", true);
    expect(await ec.envios(otro)).toEqual([]);
    rechazo(await intentar(worker, { tenantId: otro }, "select crear_correo_resumenes(null)"), "22023");
    expect(await crear(otro)).toBe(1);
    expect((await ec.envios(R)).every((e) => e.tenant_id === R)).toBe(true);
  });

  it("sin suscripcion activa ni prueba vigente no crea nada (CA-11); con correo_resumen: false tampoco crea resumenes", async () => {
    const sin = await ec.estudioPlan({ estado: null });
    const vencida = await ec.estudioPlan({ estado: "prueba", venceEn: "-1 day" });
    const apagado = await ec.estudioPlan({ features: { correo_resumen: false } });
    for (const t of [sin, vencida, apagado]) {
      const u = (await ec.et.miembro(t, "contador")).id;
      await ec.preferencia(t, u, "resumen", true);
      expect(await crear(t), t).toBe(0);
      expect(await ec.envios(t), t).toEqual([]);
    }
  });

  it("un estudio con correo_avisos: false pero resumen habilitado si crea sus resumenes", async () => {
    const t = await ec.estudioPlan({ features: { correo_avisos: false } });
    const u = (await ec.et.miembro(t, "contador")).id;
    await ec.preferencia(t, u, "resumen", true);
    expect(await crear(t)).toBe(1);
  });

  it("apagar el resumen deja omitido (preferencia_apagada) el resumen pendiente sin tomar (D-7)", async () => {
    const t = await ec.estudioPlan();
    const u = (await ec.et.miembro(t, "contador")).id;
    await ec.preferencia(t, u, "resumen", true);
    expect(await crear(t)).toBe(1);
    await backend.withTenant({ tenantId: t, userId: u }, (tx) =>
      tx.query("select correo_preferencias_fijar($1::jsonb)", [
        JSON.stringify({ buzonCritico: true, credencialInvalida: true, planLimite: false, resumen: false, todosClientes: false }),
      ]),
    );
    const [e] = await ec.envios(t, { usuarioId: u, origen: "resumen" });
    expect(e).toMatchObject({ estado: "omitido", motivo: "preferencia_apagada" });
  });
});

describe("correo_envio_tomar: marca el intento, devuelve a quien y que, y trae el corte del resumen anterior (R-3, R-13, R-9)", () => {
  const tomar = (tenant: string, id: string) =>
    enTenant(tenant, async (q) => (await q("select correo_envio_tomar($1::uuid) as r", [id]))[0].r as Record<string, unknown>);

  it("marca tomado_en y suma un intento por llamada; devuelve ids, tipo y origen", async () => {
    const t = await ec.estudioPlan();
    const { u, envioId } = await envioDeAviso(t);
    const antes = await ahoraBd();
    const r = await tomar(t, envioId);
    expect(r).toMatchObject({ envioId, usuarioId: u, tipo: "buzon_critico", origen: "aviso", intentos: 1, diaLima: null, corteDesde: null });
    const [e] = await ec.envios(t, { usuarioId: u });
    expect(e).toMatchObject({ estado: "pendiente", intentos: 1 });
    expect(Math.abs(ms(e!.tomado_en!) - antes)).toBeLessThan(5000);
    expect(await tomar(t, envioId)).toMatchObject({ intentos: 2 }); // el reintento de 008
    expect((await ec.envios(t, { usuarioId: u }))[0]!.intentos).toBe(2);
  });

  it("un envio de otro estudio o inexistente: P0002 y no cambia nada", async () => {
    const t = await ec.estudioPlan();
    const otro = await ec.estudioPlan();
    const ajeno = await envioDeAviso(otro);
    for (const id of [ajeno.envioId, "00000000-0000-4000-8000-000000000000"]) {
      rechazo(await intentar(worker, { tenantId: t }, "select correo_envio_tomar($1::uuid)", [id]), "P0002");
    }
    expect((await ec.envios(otro))[0]).toMatchObject({ tomado_en: null, intentos: 0 });
  });

  it("corteDesde es el corte_hasta del ultimo resumen enviado u omitido por sin_novedades del mismo usuario; los otros motivos, el fallido y otro usuario no cuentan", async () => {
    const t = await ec.estudioPlan();
    const u = (await ec.et.miembro(t, "contador")).id;
    const otro = (await ec.et.miembro(t, "contador")).id;
    await ec.preferencia(t, u, "resumen", true);
    await ec.preferencia(t, otro, "resumen", true);
    const ahora = await ahoraBd();
    const hace = (horas: number) => new Date(ahora - horas * 3600_000);
    const dias = [await diaLima(6), await diaLima(5), await diaLima(4), await diaLima(3), await diaLima(0)];
    const cerrar = (id: string, estado: string, motivo: string | null, c: Date | null) =>
      enTenant(t, (q) => q("select correo_envio_cerrar($1::uuid, $2::text, $3::text, $4::timestamptz)", [id, estado, motivo, c]));
    /** Ciclo real de un dia: crear, tomar y cerrar el resumen de `usuario`. Devuelve lo que devolvio `tomar`. */
    const ciclo = async (dia: string, usuario: string, cierre?: [string, string | null, Date | null]) => {
      await enTenant(t, (q) => q("select crear_correo_resumenes($1::date)", [dia]));
      const e = (await ec.envios(t, { usuarioId: usuario, origen: "resumen" })).find((x) => x.clave.endsWith(`:${dia}`))!;
      const r = await tomar(t, e.id);
      if (cierre) await cerrar(e.id, ...cierre);
      return r;
    };
    expect((await ciclo(dias[0]!, u, ["enviado", null, hace(30)])).corteDesde, "sin resumen anterior").toBeNull();
    expect(ms((await ciclo(dias[1]!, u, ["omitido", "sin_novedades", hace(20)])).corteDesde as string)).toBe(hace(30).getTime());
    await ciclo(dias[2]!, u, ["omitido", "sin_contenido", null]);
    await ciclo(dias[3]!, u, ["fallido", "transporte", null]);
    await ciclo(dias[3]!, otro, ["enviado", null, hace(5)]); // de otro usuario: no cuenta para u
    const r = await ciclo(dias[4]!, u);
    expect(ms(r.corteDesde as string)).toBe(hace(20).getTime());
    expect(r).toMatchObject({ origen: "resumen", tipo: "resumen", diaLima: dias[4], intentos: 1 });
  });
});

describe("correo_envio_cerrar: enviado, omitido con motivo o fallido por transporte; el corte queda en la fila (R-3, R-9, R-13)", () => {
  const cerrar = (tenant: string, id: string, estado: string, motivo: string | null, corte: Date | null = null) =>
    intentar(worker, { tenantId: tenant }, "select correo_envio_cerrar($1::uuid, $2::text, $3::text, $4::timestamptz)", [id, estado, motivo, corte]);
  const cerrarYLeer = async (tenant: string, id: string, estado: string, motivo: string | null, corte: Date | null = null) => {
    await enTenant(tenant, (q) => q("select correo_envio_cerrar($1::uuid, $2::text, $3::text, $4::timestamptz)", [id, estado, motivo, corte]));
    return (await ec.envios(tenant)).find((e) => e.id === id)!;
  };

  it("enviado: estado, enviado_en con la hora de la BD y el corte; no toca el resto de la fila", async () => {
    const t = await ec.estudioPlan();
    const { envioId } = await envioDeAviso(t);
    await enTenant(t, (q) => q("select correo_envio_tomar($1::uuid)", [envioId]));
    const corte = new Date((await ahoraBd()) - 3600_000);
    const antes = await ahoraBd();
    const e = await cerrarYLeer(t, envioId, "enviado", null, corte);
    expect(e).toMatchObject({ estado: "enviado", motivo: null, intentos: 1 });
    expect(ms(e.corte_hasta!)).toBe(corte.getTime());
    expect(Math.abs(ms(e.enviado_en!) - antes)).toBeLessThan(5000);
    expect(e.tomado_en).not.toBeNull();
  });

  it.each([...MOTIVOS_OMITIDO])("omitido con motivo %s", async (motivo) => {
    const t = await ec.estudioPlan();
    const { envioId } = await envioDeAviso(t);
    const e = await cerrarYLeer(t, envioId, "omitido", motivo, motivo === "sin_novedades" ? new Date() : null);
    expect(e).toMatchObject({ estado: "omitido", motivo });
  });

  it("fallido con motivo transporte (sin el texto del error)", async () => {
    const t = await ec.estudioPlan();
    const { envioId } = await envioDeAviso(t);
    expect(await cerrarYLeer(t, envioId, "fallido", "transporte")).toMatchObject({ estado: "fallido", motivo: "transporte" });
  });

  it("estado o motivo invalidos: 22023 y el envio sigue pendiente", async () => {
    const t = await ec.estudioPlan();
    const { envioId } = await envioDeAviso(t);
    for (const [estado, motivo] of [
      ["pendiente", null],
      ["otro", null],
      ["omitido", "porque_si"],
      ["omitido", "transporte"],
      ["omitido", null],
      ["fallido", "sin_correo"],
    ] as const) {
      rechazo(await cerrar(t, envioId, estado, motivo), "22023");
    }
    expect((await ec.envios(t))[0]!.estado).toBe("pendiente");
  });

  it("un envio de otro estudio o inexistente: P0002", async () => {
    const t = await ec.estudioPlan();
    const otro = await ec.estudioPlan();
    const ajeno = await envioDeAviso(otro);
    rechazo(await cerrar(t, ajeno.envioId, "enviado", null), "P0002");
    rechazo(await cerrar(t, "00000000-0000-4000-8000-000000000000", "enviado", null), "P0002");
    expect((await ec.envios(otro))[0]!.estado).toBe("pendiente");
  });
});
