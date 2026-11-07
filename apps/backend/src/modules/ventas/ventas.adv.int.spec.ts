/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 T17 · ronda adversarial (integración, PostgreSQL real) de las rutas de correlatividad (justificar, revertir,
// agregar) y de la importación (D6, D7, D8, D9, D10, D16). Caja negra con el contrato de las rutas; caja blanca sobre
// `ventas.service.ts` (comentario libre, justificaciones simultáneas) e `importar-propuesta.service.ts` (tope de
// vivas sin contar lo agregado a mano, `NODE_ENV` comparado con una sola cadena).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  csvVentas,
  cuerpoVenta,
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
  vi.unstubAllEnvs();
  await v?.cerrar();
});

const nuevo = () => v.cliente(E, { responsable: contador.id });
const conBoletas = async (numeros: number[] = [290, 292]) => {
  const c = await nuevo();
  await v.sembrarVentas(
    E.tenantId,
    c.id,
    numeros.map((n) => fila("B001", n)),
    { usuarioId: E.titular.id },
  );
  return c;
};
const justificar = (clienteId: string, cuerpo: unknown) =>
  v.llamar(contador, "POST", `${base(clienteId)}/saltos-justificados`, cuerpo);
const revertir = (clienteId: string, id: string) =>
  v.llamar(contador, "DELETE", `${base(clienteId)}/saltos-justificados/${id}`);
const agregar = (clienteId: string, cuerpo: unknown) =>
  v.llamar(contador, "POST", base(clienteId), cuerpo);
const confirmar = (clienteId: string, bytes: Uint8Array) =>
  v.bin(contador, "POST", `${base(clienteId)}/importar/confirmar`, bytes);
const salto = (o: Record<string, unknown> = {}) => ({
  tipo: "03",
  serie: "B001",
  desde: 291,
  hasta: 291,
  comentario: "Boleta anulada",
  ...o,
});

describe("T17 · justificar, revertir y agregar (D8, D9)", () => {
  it("adv-r1: un comentario con un carácter NUL (U+0000) es 400, no un 500 de PostgreSQL", async () => {
    const c = await conBoletas();
    const r = await justificar(c.id, salto({ comentario: "anulada\u0000por error" }));
    expect(r.status, r.text).toBe(400);
    expect(await v.saltos(c.id)).toHaveLength(0);
  });

  it("adv-r2: desde > hasta, un rango que se sale del faltante por un borde, otra serie o un tipo distinto: 400 y nada escrito", async () => {
    const c = await conBoletas([290, 292, 296]); // faltantes 291 y 293-295
    for (const cuerpo of [
      salto({ desde: 295, hasta: 293 }),
      salto({ desde: 290, hasta: 291 }), // 290 está presente
      salto({ desde: 291, hasta: 293 }), // une dos faltantes por encima de la 292 presente
      salto({ desde: 293, hasta: 296 }),
      salto({ serie: "B002" }),
      salto({ tipo: "01" }),
      salto({ desde: 0, hasta: 0 }),
      salto({ desde: 291, hasta: 100_000_000 }),
    ]) {
      const r = await justificar(c.id, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
    }
    expect(await v.saltos(c.id)).toHaveLength(0);
  });

  it("adv-r3: revertir una justificación de OTRO cliente del mismo estudio por la ruta de este es 404 y no la toca; revertir dos veces, 404", async () => {
    const a = await conBoletas();
    const b = await conBoletas();
    const jB = await justificar(b.id, salto());
    expect(jB.status, jB.text).toBe(201);
    const cruzada = await revertir(a.id, jB.body.id);
    expect(cruzada.status).toBe(404);
    expect((await v.saltos(b.id)).filter((s: any) => s.revertido_en === null)).toHaveLength(1);

    expect((await revertir(b.id, jB.body.id)).status).toBe(204);
    expect((await revertir(b.id, jB.body.id)).status).toBe(404);
  });

  it("adv-r4: cinco justificaciones iguales a la vez (10 rondas): todas 201 con el mismo id, sin 500, y una sola vigente", async () => {
    for (let i = 0; i < 10; i++) {
      const c = await conBoletas();
      const rs = await Promise.all(Array.from({ length: 5 }, () => justificar(c.id, salto())));
      expect(rs.map((r) => r.status), `ronda ${i}`).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(rs.map((r) => r.body.id)).size, `ronda ${i}`).toBe(1);
      expect((await v.saltos(c.id)).filter((s: any) => s.revertido_en === null), `ronda ${i}`).toHaveLength(1);
    }
  });
});

describe("T17 · importación: tope de vivas y entorno (D6, D10, D16)", () => {
  it("adv-i1: 20.000 del SIRE + 1 agregada a mano: importar una fila IGUAL a una existente (0 nuevas) se acepta", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 20_000, { usuarioId: E.titular.id });
    const ra = await agregar(c.id, cuerpoVenta("M001", 1));
    if (ra.status === 201) {
      // Agregar no tiene tope (D9): el periodo queda con 20.001 vivas por una vía legítima.
      const r = await confirmar(c.id, csvVentas([fila("S001", 1)]));
      expect(r.status, `repetir lo ya cargado (0 nuevas) no excede nada: ${r.texto}`).toBe(201);
      expect(r.json.propuesta).toMatchObject({ filasRecibidas: 1, filasNuevas: 0, filasIguales: 1 });
    } else {
      expect(ra.status).toBe(422); // si agregar respetara el tope, el periodo nunca pasaría de 20.000
    }
  });

  it("adv-i2: el layout provisional solo importa en desarrollo o pruebas: NODE_ENV ausente, «prod», «Production» o « production» dan 422", async () => {
    const c = await nuevo();
    const bytes = csvVentas([fila("B001", 290)]);
    const pasaron: string[] = [];
    for (const valor of [undefined, "prod", "Production", "PRODUCTION", " production", "staging"]) {
      vi.stubEnv("NODE_ENV", valor);
      try {
        const r = await confirmar(c.id, bytes);
        if (r.status !== 422 || r.json?.codigo !== "layout_no_oficial") pasaron.push(`${String(valor)}=${r.status}`);
      } finally {
        vi.unstubAllEnvs();
      }
    }
    expect(pasaron, "entornos que no son desarrollo ni pruebas y aun así importaron con el layout provisional").toEqual([]);
  });
});
