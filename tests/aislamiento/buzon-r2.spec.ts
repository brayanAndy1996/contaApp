// Spec 023 · T20 · pruebas propias de las correcciones de la ronda adversarial 2 en la BD (rojo; las corrige T21 con la migración
// 0058). Fijan INVARIANTES, no la implementación:
//  - H-023-2-7 (CA-1): el candado de un ciclo muerto (dueño que no soltó) se puede retomar en cuanto vence, sin esperar el
//    intervalo desde el INICIO del ciclo muerto. Un ciclo soltado con normalidad sigue sin repetirse dentro del intervalo.
//  - H-023-2-9 (CA-6, D-7, plan «la BD lo exige»): la BD rechaza con 42501 guardar un crítico reciente (o de un cliente ya
//    sincronizado) sin aviso, también cuando el worker lo disfraza con `critico = false` y una categoría crítica, sea cual sea
//    el `motivo_critico` o el resto de columnas que mande.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  comoAdmin,
  comoRol,
  crearDb,
  EscenarioBuzon,
  probar,
  sqlMensaje,
  upsertEstado,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let worker: ContappDb;
let E: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  eb = new EscenarioBuzon(admin);
  await eb.guardarProgramacion();
  E = await eb.estudioSub();
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await eb?.limpiar();
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("H-023-2-7 · buzon_ciclo_tomar retoma un ciclo muerto en cuanto vence su candado (CA-1, D-5)", () => {
  /** Fija la fila única con tiempos relativos al reloj de BD (como superusuario) y toma el ciclo como worker; todo se revierte. */
  async function tomarCon(o: {
    intervalo: number;
    dueno: string | null;
    hasta: string | null;
    inicio: string | null;
    tomador: string;
  }) {
    return comoRol(admin, "contapp_worker", null, async (c) => {
      await comoAdmin(c, "contapp_worker", async () => {
        await c.query(
          `update buzon_programacion set intervalo_min = $1, ciclo_dueno = $2,
             ciclo_hasta = case when $3::interval is null then null else clock_timestamp() + $3::interval end,
             ultimo_ciclo_inicio = case when $4::interval is null then null else clock_timestamp() + $4::interval end,
             ultimo_ciclo_fin = null`,
          [o.intervalo, o.dueno, o.hasta, o.inicio],
        );
      });
      const r = await probar(
        c,
        "select * from sistema.buzon_ciclo_tomar($1::text)",
        [o.tomador],
      );
      const e = await comoAdmin(
        c,
        "contapp_worker",
        async () => (await c.query("select * from buzon_programacion")).rows[0],
      );
      return { r, e };
    });
  }

  it("candado vencido hace 1 s de un ciclo que empezó hace 6 min (intervalo 15): otro dueño lo toma y queda como dueño", async () => {
    const { r, e } = await tomarCon({
      intervalo: 15,
      dueno: "worker-muerto",
      hasta: "-1 second",
      inicio: "-6 minutes",
      tomador: "worker-vivo",
    });
    expect(r.ok && r.rows).toHaveLength(1);
    expect(e.ciclo_dueno).toBe("worker-vivo");
    // El candado nuevo vuelve a ser de 5 minutos con el reloj de la BD.
    expect(new Date(e.ciclo_hasta).getTime() - Date.now()).toBeGreaterThan(
      290_000,
    );
  });

  it("con el intervalo en 120 min y el ciclo muerto iniciado hace 5 min, al vencer su candado también se retoma", async () => {
    const { r } = await tomarCon({
      intervalo: 120,
      dueno: "worker-muerto",
      hasta: "-1 second",
      inicio: "-5 minutes",
      tomador: "worker-vivo",
    });
    expect(r.ok && r.rows).toHaveLength(1);
  });

  it("con el candado todavía vivo no se toma, y un ciclo soltado dentro del intervalo no se repite (lo que ya vale)", async () => {
    const vivo = await tomarCon({
      intervalo: 15,
      dueno: "worker-A",
      hasta: "30 seconds",
      inicio: "-20 minutes",
      tomador: "worker-B",
    });
    expect(vivo.r.ok && vivo.r.rows).toEqual([]);
    expect(vivo.e.ciclo_dueno).toBe("worker-A");
    const soltado = await tomarCon({
      intervalo: 15,
      dueno: null,
      hasta: null,
      inicio: "-6 minutes",
      tomador: "worker-B",
    });
    expect(soltado.r.ok && soltado.r.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("H-023-2-9 · la BD no deja guardar un crítico sin su aviso aunque el worker lo disfrace (CA-6, D-7)", () => {
  const CRITICAS = [
    "coactiva",
    "resolucion_determinacion",
    "resolucion_multa",
    "requerimiento_fiscalizacion",
  ] as const;
  const MOTIVOS = [null, "codigo", "asunto", "duda"] as const;
  let nuevoSincronizado: ClientePrueba;
  let nuevoSinSincronizar: ClientePrueba;

  beforeAll(async () => {
    nuevoSinSincronizar = await eb.clienteCon(E, { cred: null });
    nuevoSincronizado = await eb.clienteCon(E, { cred: null });
    await upsertEstado(admin, E, nuevoSincronizado.id, {
      sincronizadoHace: "1 day",
    });
  });

  /** Inserta como worker (con rollback) y devuelve el código de error o «ok». */
  async function comoWorker(
    c: ClientePrueba,
    o: Parameters<typeof sqlMensaje>[2],
  ): Promise<string> {
    const m = sqlMensaje(E, c.id, o);
    const r = await intentar(worker, { tenantId: E }, m.text, m.values);
    return r.ok ? "ok" : r.code;
  }

  it("categoría crítica con critico = false, de hoy y sin aviso, se rechaza con 42501 (cualquier categoría y motivo)", async () => {
    const aceptadas: string[] = [];
    for (const categoria of CRITICAS)
      for (const motivo of MOTIVOS) {
        const r = await comoWorker(nuevoSinSincronizar, {
          categoria,
          critico: false,
          motivo,
          avisado: false,
          fechaHace: "1 hour",
        });
        if (r !== "42501") aceptadas.push(`${categoria}/${motivo}: ${r}`);
      }
    expect(aceptadas).toEqual([]);
  });

  it("categoría crítica con critico = false, antigua (60 días) pero de un cliente ya sincronizado, y sin aviso, se rechaza con 42501", async () => {
    const aceptadas: string[] = [];
    for (const categoria of CRITICAS) {
      const r = await comoWorker(nuevoSincronizado, {
        categoria,
        critico: false,
        motivo: null,
        avisado: false,
        fechaHace: "60 days",
      });
      if (r !== "42501") aceptadas.push(`${categoria}: ${r}`);
    }
    expect(aceptadas).toEqual([]);
  });

  it("lo legítimo sigue entrando: crítico avisado, crítico antiguo de un cliente sin sincronizar, y un «otro» común sin aviso", async () => {
    expect(
      await comoWorker(nuevoSinSincronizar, {
        categoria: "coactiva",
        critico: true,
        motivo: "asunto",
        avisado: true,
        fechaHace: "1 hour",
      }),
    ).toBe("ok");
    expect(
      await comoWorker(nuevoSinSincronizar, {
        categoria: "coactiva",
        critico: true,
        motivo: "asunto",
        avisado: false,
        fechaHace: "60 days",
      }),
    ).toBe("ok");
    expect(
      await comoWorker(nuevoSincronizado, {
        categoria: "otro",
        critico: false,
        motivo: null,
        avisado: false,
        fechaHace: "1 hour",
      }),
    ).toBe("ok");
  });
});
