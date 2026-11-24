// Spec 027 (T4, rojo): lector único del contexto de R-GP y glosas de la compra (D-5; R-3 S5-S7, R-13, R-14; CA-2, CA-5, CA-16). Contra la
// BD real con el backend (con usuario) y el worker, más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y
// MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/gastos/contexto.ts`):
//   leerContextoGastos(tx, {clienteId, periodo, proveedores: {tipo, numero}[]}) -> ContextoGastosLeido, en <= 4 consultas:
//     umbral (3 sin fila en `gnd_config`), globales (activas de `gnd_palabra_global`, por palabra), desactivadas (palabras globales
//     que el estudio desactivó, ascendentes), propias (activas del estudio, por palabra; `{palabra, categoria, excepciones}`),
//     ciiuCliente (de `gnd_ciiu` por el RUC del cliente; null sin fila o «sin dato»), categoriasCliente ({permitidas, quitadas};
//     vacías sin fila), ciiuProveedores e historial (una entrada por proveedor pedido, sin repetir y en su orden; ceros o null si no
//     hay datos; un documento que no es un RUC de 11 dígitos tiene ciiu null).
//   Historial de un proveedor (mismo doc_tipo y doc_numero) para el cliente y el periodo evaluado M (U-8; M no cuenta):
//     aceptadas6   compras vivas (no descartadas) con la versión VIGENTE no excluida, de M-6..M-1, en periodos cuyo estado es
//                  `revisado` o `generado` (`abierto` o sin fila no cuentan);
//     excluidas6   compras vivas con la versión vigente excluida de M-6..M-1, sea cual sea el estado del periodo;
//     excluidas12  ídem de M-12..M-1.
//   leerGlosasCompra(tx, compraId) -> string[] | null: descripciones de los ítems del XML vigente (mayor `n`) en su orden; null sin
//     XML, de otro estudio, inexistente o con el id mal formado.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leerContextoGastos, leerGlosasCompra } from "./index";
import {
  PROVEEDOR,
  abrirArnes,
  desactivarGlobalDelEstudio,
  espiar,
  fijarCategoriasDelCliente,
  fijarConfig,
  fijarEstadoPeriodo,
  idGlobal,
  palabraUnica,
  pruebasTraduccion,
  restar,
  sembrarCiiu,
  sembrarCompra,
  sembrarPropia,
  sembrarXml,
  type Arnes,
  type ClienteSembrado,
  type OpcionesCompra,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const M = "202610";

const leer = (
  c: ClienteSembrado,
  proveedores = [PROVEEDOR],
  periodo = M,
  e = h.A,
) =>
  h.comoDueno(
    (tx) => leerContextoGastos(tx, { clienteId: c.id, periodo, proveedores }),
    e,
  );

describe("diccionario efectivo crudo (R-6, R-12)", () => {
  it("globales: las activas de la plataforma, por palabra, con la semilla de plan.md", async () => {
    const c = await h.A.nuevoCliente();
    const ctx = await leer(c);
    const { rows } = await h.admin.query(
      "select palabra, categoria, excepciones from gnd_palabra_global where activa order by palabra",
    );
    expect(ctx.globales).toEqual(
      rows.map((r) => ({
        palabra: r.palabra,
        categoria: r.categoria,
        excepciones: r.excepciones,
      })),
    );
    expect(ctx.globales.length).toBeGreaterThanOrEqual(72);
    const zapatilla = ctx.globales.find((g) => g.palabra === "zapatilla");
    expect(zapatilla?.categoria).toBe("calzado-ropa");
    expect(zapatilla?.excepciones).toEqual(
      expect.arrayContaining(["seguridad", "punta de acero"]),
    );
    expect(
      ctx.globales.find((g) => g.palabra === "polera")?.excepciones,
    ).toEqual([]);
  });

  it("desactivadas: solo las del estudio; las globales siguen en `globales` (el dominio las resta)", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await desactivarGlobalDelEstudio(
      h.admin,
      e,
      await idGlobal(h.admin, "zapatilla"),
    );
    await desactivarGlobalDelEstudio(
      h.admin,
      e,
      await idGlobal(h.admin, "cerveza"),
    );
    const ctx = await leer(c, [PROVEEDOR], M, e);
    expect(ctx.desactivadas).toEqual(["cerveza", "zapatilla"]);
    expect(ctx.globales.map((g) => g.palabra)).toEqual(
      expect.arrayContaining(["zapatilla", "cerveza"]),
    );
    // el otro estudio no las ve
    const otro = await h.B.nuevoCliente();
    expect((await leer(otro, [PROVEEDOR], M, h.B)).desactivadas).toEqual([]);
  });

  it("propias: solo las activas del estudio, por palabra, con categoría y excepciones; las de otro estudio no", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await sembrarPropia(h.admin, e, {
      palabra: "bluetooth",
      categoria: "entretenimiento",
      excepciones: ["parlante industrial"],
    });
    await sembrarPropia(h.admin, e, {
      palabra: "audifono",
      categoria: "entretenimiento",
    });
    await sembrarPropia(h.admin, e, {
      palabra: "kiosko",
      categoria: "juguetes",
      activa: false,
    });
    await sembrarPropia(h.admin, h.B, {
      palabra: "bluetoothb",
      categoria: "juguetes",
    });
    const ctx = await leer(c, [PROVEEDOR], M, e);
    expect(ctx.propias).toEqual([
      { palabra: "audifono", categoria: "entretenimiento", excepciones: [] },
      {
        palabra: "bluetooth",
        categoria: "entretenimiento",
        excepciones: ["parlante industrial"],
      },
    ]);
  });
});

