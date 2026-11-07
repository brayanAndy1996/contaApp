/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 · T20a (rojo), decisión D22 del usuario (2026-11-07, defecto D-2 de T20). Contrato HTTP de las advertencias de
// la importación (RF-051; D3, D6, D11):
//  - POST …/importar/vista-previa -> 200 con, por fila, `advertencias` (`descuadre`, `tipo_cambio_requerido`; lista
//    cerrada de `shared`) y, en total, `conAdvertencia`. Una fila legible descuadrada o en USD sin tipo de cambio es
//    `valida`, con `motivos: []`; `validas` la incluye y `conError` no. No escribe nada.
//  - POST …/importar/confirmar acepta esas filas (no es `filas_con_errores`): crea la propuesta `importacion` y las guarda
//    TAL CUAL llegaron (total descuadrado sin corregir, USD con `tipo_cambio` nulo). La advertencia no cambia el todo o
//    nada de D3: una fila con ERROR sigue rechazando el archivo entero, aunque haya otras con advertencia.
//  - Lo guardado se trata como siempre: el resumen deja la USD sin tipo de cambio fuera de la suma (D11).
import { vistaPreviaVentasSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  csvVentas,
  fila,
  xlsxVentas,
  type Actor,
  type BancoVentas,
  type Estudio,
  type FilaV,
} from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

const nuevo = () => v.cliente(E, { responsable: contador.id });
const ruta = (clienteId: string, paso: "vista-previa" | "confirmar") =>
  `${base(clienteId)}/importar/${paso}`;
const FORMATOS: Array<[string, (f: FilaV[]) => Uint8Array]> = [
  ["csv", (f) => csvVentas(f)],
  ["xlsx", (f) => xlsxVentas(f)],
];
const porN = (filas: any[]) => Object.fromEntries(filas.map((f) => [f.n, f]));

/** B001-290 cuadra; B001-291 trae total 999.00 (descuadra); F002-1 es USD sin tipo de cambio; F002-2 es USD con él. */
const filasMixtas = (): FilaV[] => [
  fila("B001", 290),
  fila("B001", 291, { total: "999.00" }),
  fila("F002", 1, { tipo: "01", moneda: "USD" }),
  fila("F002", 2, { tipo: "01", moneda: "USD", tipoCambio: "3.300" }),
];

describe("vista previa con advertencias (D22)", () => {
  it.each(FORMATOS)(
    "%s: las filas descuadradas y las USD sin tipo de cambio son válidas con su advertencia; se cuentan aparte; no escribe nada",
    async (_f, armar) => {
      const c = await nuevo();
      const r = await v.bin(contador, "POST", ruta(c.id, "vista-previa"), armar(filasMixtas()));
      expect(r.status, r.texto).toBe(200);
      expect(vistaPreviaVentasSchema.safeParse(r.json).success).toBe(true);
      expect(r.json).toMatchObject({ validas: 4, conError: 0, conAdvertencia: 2 });
      const f = porN(r.json.filas);
      expect(f[2]).toEqual({ n: 2, estado: "valida", motivos: [], advertencias: [] });
      expect(f[3]).toEqual({ n: 3, estado: "valida", motivos: [], advertencias: ["descuadre"] });
      expect(f[4]).toEqual({ n: 4, estado: "valida", motivos: [], advertencias: ["tipo_cambio_requerido"] });
      expect(f[5]).toEqual({ n: 5, estado: "valida", motivos: [], advertencias: [] });
      // Ni el monto descuadrado ni el esperado salen en la respuesta.
      expect(r.texto).not.toMatch(/999\.00|118\.00/);
      expect(await v.conteo(c.id)).toEqual({ propuestas: 0, ventas: 0, diferencias: 0, saltos: 0 });
    },
  );

  it("una fila con error no lleva advertencias (vista previa)", async () => {
    const c = await nuevo();
    const bytes = csvVentas([
      fila("B001", 290, { total: "999.00", fechaEmision: "2026-02-30" }),
      fila("B001", 291, { total: "999.00" }),
    ]);
    const r = await v.bin(contador, "POST", ruta(c.id, "vista-previa"), bytes);
    expect(r.status, r.texto).toBe(200);
    const f = porN(r.json.filas);
    expect(f[2]).toEqual({ n: 2, estado: "error", motivos: ["fecha_invalida"], advertencias: [] });
    expect(f[3]).toMatchObject({ estado: "valida", advertencias: ["descuadre"] });
    expect(r.json).toMatchObject({ validas: 1, conError: 1, conAdvertencia: 1 });
  });
});

