import type { ContappDb } from "@contapp/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EscenarioCorreo, ProgramacionCorreo, soloMisEstudios } from "../../../test/correo.js";
import { crearDbAdmin, crearDbRol } from "../../../test/trabajos.js";
import { programarCorreo } from "./programar-correo.js";

// Spec 028, T5 (rojo; integración, R-16, CA-14): el ciclo del resumen de un estudio con 50 usuarios crea y encola en < 5 s. Mínimo de
// ≥ 5 corridas (se toma el mejor tiempo) con el resumen del día vuelto a abrir entre corridas; no se sube el tope para que pase.
// Va como `*.rendimiento.int.spec.ts` (el worker solo corre `*.int.spec.ts` contra BD) y fuera de las configs de cobertura.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const USUARIOS = 50;
const CORRIDAS = 5;
const TOPE_MS = 5_000;

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend", 8);
  worker = crearDbRol("contapp_worker", 8);
  prog = new ProgramacionCorreo(admin);
  await prog.guardar();
});
beforeEach(() => {
  e = new EscenarioCorreo(admin, backend, worker);
});
afterEach(async () => {
  await e.limpiar();
  await prog.restaurar();
});
afterAll(async () => {
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

/** Borra los envíos y trabajos del estudio (replica) y deja el día del resumen otra vez abierto. */
async function reabrirElDia(T: string): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query("delete from correo_baja_token where tenant_id = $1", [T]);
    await c.query("delete from correo_envio_aviso where tenant_id = $1", [T]);
    await c.query("delete from correo_envio where tenant_id = $1", [T]);
    await c.query("delete from job_registro where tenant_id = $1 and tipo = 'notificacion.enviar'", [T]);
  } finally {
    c.release(true);
  }
  await prog.restaurar();
  await prog.resumenYaToca();
  await prog.listoParaTomar();
}

describe("R-16, CA-14: ciclo del resumen de un estudio con 50 usuarios", () => {
  it(`crea y encola ${USUARIOS} resúmenes en < ${TOPE_MS} ms (mínimo de ${CORRIDAS} corridas)`, async () => {
    const T = await e.estudioPlan();
    await e.usuario(T, "dueno");
    for (let i = 0; i < USUARIOS; i++) {
      const u = await e.usuario(T, "contador");
      const c = await e.clienteCon(T, `Cliente Rendimiento ${i} SAC`);
      await e.responsable(T, c, u);
      await e.fijar(T, u, { resumen: true });
    }
    const ciclo = programarCorreo({ db: soloMisEstudios(worker, () => e.estudios) });

    const tiempos: number[] = [];
    for (let corrida = 1; corrida <= CORRIDAS; corrida++) {
      await reabrirElDia(T);
      const t0 = performance.now();
      const r = await ciclo();
      tiempos.push(performance.now() - t0);
      expect(r, `corrida ${corrida}`).toMatchObject({ tomado: true, resumenesCreados: USUARIOS, diaCerrado: true });
      expect(await e.trabajosEnviar(T), `corrida ${corrida}: un trabajo por resumen`).toHaveLength(USUARIOS);
    }
    const mejor = Math.min(...tiempos);
    expect(mejor, `tiempos (ms): ${tiempos.map((t) => Math.round(t)).join(", ")}`).toBeLessThan(TOPE_MS);
  });
});