describe("umbral, categorías del cliente y CIIU (R-11, R-13, R-14)", () => {
  it("umbral por defecto 3 y el fijado por el estudio", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    expect((await leer(c, [PROVEEDOR], M, e)).umbral).toBe(3);
    await fijarConfig(h.admin, e, 7, 2);
    expect((await leer(c, [PROVEEDOR], M, e)).umbral).toBe(7);
    await fijarConfig(h.admin, e, 20, 3);
    expect((await leer(c, [PROVEEDOR], M, e)).umbral).toBe(20);
  });

  it("categorías del cliente: vacías sin fila, las suyas con fila y sin mezclar con otro cliente", async () => {
    const c1 = await h.A.nuevoCliente();
    const c2 = await h.A.nuevoCliente();
    expect((await leer(c1)).categoriasCliente).toEqual({
      permitidas: [],
      quitadas: [],
    });
    await fijarCategoriasDelCliente(
      h.admin,
      h.A,
      c1,
      ["calzado-ropa"],
      ["juguetes", "entretenimiento"],
    );
    const ctx1 = await leer(c1);
    expect(ctx1.categoriasCliente.permitidas).toEqual(["calzado-ropa"]);
    expect([...ctx1.categoriasCliente.quitadas].sort()).toEqual([
      "entretenimiento",
      "juguetes",
    ]);
    expect((await leer(c2)).categoriasCliente).toEqual({
      permitidas: [],
      quitadas: [],
    });
  });

  it("ciiuCliente: null sin fila o «sin dato»; la clase de la caché con fila", async () => {
    const c = await h.A.nuevoCliente();
    expect((await leer(c)).ciiuCliente).toBeNull();
    await sembrarCiiu(h.admin, h.A, c.ruc, null);
    expect((await leer(c)).ciiuCliente).toBeNull();
    await sembrarCiiu(h.admin, h.A, c.ruc, "4752");
    expect((await leer(c)).ciiuCliente).toBe("4752");
  });

  it("ciiuCliente no cruza estudios: la caché del otro estudio no cuenta", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await sembrarCiiu(h.admin, h.B, c.ruc, "4752"); // mismo RUC, otro estudio
    expect((await leer(c, [PROVEEDOR], M, e)).ciiuCliente).toBeNull();
  });

  it("ciiuProveedores: una entrada por proveedor pedido, en su orden y sin repetir; sin caché o sin RUC, null", async () => {
    const c = await h.A.nuevoCliente();
    const ferreteria = { tipo: "6", numero: "20100000011" };
    const ropa = { tipo: "6", numero: "20100000022" };
    const sinDato = { tipo: "6", numero: "20100000033" };
    const dni = { tipo: "1", numero: "45678912" };
    await sembrarCiiu(h.admin, h.A, ferreteria.numero, "4752");
    await sembrarCiiu(h.admin, h.A, ropa.numero, "4771", "25 days");
    await sembrarCiiu(h.admin, h.A, sinDato.numero, null);
    const ctx = await leer(c, [
      ropa,
      dni,
      ferreteria,
      sinDato,
      ropa,
      PROVEEDOR,
    ]);
    expect(ctx.ciiuProveedores).toEqual([
      { proveedor: ropa, ciiu: "4771" },
      { proveedor: dni, ciiu: null },
      { proveedor: ferreteria, ciiu: "4752" },
      { proveedor: sinDato, ciiu: null },
      { proveedor: PROVEEDOR, ciiu: null },
    ]);
  });

  it("sin proveedores: ciiuProveedores e historial vacíos, el resto sí viene", async () => {
    const c = await h.A.nuevoCliente();
    const ctx = await leer(c, []);
    expect(ctx.ciiuProveedores).toEqual([]);
    expect(ctx.historial).toEqual([]);
    expect(ctx.umbral).toBeGreaterThanOrEqual(1);
  });
});

