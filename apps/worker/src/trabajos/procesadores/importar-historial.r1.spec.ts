/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON de la BD falsa dinámicos en pruebas */
// Spec 025 · T16: correcciones de la ronda adversarial 1 en el procesador `reglas.historial.importar` (BD y puerto falsos), en rojo
// hasta T17.
//  - H-025-1-6: si no se leyó ningún periodo (todos `ErrorDatos`), la importación se cierra `fallida` con motivo `datos_invalidos` y
//    NO se llama a `completar` (así no reemplaza la revisión pendiente anterior). Esto sustituye lo que fijaba T11 («todos sin
//    datos: se completa con cero candidatas», `importar-historial.spec.ts`), que T17 debe retirar.
//  - H-025-1-7: un registro cuyo `periodo` no es el pedido se trata como «sin datos» de ese periodo: no cuenta como leído y sus filas
//    no llegan a las candidatas. (Con todos los periodos mal atribuidos no se lee ninguno: vale H-025-1-6.)
import { ErrorDatos, type FilaPropuestaSire, type SireApiClient } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import type { ContextoProcesador } from "../ejecutor.js";
import { importarHistorial } from "./importar-historial.js";

const IMPORTACION = "0194a1b2-0000-7000-8000-0000000000b1";
const CLIENTE = "0194a1b2-0000-7000-8000-0000000000b2";
const RUC = "20700000002";
const PERIODOS = ["202610", "202609", "202608"];
const BUENO = "20100070970";
const AJENO = "20100017491";

const trabajo = (): ContextoProcesador["trabajo"] => ({
  id: "j-r1",
  tenantId: "t-r1",
  clienteId: CLIENTE,
  ruc: RUC,
  tipo: "reglas.historial.importar",
  parametros: { importacionId: IMPORTACION },
  intentos: 0,
  creadoPor: "u-r1",
});

function bd() {
  const completar: Array<{ resumen: Record<string, any>; candidatas: Array<Record<string, any>> }> = [];
  const fallar: string[] = [];
  const tx = {
    query: async (texto: string, valores: unknown[]) => {
      if (texto.includes("reglas_importacion_completar")) {
        completar.push({
          resumen: JSON.parse(String(valores[1])) as Record<string, any>,
          candidatas: JSON.parse(String(valores[2])) as Array<Record<string, any>>,
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

// T20 (H-025-2-1): cada periodo trae SUS dos comprobantes; con el mismo F001-1/F001-2 en todos, ahora contarían una vez.
const dos = (ruc: string, periodo: string): FilaPropuestaSire[] => [fila(ruc, `${periodo}-1`), fila(ruc, `${periodo}-2`)];

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

describe("T16 · H-025-1-6: ningún periodo leído", () => {
  it("todos los periodos «sin datos»: la importación queda fallida con datos_invalidos y no se llama a completar", async () => {
    const b = bd();
    await correr(b, puerto(() => new ErrorDatos())).catch(() => undefined);
    expect(b.fallar, "cierre fallido con el motivo de datos").toEqual(["datos_invalidos"]);
    expect(b.completar, "ninguna importación vacía llega a completar (no reemplaza la revisión anterior)").toEqual([]);
  });

  it("control: con al menos un periodo leído se completa (los demás «sin datos») y no se falla", async () => {
    const b = bd();
    await correr(b, puerto((p) => (p === "202610" ? { libro: "compras", periodo: p, filas: dos(BUENO, p) } : new ErrorDatos())));
    expect(b.fallar).toEqual([]);
    expect(b.completar).toHaveLength(1);
    expect(b.completar[0]!.resumen).toMatchObject({ periodos_leidos: 1, periodos_sin_datos: ["202609", "202608"] });
  });
});

describe("T16 · H-025-1-7: registro de otro periodo que el pedido", () => {
  it("el periodo mal atribuido queda «sin datos»: no se cuenta como leído y sus filas no llegan a las candidatas", async () => {
    const b = bd();
    // 202609 contesta con un registro de 202610 (y de otro proveedor); 202610 y 202608 contestan lo suyo.
    const api = puerto((p) =>
      p === "202609" ? { libro: "compras", periodo: "202610", filas: dos(AJENO, p) } : { libro: "compras", periodo: p, filas: dos(BUENO, p) },
    );
    await correr(b, api);
    expect(b.completar).toHaveLength(1);
    const c = b.completar[0]!;
    expect(c.resumen).toMatchObject({ periodos_leidos: 2, periodos_sin_datos: ["202609"] });
    expect(c.candidatas.map((x) => x.doc_numero), "solo el proveedor de los periodos bien atribuidos").toEqual([BUENO]);
    expect(c.candidatas[0]).toMatchObject({ n_total: 4, periodos_con_proveedor: 2 });
  });

  it("control: periodos que coinciden con lo pedido se cuentan todos como leídos", async () => {
    const b = bd();
    await correr(b, puerto((p) => ({ libro: "compras", periodo: p, filas: dos(BUENO, p) })));
    expect(b.completar[0]!.resumen).toMatchObject({ periodos_leidos: 3, periodos_sin_datos: [] });
    expect(b.completar[0]!.candidatas[0]).toMatchObject({ doc_numero: BUENO, n_total: 6, periodos_con_proveedor: 3 });
  });
});
