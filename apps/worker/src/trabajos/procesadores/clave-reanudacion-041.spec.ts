// Spec 041 · T4 (rojo): los procesadores pasan `claveReanudacion = "{tenantId}:{clienteId}"` al puerto SIRE (plan, «Archivos del worker»; CA-8).
//
// CONTRATO que fija (T7): `descargarPropuesta` (libros ventas y compras) e `importarHistorial` (registro presentado) llaman a
// `sireApi.descargarPropuesta` / `descargarRegistroPresentado` con la solicitud habitual MÁS `claveReanudacion: "${tenantId}:${clienteId}"`
// del trabajo en curso. La clave es opaca para el puerto, nunca contiene el RUC, el token ni credenciales, y no sale a SUNAT (T6).
import type { SireApiClient } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import type { ContextoProcesador } from "../ejecutor.js";
import { descargarPropuesta } from "./descargar-propuesta.js";
import { importarHistorial } from "./importar-historial.js";
import type { PersistidorLibro } from "../persistidores/tipos.js";

const T = "0194a1b2-0000-7000-8000-0000000000a1";
const C = "0194a1b2-0000-7000-8000-0000000000c1";
const RUC = "20700000002";
const IMPORTACION = "0194a1b2-0000-7000-8000-000000000001";

const conToken = <T2>(usar: (t: string) => Promise<T2>) => usar("tok");

const trabajo = (
  tipo: string,
  parametros: unknown,
): ContextoProcesador["trabajo"] => ({
  id: "j-1",
  tenantId: T,
  clienteId: C,
  ruc: RUC,
  tipo,
  parametros,
  intentos: 0,
  creadoPor: "u-1",
});

describe("claveReanudacion · descargarPropuesta", () => {
  const tx = {
    query: async (texto: string) =>
      texto.includes("insert into propuesta ")
        ? { rows: [{ id: "p-1" }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
  };
  const db = {
    withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx),
  } as never;
  const vacio: PersistidorLibro = {
    preparar: () => [],
    leerExistentes: async () => [],
    insertar: async () => undefined,
  };

  it.each(["ventas", "compras"] as const)(
    "libro %s: la solicitud lleva ruc, periodo, libro y claveReanudacion del estudio y el cliente",
    async (libro) => {
      const solicitudes: unknown[] = [];
      const sireApi = {
        descargarPropuesta: async (_t: unknown, s: unknown) => {
          solicitudes.push(s);
          return { libro, periodo: "202610", filas: [] } as never;
        },
        descargarRegistroPresentado: async () => {
          throw new Error("no se usa");
        },
      } as SireApiClient;
      await descargarPropuesta({
        db,
        sireApi,
        persistidores: { ventas: vacio, compras: vacio },
      })({
        trabajo: trabajo("sire.propuesta.descargar", {
          periodo: "202610",
          libro,
        }),
        conToken,
      });
      expect(solicitudes).toEqual([
        { ruc: RUC, periodo: "202610", libro, claveReanudacion: `${T}:${C}` },
      ]);
    },
  );
});

describe("claveReanudacion · importarHistorial (registro presentado)", () => {
  const fila = {
    id: IMPORTACION,
    cliente_id: C,
    estado: "en_curso",
    periodos: ["202610", "202609"],
    ruc: RUC,
  };
  const tx = {
    query: async (texto: string) => {
      if (texto.includes("reglas_importacion_completar"))
        return { rows: [{ n: 0 }], rowCount: 1 };
      if (texto.includes("reglas_importacion_fallar"))
        return { rows: [{}], rowCount: 1 };
      return { rows: [fila], rowCount: 1 };
    },
  };
  const db = {
    withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx),
  } as never;
  const config = {
    obtener: async () => new Map([["sire", { reintentos: 3 }]]) as never,
  };

  it("cada periodo se pide con la misma claveReanudacion del estudio y el cliente", async () => {
    const solicitudes: Array<{ periodo: string }> = [];
    const sireApi = {
      descargarPropuesta: async () => {
        throw new Error("no se usa");
      },
      descargarRegistroPresentado: async (
        _t: unknown,
        s: { periodo: string },
      ) => {
        solicitudes.push(s);
        return { libro: "compras", periodo: s.periodo, filas: [] } as never;
      },
    } as SireApiClient;
    await importarHistorial({ db, sireApi, config })({
      trabajo: trabajo("reglas.historial.importar", {
        importacionId: IMPORTACION,
      }),
      conToken,
    });
    expect(solicitudes.map((s) => s.periodo)).toEqual(["202610", "202609"]);
    for (const s of solicitudes)
      expect(s).toEqual({
        ruc: RUC,
        periodo: s.periodo,
        claveReanudacion: `${T}:${C}`,
      });
  });
});