// ---- Historial S6/S7 (U-8) ----------------------------------------------------------------------------------------------------
type Estado = "abierto" | "revisado" | "generado";

/** Siembra compras y estados en un cliente nuevo y lee el historial del proveedor (o de varios) para `periodo`. */
async function historialDe(
  compras: Array<Omit<OpcionesCompra, "periodo"> & { periodo: string }>,
  estados: Record<string, Estado> = {},
  periodo = M,
  proveedores = [PROVEEDOR],
) {
  const c = await h.A.nuevoCliente();
  for (const [p, st] of Object.entries(estados))
    await fijarEstadoPeriodo(h.admin, h.A, c, p, st);
  for (const o of compras) await sembrarCompra(h.admin, h.A, c, o);
  const ctx = await leer(c, proveedores, periodo);
  return { c, ctx, h: ctx.historial[0]! };
}

const marcar = (periodos: string[], st: Estado = "revisado") =>
  Object.fromEntries(periodos.map((p) => [p, st])) as Record<string, Estado>;

describe.each(["202610", "202603", "202601"])(
  "historial en los bordes (M = %s)",
  (m) => {
    const p = (k: number) => restar(m, k);
    const tres = (periodo: string) => [0, 1, 2].map(() => ({ periodo }));

    it("S7: 3 compras en M-6 con el periodo revisado cuentan; en M-7 no", async () => {
      const dentro = await historialDe(tres(p(6)), marcar([p(6)]), m);
      expect(dentro.h).toEqual({
        proveedor: PROVEEDOR,
        aceptadas6: 3,
        excluidas6: 0,
        excluidas12: 0,
      });
      const fuera = await historialDe(tres(p(7)), marcar([p(7)]), m);
      expect(fuera.h.aceptadas6).toBe(0);
    });

    it("S7: M-1 cuenta; M (el evaluado) y M+1 no", async () => {
      const r = await historialDe(
        [{ periodo: p(1) }, { periodo: m }, { periodo: restar(m, -1) }],
        marcar([p(1), m, restar(m, -1)]),
        m,
      );
      expect(r.h.aceptadas6).toBe(1);
    });

    it("S6: excluidas en M-12 cuentan en 12 y no en 6; en M-13 no cuentan", async () => {
      const r = await historialDe(
        [
          { periodo: p(12), versiones: [true] },
          { periodo: p(12), versiones: [false, true] },
        ],
        {},
        m,
      );
      expect(r.h).toMatchObject({
        aceptadas6: 0,
        excluidas6: 0,
        excluidas12: 2,
      });
      const f = await historialDe(
        [
          { periodo: p(13), versiones: [true] },
          { periodo: p(13), versiones: [true] },
        ],
        {},
        m,
      );
      expect(f.h).toMatchObject({ excluidas6: 0, excluidas12: 0 });
    });

    it("S6: M-6 cuenta en 6 y en 12; M-7 solo en 12; M no cuenta", async () => {
      const r = await historialDe(
        [
          { periodo: p(6), versiones: [true] },
          { periodo: p(7), versiones: [true] },
          { periodo: m, versiones: [true] },
        ],
        {},
        m,
      );
      expect(r.h).toMatchObject({ excluidas6: 1, excluidas12: 2 });
    });
  },
);

