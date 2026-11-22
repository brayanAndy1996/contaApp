// Spec 027 (T14a): `reevaluarLoteSiCambia` (packages/db/src/xml/reevaluar.ts), la re-evaluación por lotes que usa el worker al cambiar el
// contexto de gastos (R-12, R-13). Contra la BD real con el worker (bloqueo por la función `bloquear_compras_reevaluar`) y el backend
// (bloqueo directo de la fila). Contrato que fijan estas pruebas:
//   reevaluarLoteSiCambia(tx, clienteId, periodo, despuesDe, tamano, {evaluarDe, bloqueo?}) -> {revisadas, cambiadas, ultimoId}
//   - Toma las compras vivas del cliente y periodo por id ascendente a partir de `despuesDe` (hasta `tamano`).
//   - Agrega la evaluación `n + 1` de la versión vigente SOLO a las que cambian respecto de su última evaluación (regla, sugerencia,
//     lecturas y confirmación; el orden de los hallazgos y el de las claves no cuentan; sin evaluación previa equivale a «sin hallazgos»).
//   - No crea versiones ni mueve el puntero; si `evaluar` lanza, no queda nada escrito.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reevaluarLoteSiCambia } from "./../index";
import {
  abrirArnes,
  fijarEstadoPeriodo,
  sembrarCompra,
  sembrarXml,
  type Arnes,
  type ClienteSembrado,
  type CompraSembrada,
  type Estudio,
} from "./soporte-prueba";
import type { Evaluar, HallazgoNuevo } from "../compras/tipos";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const PERIODO = "202610";

const hallazgo = (o: Partial<HallazgoNuevo> = {}): HallazgoNuevo => ({
  regla: "R-STD",
  sugerencia: null,
  lecturas: {},
  requiereConfirmacion: false,
  ...o,
});

type Lote = Parameters<typeof reevaluarLoteSiCambia>;

/** Corre un lote como worker (bloqueo por función) o como backend (bloqueo de fila). */
function lote(
  c: ClienteSembrado,
  evaluar: Evaluar,
  o: {
    despuesDe?: string | null;
    tamano?: number;
    como?: "worker" | "backend";
    bloqueo?: "auto" | "fila" | "funcion";
    periodo?: string;
    estudio?: Estudio;
  } = {},
) {
  const e = o.estudio ?? h.A;
  const llamar = (tx: Lote[0]) =>
    reevaluarLoteSiCambia(
      tx,
      c.id,
      o.periodo ?? PERIODO,
      o.despuesDe ?? null,
      o.tamano ?? 200,
      {
        evaluarDe: () => evaluar,
        ...(o.bloqueo === undefined ? {} : { bloqueo: o.bloqueo }),
      },
    );
  return (o.como ?? "worker") === "worker"
    ? h.comoWorker((tx) => llamar(tx), e)
    : h.comoDueno((tx) => llamar(tx), e);
}

async function evaluaciones(compraId: string): Promise<number[]> {
  const r = await h.admin.query(
    "select n from compra_evaluacion where compra_id = $1 order by version_n, n",
    [compraId],
  );
  return r.rows.map((x: { n: number }) => x.n);
}

async function hallazgosDe(compraId: string, n: number) {
  const r = await h.admin.query(
    `select regla, sugerencia, lecturas, requiere_confirmacion from compra_hallazgo
      where compra_id = $1 and evaluacion_n = $2 order by regla`,
    [compraId, n],
  );
  return r.rows as Array<{
    regla: string;
    sugerencia: unknown;
    lecturas: Record<string, string>;
    requiere_confirmacion: boolean;
  }>;
}

async function escenario(n: number, e: Estudio = h.A) {
  const c = await e.nuevoCliente();
  const compras: CompraSembrada[] = [];
  for (let i = 0; i < n; i++)
    compras.push(await sembrarCompra(h.admin, e, c, { periodo: PERIODO }));
  compras.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { c, compras };
}

