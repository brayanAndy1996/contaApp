// Spec 026 (T4, rojo): totales de ventas del SIRE por periodo para la prorrata (R-2, R-5, R-7; CA-3, CA-5, CA-11). Contra la BD real
// con el backend, más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA.
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/prorrata/ventas.ts`):
//   leerTotalesVentasProrrata(tx, clienteId, periodos) -> TotalesVentasPeriodo[]   UNA entrada por periodo pedido, en el MISMO orden
//       y con la misma longitud que `periodos` (los no cargados también salen). Las filas que cuentan son EXACTAMENTE las que
//       suma el resumen de 013 (`leerFilasVentas` sin las de exclusión vigente; una exclusión restaurada vuelve a sumar), de
//       cualquier origen (sire o manual).
//       - `cargado`: hay una propuesta de ventas del periodo (descarga o importación del SIRE) o filas; un periodo sin propuesta ni
//         filas es `false`; uno con propuesta y 0 filas es `true` («SIRE en 0», R-5).
//       - `pen`: sumas EXACTAS en SQL (NUMERIC) de base_gravada, igv, exonerada e inafecta de las filas PEN, como cadenas con 2
//         decimales («0.00» si no hay filas); notas de crédito (negativas) restan; isc, icbper, otros y total no entran.
//       - `usd`: UNA entrada por fila USD (no se suman: el dominio convierte fila a fila como `resumirVentas`), con su tipo de cambio
//         «3.750» o null si la fila no lo trae. El orden de `usd` no importa.
//   ProrrataRepoError { codigo }: de todo error de `pg` solo se conserva el SQLSTATE o "desconocido".
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leerFilasVentas } from "../ventas/lectura";
import type { Tx } from "../with-tenant";
import { leerTotalesVentasProrrata } from "./index";
import {
  abrirArnes,
  aCentimos,
  deCentimos,
  oraculoPen,
  oraculoUsd,
  porClaveUsd,
  pruebasTraduccion,
  sembrarVentas,
  sembrarVolumen,
  ventana,
  type Arnes,
  type ClienteSembrado,
  type FilaSembrada,
  type FilaVentaSembrada,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const totales = (c: ClienteSembrado, periodos: string[], e = h.A) =>
  h.comoDueno((tx) => leerTotalesVentasProrrata(tx, c.id, periodos), e);

const pen = (
  baseGravada: string,
  igv: string,
  exonerada = "0.00",
  inafecta = "0.00",
): FilaVentaSembrada => ({
  baseGravada,
  igv,
  exonerada,
  inafecta,
});
const usd = (
  baseGravada: string,
  igv: string,
  tipoCambio: string | null,
  exonerada = "0.00",
  inafecta = "0.00",
): FilaVentaSembrada => ({
  moneda: "USD",
  tipoCambio,
  baseGravada,
  igv,
  exonerada,
  inafecta,
});

const CERO = {
  baseGravada: "0.00",
  igv: "0.00",
  exonerada: "0.00",
  inafecta: "0.00",
};

describe("cargado y periodos vacíos (R-5)", () => {
  it("sin periodo de ventas (ni propuesta ni filas): cargado false, ceros y sin USD", async () => {
    const c = await h.A.nuevoCliente();
    const [t] = await totales(c, ["202610"]);
    expect(t).toEqual({
      periodo: "202610",
      cargado: false,
      pen: CERO,
      usd: [],
    });
  });

  it("periodo cargado sin filas (propuesta de 0 filas): cargado true y ceros", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202610", []);
    const [t] = await totales(c, ["202610"]);
    expect(t).toEqual({ periodo: "202610", cargado: true, pen: CERO, usd: [] });
  });

  it("periodo cargado con filas: cargado true", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202610", [pen("100.00", "18.00")]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.cargado).toBe(true);
  });

  it("devuelve una entrada por periodo pedido, en el orden pedido, mezclando cargados y no cargados", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202608", [pen("80.00", "14.40")]);
    await sembrarVentas(h.admin, h.A, c, "202610", []);
    const r = await totales(c, ["202610", "202609", "202608"]);
    expect(r.map((t) => [t.periodo, t.cargado])).toEqual([
      ["202610", true],
      ["202609", false],
      ["202608", true],
    ]);
    expect(r[2]!.pen.baseGravada).toBe("80.00");
    expect(await totales(c, [])).toEqual([]);
  });

  it("no mezcla clientes, periodos ni estudios", async () => {
    const c1 = await h.A.nuevoCliente();
    const c2 = await h.A.nuevoCliente();
    const cb = await h.B.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c1, "202610", [pen("100.00", "18.00")]);
    await sembrarVentas(h.admin, h.A, c1, "202609", [pen("900.00", "162.00")]);
    await sembrarVentas(h.admin, h.B, cb, "202610", [pen("777.00", "139.86")]);
    const [t2] = await totales(c2, ["202610"]);
    expect(t2).toEqual({
      periodo: "202610",
      cargado: false,
      pen: CERO,
      usd: [],
    });
    const [tb] = await totales(cb, ["202610"]); // el cliente de B visto desde A
    expect(tb).toEqual({
      periodo: "202610",
      cargado: false,
      pen: CERO,
      usd: [],
    });
    const [t1] = await totales(c1, ["202610"]);
    expect(t1!.pen.baseGravada).toBe("100.00");
    const [tbB] = await totales(cb, ["202610"], h.B);
    expect(tbB!.pen.baseGravada).toBe("777.00");
    const [inex] = await h.comoDueno((tx) =>
      leerTotalesVentasProrrata(tx, randomUUID(), ["202610"]),
    );
    expect(inex!.cargado).toBe(false);
  });
});

describe("sumas PEN exactas contra un oráculo en memoria (R-2, R-7)", () => {
  it("suma base gravada, IGV, exonerada e inafecta y no cuenta isc, icbper, otros ni total", async () => {
    const c = await h.A.nuevoCliente();
    const filas = await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("1000.10", "180.02", "50.05", "10.00"),
      pen("2000.20", "360.04", "0.00", "0.00"),
      pen("0.00", "0.00", "300.00", "700.70"),
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.pen).toEqual({
      baseGravada: "3000.30",
      igv: "540.06",
      exonerada: "350.05",
      inafecta: "710.70",
    });
    expect(t!.pen).toEqual(oraculoPen(filas));
    expect(Object.keys(t!.pen).sort()).toEqual([
      "baseGravada",
      "exonerada",
      "igv",
      "inafecta",
    ]);
  });

  it("las notas de crédito (montos negativos) restan, y un periodo puede dar total negativo", async () => {
    const c = await h.A.nuevoCliente();
    const filas = await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("1000.00", "180.00"),
      { tipo: "07", ...pen("-1500.00", "-270.00", "-20.00", "-5.00") },
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.pen).toEqual({
      baseGravada: "-500.00",
      igv: "-90.00",
      exonerada: "-20.00",
      inafecta: "-5.00",
    });
    expect(t!.pen).toEqual(oraculoPen(filas));
  });

  it("sumas de 12 dígitos exactas, sin pasar por number (0.1 + 0.2 y montos que number no representa)", async () => {
    const c = await h.A.nuevoCliente();
    const filas = await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("999999999999.99", "0.10"),
      pen("999999999999.99", "0.20"),
      pen("999999999999.99", "0.01"),
      pen("0.01", "0.00"),
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.pen.baseGravada).toBe("2999999999999.98");
    expect(t!.pen.igv).toBe("0.31");
    expect(t!.pen).toEqual(oraculoPen(filas));
    for (const v of Object.values(t!.pen)) expect(typeof v).toBe("string");
  });

  it("incluye las filas de origen manual del periodo (las mismas que suma el resumen de 013)", async () => {
    const c = await h.A.nuevoCliente();
    const filas = await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("100.00", "18.00"),
      { origen: "manual", ...pen("55.50", "9.99") },
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.pen.baseGravada).toBe("155.50");
    expect(t!.pen).toEqual(oraculoPen(filas));
  });

  it("propiedad: 24 periodos aleatorios (semilla fija) coinciden con el oráculo de céntimos BigInt", async () => {
    const c = await h.A.nuevoCliente();
    let semilla = 12345;
    const azar = (n: number): number => {
      semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
      return semilla % n;
    };
    const monto = (): string => deCentimos(BigInt(azar(2_000_000) - 400_000));
    const periodos = ventana("203012").concat(ventana("202912")).slice(0, 24);
    const esperados = new Map<string, FilaSembrada[]>();
    for (const p of periodos) {
      const n = azar(8);
      const filas: FilaVentaSembrada[] = Array.from({ length: n }, () =>
        pen(monto(), monto(), monto(), monto()),
      );
      esperados.set(p, await sembrarVentas(h.admin, h.A, c, p, filas));
    }
    const r = await totales(c, periodos);
    for (const t of r)
      expect(t.pen).toEqual(oraculoPen(esperados.get(t.periodo)!));
    expect(aCentimos("-1234.56")).toBe(-123456n); // sanidad del oráculo
  });
});

describe("mismas filas que leerFilasVentas: exclusiones (R-7, CA-5)", () => {
  it("las ventas excluidas no suman; una exclusión restaurada vuelve a sumar", async () => {
    const c = await h.A.nuevoCliente();
    const filas = await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("100.00", "18.00"),
      { exclusion: "excluida", ...pen("1000.00", "180.00") },
      { exclusion: "restaurada", ...pen("10.00", "1.80") },
      { exclusion: "excluida", ...usd("500.00", "90.00", "3.750") },
      { exclusion: "restaurada", ...usd("7.00", "1.26", "3.800") },
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.pen).toEqual({
      baseGravada: "110.00",
      igv: "19.80",
      exonerada: "0.00",
      inafecta: "0.00",
    });
    expect(t!.pen).toEqual(oraculoPen(filas));
    expect([...t!.usd].sort(porClaveUsd)).toEqual(oraculoUsd(filas));
    expect(t!.usd).toHaveLength(1);
  });

  it("las filas que cuentan son exactamente las de leerFilasVentas sin exclusión vigente", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("100.25", "18.05"),
      { exclusion: "excluida", ...pen("999.00", "179.82") },
      { exclusion: "restaurada", ...pen("12.34", "2.22") },
      { origen: "manual", ...pen("7.00", "1.26") },
      { tipo: "07", ...pen("-30.00", "-5.40") },
      usd("200.00", "36.00", "3.745", "10.00", "5.00"),
      usd("1.00", "0.18", null),
      { exclusion: "excluida", ...usd("2.00", "0.36", "3.700") },
    ]);
    const [t] = await totales(c, ["202610"]);
    const de013 = (
      await h.comoDueno((tx) => leerFilasVentas(tx, c.id, "202610"))
    ).filter((f) => f.exclusion === null);
    const suma = (
      col: "baseGravada" | "igv" | "exonerada" | "inafecta",
    ): string =>
      deCentimos(
        de013
          .filter((f) => f.moneda === "PEN")
          .reduce((s, f) => s + aCentimos(f[col]), 0n),
      );
    expect(t!.pen).toEqual({
      baseGravada: suma("baseGravada"),
      igv: suma("igv"),
      exonerada: suma("exonerada"),
      inafecta: suma("inafecta"),
    });
    const usdDe013 = de013
      .filter((f) => f.moneda === "USD")
      .map((f) => ({
        baseGravada: f.baseGravada,
        igv: f.igv,
        exonerada: f.exonerada,
        inafecta: f.inafecta,
        tipoCambio: f.tipoCambio,
      }))
      .sort(porClaveUsd);
    expect([...t!.usd].sort(porClaveUsd)).toEqual(usdDe013);
  });

  it("un periodo con todas las ventas excluidas sigue cargado y suma cero", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202610", [
      { exclusion: "excluida", ...pen("100.00", "18.00") },
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t).toEqual({ periodo: "202610", cargado: true, pen: CERO, usd: [] });
  });
});

describe("filas USD: una por fila con su tipo de cambio (R-2)", () => {
  it("las USD no se suman a las PEN y salen una por una con su tipo de cambio", async () => {
    const c = await h.A.nuevoCliente();
    const filas = await sembrarVentas(h.admin, h.A, c, "202610", [
      pen("100.00", "18.00"),
      usd("1000.00", "180.00", "3.750", "20.00", "5.00"),
      usd("333.33", "60.00", "3.812"),
      usd("1000.00", "180.00", "3.750", "20.00", "5.00"), // igual a la primera: son dos filas
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.pen.baseGravada).toBe("100.00");
    expect(t!.usd).toHaveLength(3);
    expect([...t!.usd].sort(porClaveUsd)).toEqual(oraculoUsd(filas));
    for (const f of t!.usd) {
      expect(typeof f.baseGravada).toBe("string");
      expect(f.tipoCambio === null || /^\d+\.\d{3}$/.test(f.tipoCambio)).toBe(
        true,
      );
    }
  });

  it("una USD sin tipo de cambio sale con tipoCambio null (el dominio la deja fuera con aviso)", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202610", [
      usd("50.00", "9.00", null),
    ]);
    const [t] = await totales(c, ["202610"]);
    expect(t!.usd).toEqual([
      {
        baseGravada: "50.00",
        igv: "9.00",
        exonerada: "0.00",
        inafecta: "0.00",
        tipoCambio: null,
      },
    ]);
    expect(t!.pen).toEqual(CERO);
  });

  it("las USD de cada periodo salen en su periodo", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarVentas(h.admin, h.A, c, "202609", [
      usd("10.00", "1.80", "3.700"),
    ]);
    await sembrarVentas(h.admin, h.A, c, "202610", [
      usd("20.00", "3.60", "3.800"),
      usd("30.00", "5.40", "3.900"),
    ]);
    const r = await totales(c, ["202609", "202610"]);
    expect(r[0]!.usd).toHaveLength(1);
    expect(r[1]!.usd).toHaveLength(2);
  });
});

describe("rendimiento (CA-11)", () => {
  it("12 periodos × 5.000 ventas: menos de 150 ms y sin recorrido secuencial de `venta`", async () => {
    const c = await h.A.nuevoCliente();
    const periodos = ventana("202610");
    for (const p of periodos) await sembrarVolumen(h.admin, h.A, c, p, 5000);
    await h.admin.query("analyze venta");

    // Una venta con los mismos datos que `sembrarVolumen` calcula: por periodo, 5.000 filas PEN/USD (una USD cada 50 = 100).
    const medir = async (): Promise<number> => {
      const t0 = performance.now();
      const r = await totales(c, periodos);
      const ms = performance.now() - t0;
      expect(r).toHaveLength(12);
      for (const t of r) {
        expect(t.cargado).toBe(true);
        expect(t.usd).toHaveLength(100);
        expect(aCentimos(t.pen.baseGravada)).toBeGreaterThan(0n);
      }
      return ms;
    };
    await medir(); // calienta el pool y los planes
    const tiempos = [await medir(), await medir(), await medir()];
    expect(Math.min(...tiempos)).toBeLessThan(150);

    // EXPLAIN de cada consulta que lee `venta`: con el seqscan descartado, la consulta debe poder resolverse por índice
    // (los de 0030 y 0039 cubren cliente y periodo); un Seq Scan sobre `venta` aun así delata que no hay camino por índice.
    const sentencias: Array<{ texto: string; valores: unknown[] }> = [];
    await h.backend.withTenant(
      { tenantId: h.A.tenantId, userId: h.A.dueno.id },
      async (tx: Tx) => {
        const espia = {
          query: (texto: string, valores?: unknown[]) => {
            sentencias.push({ texto, valores: valores ?? [] });
            return tx.query(texto, valores);
          },
        };
        await leerTotalesVentasProrrata(espia as never, c.id, periodos);
        await tx.query("set local enable_seqscan = off");
        const sobreVenta = sentencias.filter((s) => /\bventa\b/.test(s.texto));
        expect(sobreVenta.length).toBeGreaterThan(0);
        for (const s of sobreVenta) {
          // Solo en la prueba: el texto es el SQL estático del propio repositorio precedido de EXPLAIN.
          const explicar = ["explain (format json)", s.texto].join(" ");
          // eslint-disable-next-line sql-crudo/sin-sql-crudo -- EXPLAIN del SQL estático del repositorio, solo en la prueba
          const plan = await tx.query(explicar, s.valores);
          const nodos = JSON.stringify(plan.rows[0]);
          const recorridos = [
            ...nodos.matchAll(
              /"Node Type":"Seq Scan"[^{}]*?"Relation Name":"venta"/g,
            ),
          ];
          expect(
            recorridos,
            `Seq Scan sobre venta en: ${s.texto}`,
          ).toHaveLength(0);
        }
      },
    );
  }, 180_000);
});

const CLIENTE = "01990000-0000-7000-8000-000000000001";
pruebasTraduccion([
  [
    "leerTotalesVentasProrrata",
    (tx) => leerTotalesVentasProrrata(tx, CLIENTE, ["202610"]),
  ],
]);
