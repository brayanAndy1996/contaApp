// Spec 026 · T16 (tester): pruebas de las correcciones de la ronda adversarial 1 sobre `prorrata_declaraciones_registrar` (0066), en BD
// real. Una prueba por hallazgo, escrita contra lo que pide la spec y no contra el ataque:
//   H-026-1-1: `p_trabajo` debe estar en ejecucion (`ejecutando`, catalogo de 008): completado, error, cancelado y en_cola se
//              rechazan con 22023 (el mismo «trabajo invalido» de 0066) y sin escribir obtencion ni auditoria.
//   H-026-1-2: si `app.trabajo_id` esta fijado debe coincidir con `p_trabajo` (error fijo, sin escribir); y el actor de
//              `prorrata.declaraciones_obtenidas` es el trabajo `p_trabajo` (actor «trabajo»), coherente con `trabajo_id` de la fila.
//   H-026-1-3: R-1 tambien en la funcion: un periodo posterior al mes en curso en Lima (`clock_timestamp()`) se rechaza con 22023 y
//              nada escrito; el mes en curso y los anteriores siguen validos.
// Controles en verde incluidos (trabajo en ejecucion con sesion coherente, mes en curso) para que el rojo sea por el defecto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import {
  argsRegistrar,
  codigoDe,
  EscenarioProrrata,
  llamar,
  SQL,
} from "./prorrata-soporte";