describe("reevaluarLoteSiCambia: lote y paginación", () => {
  it("sin compras vivas devuelve 0, 0 y ultimoId null sin llamar a evaluarDe", async () => {
    const c = await h.A.nuevoCliente();
    let armado = false;
    const r = await h.comoWorker((tx) =>
      reevaluarLoteSiCambia(tx, c.id, PERIODO, null, 200, {
        evaluarDe: () => {
          armado = true;
          return () => [];
        },
      }),
    );
    expect(r).toEqual({ revisadas: 0, cambiadas: 0, ultimoId: null });
    expect(armado).toBe(false);
  });

  it("recorre el periodo por id ascendente en páginas y termina con ultimoId null", async () => {
    const { c, compras } = await escenario(5);
    const vistos: string[] = [];
    let despuesDe: string | null = null;
    for (;;) {
      const r: Awaited<ReturnType<typeof lote>> = await lote(
        c,
        (fila) => {
          vistos.push(fila.id);
          return [];
        },
        { despuesDe, tamano: 2 },
      );
      if (r.ultimoId === null) {
        expect(r.revisadas).toBe(0);
        break;
      }
      expect(r.revisadas).toBeLessThanOrEqual(2);
      despuesDe = r.ultimoId;
    }
    expect(vistos).toEqual(compras.map((x) => x.id));
  });

  it("el lote se acota por `tamano` y `ultimoId` es la última compra revisada", async () => {
    const { c, compras } = await escenario(3);
    const r = await lote(c, () => [], { tamano: 2 });
    expect(r).toEqual({ revisadas: 2, cambiadas: 0, ultimoId: compras[1]!.id });
  });

  it("no toca compras descartadas, de otro periodo ni de otro cliente", async () => {
    const { c, compras } = await escenario(1);
    const descartada = await sembrarCompra(h.admin, h.A, c, {
      periodo: PERIODO,
      descartada: true,
    });
    const otroPeriodo = await sembrarCompra(h.admin, h.A, c, {
      periodo: "202609",
    });
    const otro = await escenario(1);
    const vistos: string[] = [];
    const r = await lote(c, (fila) => {
      vistos.push(fila.id);
      return [hallazgo()];
    });
    expect(r).toMatchObject({ revisadas: 1, cambiadas: 1 });
    expect(vistos).toEqual([compras[0]!.id]);
    for (const x of [descartada, otroPeriodo, otro.compras[0]!])
      expect(await evaluaciones(x.id)).toEqual([]);
  });
});

