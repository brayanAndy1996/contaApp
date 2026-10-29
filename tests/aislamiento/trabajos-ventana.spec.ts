// Spec 008 (T9c, rojo): `siguientesDisponibles` de `packages/db/src/trabajos/registro.ts` contra la BD real (CA-2, D21).
// Sin Redis. Se importa de `@contapp/db` por nombre (si falta, `exportado` dice cual).
//
// FIRMA que fija (T9d). Misma convencion que `trabajos-repos.spec.ts` (tx de withTenant primero; filas en camelCase):
//   siguientesDisponibles(tx, cola, ahora: Date, limite: number) -> TrabajoFila[]      (rol worker)
//        Los `en_cola` del estudio del contexto, de esa cola, con disponible_desde <= ahora, en el orden de
//        `siguienteDisponible` (interactivo antes que programado; luego creado_en; luego id) y a lo mas `limite`.
//        `limite` entero 1..50; fuera de rango (0, 51, negativo, no entero, NaN, no numerico) lanza ANTES de consultar.
//        `siguienteDisponible` se conserva y equivale a `limite = 1`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import {
  crearDb,
  EscenarioTrabajos,
  exportado,
  type ClientePrueba,
} from "./trabajos-soporte";

type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);
const ids = (filas: { id: string }[]): string[] => filas.map((x) => x.id);

let admin: Pool;
let et: EscenarioTrabajos;
const dbs: ContappDb[] = [];

beforeAll(async () => {
  admin = abrirAdmin(4);
  et = new EscenarioTrabajos(admin);
});
afterAll(async () => {
  await et?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await admin?.end();
});

const worker = (): ContappDb => {
  const d = crearDb("contapp_worker", 3);
  dbs.push(d);
  return d;
};

/** Estudio aislado con su cliente (la cola esta vacia al empezar). */
async function estudioNuevo(): Promise<{ t: string; c: ClientePrueba }> {
  const t = (await et.estudio()).id;
  return { t, c: await et.cliente(t) };
}

const ventana = (t: string, cola: string, ahora: Date, limite: number) =>
  worker().withTenant({ tenantId: t }, (tx) =>
    f("siguientesDisponibles")(tx, cola, ahora, limite),
  );

