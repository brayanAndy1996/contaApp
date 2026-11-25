// Spec 028 (T3, rojo): concurrencia del correo en BD real (R-5, R-14, D-2, D-7; CA-4, CA-9). Dos capturas del mismo usuario a la vez dejan un solo
// envio pendiente, el tope cruzado por dos transacciones nunca llega a 31, tomar un envio a la vez que se apaga la preferencia no deja un
// pendiente sin tomar de una preferencia apagada, y dos ciclos del resumen o del encolado a la vez no duplican nada. 10 rondas cada una.
// Las carreras de las dos primeras son deterministas: una transaccion del superusuario llama a `interno.notificar` y espera con el envio sin
// confirmar mientras la otra entra; sin el candado por (estudio, usuario) la segunda no ve a la primera. Falla hoy porque las migraciones
// 0073-0074 aun no existen. El contrato esta en la cabecera de correo-soporte.ts.
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import { abrirAdmin, crearDb, dormir, EscenarioCorreo } from "./correo-soporte";

let admin: Pool;
let ec: EscenarioCorreo;
let worker: ContappDb;
let worker2: ContappDb;
let backend: ContappDb;
let E: string;
const RONDAS = 10;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioCorreo(admin);
  E = await ec.estudioPlan();
  worker = crearDb("contapp_worker", 6);
  worker2 = crearDb("contapp_worker", 6);
  backend = crearDb("contapp_backend", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  for (const d of [worker, worker2, backend]) await d?.close().catch(() => undefined);
  await admin?.end();
});

/** Una transaccion del superusuario que corre `fn`, espera `despues` ms con todo sin confirmar y confirma. Empieza `antes` ms tarde. */
async function conTx<T>(fn: (c: PoolClient) => Promise<T>, o: { antes?: number; despues?: number } = {}): Promise<T> {
  if (o.antes) await dormir(o.antes);
  const c = await admin.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    if (o.despues) await dormir(o.despues);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const usuario = async (rol: "contador" | "dueno" = "contador") => (await ec.et.miembro(E, rol)).id;
const codigo = (e: unknown): string => String((e as { code?: string }).code ?? "");
const diaLima = async (atras: number): Promise<string> =>
  (await admin.query("select to_char((clock_timestamp() at time zone 'America/Lima')::date - $1::int, 'YYYY-MM-DD') as d", [atras])).rows[0].d as string;

describe("D-2 · dos capturas del mismo usuario a la vez: un solo envio pendiente", () => {
  it(`${RONDAS} rondas: ambas capturas terminan sin error, quedan un envio y dos avisos unidos a el`, async () => {
    for (let i = 0; i < RONDAS; i++) {
      const u = await usuario();
      const captura = (o: { antes?: number; despues?: number }) => conTx((c) => ec.notificarDirecto(c, E, [u], "buzon_critico"), o);
      // rondas pares: gana la primera transaccion; impares: la segunda sale primero
      const [a, b] = await Promise.allSettled(i % 2 === 0 ? [captura({ despues: 250 }), captura({ antes: 80 })] : [captura({ antes: 80 }), captura({ despues: 250 })]);
      expect(a.status, `ronda ${i}: ${a.status === "rejected" ? codigo(a.reason) : ""}`).toBe("fulfilled");
      expect(b.status, `ronda ${i}: ${b.status === "rejected" ? codigo(b.reason) : ""}`).toBe("fulfilled");
      const envios = await ec.envios(E, { usuarioId: u });
      expect(envios, `ronda ${i}`).toHaveLength(1);
      expect(envios[0]).toMatchObject({ estado: "pendiente", total_avisos: 2 });
      const avisos = await ec.avisosDe(E, { usuarioId: u });
      expect(avisos).toHaveLength(2);
      expect(avisos.every((x) => x.envio_id === envios[0]!.id)).toBe(true);
    }
  }, 60_000);
});

describe("R-14 · el tope cruzado por dos transacciones nunca pasa de 30 correos", () => {
  it(`${RONDAS} rondas con 29 enviados: el 30.º sale y el aviso de la otra transaccion se difiere (nunca hay 31)`, async () => {
    for (let i = 0; i < RONDAS; i++) {
      const u = await usuario();
      await ec.sembrarEnviados(E, u, 29);
      const tipos = i % 2 === 0 ? (["buzon_critico", "credencial_invalida"] as const) : (["credencial_invalida", "buzon_critico"] as const);
      const [a, b] = await Promise.allSettled([
        conTx((c) => ec.notificarDirecto(c, E, [u], tipos[0]), { despues: 300 }),
        conTx((c) => ec.notificarDirecto(c, E, [u], tipos[1]), { antes: 100 }),
      ]);
      expect([a.status, b.status], `ronda ${i}`).toEqual(["fulfilled", "fulfilled"]);
      expect(await ec.envios(E, { usuarioId: u }), `ronda ${i}: nunca 31`).toHaveLength(30);
      expect((await ec.diferidosDe(E, u)).filter((x) => x.diferido_en !== null && x.envio_id === null), `ronda ${i}`).toHaveLength(1);
      const notifs = await ec.notifs(E, { usuarioId: u });
      const avisos = await ec.avisosDe(E, { usuarioId: u });
      expect(avisos).toHaveLength(notifs.length); // ningun aviso se pierde
    }
  }, 60_000);

  it("diez transacciones a la vez de un mismo usuario con 28 enviados: nunca pasa de 30 correos y ningun aviso se pierde", async () => {
    const u = await usuario();
    await ec.sembrarEnviados(E, u, 28);
    await ec.preferencia(E, u, "plan_limite", true);
    const tipos = ["buzon_critico", "credencial_invalida", "plan_limite"];
    // cada una en su transaccion y con claves distintas: tres tipos compiten por los dos correos que quedan
    const r = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => conTx((c) => ec.notificarDirecto(c, E, [u], tipos[i % 3]!), { antes: (i % 4) * 5, despues: 20 })),
    );
    expect(r.map((x) => x.status)).toEqual(Array(10).fill("fulfilled"));
    expect(await ec.envios(E, { usuarioId: u })).toHaveLength(30);
    const avisos = await ec.avisosDe(E, { usuarioId: u });
    expect(avisos).toHaveLength(10);
    expect(avisos.every((a) => a.envio_id !== null || a.diferido_en !== null)).toBe(true);
    expect(avisos.some((a) => a.diferido_en !== null), "el tercer tipo ya no cabe: se difiere").toBe(true);
  }, 60_000);
});

