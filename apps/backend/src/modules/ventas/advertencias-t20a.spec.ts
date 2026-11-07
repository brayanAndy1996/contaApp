// Spec 013 · T20a (rojo), decisión D22 del usuario (2026-11-07, defecto D-2 de T20): la vista previa de la importación
// marca con una ADVERTENCIA que no bloquea las filas legibles pero descuadradas (`descuadre`) y las de USD sin tipo de
// cambio (`tipo_cambio_requerido`). Son advertencias aparte de los errores: la fila sigue siendo `valida`, sus `motivos`
// quedan vacíos y suma en `validas`; `conAdvertencia` cuenta las filas con alguna. Una fila con error no se evalúa
// (sin advertencias). Orden fijo de las advertencias: `descuadre`, luego `tipo_cambio_requerido`. La respuesta nunca lleva
// el monto ni el contenido de la celda. Sin BD; el guardado «tal cual» al confirmar lo cubre
// `importacion-advertencias-t20a.int.spec.ts`.
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  clienteVisible: vi.fn(async () => true),
  leerClienteDto: vi.fn(async () => ({ archivado: false })),
}));

import type { Alcance } from "@contapp/db";
import { MOTIVOS_ADVERTENCIA_VENTA, vistaPreviaVentasSchema } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ImportarPropuestaService } from "./importar-propuesta.service.js";

const sesion = { tenantActivo: "t-1", usuarioId: "u-1" } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const CABECERA =
  "tipo,serie,numero,tipoDocContraparte,docContraparte,fechaEmision,moneda,tipoCambio,baseGravada,igv,exonerada,inafecta,isc,icbper,otros,total";
const BUENA = ["03", "B001", "290", "", "-", "2026-10-03", "PEN", "", "100.00", "18.00", "0", "0", "0", "0", "0", "118.00"];

const csv = (...filas: string[][]) => new TextEncoder().encode([CABECERA, ...filas.map((f) => f.join(","))].join("\r\n") + "\r\n");
const con = (cambios: Record<string, string>, numero?: string): string[] => {
  const f = [...BUENA];
  for (const [campo, valor] of Object.entries(cambios)) f[CABECERA.split(",").indexOf(campo)] = valor;
  if (numero !== undefined) f[2] = numero;
  return f;
};
const previa = (cuerpo: Uint8Array) =>
  new ImportarPropuestaService({
    withTenant: (_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
  } as never).vistaPrevia(sesion, alcance, "c-1", "202610", cuerpo);

describe("D22 · advertencias de la vista previa", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "test"));
  afterEach(() => vi.unstubAllEnvs());

  it("una fila que cuadra no trae advertencias y `conAdvertencia` es 0", async () => {
    const r = await previa(csv(BUENA));
    expect(r.filas).toEqual([{ n: 2, estado: "valida", motivos: [], advertencias: [] }]);
    expect(r).toMatchObject({ validas: 1, conError: 0, conAdvertencia: 0 });
  });

  it("descuadrada (118.00 → 999.00): válida, sin motivos y con la advertencia `descuadre`", async () => {
    const r = await previa(csv(con({ total: "999.00" })));
    expect(r.filas).toEqual([{ n: 2, estado: "valida", motivos: [], advertencias: ["descuadre"] }]);
    expect(r).toMatchObject({ validas: 1, conError: 0, conAdvertencia: 1 });
  });

  it("un céntimo de diferencia también descuadra (tolerancia 0.00, D9)", async () => {
    const r = await previa(csv(con({ total: "118.01" }), con({ total: "117.99" }, "291")));
    expect(r.filas.map((f) => f.advertencias)).toEqual([["descuadre"], ["descuadre"]]);
  });

  it("USD sin tipo de cambio: válida con `tipo_cambio_requerido`; con tipo de cambio, sin advertencia", async () => {
    const r = await previa(
      csv(
        con({ moneda: "USD", tipo: "01", serie: "F002" }, "1"),
        con({ moneda: "USD", tipo: "01", serie: "F002", tipoCambio: "3.3" }, "2"),
      ),
    );
    expect(r.filas.map((f) => [f.estado, f.motivos, f.advertencias])).toEqual([
      ["valida", [], ["tipo_cambio_requerido"]],
      ["valida", [], []],
    ]);
    expect(r).toMatchObject({ validas: 2, conError: 0, conAdvertencia: 1 });
  });

  it("descuadrada y en USD sin tipo de cambio a la vez: las dos advertencias, en orden fijo", async () => {
    const r = await previa(csv(con({ moneda: "USD", tipo: "01", serie: "F002", total: "999.00" }, "1")));
    expect(r.filas[0]).toEqual({
      n: 2,
      estado: "valida",
      motivos: [],
      advertencias: ["descuadre", "tipo_cambio_requerido"],
    });
    expect(r.conAdvertencia).toBe(1); // cuenta filas, no advertencias
  });

  it("una fila con error no se evalúa: sin advertencias aunque además esté descuadrada", async () => {
    const r = await previa(csv(con({ fechaEmision: "2026-02-30", total: "999.00" })));
    expect(r.filas).toEqual([{ n: 2, estado: "error", motivos: ["fecha_invalida"], advertencias: [] }]);
    expect(r).toMatchObject({ validas: 0, conError: 1, conAdvertencia: 0 });
  });

  it("una celda peligrosa tampoco lleva advertencias", async () => {
    const r = await previa(csv(con({ docContraparte: '"=1+1"', total: "999.00" })));
    expect(r.filas).toEqual([{ n: 2, estado: "error", motivos: ["celda_peligrosa"], advertencias: [] }]);
  });

  it("mezcla: los contadores separan válidas, con advertencia y con error", async () => {
    const r = await previa(
      csv(
        BUENA,
        con({ total: "999.00" }, "291"),
        con({ moneda: "USD", tipo: "01", serie: "F002" }, "1"),
        con({ fechaEmision: "x" }, "292"),
      ),
    );
    expect(r.filas.map((f) => f.estado)).toEqual(["valida", "valida", "valida", "error"]);
    expect(r).toMatchObject({ validas: 3, conError: 1, conAdvertencia: 2 });
  });

  it("los motivos de error nunca incluyen `descuadre` ni `tipo_cambio_requerido`: viven solo en `advertencias`", async () => {
    const r = await previa(
      csv(con({ total: "999.00" }), con({ moneda: "USD", tipo: "01", serie: "F002" }, "1"), con({ baseGravada: "x", igv: "abc" }, "2")),
    );
    for (const f of r.filas) for (const m of f.motivos) expect(MOTIVOS_ADVERTENCIA_VENTA as readonly string[]).not.toContain(m);
    for (const f of r.filas) for (const a of f.advertencias) expect(MOTIVOS_ADVERTENCIA_VENTA as readonly string[]).toContain(a);
  });

  it("la respuesta cumple el esquema de shared y no filtra montos ni contenido de celdas", async () => {
    const r = await previa(csv(con({ total: "999.00", docContraparte: "CANARIOIMPT20A" })));
    expect(vistaPreviaVentasSchema.safeParse(r).success).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["conAdvertencia", "conError", "filas", "validas"]);
    expect(Object.keys(r.filas[0]!).sort()).toEqual(["advertencias", "estado", "motivos", "n"]);
    expect(JSON.stringify(r)).not.toMatch(/999|118|CANARIOIMPT20A/);
  });
});
