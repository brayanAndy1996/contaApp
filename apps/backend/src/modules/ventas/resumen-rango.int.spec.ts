// Spec 013 (T13): una suma del resumen que excede NUMERIC(14,2) (`MontoFueraDeRangoError` de `Money`) es el 422
// `resumen_fuera_de_rango` con cuerpo `{ codigo }`, no un 500; el resto de rutas del periodo siguen respondiendo.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  fila,
  type Actor,
  type BancoVentas,
  type Estudio,
} from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

describe("resumen con sumas fuera de rango", () => {
  it("dos ventas de 999999999999.99 suman más que NUMERIC(14,2): 422 resumen_fuera_de_rango y nada más en el cuerpo", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const enorme = (n: number) =>
      fila("M001", n, {
        tipo: "01",
        baseGravada: "999999999999.99",
        igv: "0.00",
        total: "999999999999.99",
      });
    await v.sembrarVentas(E.tenantId, c.id, [enorme(1), enorme(2)], {
      usuarioId: E.titular.id,
    });
    const r = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "resumen_fuera_de_rango" });
    // La grilla y la correlatividad del mismo periodo no dependen del resumen.
    expect((await v.llamar(contador, "GET", base(c.id))).status).toBe(200);
    expect(
      (await v.llamar(contador, "GET", `${base(c.id)}/correlatividad`)).status,
    ).toBe(200);
  });

  it("con una sola de esas ventas el resumen sí responde (el borde de NUMERIC(14,2) es válido)", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [
        fila("M001", 1, {
          tipo: "01",
          baseGravada: "999999999999.99",
          igv: "0.00",
          total: "999999999999.99",
        }),
      ],
      { usuarioId: E.titular.id },
    );
    const r = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.total).toMatchObject({
      cantidad: 1,
      total: "999999999999.99",
    });
  });
});