describe("confirmar con advertencias: se guarda tal cual (D3, D22)", () => {
  it.each(FORMATOS)(
    "%s: 201, la propuesta de importación y las cuatro filas tal como llegaron (sin corregir el total ni inventar el tipo de cambio)",
    async (_f, armar) => {
      const c = await nuevo();
      const r = await v.bin(contador, "POST", ruta(c.id, "confirmar"), armar(filasMixtas()));
      expect(r.status, r.texto).toBe(201);
      expect(r.json.propuesta).toMatchObject({
        fuente: "importacion",
        filasRecibidas: 4,
        filasNuevas: 4,
        filasIguales: 0,
        filasDistintas: 0,
      });
      const ventas = await v.ventas(c.id);
      expect(ventas).toHaveLength(4);
      expect(ventas.find((x) => x.clave === "03|B001|291")).toMatchObject({
        total: "999.00",
        base_gravada: "100.00",
        igv: "18.00",
        moneda: "PEN",
      });
      expect(ventas.find((x) => x.clave === "01|F002|1")).toMatchObject({ moneda: "USD", tipo_cambio: null });
      expect(ventas.find((x) => x.clave === "01|F002|2")).toMatchObject({ moneda: "USD", tipo_cambio: "3.300" });
    },
  );

  it("el resumen deja la USD sin tipo de cambio fuera de la suma y la avisa (D11); la descuadrada suma como llegó", async () => {
    const c = await nuevo();
    const ok = await v.bin(contador, "POST", ruta(c.id, "confirmar"), csvVentas(filasMixtas()));
    expect(ok.status, ok.texto).toBe(201);
    const res = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.avisos).toContain("usd_sin_tipo_cambio");
    expect(res.body.sinConvertir).toEqual([{ clave: "01|F002|1", moneda: "USD" }]);
    const t03 = res.body.porTipo.find((x: any) => x.tipo === "03");
    expect(t03).toMatchObject({ cantidad: 2, total: "1117.00" }); // 118.00 + 999.00, sin corregir
  });

  it("todo o nada: un error en otra fila sigue rechazando el archivo aunque haya filas con advertencia", async () => {
    const c = await nuevo();
    const bytes = csvVentas([
      fila("B001", 290, { total: "999.00" }),
      fila("B001", 291, { fechaEmision: "2026-02-30" }),
    ]);
    const r = await v.bin(contador, "POST", ruta(c.id, "confirmar"), bytes);
    expect([400, 422], r.texto).toContain(r.status);
    expect(await v.conteo(c.id)).toEqual({ propuestas: 0, ventas: 0, diferencias: 0, saltos: 0 });
  });

  it("repetir la importación de las mismas filas con advertencia da 0 nuevas (D16)", async () => {
    const c = await nuevo();
    const bytes = csvVentas(filasMixtas());
    expect((await v.bin(contador, "POST", ruta(c.id, "confirmar"), bytes)).status).toBe(201);
    const otra = await v.bin(contador, "POST", ruta(c.id, "confirmar"), bytes);
    expect(otra.status, otra.texto).toBe(201);
    expect(otra.json.propuesta).toMatchObject({ filasRecibidas: 4, filasNuevas: 0, filasIguales: 4, filasDistintas: 0 });
    expect((await v.conteo(c.id)).ventas).toBe(4);
  });
});