describe("reevaluarLoteSiCambia: solo escribe lo que cambia", () => {
  it("sin evaluación previa, «sin hallazgos» no cambia nada y no escribe", async () => {
    const { c, compras } = await escenario(2);
    const r = await lote(c, () => []);
    expect(r).toMatchObject({ revisadas: 2, cambiadas: 0 });
    for (const x of compras) expect(await evaluaciones(x.id)).toEqual([]);
  });

  it("un hallazgo nuevo agrega la evaluación 1; repetir lo mismo no agrega otra; un cambio agrega la 2", async () => {
    const { c, compras } = await escenario(2);
    const [a, b] = compras as [CompraSembrada, CompraSembrada];
    const primero = await lote(c, () => [
      hallazgo({
        regla: "R-GP",
        lecturas: { x: "1" },
        requiereConfirmacion: true,
      }),
    ]);
    expect(primero).toMatchObject({ revisadas: 2, cambiadas: 2 });
    expect(await evaluaciones(a.id)).toEqual([1]);
    expect(await hallazgosDe(a.id, 1)).toEqual([
      {
        regla: "R-GP",
        sugerencia: null,
        lecturas: { x: "1" },
        requiere_confirmacion: true,
      },
    ]);

    const igual = await lote(c, () => [
      hallazgo({
        regla: "R-GP",
        lecturas: { x: "1" },
        requiereConfirmacion: true,
      }),
    ]);
    expect(igual).toMatchObject({ revisadas: 2, cambiadas: 0 });
    expect(await evaluaciones(a.id)).toEqual([1]);

    // Cambia solo para `a`: `b` conserva su evaluación 1.
    const distinto = await lote(c, (fila) => [
      hallazgo({
        regla: "R-GP",
        lecturas: { x: fila.id === a.id ? "2" : "1" },
        requiereConfirmacion: true,
      }),
    ]);
    expect(distinto).toMatchObject({ revisadas: 2, cambiadas: 1 });
    expect(await evaluaciones(a.id)).toEqual([1, 2]);
    expect(await evaluaciones(b.id)).toEqual([1]);
    expect((await hallazgosDe(a.id, 2))[0]!.lecturas).toEqual({ x: "2" });
  });

  it("el orden de los hallazgos y el de las claves de sugerencia y lecturas no cuentan", async () => {
    const { c, compras } = await escenario(1);
    await lote(c, () => [
      hallazgo({
        regla: "R-ISC",
        sugerencia: { b: 1, a: { d: 2, c: 3 } },
        lecturas: { y: "1", x: "2" },
      }),
      hallazgo({ regla: "R-MIX", sugerencia: [{ z: 1, y: 2 }, "t"] }),
    ]);
    const r = await lote(c, () => [
      hallazgo({ regla: "R-MIX", sugerencia: [{ y: 2, z: 1 }, "t"] }),
      hallazgo({
        regla: "R-ISC",
        sugerencia: { a: { c: 3, d: 2 }, b: 1 },
        lecturas: { x: "2", y: "1" },
      }),
    ]);
    expect(r).toMatchObject({ revisadas: 1, cambiadas: 0 });
    expect(await evaluaciones(compras[0]!.id)).toEqual([1]);
  });

  it("cambia si cambia la sugerencia, la confirmación o el conjunto de reglas", async () => {
    const { c, compras } = await escenario(1);
    const id = compras[0]!.id;
    const variantes: HallazgoNuevo[][] = [
      [hallazgo({ regla: "R-NEW", sugerencia: { v: 1 } })],
      [hallazgo({ regla: "R-NEW", sugerencia: { v: 2 } })],
      [
        hallazgo({
          regla: "R-NEW",
          sugerencia: { v: 2 },
          requiereConfirmacion: true,
        }),
      ],
      [
        hallazgo({
          regla: "R-NEW",
          sugerencia: { v: 2 },
          requiereConfirmacion: true,
        }),
        hallazgo({ regla: "R-RED" }),
      ],
      [hallazgo({ regla: "R-RED" })],
      [],
    ];
    for (const [i, v] of variantes.entries()) {
      const r = await lote(c, () => v);
      expect(r.cambiadas, `variante ${i}`).toBe(1);
    }
    expect(await evaluaciones(id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await hallazgosDe(id, 6)).toEqual([]);
  });

  it("evaluar sin hallazgos (undefined) se toma como «sin hallazgos»", async () => {
    const { c, compras } = await escenario(1);
    const r = await lote(c, (() => undefined) as unknown as Evaluar);
    expect(r).toMatchObject({ revisadas: 1, cambiadas: 0 });
    expect(await evaluaciones(compras[0]!.id)).toEqual([]);
  });

  it("no crea versiones ni mueve el puntero y deja el XML de la evaluación", async () => {
    const e = h.A;
    const c = await e.nuevoCliente();
    const compra = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [false, true],
      vigente: 1,
    });
    await sembrarXml(h.admin, e, c, compra, ["ZAPATILLA RUNNER"]);
    const antes = await h.admin.query(
      "select version_vigente, (select count(*)::int from compra_version v where v.compra_id = c.id) as versiones from compra c where id = $1",
      [compra.id],
    );
    const vistas: unknown[] = [];
    await lote(c, (fila) => {
      vistas.push(
        fila.version,
        (fila.xml?.detalle as { items: { descripcion: string }[] }).items[0]!
          .descripcion,
      );
      return [hallazgo()];
    });
    const despues = await h.admin.query(
      "select version_vigente, (select count(*)::int from compra_version v where v.compra_id = c.id) as versiones from compra c where id = $1",
      [compra.id],
    );
    expect(despues.rows).toEqual(antes.rows);
    // Evalúa la versión vigente (1), no la última creada, y con el XML del comprobante.
    expect(vistas).toEqual([1, "ZAPATILLA RUNNER"]);
    const ev = await h.admin.query(
      "select version_n, n, documento_xml_id from compra_evaluacion where compra_id = $1",
      [compra.id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ version_n: 1, n: 1 });
    expect(ev.rows[0].documento_xml_id).not.toBeNull();
  });

  it("la evaluación nueva de una versión sin evaluaciones previas es la 1, aunque otra versión tenga las suyas", async () => {
    const e = h.A;
    const c = await e.nuevoCliente();
    const compra = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [false, true],
    });
    await h.admin.query(
      "insert into compra_evaluacion (tenant_id, compra_id, version_n, n) values ($1, $2, 1, 1), ($1, $2, 1, 2)",
      [e.tenantId, compra.id],
    );
    const r = await lote(c, () => [hallazgo()]);
    expect(r).toMatchObject({ revisadas: 1, cambiadas: 1 });
    const ev = await h.admin.query(
      "select version_n, n from compra_evaluacion where compra_id = $1 order by version_n, n",
      [compra.id],
    );
    expect(ev.rows).toEqual([
      { version_n: 1, n: 1 },
      { version_n: 1, n: 2 },
      { version_n: 2, n: 1 },
    ]);
  });

  it("si la evaluación lanza, se propaga y no queda nada escrito (ni siquiera en las compras anteriores del lote)", async () => {
    const { c, compras } = await escenario(3);
    const medio = compras[1]!.id;
    await expect(
      lote(c, (fila) => {
        if (fila.id === medio) throw new Error("falla de la regla");
        return [hallazgo()];
      }),
    ).rejects.toThrow("falla de la regla");
    for (const x of compras) expect(await evaluaciones(x.id)).toEqual([]);
  });
});

