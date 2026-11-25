// Spec 028 (T3, rojo): rendimiento de la BD de correo (R-16, CA-14). Registrar avisos en `interno.notificar` no cuesta mas del doble que la
// misma captura sin correo (200 criticos en una transaccion, 5 destinatarios) y el ciclo del resumen de un estudio con 50 usuarios crea y
// encola en menos de 5 s. Lecciones de 027: se toma el MINIMO de >= 5 corridas, las dos variantes van INTERCALADAS (A, B, A, B...) y no se
// sube un tope para que pase. Las medidas son contra la BD real con las dos variantes en estudios gemelos; la variante «sin correo» es un plan
// con `correo_avisos: false` (la notificacion en la app se inserta igual). Falla hoy porque las migraciones 0073-0074 aun no existen (y la
// `interno.notificar` vieja no registra ningun aviso, asi que la medida seria vacua: se comprueba que los avisos existen).
// Este archivo no entra en las configuraciones de cobertura.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import { abrirAdmin, crearDb, EscenarioCorreo } from "./correo-soporte";

let admin: Pool;
let ec: EscenarioCorreo;
let worker: ContappDb;
let SIN: string; // plan con correo_avisos: false
let CON: string; // plan con todo habilitado
const CORRIDAS = 6;
const CRITICOS = 200;
const DESTINATARIOS = 5;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioCorreo(admin);
  SIN = await ec.estudioPlan({ features: { correo_avisos: false } });
  CON = await ec.estudioPlan();
  for (const t of [SIN, CON]) {
    for (let i = 0; i < 2; i++) await ec.et.miembro(t, "dueno");
    for (let i = 0; i < DESTINATARIOS - 2; i++) await ec.et.miembro(t, "admin");
  }
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const minimo = (xs: number[]): number => Math.min(...xs);
const mediana = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Una captura de 200 criticos de un cliente nuevo sin responsable (5 destinatarios) en una sola transaccion del worker; devuelve ms. */
async function capturaDe200(tenant: string): Promise<number> {
  const c = await ec.et.cliente(tenant);
  const trabajo = await ec.et.job(tenant, c, { estado: "ejecutando", tipo: "sol.buzon.revisar", cola: "sol", canal: "sol" });
  const t0 = performance.now();
  await worker.withTenant({ tenantId: tenant, trabajoId: trabajo }, (tx) => ec.capturarLote(tenant, c, CRITICOS, tx));
  return performance.now() - t0;
}
const avisos = async (t: string): Promise<number> =>
  (await admin.query("select count(*)::int as n from correo_envio_aviso where tenant_id = $1", [t])).rows[0].n as number;
const notificaciones = async (t: string): Promise<number> =>
  (await admin.query("select count(*)::int as n from notificacion where tenant_id = $1 and tipo = 'buzon_critico'", [t])).rows[0].n as number;

describe("R-16 · interno.notificar con correo cuesta como maximo el doble que sin correo", () => {
  it(`${CORRIDAS} corridas intercaladas de ${CRITICOS} criticos con ${DESTINATARIOS} destinatarios: minimo con correo <= 2 x minimo sin correo`, async () => {
    const sin: number[] = [];
    const con: number[] = [];
    for (let i = 0; i < CORRIDAS; i++) {
      sin.push(await capturaDe200(SIN)); // A
      // los envios de la corrida anterior ya los tomo el ciclo: cada corrida abre los suyos (si no, la medida mezclaria dos caminos)
      await admin.query("update correo_envio set tomado_en = clock_timestamp(), intentos = 1 where tenant_id = $1 and tomado_en is null", [CON]).catch(() => undefined);
      con.push(await capturaDe200(CON)); // B
    }
    // control anti vacuidad: las dos variantes guardaron las mismas notificaciones y solo la de correo registro sus avisos
    expect(await notificaciones(SIN)).toBe(CORRIDAS * CRITICOS * DESTINATARIOS);
    expect(await notificaciones(CON)).toBe(CORRIDAS * CRITICOS * DESTINATARIOS);
    expect(await avisos(SIN)).toBe(0);
    expect(await avisos(CON), "la variante con correo debe registrar un aviso por notificacion").toBe(CORRIDAS * CRITICOS * DESTINATARIOS);
    const razon = minimo(con) / minimo(sin);
    expect(
      razon,
      `minimo con correo ${minimo(con).toFixed(0)} ms, sin correo ${minimo(sin).toFixed(0)} ms (medianas ${mediana(con).toFixed(0)} / ${mediana(sin).toFixed(0)}): ${razon.toFixed(2)}x`,
    ).toBeLessThanOrEqual(2);
  }, 240_000);
});

describe("R-16 · el ciclo del resumen de un estudio con 50 usuarios crea y encola en menos de 5 s", () => {
  it(`minimo de ${CORRIDAS} corridas (un dia distinto cada una) < 5000 ms, con 50 resumenes y 50 trabajos por corrida`, async () => {
    const t = await ec.estudioPlan();
    const us: string[] = [];
    for (let i = 0; i < 50; i++) {
      const u = (await ec.et.miembro(t, "contador")).id;
      us.push(u);
    }
    await admin.query(
      `insert into correo_preferencia (tenant_id, usuario_id, tipo, activo) select $1, u, 'resumen', true from unnest($2::uuid[]) u`,
      [t, us],
    );
    const tiempos: number[] = [];
    for (let i = 0; i < CORRIDAS; i++) {
      const dia = (
        await admin.query("select to_char((clock_timestamp() at time zone 'America/Lima')::date - $1::int, 'YYYY-MM-DD') as d", [i])
      ).rows[0].d as string;
      const t0 = performance.now();
      const n = await worker.withTenant({ tenantId: t }, async (tx) => Number((await tx.query("select crear_correo_resumenes($1::date) as n", [dia])).rows[0].n));
      tiempos.push(performance.now() - t0);
      expect(n, `corrida ${i}`).toBe(50);
    }
    const jobs = (await admin.query("select count(*)::int as n from job_registro where tenant_id = $1 and tipo = 'notificacion.enviar'", [t])).rows[0].n;
    expect(jobs).toBe(50 * CORRIDAS);
    expect(minimo(tiempos), `tiempos ${tiempos.map((x) => x.toFixed(0)).join(", ")} ms`).toBeLessThan(5000);
  }, 240_000);
});
