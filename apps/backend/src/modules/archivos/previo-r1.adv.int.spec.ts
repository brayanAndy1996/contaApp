// Spec 012b · T17 ronda adversarial 1 (adversario). Montos fuera de NUMERIC(14,2) en el previo (pista de T16a).
//  - H-012b-2 (caja blanca): cada venta cabe en NUMERIC(14,2) y cuadra al 18 %, pero la suma del impacto en IGV no cabe. El
//    dominio (`resumen.ts`, `sumaEnRango`) convierte el desborde en `EntradaPrevalidacionInvalidaError`, que NO es un `DineroError`:
//    `calcularPrevio` solo traduce `DineroError` a 422 `resumen_fuera_de_rango` y deja pasar el resto como 500 `error_interno`.
//    El resumen de ventas de 013 (RF-056), con los mismos datos, responde 422 `resumen_fuera_de_rango`: ese es el contrato de la casa.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, rutaArchivos, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base, fila } from "../../../test/soporte-ventas.js";

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

describe("H-012b-2 · un impacto en IGV que no cabe en NUMERIC(14,2) es un error controlado, nunca un 500", () => {
  it("7 ventas agregadas válidas (IGV 144 000 000 000.00 c/u): previo y POST responden 422 resumen_fuera_de_rango", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    // Cada venta: base 800 000 000 000.00 + IGV 18 % = 944 000 000 000.00 (cabe y cuadra). Σ IGV = 1 008 000 000 000.00 (no cabe).
    const grandes = Array.from({ length: 7 }, (_, i) =>
      fila("M001", i + 1, { baseGravada: "800000000000.00", igv: "144000000000.00", total: "944000000000.00" }),
    );
    await v.sembrarVentas(E.tenantId, c.id, grandes, { usuarioId: E.titular.id, origen: "manual" });

    // Control: el resumen de ventas (013) con los mismos datos ya responde el error controlado.
    const resumen = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect(resumen.status, resumen.text).toBe(422);
    expect(resumen.body).toEqual({ codigo: "resumen_fuera_de_rango" });

    const previo = await v.llamar(contador, "GET", `${rutaArchivos(c.id, PERIODO, "ventas")}/previo`);
    const generar = await v.llamar(contador, "POST", rutaArchivos(c.id, PERIODO, "ventas"), {
      estadoVisto: "abierto",
      huella: "0".repeat(64),
    });
    expect({ previo: [previo.status, previo.body], generar: [generar.status, generar.body] }).toEqual({
      previo: [422, { codigo: "resumen_fuera_de_rango" }],
      generar: [422, { codigo: "resumen_fuera_de_rango" }],
    });
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
  });
});
