// Spec 025 · T18 (ronda adversarial 2): procesador `reglas.historial.importar` con la BD y el puerto falsos. Ataques: filas
// duplicadas del registro (el mismo comprobante dos veces en un periodo o en dos periodos), 12 periodos con un transitorio en el
// último que se lee, un monto fuera de NUMERIC(14,2) entre 12 periodos válidos, y documentos/razones sociales hostiles frente a la
// gramática que exige `reglas_importacion_completar` (0064). Las que revelan un hallazgo quedan en rojo (H-025-2-n en tasks.md).
import { ErrorDatos, ErrorTransitorio, type FilaPropuestaSire, type SireApiClient } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import { importarHistorial } from "./importar-historial.js";

const IMPORTACION = "0194a1b2-0000-7000-8000-0000000000b1";
const CLIENTE = "0194a1b2-0000-7000-8000-0000000000b2";
const RUC = "20700000002";
const P12 = ["202610", "202609", "202608", "202607", "202606", "202605", "202604", "202603", "202602", "202601", "202512", "202511"];
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

describe("T18 · filas duplicadas del registro (D-3: se cuentan COMPROBANTES)", () => {
  it("ADV2-5 el mismo comprobante dos veces en un periodo cuenta una vez: un solo comprobante no llega al mínimo de 2 (U-2)", async () => {
    const b = bd(["202610"]);
    // Una sola factura F001-1 del proveedor, repetida por el registro (p. ej. una página que el adaptador lee dos veces).
    const api = puerto((p) => [comprobante({ periodo: p, ruc: PROV, numero: "1" }), comprobante({ periodo: p, ruc: PROV, numero: "1" })]);
    await correr(b, api);
    const c = candidataDe(b, PROV);
    expect(c, "hay candidata del proveedor").toBeDefined();
    expect(c?.n_total, "un comprobante repetido no son dos comprobantes").toBe(1);
    expect(c?.destino_propuesto, "con un solo comprobante no hay propuesta (U-2: al menos 2)").toBeNull();
  });

  it("ADV2-6 el mismo comprobante en el registro de dos periodos cuenta una vez", async () => {
    const b = bd(["202610", "202609"]);
    // F001-1 se anota una sola vez en el SIRE; si el adaptador lo devuelve en dos periodos, sigue siendo un comprobante.
    const api = puerto((p) => [comprobante({ periodo: "202609", ruc: PROV, numero: "1" }), comprobante({ periodo: p, ruc: PROV, numero: `${p}-2` })]);
    await correr(b, api);
    const c = candidataDe(b, PROV);
    expect(c?.n_total, "3 comprobantes distintos (F001-1, F001-202610-2, F001-202609-2), no 4").toBe(3);
  });
});

describe("T18 · 12 periodos (máximo de U-5)", () => {
  it("ADV2-7 un transitorio en el último periodo leído: sin escribir con reintentos pendientes; en el último intento, cerrada sunat_no_responde", async () => {
    const masAntiguo = P12[P12.length - 1] as string;
    const responder = (p: string) => (p === masAntiguo ? new ErrorTransitorio() : [comprobante({ periodo: p, ruc: PROV, numero: p })]);
    const b1 = bd(P12);
    const api1 = puerto(responder);
    await expect(correr(b1, api1, 0)).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(api1.llamadas, "del más reciente al más antiguo; el transitorio llega al final").toEqual(P12);
    expect(b1.completar, "11 periodos leídos no se escriben a medias").toEqual([]);
    expect(b1.fallar, "con reintentos pendientes no se cierra").toEqual([]);
    const b2 = bd(P12);
    await expect(correr(b2, puerto(responder), REINTENTOS)).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(b2.completar).toEqual([]);
    expect(b2.fallar).toEqual(["sunat_no_responde"]);
  });

  it("ADV2-8 un monto fuera de NUMERIC(14,2) en una fila de 12 periodos: no completa (no reemplaza la revisión anterior) y cierra datos_invalidos", async () => {
    const b = bd(P12);
    const api = puerto((p) => [
      comprobante({ periodo: p, ruc: PROV, numero: p }),
      ...(p === "202603" ? [comprobante({ periodo: p, ruc: "20555555551", numero: "9", biDg: "100.005" })] : []),
    ]);
    await expect(correr(b, api)).rejects.toBeInstanceOf(ErrorDatos);
    expect(b.completar).toEqual([]);
    expect(b.fallar).toEqual(["datos_invalidos"]);
  });
});

describe("T18 · lo que llega a completar cumple la gramática de 0064", () => {
  const CONTROLES_BD = /[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/u;
  const admitida = (c: Carga): boolean => {
    const tipo = String(c.doc_tipo);
    const numero = String(c.doc_numero);
    const razon = c.razon_social as string | null;
    const largo = razon === null ? 1 : Array.from(razon).length;
    return (
      /^[0-9A-Z]{1,2}$/.test(tipo) &&
      /^[0-9A-Z-]{1,20}$/.test(numero) &&
      /[0-9A-Z]/.test(numero) &&
      (tipo !== "6" || /^[0-9]{11}$/.test(numero)) &&
      largo >= 1 &&
      largo <= 200 &&
      (razon === null || !CONTROLES_BD.test(razon)) &&
      Number(c.n_total) === Number(c.n_dg) + Number(c.n_dgng) + Number(c.n_dng) + Number(c.n_mixto) &&
      Number(c.periodos_con_proveedor) >= 1
    );
  };

  it("ADV2-9 tipos raros, `--`, espacios Unicode, dígitos de ancho completo, USD y razones con bidi o 10.000 caracteres: nada tumba la importación", async () => {
    const b = bd(["202610", "202609"]);
    const raras: Array<{ ruc: string; tipoDoc?: string; razon?: string; moneda?: "USD" }> = [
      { ruc: "--", tipoDoc: "0" },
      { ruc: "-1-", tipoDoc: "7" },
      { ruc: "ab12345", tipoDoc: "z" },
      { ruc: " 201　000 70970 ", razon: "‮SAC‬ | \n" },
      { ruc: "２０１０００７０９７０" },
      { ruc: "12345678", tipoDoc: "1", razon: "Ñ".repeat(10_000) },
      { ruc: "X1234567890123456789", tipoDoc: "B" },
      { ruc: "20100070971", tipoDoc: "06" },
      { ruc: "20100070972", tipoDoc: "", razon: "\u0000\uD800", moneda: "USD" },
    ];
    const api = puerto((p) =>
      raras.flatMap((r, i) => [
        comprobante({ periodo: p, numero: `${p}${i}a`, ...r }),
        comprobante({ periodo: p, numero: `${p}${i}b`, ...r }),
      ]),
    );
    await correr(b, api);
    expect(b.fallar).toEqual([]);
    expect(b.completar).toHaveLength(1);
    const cands = b.completar[0]!.candidatas;
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(admitida(c), JSON.stringify(c).slice(0, 160)).toBe(true);
  });
});