describe("D-7, R-3 · tomar un envio a la vez que se apaga la preferencia", () => {
  const apagar = (tenant: string, userId: string, espera: number) =>
    backend.withTenant({ tenantId: tenant, userId }, async (tx) => {
      await tx.query("select correo_preferencias_fijar($1::jsonb)", [
        JSON.stringify({ buzonCritico: false, credencialInvalida: true, planLimite: false, resumen: false, todosClientes: false }),
      ]);
      if (espera) await tx.query("select pg_sleep($1::float)", [espera / 1000]);
    });
  const tomar = (tenant: string, envioId: string, espera: number) =>
    worker.withTenant({ tenantId: tenant }, async (tx) => {
      const r = (await tx.query("select correo_envio_tomar($1::uuid) as r", [envioId])).rows[0].r;
      if (espera) await tx.query("select pg_sleep($1::float)", [espera / 1000]);
      return r;
    });

  it(`${RONDAS} rondas: nunca queda un pendiente sin tomar con la preferencia apagada, y no hay interbloqueos`, async () => {
    for (let i = 0; i < RONDAS; i++) {
      const u = await usuario();
      await ec.notificarDirecto(admin, E, [u], "buzon_critico");
      const [e] = await ec.envios(E, { usuarioId: u });
      // pares: tomar primero y retener el candado; impares: apagar primero y retener
      const [t, a] =
        i % 2 === 0
          ? await Promise.allSettled([tomar(E, e!.id, 120), (async () => { await dormir(30); return apagar(E, u, 0); })()])
          : await Promise.allSettled([(async () => { await dormir(30); return tomar(E, e!.id, 0); })(), apagar(E, u, 120)]);
      expect(a.status, `ronda ${i}: apagar ${a.status === "rejected" ? codigo(a.reason) : ""}`).toBe("fulfilled");
      if (t.status === "rejected") expect(codigo(t.reason), `ronda ${i}: tomar`).toBe("P0002"); // el envio ya estaba omitido
      expect(await ec.efectiva(E, u, "buzon_critico")).toBe(false);
      const [despues] = await ec.envios(E, { usuarioId: u });
      const consistente =
        (despues!.estado === "omitido" && despues!.motivo === "preferencia_apagada") || (despues!.estado === "pendiente" && despues!.tomado_en !== null);
      expect(consistente, `ronda ${i}: ${despues!.estado} tomado=${String(despues!.tomado_en !== null)}`).toBe(true);
    }
  }, 60_000);
});

