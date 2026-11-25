import type { ContappDb } from "@contapp/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ORIGIN,
  CorreoMemoria,
  EscenarioCorreo,
  ProgramacionCorreo,
  ctxEnvio,
} from "../../../test/correo.js";
import { crearDbAdmin, crearDbRol } from "../../../test/trabajos.js";
import { authPurgar } from "./auth-purgar.js";
import { enviarCorreo } from "./enviar-correo.js";

// Spec 028, T5 (rojo; integración con PostgreSQL real, rol contapp_worker): `auth.purgar` borra los envíos de correo (con sus avisos y
// tokens de baja) de más de 90 días de CADA estudio y lo cuenta en `resultado.correo`; lo reciente se conserva; borrar la notificación
// vieja a la vez no falla por el aviso de correo que la sigue (R-11, plan 017 P-7). Contrato: ver auth-purgar-correo.spec.ts.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;
type ConCorreo = Awaited<ReturnType<typeof authPurgar>> & { correo: number };

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 4);
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

/** Un envío de aviso real, entregado (con su aviso y su token de baja), de un usuario y cliente propios. */
async function envioEntregado(T: string, n: number): Promise<string> {
  const u = await e.usuario(T, "contador");
  const c = await e.clienteCon(T, `Cliente Purga ${n} SAC`);
  await e.responsable(T, c, u);
  await e.capturar(T, c);
  const envio = await e.envioDe(T, { usuarioId: u, tipo: "buzon_critico" });
  const correo = new CorreoMemoria();
  await enviarCorreo({ db: worker, correo, appOrigin: APP_ORIGIN })(ctxEnvio(T, envio.id));
  expect(correo.enviados).toHaveLength(1);
  return envio.id;
}

const vivos = async (T: string): Promise<Set<string>> =>
  new Set((await e.envios(T)).map((f) => f.id));

describe("CA-15 de 028: auth.purgar y el correo", () => {
  it("borra los envíos de más de 90 días de cada estudio con sus avisos y tokens, deja los de 90 o menos y los cuenta", async () => {
    const T1 = await e.estudioPlan();
    const T2 = await e.estudioPlan();
    const viejo1 = await envioEntregado(T1, 1);
    const reciente1 = await envioEntregado(T1, 2);
    const viejo2 = await envioEntregado(T2, 3);
    const borde2 = await envioEntregado(T2, 4);
    await e.envejecer(T1, 100, [viejo1]);
    await e.envejecer(T2, 120, [viejo2]);
    await e.envejecer(T2, 89, [borde2]);
    expect(await vivos(T1)).toEqual(new Set([viejo1, reciente1]));

    const r = (await authPurgar({ db: worker })) as ConCorreo;

    expect(r.correo, "al menos los dos de esta prueba (la base puede traer más)").toBeGreaterThanOrEqual(2);
    expect(await vivos(T1)).toEqual(new Set([reciente1]));
    expect(await vivos(T2)).toEqual(new Set([borde2]));
    expect(await e.avisosDe(T1, { envioId: viejo1 }), "el aviso sigue a su envío").toHaveLength(0);
    expect(await e.tokensDe(viejo1)).toHaveLength(0);
    expect(await e.tokensDe(viejo2)).toHaveLength(0);
    expect(await e.avisosDe(T1, { envioId: reciente1 })).toHaveLength(1);
    expect(await e.tokensDe(reciente1)).toHaveLength(1);
    expect(await e.tokensDe(borde2)).toHaveLength(1);
  });

  it("junto con las notificaciones de más de 90 días: purgar ambas a la vez no falla por el aviso de correo", async () => {
    const T = await e.estudioPlan();
    const viejo = await envioEntregado(T, 5);
    await e.envejecer(T, 100, [viejo]);
    const c = await admin.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query("update notificacion set creada_en = creada_en - interval '100 days' where tenant_id = $1", [T]);
    } finally {
      c.release(true);
    }

    const r = (await authPurgar({ db: worker })) as ConCorreo;
    expect(r.correo).toBeGreaterThanOrEqual(1);
    expect(r.notificaciones).toBeGreaterThanOrEqual(1);
    expect(await vivos(T)).toEqual(new Set());
    expect(
      (await admin.pool.query("select count(*)::int as n from notificacion where tenant_id = $1", [T])).rows[0].n,
    ).toBe(0);
  });

  it("es idempotente: la segunda corrida no encuentra nada de esta prueba", async () => {
    const T = await e.estudioPlan();
    const viejo = await envioEntregado(T, 6);
    const reciente = await envioEntregado(T, 7);
    await e.envejecer(T, 100, [viejo]);
    await authPurgar({ db: worker });
    expect(await vivos(T)).toEqual(new Set([reciente]));
    await authPurgar({ db: worker });
    expect(await vivos(T)).toEqual(new Set([reciente]));
  });
});
