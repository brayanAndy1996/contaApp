// Spec 026 (T6, rojo): rendimiento de la pantalla de prorrata (CA-11, RNF-034).
// Un cliente con los 12 meses de la ventana de M = 202610 SOLO en el SIRE, cada uno con 5.000 ventas (60.000 en total), y M con 5.000
// compras DG, sembrados con SQL masivo como `contapp_migrator` y con `ANALYZE` (así el plan ve estadísticas reales).
//  - 30 lecturas de `GET /clientes/:clienteId/prorrata?periodo=202610` con p95 < 300 ms (la lectura agrega las ventas en SQL: 12 periodos
//    × 5.000 filas no viajan fila a fila; las compras de M salen del resumen de 014). Como en `bandeja.rendimiento.int.spec.ts`, el tiempo no
//    se evalúa bajo cobertura (DT-1); la parte funcional corre siempre.
//  - La cifra es la correcta: 12 meses SIRE de 500.000,00 de gravadas -> coeficiente 100.00 «provisional»; IGV de ventas 90.000,00 − crédito DG
//    90.000,00 = 0.00 («cero»).
// Rojo: la ruta aún no existe (T12): responde 404 de ruta inexistente. La siembra de ventas y compras no depende de las tablas de T10.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BAJO_COBERTURA } from "../../../test/tiempos.js";
import {
  abrirBancoProrrata,
  ventanaHasta,
  M,
  p95,
  rutaVista,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const N_VENTAS = 5000;
const N_COMPRAS = 5000;
const MUESTRAS = 30;
const LIMITE_MS = 300;

let v: BancoProrrata;
let E: Estudio;
let contador: Actor;
let cliente: { id: string; ruc: string };

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  cliente = await v.cliente(E, { responsable: contador.id });
  // Una serie distinta por periodo: la clave de una venta es tipo|serie|número y no depende del periodo en todas las unicidades.
  for (const [i, periodo] of ventanaHasta(M).entries()) {
    await v.sembrarMuchas(E.tenantId, cliente.id, N_VENTAS, { usuarioId: E.titular.id, periodo, serie: `S${String(i + 1).padStart(3, "0")}` });
  }
  await v.sembrarVolumen(E.tenantId, cliente.id, N_COMPRAS, { usuarioId: E.titular.id, periodo: M });
  await v.b.sql("ANALYZE venta");
  await v.b.sql("ANALYZE compra");
  await v.b.sql("ANALYZE compra_version");
});
afterAll(async () => {
  await v?.cerrar();
});

describe("CA-11 · la pantalla con 12 meses SIRE de 5.000 ventas y M con 5.000 compras", () => {
  it("responde con la cifra correcta: 12 meses SIRE, coeficiente 100.00 provisional e IGV estimado «cero»", async () => {
    const r = await v.http(contador, "GET", rutaVista(cliente.id, M));
    expect(r.status, r.text).toBe(200);
    expect(r.body.ventana).toHaveLength(12);
    for (const m of r.body.ventana) {
      expect(m, m.periodo).toMatchObject({
        origen: "sire",
        gravadas: "500000.00", // 5.000 ventas de 100.00 de base gravada
        exportaciones: "0.00",
        noGravadas: "0.00",
        total: "500000.00",
        sireCargado: true,
      });
      expect(m.avisos).toEqual(["sire_sin_exportaciones"]);
    }
    expect(r.body.coeficiente).toEqual({ estado: "calculado", porcentaje: "100.00", numerador: "6000000.00", total: "6000000.00", provisional: true, avisos: [] });
    expect(r.body.igvEstimado).toEqual({
      estado: "calculado",
      igvVentas: "90000.00", // 5.000 × 18.00
      creditoDg: "90000.00", // 5.000 compras de 18.00 de IGV en DG
      igvDgng: "0.00",
      creditoDgng: "0.00",
      igvDng: "0.00",
      resultado: "0.00",
      situacion: "cero",
      estadoPeriodoCompras: "abierto",
    });
  });

  it(`${MUESTRAS} lecturas con p95 < ${LIMITE_MS} ms`, async () => {
    await v.http(contador, "GET", rutaVista(cliente.id, M)); // calentamiento: plan y caché de la BD
    const ms: number[] = [];
    for (let i = 0; i < MUESTRAS; i++) {
      const r = await v.http(contador, "GET", rutaVista(cliente.id, M));
      expect(r.status, r.text).toBe(200);
      ms.push(r.ms);
    }
    const p = p95(ms);
    if (!BAJO_COBERTURA) expect(p, `p95 = ${Math.round(p)} ms con ${ms.map((x) => Math.round(x)).join(", ")}`).toBeLessThan(LIMITE_MS);
  });

  it("las lecturas simultáneas no se degradan: 10 en paralelo, todas 200 con la misma cifra", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => v.http(contador, "GET", rutaVista(cliente.id, M))));
    for (const r of rs) {
      expect(r.status, r.text).toBe(200);
      expect(r.body.coeficiente.porcentaje).toBe("100.00");
    }
    if (!BAJO_COBERTURA) expect(Math.max(...rs.map((r) => r.ms))).toBeLessThan(5000);
  });
});