describe("reevaluarLoteSiCambia: armado de las reglas con las compras del lote y bloqueo", () => {
  it("evaluarDe recibe las compras del lote (ya releídas) y se llama una vez por lote", async () => {
    const { c, compras } = await escenario(3);
    const recibidas: string[][] = [];
    const e = h.A;
    await h.comoWorker(
      (tx) =>
        reevaluarLoteSiCambia(tx, c.id, PERIODO, null, 200, {
          evaluarDe: (cs) => {
            recibidas.push(cs.map((x) => x.id));
            return () => [];
          },
        }),
      e,
    );
    expect(recibidas).toEqual([compras.map((x) => x.id)]);
  });

  it.each([
    ["worker", "auto"],
    ["worker", "funcion"],
    ["backend", "auto"],
    ["backend", "fila"],
  ] as const)(
    "%s con bloqueo %s revisa y escribe igual",
    async (como, bloqueo) => {
      const { c, compras } = await escenario(2);
      const r = await lote(c, () => [hallazgo({ regla: "R-RED" })], {
        como,
        bloqueo,
      });
      expect(r).toMatchObject({ revisadas: 2, cambiadas: 2 });
      for (const x of compras) expect(await evaluaciones(x.id)).toEqual([1]);
    },
  );

  it.each([
    ["backend", "funcion"],
    ["worker", "fila"],
  ] as const)(
    "%s no puede forzar el bloqueo %s del otro rol: 42501 y no escribe",
    async (como, bloqueo) => {
      const { c, compras } = await escenario(1);
      await expect(
        lote(c, () => [hallazgo()], { como, bloqueo }),
      ).rejects.toMatchObject({ codigo: "42501" });
      expect(await evaluaciones(compras[0]!.id)).toEqual([]);
    },
  );

  it("el estado del periodo no impide re-evaluar (vale en periodo revisado)", async () => {
    const { c, compras } = await escenario(1);
    await fijarEstadoPeriodo(h.admin, h.A, c, PERIODO, "revisado");
    const r = await lote(c, () => [hallazgo()]);
    expect(r).toMatchObject({ revisadas: 1, cambiadas: 1 });
    expect(await evaluaciones(compras[0]!.id)).toEqual([1]);
  });

  it("otro estudio no ve ni evalúa compras ajenas (RLS)", async () => {
    const { c } = await escenario(2);
    const r = await h.comoWorker(
      (tx) =>
        reevaluarLoteSiCambia(tx, c.id, PERIODO, null, 200, {
          evaluarDe: () => () => [hallazgo()],
        }),
      h.B,
    );
    expect(r).toEqual({ revisadas: 0, cambiadas: 0, ultimoId: null });
  });
});