describe("historial: estados del periodo, versión vigente, descartadas y aislamiento (U-8, CA-2, CA-5)", () => {
  const p = (k: number) => restar(M, k);

  it("`generado` cuenta como `revisado`; `abierto` y sin fila no cuentan", async () => {
    const r = await historialDe(
      [
        { periodo: p(1) },
        { periodo: p(2) },
        { periodo: p(3) },
        { periodo: p(4) },
      ],
      { [p(1)]: "revisado", [p(2)]: "generado", [p(3)]: "abierto" },
    );
    expect(r.h.aceptadas6).toBe(2);
  });

  it("cuenta compras, no periodos: dos compras del mismo periodo revisado son dos", async () => {
    const r = await historialDe(
      [{ periodo: p(2) }, { periodo: p(2) }],
      marcar([p(2)]),
    );
    expect(r.h.aceptadas6).toBe(2);
  });

  it("una excluida cuenta como excluida, nunca como aceptada, aunque su periodo esté revisado", async () => {
    const r = await historialDe(
      [{ periodo: p(2), versiones: [false, true] }, { periodo: p(3) }],
      marcar([p(2), p(3)]),
    );
    expect(r.h).toMatchObject({ aceptadas6: 1, excluidas6: 1, excluidas12: 1 });
  });

  it("las excluidas cuentan aunque el periodo esté abierto o sin fila", async () => {
    const r = await historialDe(
      [
        { periodo: p(2), versiones: [true] },
        { periodo: p(3), versiones: [true] },
      ],
      { [p(2)]: "abierto" },
    );
    expect(r.h).toMatchObject({ aceptadas6: 0, excluidas6: 2, excluidas12: 2 });
  });

  it("excluida y luego restaurada: la versión vigente manda (vuelve a ser aceptada)", async () => {
    const r = await historialDe(
      [{ periodo: p(2), versiones: [false, true, false] }],
      marcar([p(2)]),
    );
    expect(r.h).toMatchObject({ aceptadas6: 1, excluidas6: 0, excluidas12: 0 });
  });

  it("deshacer deja el puntero atrás: manda la versión a la que apunta, no la de mayor n", async () => {
    const r = await historialDe(
      [
        { periodo: p(2), versiones: [false, true], vigente: 1 },
        { periodo: p(3), versiones: [true, false], vigente: 1 },
      ],
      marcar([p(2), p(3)]),
    );
    expect(r.h).toMatchObject({ aceptadas6: 1, excluidas6: 1, excluidas12: 1 });
  });

  it("las compras descartadas quedan fuera, aceptadas o excluidas", async () => {
    const r = await historialDe(
      [
        { periodo: p(2), descartada: true },
        { periodo: p(3), versiones: [true], descartada: true },
        { periodo: p(4) },
      ],
      marcar([p(2), p(3), p(4)]),
    );
    expect(r.h).toMatchObject({ aceptadas6: 1, excluidas6: 0, excluidas12: 0 });
  });

  it("otro proveedor (mismo número con otro tipo de documento, o distinto número) no cuenta", async () => {
    const r = await historialDe(
      [
        { periodo: p(2), proveedor: { tipo: "1", numero: PROVEEDOR.numero } },
        { periodo: p(2), proveedor: { tipo: "6", numero: "20100000999" } },
        { periodo: p(2) },
      ],
      marcar([p(2)]),
    );
    expect(r.h.aceptadas6).toBe(1);
  });

  it("solo las compras del cliente evaluado: otro cliente del mismo estudio no suma", async () => {
    const otro = await h.A.nuevoCliente();
    await fijarEstadoPeriodo(h.admin, h.A, otro, p(2), "revisado");
    await sembrarCompra(h.admin, h.A, otro, { periodo: p(2) });
    await sembrarCompra(h.admin, h.A, otro, {
      periodo: p(2),
      versiones: [true],
    });
    const r = await historialDe([{ periodo: p(3) }], marcar([p(3)]));
    expect(r.h).toMatchObject({ aceptadas6: 1, excluidas6: 0 });
  });

  it("el estado del periodo es el del cliente evaluado: revisado en otro cliente no cuenta", async () => {
    const c = await h.A.nuevoCliente();
    const otro = await h.A.nuevoCliente();
    await fijarEstadoPeriodo(h.admin, h.A, otro, p(2), "revisado"); // el periodo del otro cliente
    await sembrarCompra(h.admin, h.A, c, { periodo: p(2) });
    expect((await leer(c)).historial[0]!.aceptadas6).toBe(0);
  });

  it("el otro estudio no cuenta aunque tenga el mismo RUC de proveedor (RLS)", async () => {
    const c = await h.A.nuevoCliente();
    const cb = await h.B.nuevoCliente();
    await fijarEstadoPeriodo(h.admin, h.B, cb, p(2), "revisado");
    await sembrarCompra(h.admin, h.B, cb, { periodo: p(2) });
    await sembrarCompra(h.admin, h.B, cb, { periodo: p(2), versiones: [true] });
    const ctx = await leer(c);
    expect(ctx.historial[0]).toEqual({
      proveedor: PROVEEDOR,
      aceptadas6: 0,
      excluidas6: 0,
      excluidas12: 0,
    });
  });

  it("proveedor sin compras: una entrada con ceros; repetidos se unen y se conserva el orden pedido", async () => {
    const a = { tipo: "6", numero: "20100000001" };
    const b = { tipo: "6", numero: "20100000002" };
    const c = await h.A.nuevoCliente();
    await fijarEstadoPeriodo(h.admin, h.A, c, p(2), "revisado");
    await sembrarCompra(h.admin, h.A, c, { periodo: p(2), proveedor: b });
    const ctx = await leer(c, [b, a, b]);
    expect(ctx.historial).toEqual([
      { proveedor: b, aceptadas6: 1, excluidas6: 0, excluidas12: 0 },
      { proveedor: a, aceptadas6: 0, excluidas6: 0, excluidas12: 0 },
    ]);
  });

  it("caso de CA-2: 3 compras revisadas en M-6..M-1 y ninguna excluida; con una excluida o 2 compras, distinto", async () => {
    const ok = await historialDe(
      [{ periodo: p(1) }, { periodo: p(3) }, { periodo: p(6) }],
      marcar([p(1), p(3), p(6)]),
    );
    expect(ok.h).toMatchObject({ aceptadas6: 3, excluidas6: 0 });
    const conExcluida = await historialDe(
      [
        { periodo: p(1) },
        { periodo: p(3) },
        { periodo: p(6) },
        { periodo: p(5), versiones: [true] },
      ],
      marcar([p(1), p(3), p(6), p(5)]),
    );
    expect(conExcluida.h).toMatchObject({ aceptadas6: 3, excluidas6: 1 });
    const abiertas = await historialDe(
      [{ periodo: p(1) }, { periodo: p(3) }, { periodo: p(6) }],
      marcar([p(1), p(3), p(6)], "abierto"),
    );
    expect(abiertas.h.aceptadas6).toBe(0);
  });
});

