// Spec 012b · T18 (rojo): corrección de H-012b-2 (ronda adversarial 1). Datos reales cuyo impacto total en IGV no cabe en
// NUMERIC(14,2): cada venta cabe y cuadra al 18 %, pero la suma no. El resumen de ventas de 013 ya responde 422
// `resumen_fuera_de_rango` con esos datos; el previo y el `POST` de generar responden lo mismo (como el resumen de 014), nunca un
// 500 `error_interno`, y no encolan nada ni cambian el estado del periodo.
//  - Hoy (rojo): el dominio (`prevalidacion/resumen.ts`, `sumaEnRango`) lanza `EntradaPrevalidacionInvalidaError` (D22 de 012, que
//    sus pruebas fijan), que no es un `DineroError`; `calcularPrevio` (archivos/previo.ts) solo traduce `DineroError` y el resto
//    sale como 500.
// Datos reales en la BD: nada de mocks de `MontoFueraDeRangoError`. La parte del worker está en
// `apps/worker/src/trabajos/procesadores/generar-archivo-r1.int.spec.ts`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, rutaArchivos, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base, boletas290y292, fila, type FilaV } from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
});

const HUELLA = "0".repeat(64);
const IGV_ENORME = "144000000000.00"; // 18 % de 800 000 000 000.00 (la base más grande que deja el total dentro del rango)

/** 7 ventas válidas (cada una cabe en NUMERIC(14,2) y cuadra): Σ IGV = 1 008 000 000 000.00, fuera de rango. */
const desbordan = (extra: Partial<FilaV> = {}): FilaV[] =>
  Array.from({ length: 7 }, (_, i) =>
    fila("M001", i + 1, { baseGravada: "800000000000.00", igv: IGV_ENORME, total: "944000000000.00", ...extra }),
  );

async function sinEfectos(clienteId: string): Promise<void> {
  expect(await A.trabajosArchivo(clienteId)).toEqual([]);
  expect(await A.versionesBd(clienteId)).toEqual([]);
  expect(await A.periodoVentas(clienteId)).toBeNull();
}

describe("H-012b-2 · un impacto en IGV que no cabe en NUMERIC(14,2) es un 422 resumen_fuera_de_rango, nunca un 500", () => {
  it("ventas con Σ IGV fuera de rango: el previo (GET) responde 422 { codigo: resumen_fuera_de_rango }, igual que el resumen de 013", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarVentas(E.tenantId, c.id, desbordan(), { usuarioId: E.titular.id, origen: "manual" });

    const resumen = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect([resumen.status, resumen.body]).toEqual([422, { codigo: "resumen_fuera_de_rango" }]); // control: 013

    const previo = await v.llamar(contador, "GET", `${rutaArchivos(c.id, PERIODO, "ventas")}/previo`);
    expect([previo.status, previo.body], previo.text).toEqual([422, { codigo: "resumen_fuera_de_rango" }]);
    await sinEfectos(c.id);
  });

  it("ventas con Σ IGV fuera de rango: generar (POST) responde 422 antes de comparar la huella y no encola nada", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarVentas(E.tenantId, c.id, desbordan(), { usuarioId: E.titular.id, origen: "manual" });

    for (const huella of [HUELLA, "f".repeat(64)]) {
      const r = await v.llamar(contador, "POST", rutaArchivos(c.id, PERIODO, "ventas"), { estadoVisto: "abierto", huella });
      expect([r.status, r.body], r.text).toEqual([422, { codigo: "resumen_fuera_de_rango" }]);
    }
    await sinEfectos(c.id);
  });

  it("la suma negativa también (notas de crédito): 422 resumen_fuera_de_rango en el previo", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const notas = desbordan({ tipo: "07" }).map((f) => ({
      ...f,
      baseGravada: `-${f.baseGravada}`,
      igv: `-${f.igv}`,
      total: `-${f.total}`,
    }));
    await v.sembrarVentas(E.tenantId, c.id, notas, { usuarioId: E.titular.id, origen: "manual" });

    const previo = await v.llamar(contador, "GET", `${rutaArchivos(c.id, PERIODO, "ventas")}/previo`);
    expect([previo.status, previo.body], previo.text).toEqual([422, { codigo: "resumen_fuera_de_rango" }]);
    await sinEfectos(c.id);
  });

  it("control: una nota de crédito con montos negativos normales no es un desborde: 200", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [fila("NC01", 1, { tipo: "07", baseGravada: "-100.00", igv: "-18.00", total: "-118.00" })],
      { usuarioId: E.titular.id, origen: "manual" },
    );
    const previo = await v.llamar(contador, "GET", `${rutaArchivos(c.id, PERIODO, "ventas")}/previo`);
    expect(previo.status, previo.text).toBe(200);
  });

  it("control: un periodo normal sigue respondiendo 200 y los montos grandes que sí caben no se confunden con el desborde", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    // 6 ventas de IGV 144 000 000 000.00: Σ = 864 000 000 000.00, dentro de NUMERIC(14,2).
    await v.sembrarVentas(E.tenantId, c.id, [...desbordan().slice(0, 6), ...boletas290y292()], {
      usuarioId: E.titular.id,
      origen: "manual",
    });
    const previo = await v.llamar(contador, "GET", `${rutaArchivos(c.id, PERIODO, "ventas")}/previo`);
    expect(previo.status, previo.text).toBe(200);
  });
});