describe("R-5 · dos ciclos a la vez no duplican", () => {
  it(`${RONDAS} rondas de crear_correo_resumenes desde dos workers: un resumen por usuario y dia, con un solo trabajo cada uno`, async () => {
    const t = await ec.estudioPlan();
    const us: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = (await ec.et.miembro(t, "contador")).id;
      await ec.preferencia(t, u, "resumen", true);
      us.push(u);
    }
    const crear = (db: ContappDb, dia: string) =>
      db.withTenant({ tenantId: t }, async (tx) => Number((await tx.query("select crear_correo_resumenes($1::date) as n", [dia])).rows[0].n));
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const dia = await diaLima(ronda);
      const [a, b] = await Promise.allSettled([crear(worker, dia), crear(worker2, dia)]);
      expect([a.status, b.status], `ronda ${ronda}: ${[a, b].map((x) => (x.status === "rejected" ? codigo(x.reason) : "")).join(",")}`).toEqual(["fulfilled", "fulfilled"]);
      const creados = (a as PromiseFulfilledResult<number>).value + (b as PromiseFulfilledResult<number>).value;
      expect(creados, `ronda ${ronda}`).toBe(5);
      const delDia = (await ec.envios(t, { origen: "resumen" })).filter((e) => e.clave.endsWith(`:${dia}`));
      expect(delDia.map((e) => e.usuario_id).sort(), `ronda ${ronda}`).toEqual([...us].sort());
      const jobs = (
        await admin.query("select parametros->>'envioId' as id from job_registro where tenant_id = $1 and tipo = 'notificacion.enviar'", [t])
      ).rows.map((x) => x.id as string);
      expect(jobs.length, `ronda ${ronda}: un trabajo por envio`).toBe((ronda + 1) * 5);
      expect(new Set(jobs).size).toBe(jobs.length);
    }
  }, 90_000);

  it(`${RONDAS} rondas de encolar_correo_avisos desde dos workers: cada envio vencido queda en la cola una sola vez`, async () => {
    const t = await ec.estudioPlan();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const us: string[] = [];
      for (let i = 0; i < 4; i++) {
        const u = (await ec.et.miembro(t, "contador")).id;
        await ec.notificarDirecto(admin, t, [u], "buzon_critico");
        us.push(u);
      }
      const encolar = (db: ContappDb) =>
        db.withTenant({ tenantId: t }, async (tx) => Number((await tx.query("select encolar_correo_avisos(100) as n")).rows[0].n));
      const [a, b] = await Promise.allSettled([encolar(worker), encolar(worker2)]);
      expect([a.status, b.status], `ronda ${ronda}: ${[a, b].map((x) => (x.status === "rejected" ? codigo(x.reason) : "")).join(",")}`).toEqual(["fulfilled", "fulfilled"]);
      expect((a as PromiseFulfilledResult<number>).value + (b as PromiseFulfilledResult<number>).value, `ronda ${ronda}`).toBe(4);
      const jobs = (
        await admin.query("select parametros->>'envioId' as id from job_registro where tenant_id = $1 and tipo = 'notificacion.enviar'", [t])
      ).rows;
      expect(jobs.length, `ronda ${ronda}`).toBe((ronda + 1) * 4);
      expect(new Set(jobs.map((x) => x.id)).size).toBe(jobs.length);
    }
  }, 90_000);
});