// ---- Oráculo en memoria -----------------------------------------------------------------------------------------------------
/** PRNG determinista (mulberry32): la misma semilla, el mismo escenario. */
function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const indice = (periodo: string): number =>
  Number(periodo.slice(0, 4)) * 12 + Number(periodo.slice(4)) - 1;

interface CompraEscenario {
  periodo: string;
  proveedor: number;
  versiones: boolean[];
  vigente: number;
  descartada: boolean;
}

function oraculo(
  compras: readonly CompraEscenario[],
  estados: ReadonlyMap<string, Estado>,
  periodo: string,
  proveedor: number,
) {
  const m = indice(periodo);
  const r = { aceptadas6: 0, excluidas6: 0, excluidas12: 0 };
  for (const c of compras) {
    if (c.descartada || c.proveedor !== proveedor) continue;
    const d = m - indice(c.periodo); // meses antes de M
    if (d < 1 || d > 12) continue;
    const excluida = c.versiones[c.vigente - 1]!;
    if (excluida) {
      r.excluidas12++;
      if (d <= 6) r.excluidas6++;
    } else if (d <= 6) {
      const st = estados.get(c.periodo);
      if (st === "revisado" || st === "generado") r.aceptadas6++;
    }
  }
  return r;
}

describe("historial contra un oráculo en memoria (escenario aleatorio determinista)", () => {
  it.each([1, 2, 3])(
    "semilla %i: coincide para varios periodos evaluados",
    async (semilla) => {
      const azar = prng(semilla * 7919);
      const entero = (n: number) => Math.floor(azar() * n);
      const base = "202607";
      const proveedores = [0, 1, 2, 3, 4, 5].map((i) => ({
        tipo: "6",
        numero: `2010007${String(i).padStart(4, "0")}`,
      }));
      const c = await h.A.nuevoCliente();
      const estados = new Map<string, Estado>();
      for (let k = -2; k <= 15; k++) {
        const periodo = restar(base, k);
        const st = ["ninguno", "abierto", "revisado", "generado"][entero(4)]!;
        if (st !== "ninguno") {
          estados.set(periodo, st as Estado);
          await fijarEstadoPeriodo(h.admin, h.A, c, periodo, st as Estado);
        }
      }
      const compras: CompraEscenario[] = [];
      for (let i = 0; i < 90; i++) {
        const versiones = Array.from(
          { length: 1 + entero(3) },
          () => azar() < 0.3,
        );
        compras.push({
          periodo: restar(base, entero(18) - 2),
          proveedor: entero(proveedores.length),
          versiones,
          vigente: 1 + entero(versiones.length),
          descartada: azar() < 0.1,
        });
      }
      for (const x of compras)
        await sembrarCompra(h.admin, h.A, c, {
          periodo: x.periodo,
          proveedor: proveedores[x.proveedor]!,
          versiones: x.versiones,
          vigente: x.vigente,
          descartada: x.descartada,
        });
      for (const periodo of [
        base,
        restar(base, 2),
        restar(base, -1),
        "202603",
      ]) {
        const ctx = await leer(c, proveedores, periodo);
        expect(ctx.historial).toEqual(
          proveedores.map((proveedor, i) => ({
            proveedor,
            ...oraculo(compras, estados, periodo, i),
          })),
        );
      }
    },
    120_000,
  );
});