describe("siguientesDisponibles: orden, limite y filtros (CA-2, D21)", () => {
  it("devuelve en el orden de siguienteDisponible: interactivo, programado; luego creado_en", async () => {
    const { t, c } = await estudioNuevo();
    const progViejo = await et.job(t, c, {
      prioridad: "programado",
      hace: 900,
    });
    const progNuevo = await et.job(t, c, { prioridad: "programado", hace: 20 });
    const interNuevo = await et.job(t, c, {
      prioridad: "interactivo",
      hace: 10,
    });
    const interViejo = await et.job(t, c, {
      prioridad: "interactivo",
      hace: 100,
    });
    const r = await ventana(t, "sire", new Date(), 10);
    expect(ids(r)).toEqual([interViejo, interNuevo, progViejo, progNuevo]);
  });

  it("desempata por id cuando creado_en coincide", async () => {
    const { t, c } = await estudioNuevo();
    const a = await et.job(t, c, { hace: 50 });
    const b = await et.job(t, c, { hace: 50 });
    const igual = await admin.query(
      "update job_registro set creado_en = (select creado_en from job_registro where id = $1) where id = $2",
      [a, b],
    );
    expect(igual.rowCount).toBe(1);
    const r = await ventana(t, "sire", new Date(), 5);
    expect(ids(r)).toEqual([a, b].sort());
  });

  it("respeta `limite` y sus filas son las primeras de una ventana mas grande", async () => {
    const { t, c } = await estudioNuevo();
    const todosIds: string[] = [];
    for (let i = 0; i < 5; i++)
      todosIds.push(await et.job(t, c, { hace: 500 - i * 10 }));
    const dos = await ventana(t, "sire", new Date(), 2);
    const todos = await ventana(t, "sire", new Date(), 50);
    expect(ids(dos)).toEqual(todosIds.slice(0, 2));
    expect(ids(todos)).toEqual(todosIds);
  });

  it("limite 1 equivale a siguienteDisponible (que se conserva)", async () => {
    const { t, c } = await estudioNuevo();
    await et.job(t, c, { prioridad: "programado", hace: 900 });
    const inter = await et.job(t, c, { prioridad: "interactivo", hace: 10 });
    const [uno, cabeza] = await worker().withTenant(
      { tenantId: t },
      async (tx) => [
        await f("siguientesDisponibles")(tx, "sire", new Date(), 1),
        await f("siguienteDisponible")(tx, "sire", new Date()),
      ],
    );
    expect(ids(uno)).toEqual([inter]);
    expect(cabeza.id).toBe(inter);
  });

  it("solo en_cola, de la cola pedida y con disponible_desde <= ahora (los futuros entran cuando `ahora` los alcanza)", async () => {
    const { t, c } = await estudioNuevo();
    const ok = await et.job(t, c, { hace: 100 });
    await et.job(t, c, { hace: 100, estado: "ejecutando" });
    await et.job(t, c, { hace: 100, estado: "completado" });
    await et.job(t, c, {
      hace: 100,
      estado: "cancelado",
      motivo: "cancelado_usuario",
    });
    const sol = await et.job(t, c, { hace: 100, cola: "sol", canal: "sol" });
    const futuro = await et.job(t, c, { hace: 100, disponibleEn: 3600 });
    expect(ids(await ventana(t, "sire", new Date(), 20))).toEqual([ok]);
    expect(
      ids(await ventana(t, "sire", new Date(Date.now() + 2 * 3600_000), 20)),
    ).toEqual([ok, futuro]);
    expect(ids(await ventana(t, "sol", new Date(), 20))).toEqual([sol]);
  });

  it("entrega la fila completa en camelCase (como siguienteDisponible)", async () => {
    const { t, c } = await estudioNuevo();
    const id = await et.job(t, c, { hace: 30, parametros: { n: 7 } });
    const [fila] = await ventana(t, "sire", new Date(), 3);
    expect(fila).toMatchObject({
      id,
      tenantId: t,
      clienteId: c.id,
      ruc: c.ruc,
      tipo: "prueba.eco",
      cola: "sire",
      canal: "sire",
      prioridad: "interactivo",
      estado: "en_cola",
      parametros: { n: 7 },
      intentos: 0,
      maxIntentos: 3,
      motivo: null,
    });
    expect(fila.creadoEn).toBeInstanceOf(Date);
    expect(fila.disponibleDesde).toBeInstanceOf(Date);
  });

  it("no ve los trabajos de otro estudio (RLS) y devuelve [] con la cola vacia", async () => {
    const a = await estudioNuevo();
    const b = await estudioNuevo();
    await et.job(b.t, b.c);
    await et.job(b.t, b.c);
    expect(await ventana(a.t, "sire", new Date(), 20)).toEqual([]);
    const idA = await et.job(a.t, a.c);
    expect(ids(await ventana(a.t, "sire", new Date(), 20))).toEqual([idA]);
    const deB = await ventana(b.t, "sire", new Date(), 20);
    expect(deB).toHaveLength(2);
    expect(deB.every((x: { tenantId: string }) => x.tenantId === b.t)).toBe(
      true,
    );
  });

  it("es solo lectura: no cambia ninguna fila", async () => {
    const { t, c } = await estudioNuevo();
    const id = await et.job(t, c);
    const antes = await et.fila(id);
    await ventana(t, "sire", new Date(), 20);
    const despues = await et.fila(id);
    expect(despues.estado).toBe("en_cola");
    expect(despues.actualizado_en.getTime()).toBe(
      antes.actualizado_en.getTime(),
    );
  });
});

describe("siguientesDisponibles: `limite` invalido lanza antes de consultar (D21)", () => {
  const malos: [string, unknown][] = [
    ["0", 0],
    ["51", 51],
    ["negativo", -1],
    ["no entero", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["cadena numerica", "5"],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [nombre, valor] of malos) {
    it(`limite ${nombre}: rechaza sin tocar la BD`, async () => {
      let consultas = 0;
      const tx = {
        query: async () => {
          consultas++;
          return { rows: [], rowCount: 0 };
        },
      };
      await expect(
        f("siguientesDisponibles")(tx, "sire", new Date(), valor),
      ).rejects.toThrow();
      expect(consultas).toBe(0);
    });
  }

  it("los extremos 1 y 50 son validos", async () => {
    const { t, c } = await estudioNuevo();
    await et.job(t, c);
    expect(await ventana(t, "sire", new Date(), 1)).toHaveLength(1);
    expect(await ventana(t, "sire", new Date(), 50)).toHaveLength(1);
  });
});
