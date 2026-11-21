// Spec 025 · T19 (correcciones de la ronda 2, rojo): H-025-2-1 en el procesador `reglas.historial.importar` (BD y puerto falsos).
// El worker pasa `serie` y `numero` del registro a `FilaHistorial` y la deducción cuenta cada comprobante una vez (ver el contrato
// en `packages/domain/src/reglas/correcciones-t19.spec.ts`: clave = proveedor + tipo + serie + número; con montos distintos cuenta
// la fila del periodo más reciente). Lo que se verifica es lo que se escribe en `reglas_importacion_completar`.
import { type FilaPropuestaSire, type SireApiClient } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import { importarHistorial } from "./importar-historial.js";

const IMPORTACION = "0194a1b2-0000-7000-8000-0000000000b1";
const CLIENTE = "0194a1b2-0000-7000-8000-0000000000b2";
const RUC = "20700000002";
const REINTENTOS = 3;

type Carga = Record<string, unknown>;

function bd(periodos: readonly string[]) {
  const completar: Array<{ resumen: Carga; candidatas: Carga[] }> = [];
  const fallar: string[] = [];
  const tx = {
    query: async (texto: string, valores: unknown[]) => {
      if (texto.includes("reglas_importacion_completar")) {
        completar.push({
          resumen: JSON.parse(String(valores[1])) as Carga,
          candidatas: JSON.parse(String(valores[2])) as Carga[],
        });
        return { rows: [{ n: 0 }], rowCount: 1 };
      }
      if (texto.includes("reglas_importacion_fallar")) {
        fallar.push(String(valores[1]));
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [{ id: IMPORTACION, cliente_id: CLIENTE, estado: "en_curso", periodos, ruc: RUC }], rowCount: 1 };
    },
  };
  return { db: { withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx) } as never, completar, fallar };
}

const CERO = "0.00";
function comprobante(o: { periodo: string; ruc: string; numero: string; serie?: string; biDg?: string; tipoDoc?: string; razon?: string; moneda?: "PEN" | "USD" }): FilaPropuestaSire {
  const biDg = o.biDg ?? "100.00";
  return {
    tipo: "01",
    serie: o.serie ?? "F001",
    numero: o.numero,
    rucContraparte: o.ruc,
    ...(o.tipoDoc === undefined ? {} : { tipoDocContraparte: o.tipoDoc }),
    ...(o.razon === undefined ? {} : { razonSocialContraparte: o.razon }),
    fechaEmision: `${o.periodo.slice(0, 4)}-${o.periodo.slice(4)}-15`,
    moneda: o.moneda ?? "PEN",
    ...(o.moneda === "USD" ? { tipoCambio: "3.712" } : {}),
    biDg,
    igvDg: CERO,
    biDgng: CERO,
    igvDgng: CERO,
    biDng: CERO,
    igvDng: CERO,
    noGravado: CERO,
    isc: CERO,
    icbper: CERO,
    otros: CERO,
    total: biDg,
  } as FilaPropuestaSire;
}

function puerto(responder: (periodo: string) => FilaPropuestaSire[] | Error): SireApiClient & { llamadas: string[] } {
  const llamadas: string[] = [];
  return {
    llamadas,
    descargarPropuesta: async () => {
      throw new Error("no se usa");
    },
    descargarRegistroPresentado: async (_t: unknown, s: { periodo: string }) => {
      llamadas.push(s.periodo);
      const r = responder(s.periodo);
      if (r instanceof Error) throw r;
      return { libro: "compras", periodo: s.periodo, filas: r };
    },
  } as never;
}

const correr = (b: ReturnType<typeof bd>, api: SireApiClient, intentos = 0) =>
  importarHistorial({
    db: b.db,
    sireApi: api,
    config: { obtener: async () => new Map([["sire", { reintentos: REINTENTOS }]]) as never },
  })({
    trabajo: {
      id: "j-adv2",
      tenantId: "t-adv2",
      clienteId: CLIENTE,
      ruc: RUC,
      tipo: "reglas.historial.importar",
      parametros: { importacionId: IMPORTACION },
      intentos,
      creadoPor: "u-adv2",
    },
    conToken: (usar) => usar("tok"),
  });