// ---- Consultas y rendimiento --------------------------------------------------------------------------------------------------
describe("consultas y rendimiento (R-10, CA-15)", () => {
  it("en <= 4 consultas aunque se pidan varios proveedores", async () => {
    const c = await h.A.nuevoCliente();
    const provs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
      tipo: "6",
      numero: `2010008${String(i).padStart(4, "0")}`,
    }));
    await fijarEstadoPeriodo(h.admin, h.A, c, restar(M, 2), "revisado");
    for (const proveedor of provs)
      await sembrarCompra(h.admin, h.A, c, {
        periodo: restar(M, 2),
        proveedor,
      });
    await sembrarCiiu(h.admin, h.A, provs[0]!.numero, "4771");
    const { consultas, ctx } = await h.comoDueno(async (tx) => {
      const espia = espiar(tx);
      const ctx = await leerContextoGastos(espia.tx, {
        clienteId: c.id,
        periodo: M,
        proveedores: provs,
      });
      return { ctx, consultas: espia.consultas() };
    });
    expect(ctx.historial).toHaveLength(8);
    expect(consultas).toBeGreaterThanOrEqual(1);
    expect(consultas).toBeLessThanOrEqual(4);
  });

  it("5.000 compras de historial en < 150 ms, con el resultado exacto del oráculo", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    const N = 5000;
    const NP = 50;
    // Compra g: proveedor g % 50, periodo M-(1 + g % 12), excluida si g % 7 = 0; el periodo M-k está `revisado` (k % 3 = 1),
    // `generado` (k % 3 = 2) o `abierto` (k % 3 = 0).
    await h.admin.query(
      `insert into compra_periodo (tenant_id, cliente_id, periodo, estado)
       select $1::uuid, $2::uuid, to_char(to_date($3 || '01', 'YYYYMMDD') - (k || ' month')::interval, 'YYYYMM'),
         case k % 3 when 1 then 'revisado' when 2 then 'generado' else 'abierto' end
       from generate_series(1, 12) k`,
      [e.tenantId, c.id, M],
    );
    await h.admin.query(
      `with filas as materialized (
         select g, gen_random_uuid() as id, 1 + (g % 12) as k, '20' || lpad((g % $5::int)::text, 9, '0') as ruc
         from generate_series(1, $4::int) g
       ), c as (
         insert into compra (id, tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
           razon_social, fecha, moneda, origen, version_vigente)
         select id, $1::uuid, $2::uuid, to_char(to_date($3 || '01', 'YYYYMMDD') - (k || ' month')::interval, 'YYYYMM'),
           null, 'perf-' || g, '01', 'F001', g::text, '6', ruc, 'PROVEEDOR SINTETICO SAC', date '2026-01-15', 'PEN', 'agregada', 1
         from filas
         returning id
       )
       insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper,
         otros_tributos, total, excluida, motivo, clasificada, accion)
       select $1::uuid, id, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, g % 7 = 0, case when g % 7 = 0 then 'Prueba' end, false, 'agregada'
       from filas`,
      [e.tenantId, c.id, M, N, NP],
    );
    await h.admin.query("analyze compra");
    await h.admin.query("analyze compra_version");
    await h.admin.query("analyze compra_periodo");

    const pedidos = Array.from({ length: 20 }, (_, i) => ({
      tipo: "6",
      numero: `20${String(i * 2).padStart(9, "0")}`,
    }));
    const esperado = pedidos.map((proveedor, i) => {
      const p = i * 2;
      let aceptadas6 = 0;
      let excluidas6 = 0;
      let excluidas12 = 0;
      for (let g = 1; g <= N; g++) {
        if (g % NP !== p) continue;
        const k = 1 + (g % 12);
        if (g % 7 === 0) {
          excluidas12++;
          if (k <= 6) excluidas6++;
        } else if (k <= 6 && k % 3 !== 0) aceptadas6++;
      }
      return { proveedor, aceptadas6, excluidas6, excluidas12 };
    });

    const tiempos: number[] = [];
    let ultimo = null as Awaited<ReturnType<typeof leer>> | null;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      ultimo = await leer(c, pedidos, M, e);
      tiempos.push(performance.now() - t0);
    }
    expect(ultimo!.historial).toEqual(esperado);
    // el primero calienta el pool y el plan; el criterio es el régimen estable
    expect(Math.min(...tiempos.slice(1))).toBeLessThan(150);
  }, 120_000);
});

