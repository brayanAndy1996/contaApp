// Spec 025 · T15 (ronda adversarial 1): procesador `reglas.historial.importar` con la BD y el puerto falsos. Ataques: todos los
// periodos «sin datos» (la importación vacía reemplaza la revisión pendiente de la anterior) y un registro de OTRO periodo que el
// pedido (se cuenta como si fuera del pedido). Las que revelan un hallazgo quedan en rojo (H-025-1-n en tasks.md).
import { ErrorDatos, type FilaPropuestaSire, type SireApiClient } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import type { ContextoProcesador } from "../ejecutor.js";
import { importarHistorial } from "./importar-historial.js";

const IMPORTACION = "0194a1b2-0000-7000-8000-0000000000a1";
const CLIENTE = "0194a1b2-0000-7000-8000-0000000000a2";
const RUC = "20700000002";
const PERIODOS = ["202610", "202609", "202608"];

const trabajo = (): ContextoProcesador["trabajo"] => ({
  id: "j-adv",
  tenantId: "t-adv",
  clienteId: CLIENTE,
  ruc: RUC,
  tipo: "reglas.historial.importar",
  parametros: { importacionId: IMPORTACION },
  intentos: 0,
  creadoPor: "u-adv",
});

function bd() {
  const completar: Array<{ resumen: Record<string, unknown>; candidatas: unknown[] }> = [];
  const fallar: string[] = [];
  const tx = {
    query: async (texto: string, valores: unknown[]) => {
      if (texto.includes("reglas_importacion_completar")) {
        completar.push({
          resumen: JSON.parse(String(valores[1])) as Record<string, unknown>,
          candidatas: JSON.parse(String(valores[2])) as unknown[],
        });
        return { rows: [{ n: 0 }], rowCount: 1 };
      }
      if (texto.includes("reglas_importacion_fallar")) {
        fallar.push(String(valores[1]));
        return { rows: [{}], rowCount: 1 };
      }
      return {
        rows: [{ id: IMPORTACION, cliente_id: CLIENTE, estado: "en_curso", periodos: PERIODOS, ruc: RUC }],
        rowCount: 1,
      };
    },
  };
  return { db: { withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx) } as never, completar, fallar };
}

const fila = (ruc: string, numero: string): FilaPropuestaSire =>
  ({
    tipo: "01",
    serie: "F001",
    numero,
    rucContraparte: ruc,
    fechaEmision: "2026-08-15",
    moneda: "PEN",
    biDg: "100.00",
    igvDg: "18.00",
    biDgng: "0.00",
    igvDgng: "0.00",
    biDng: "0.00",
    igvDng: "0.00",
    noGravado: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otros: "0.00",
    total: "118.00",
  }) as FilaPropuestaSire;

function puerto(responder: (periodo: string) => unknown): SireApiClient {
  return {
    descargarPropuesta: async () => {
      throw new Error("no se usa");
    },
    descargarRegistroPresentado: async (_t: unknown, s: { periodo: string }) => {
      const r = responder(s.periodo);
      if (r instanceof Error) throw r;
      return r;
    },
  } as never;
}

const correr = (b: ReturnType<typeof bd>, api: SireApiClient) =>
  importarHistorial({
    db: b.db,
    sireApi: api,
    config: { obtener: async () => new Map([["sire", { reintentos: 3 }]]) as never },
  })({ trabajo: trabajo(), conToken: (usar) => usar("tok") });

describe("T15 · importarHistorial", () => {
  it("ADV-9 todos los periodos «sin datos»: no completa una importación vacía que reemplace la revisión pendiente anterior", async () => {
    const b = bd();
    const api = puerto(() => new ErrorDatos());
    await correr(b, api).catch(() => undefined);
    // `completar` con 0 periodos leídos pasa a «reemplazada» TODAS las pendientes del cliente (CA-5) sin haber leído nada: un SIRE
    // que responde «sin registro» a todo (o el centinela de datos) borra el trabajo de revisión del contador.
    const vacias = b.completar.filter((c) => c.resumen.periodos_leidos === 0);
    expect(vacias, "ninguna importación con 0 periodos leídos llega a completar").toEqual([]);
  });

  it("ADV-10 el registro devuelto es de OTRO periodo que el pedido: no se cuenta como del pedido", async () => {
    // Ajustada en T17 por decisión del orquestador sobre H-025-1-7: un registro de otro periodo que el pedido es «sin datos» de ese
    // periodo (no falla el trabajo entero). Antes exigía que el trabajo fallara y no escribiera nada; ahora, que lo mal atribuido no
    // se cuente como leído ni sus filas lleguen a las candidatas. Aquí solo 202610 coincide con lo pedido.
    const b = bd();
    // El puerto contesta siempre el registro de 202610, pida lo que pida (mismo libro): tres «periodos» con el mismo comprobante.
    const api = puerto(() => ({ libro: "compras", periodo: "202610", filas: [fila("20100070970", "1")] }));
    await correr(b, api);
    expect(b.completar).toHaveLength(1);
    const c = b.completar[0]!;
    expect(c.resumen, "los periodos mal atribuidos quedan «sin datos»").toMatchObject({
      periodos_leidos: 1,
      periodos_sin_datos: ["202609", "202608"],
    });
    const cands = c.candidatas as Array<{ n_total: number; periodos_con_proveedor: number }>;
    const comprobantes = cands.reduce((n, x) => n + x.n_total, 0);
    expect(comprobantes, "las filas de los periodos mal atribuidos no llegan a las candidatas").toBeLessThanOrEqual(1);
    for (const x of cands) expect(x.periodos_con_proveedor).toBeLessThanOrEqual(1);
  });
});