let admin: Pool;
let ep: EscenarioProrrata;
let worker: ContappDb;
let X: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ep = new EscenarioProrrata(admin);
  X = (await ep.estudio()).id;
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(
    [worker?.close(), ep?.cerrar()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

const VACIO = {
  prorrata_obtencion: 0,
  declaracion_mensual: 0,
  prorrata_mes_manual: 0,
  prorrata_usada_manual: 0,
};

/** Mes en curso en hora de Lima (UTC-5 todo el ano) y desplazamientos en meses, AAAAMM. */
function mesLima(desplazamiento: number): string {
  const lima = new Date(Date.now() - 5 * 3_600_000);
  const indice =
    lima.getUTCFullYear() * 12 + lima.getUTCMonth() + desplazamiento;
  const a = Math.floor(indice / 12);
  const m = (indice % 12) + 1;
  return `${a}${String(m).padStart(2, "0")}`;
}

async function auditoriaObtencion(
  clienteId: string,
): Promise<{ actor_tipo: string; trabajo_id: string | null }[]> {
  return (
    await admin.query(
      `select actor_tipo, trabajo_id from auditoria
        where cliente_id = $1 and accion = 'prorrata.declaraciones_obtenidas' order by ocurrida_en, id`,
      [clienteId],
    )
  ).rows;
}

// =================================================================================================
describe("H-026-1-1 · registrar exige que p_trabajo este en ejecucion (008: estado «ejecutando»)", () => {
  it("control: un trabajo en ejecucion con la sesion coherente escribe la obtencion y su auditoria", async () => {
    const c = await ep.cliente(X);
    const job = await ep.jobDescarga(X, c, { periodo: "202610" });
    const r = await llamar(
      worker,
      { tenantId: X, trabajoId: job },
      SQL.registrar,
      argsRegistrar(c, job),
    );
    expect(codigoDe(r)).toBe("ok");
    expect((await ep.totales(c.id)).prorrata_obtencion).toBe(1);
    expect(await auditoriaObtencion(c.id)).toHaveLength(1);
  });

  it.each(["completado", "error", "cancelado", "en_cola"])(
    "un trabajo %s: 22023 y ni obtencion, ni presentaciones, ni auditoria",
    async (estado) => {
      const c = await ep.cliente(X);
      const job = await ep.jobDescarga(X, c, { periodo: "202610", estado });
      const r = await llamar(
        worker,
        { tenantId: X, trabajoId: job },
        SQL.registrar,
        argsRegistrar(c, job),
      );
      expect(codigoDe(r), `estado ${estado}`).toBe("22023");
      expect(await ep.totales(c.id)).toEqual(VACIO);
      expect(await auditoriaObtencion(c.id)).toEqual([]);
    },
  );
});

// =================================================================================================
describe("H-026-1-2 · app.trabajo_id coincide con p_trabajo y el actor de la auditoria es ese trabajo (D-6)", () => {
  it("app.trabajo_id de OTRO trabajo: error fijo (22023 o 42501) y nada escrito, ni obtencion ni auditoria", async () => {
    const a = await ep.cliente(X);
    const b = await ep.cliente(X);
    const jobA = await ep.jobDescarga(X, a, { periodo: "202610" });
    const jobB = await ep.jobDescarga(X, b, { periodo: "202610" });
    const r = await llamar(
      worker,
      { tenantId: X, trabajoId: jobB },
      SQL.registrar,
      argsRegistrar(a, jobA),
    );
    expect(
      ["22023", "42501"],
      "la sesion de otro trabajo escribe por A",
    ).toContain(codigoDe(r));
    expect(await ep.totales(a.id)).toEqual(VACIO);
    expect(await auditoriaObtencion(a.id)).toEqual([]);
    expect(await auditoriaObtencion(b.id)).toEqual([]);
  });

  it("sesion coherente (app.trabajo_id = p_trabajo): actor «trabajo» con p_trabajo, igual al trabajo_id de la obtencion", async () => {
    const c = await ep.cliente(X);
    const job = await ep.jobDescarga(X, c, { periodo: "202610" });
    const r = await llamar(
      worker,
      { tenantId: X, trabajoId: job },
      SQL.registrar,
      argsRegistrar(c, job),
    );
    expect(codigoDe(r)).toBe("ok");
    const aud = await auditoriaObtencion(c.id);
    expect(aud).toEqual([{ actor_tipo: "trabajo", trabajo_id: job }]);
    expect((await ep.obtenciones(c.id)).map((o) => o.trabajo_id)).toEqual([
      job,
    ]);
  });

  it("sin app.trabajo_id en la sesion: se escribe y el actor es «trabajo» con p_trabajo (no «sistema»), igual al trabajo_id de la fila", async () => {
    const c = await ep.cliente(X);
    const job = await ep.jobDescarga(X, c, { periodo: "202610" });
    const r = await llamar(
      worker,
      { tenantId: X },
      SQL.registrar,
      argsRegistrar(c, job),
    );
    expect(codigoDe(r)).toBe("ok");
    const aud = await auditoriaObtencion(c.id);
    expect(aud).toEqual([{ actor_tipo: "trabajo", trabajo_id: job }]);
    expect((await ep.obtenciones(c.id)).map((o) => o.trabajo_id)).toEqual([
      job,
    ]);
  });
});

// =================================================================================================
describe("H-026-1-3 · R-1 en la funcion: el periodo no puede ser posterior al mes en curso en Lima", () => {
  it("control: el mes en curso y el anterior se aceptan", async () => {
    for (const periodo of [mesLima(0), mesLima(-1)]) {
      const c = await ep.cliente(X);
      const job = await ep.jobDescarga(X, c, { periodo });
      const r = await llamar(
        worker,
        { tenantId: X, trabajoId: job },
        SQL.registrar,
        argsRegistrar(c, job, { hasta: periodo, declaraciones: [] }),
      );
      expect(codigoDe(r), `periodo ${periodo}`).toBe("ok");
    }
  });

  it.each([1, 2, 24])(
    "un periodo %i mes(es) posterior al en curso: 22023 y ni obtencion, ni presentaciones, ni auditoria",
    async (desplazamiento) => {
      const periodo = mesLima(desplazamiento);
      const c = await ep.cliente(X);
      const job = await ep.jobDescarga(X, c, { periodo });
      const r = await llamar(
        worker,
        { tenantId: X, trabajoId: job },
        SQL.registrar,
        argsRegistrar(c, job, { hasta: periodo, declaraciones: [] }),
      );
      expect(codigoDe(r), `ventana de ${periodo} (futuro)`).toBe("22023");
      expect(await ep.totales(c.id)).toEqual(VACIO);
      expect(await auditoriaObtencion(c.id)).toEqual([]);
    },
  );
});