const PROV = "20100070970";
const candidataDe = (b: ReturnType<typeof bd>, ruc: string): Carga | undefined =>
  b.completar[0]?.candidatas.find((c) => c.doc_numero === ruc);


const con = (f: FilaPropuestaSire, o: Partial<FilaPropuestaSire>): FilaPropuestaSire => ({ ...f, ...o }) as FilaPropuestaSire;

describe("T19 · H-025-2-1: el worker pasa serie y número y cuenta comprobantes", () => {
  it("una sola factura DG repetida en el registro de un periodo: total 1 y sin destino propuesto (sin criterio claro)", async () => {
    const b = bd(["202610"]);
    await correr(b, puerto((p) => [comprobante({ periodo: p, ruc: PROV, numero: "1" }), comprobante({ periodo: p, ruc: PROV, numero: "1" })]));
    const c = candidataDe(b, PROV);
    expect(c).toBeDefined();
    expect(c).toMatchObject({ n_total: 1, n_dg: 1, destino_propuesto: null });
    expect(b.completar[0]?.resumen).toMatchObject({ candidatas: 1, sinCriterio: 1 });
  });

  it("la misma factura devuelta en dos periodos más otra distinta por periodo: 3 comprobantes, no 4", async () => {
    const b = bd(["202610", "202609"]);
    await correr(b, puerto((p) => [comprobante({ periodo: "202609", ruc: PROV, numero: "1" }), comprobante({ periodo: p, ruc: PROV, numero: `${p}-2` })]));
    expect(candidataDe(b, PROV)).toMatchObject({ n_total: 3, n_dg: 3 });
  });

  it("dos facturas distintas DG proponen DG aunque una venga repetida", async () => {
    const b = bd(["202610"]);
    await correr(
      b,
      puerto((p) => [
        comprobante({ periodo: p, ruc: PROV, numero: "1" }),
        comprobante({ periodo: p, ruc: PROV, numero: "1" }),
        comprobante({ periodo: p, ruc: PROV, numero: "2" }),
      ]),
    );
    expect(candidataDe(b, PROV)).toMatchObject({ n_total: 2, n_dg: 2, destino_propuesto: "DG" });
  });

  it("mismo comprobante con montos distintos en dos periodos: cuenta la fila del periodo más reciente", async () => {
    const b = bd(["202610", "202609"]);
    // F001-1 llega como DG en 202609 y como DNG en 202610; F001-2 es DNG en 202610: el más reciente manda, DNG 2 de 2.
    await correr(
      b,
      puerto((p) =>
        p === "202610"
          ? [con(comprobante({ periodo: p, ruc: PROV, numero: "1" }), { biDg: CERO, biDng: "100.00", total: "100.00" }), con(comprobante({ periodo: p, ruc: PROV, numero: "2" }), { biDg: CERO, biDng: "100.00", total: "100.00" })]
          : [comprobante({ periodo: p, ruc: PROV, numero: "1" })],
      ),
    );
    expect(candidataDe(b, PROV)).toMatchObject({ n_total: 2, n_dng: 2, n_dg: 0, destino_propuesto: "DNG" });
  });

  it("controles: otra serie, otro tipo de comprobante u otro proveedor con el mismo número son otros comprobantes", async () => {
    const b = bd(["202610"]);
    const OTRO = "20555555551";
    await correr(
      b,
      puerto((p) => [
        comprobante({ periodo: p, ruc: PROV, numero: "1" }),
        comprobante({ periodo: p, ruc: PROV, numero: "1", serie: "F002" }),
        con(comprobante({ periodo: p, ruc: PROV, numero: "1" }), { tipo: "07" } as never),
        comprobante({ periodo: p, ruc: OTRO, numero: "1" }),
      ]),
    );
    expect(candidataDe(b, PROV)).toMatchObject({ n_total: 3 });
    expect(candidataDe(b, OTRO)).toMatchObject({ n_total: 1 });
  });
});