// ---- Glosas de la compra --------------------------------------------------------------------------------------------------------
describe("leerGlosasCompra (R-7, D-2)", () => {
  const leerGlosas = (id: string, e = h.A) =>
    h.comoDueno((tx) => leerGlosasCompra(tx, id), e);

  it("devuelve las descripciones de los ítems del XML vigente, en orden", async () => {
    const c = await h.A.nuevoCliente();
    const compra = await sembrarCompra(h.admin, h.A, c, {
      periodo: M,
      serie: "F001",
      numero: "5070",
    });
    await sembrarXml(h.admin, h.A, c, compra, [
      "ZAPATILLA URBANA T42",
      "BOLSA PLASTICA",
      "AUDIFONOS BLUETOOTH JBL X2 UND 2.00",
    ]);
    expect(await leerGlosas(compra.id)).toEqual([
      "ZAPATILLA URBANA T42",
      "BOLSA PLASTICA",
      "AUDIFONOS BLUETOOTH JBL X2 UND 2.00",
    ]);
  });

  it("con varias versiones del XML manda la de mayor n", async () => {
    const c = await h.A.nuevoCliente();
    const compra = await sembrarCompra(h.admin, h.A, c, { periodo: M });
    await sembrarXml(h.admin, h.A, c, compra, ["GLOSA SIMULADA"], { n: 1 });
    await sembrarXml(
      h.admin,
      h.A,
      c,
      compra,
      ["GLOSA SUBIDA 1", "GLOSA SUBIDA 2"],
      { n: 2, origen: "subido" },
    );
    expect(await leerGlosas(compra.id)).toEqual([
      "GLOSA SUBIDA 1",
      "GLOSA SUBIDA 2",
    ]);
  });

  it("el XML es del comprobante de ESE proveedor: el de otro RUC con la misma serie y número no cuenta", async () => {
    const c = await h.A.nuevoCliente();
    const compra = await sembrarCompra(h.admin, h.A, c, {
      periodo: M,
      serie: "F001",
      numero: "6001",
    });
    const otra = await sembrarCompra(h.admin, h.A, c, {
      periodo: M,
      serie: "F001",
      numero: "6001",
      proveedor: { tipo: "6", numero: "20100000777" },
    });
    await sembrarXml(h.admin, h.A, c, otra, ["GLOSA DEL OTRO PROVEEDOR"]);
    expect(await leerGlosas(compra.id)).toBeNull();
    expect(await leerGlosas(otra.id)).toEqual(["GLOSA DEL OTRO PROVEEDOR"]);
  });

  it("null sin XML, con id inexistente, mal formado o de otro estudio", async () => {
    const c = await h.A.nuevoCliente();
    const sinXml = await sembrarCompra(h.admin, h.A, c, { periodo: M });
    expect(await leerGlosas(sinXml.id)).toBeNull();
    expect(await leerGlosas(randomUUID())).toBeNull();
    expect(await leerGlosas("no-es-un-uuid")).toBeNull();
    const cb = await h.B.nuevoCliente();
    const deB = await sembrarCompra(h.admin, h.B, cb, { periodo: M });
    await sembrarXml(h.admin, h.B, cb, deB, ["GLOSA DE B"]);
    expect(await leerGlosas(deB.id, h.A)).toBeNull();
    expect(await leerGlosas(deB.id, h.B)).toEqual(["GLOSA DE B"]);
  });
});

describe("el worker lee el mismo contexto (D-5)", () => {
  it("leerContextoGastos con el worker (sin usuario) da lo mismo que con el backend", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await fijarConfig(h.admin, e, 5, 2);
    await sembrarPropia(h.admin, e, {
      palabra: palabraUnica(),
      categoria: "juguetes",
    });
    await fijarEstadoPeriodo(h.admin, e, c, restar(M, 2), "revisado");
    await sembrarCompra(h.admin, e, c, { periodo: restar(M, 2) });
    const args = { clienteId: c.id, periodo: M, proveedores: [PROVEEDOR] };
    const w = await h.comoWorker((tx) => leerContextoGastos(tx, args), e);
    const b = await h.comoDueno((tx) => leerContextoGastos(tx, args), e);
    expect(w).toEqual(b);
    expect(w.umbral).toBe(5);
    expect(w.historial[0]!.aceptadas6).toBe(1);
  });
});

pruebasTraduccion([
  [
    "leerContextoGastos",
    (tx) =>
      leerContextoGastos(tx, {
        clienteId: randomUUID(),
        periodo: M,
        proveedores: [PROVEEDOR],
      }),
  ],
  ["leerGlosasCompra", (tx) => leerGlosasCompra(tx, randomUUID())],
]);
