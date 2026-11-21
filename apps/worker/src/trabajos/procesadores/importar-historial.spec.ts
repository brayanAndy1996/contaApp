// Unitarias del procesador `reglas.historial.importar` (spec 025, T11): lo que la integración (T5) no recorre, con la BD y el
// puerto falsos: parámetros, payload forjado, importación cerrada, filtro de candidatas que la BD rechazaría (T10: RUC sin 11
// dígitos), filas ilegibles, rechazo 22023 / 55000 de la BD y a qué motivo cierra cada fallo (credencial, datos, portal, red).
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorPortal,
  ErrorTransitorio,
  type FilaPropuestaSire,
  type SireApiClient,
} from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import type { ContextoProcesador } from "../ejecutor.js";
import { TOPE_FILAS } from "./descargar-propuesta.js";
import {
  esCandidataGuardable,
  importarHistorial,
} from "./importar-historial.js";

const IMPORTACION = "0194a1b2-0000-7000-8000-000000000001";
const CLIENTE = "0194a1b2-0000-7000-8000-0000000000c1";
const RUC = "20700000002";

const trabajo = (
  extra: Partial<ContextoProcesador["trabajo"]> = {},
  parametros: unknown = { importacionId: IMPORTACION },
): ContextoProcesador["trabajo"] => ({
  id: "j-1",
  tenantId: "t-1",
  clienteId: CLIENTE,
  ruc: RUC,
  tipo: "reglas.historial.importar",
  parametros,
  intentos: 0,
  creadoPor: "u-1",
  ...extra,
});
const conToken = <T>(usar: (t: string) => Promise<T>) => usar("tok");
const ctx = (
  t: ContextoProcesador["trabajo"] = trabajo(),
): ContextoProcesador => ({ trabajo: t, conToken });

interface Registro {
  completar: Array<{ resumen: Record<string, unknown>; candidatas: unknown[] }>;
  fallar: string[];
}

interface OpcionesBd {
  importacion?: Record<string, unknown> | null;
  /** Error (con `code`) que lanza `completar`. */
  errorCompletar?: unknown;
  errorFallar?: unknown;
}

function bd(o: OpcionesBd = {}) {
  const registro: Registro = { completar: [], fallar: [] };
  const fila =
    o.importacion === undefined
      ? {
          id: IMPORTACION,
          cliente_id: CLIENTE,
          estado: "en_curso",
          periodos: ["202609", "202610"],
          ruc: RUC,
        }
      : o.importacion;
  const tx = {
    query: async (texto: string, valores: unknown[]) => {
      if (texto.includes("reglas_importacion_completar")) {
        if (o.errorCompletar !== undefined) throw o.errorCompletar;
        registro.completar.push({
          resumen: JSON.parse(String(valores[1])) as Record<string, unknown>,
          candidatas: JSON.parse(String(valores[2])) as unknown[],
        });
        return { rows: [{ n: 0 }], rowCount: 1 };
      }
      if (texto.includes("reglas_importacion_fallar")) {
        if (o.errorFallar !== undefined) throw o.errorFallar;
        registro.fallar.push(String(valores[1]));
        return { rows: [{}], rowCount: 1 };
      }
      return {
        rows: fila === null ? [] : [fila],
        rowCount: fila === null ? 0 : 1,
      };
    },
  };
  const db = {
    withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx),
  } as never;
  return { db, registro };
}

const fila = (
  ruc: string,
  extra: Partial<FilaPropuestaSire> = {},
): FilaPropuestaSire =>
  ({
    tipo: "01",
    serie: "F001",
    numero: "1",
    rucContraparte: ruc,
    fechaEmision: "2026-10-15",
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
    ...extra,
  }) as FilaPropuestaSire;

/** Puerto cuya respuesta (o error) sale de `responder(periodo)`. */
const puerto = (
  responder: (periodo: string) => unknown,
): SireApiClient & { periodos: string[] } => {
  const periodos: string[] = [];
  return {
    periodos,
    descargarPropuesta: async () => {
      throw new Error("no se usa");
    },
    descargarRegistroPresentado: async (
      _t: unknown,
      s: { periodo: string },
    ) => {
      periodos.push(s.periodo);
      const r = responder(s.periodo);
      if (r instanceof Error) throw r;
      return r;
    },
  } as never;
};
const registro = (filas: unknown, libro = "compras") => ({
  libro,
  periodo: "202610",
  filas,
});

const config = (reintentos: number | null = 3) => ({
  obtener: async () =>
    new Map(reintentos === null ? [] : [["sire", { reintentos }]]) as never,
});

const correr = (
  d: {
    bd?: ReturnType<typeof bd>;
    api: SireApiClient;
    reintentos?: number | null;
  },
  t = trabajo(),
) => {
  const b = d.bd ?? bd();
  return importarHistorial({
    db: b.db,
    sireApi: d.api,
    config: config(d.reintentos === undefined ? 3 : d.reintentos),
  })(ctx(t));
};

const dosDe = (ruc: string, extra: Partial<FilaPropuestaSire> = {}) => [
  fila(ruc, extra),
  fila(ruc, { numero: "2", ...extra }),
];

describe("importarHistorial: entrada", () => {
  it("parámetros inválidos: error de datos sin tocar la BD ni el puerto", async () => {
    const b = bd();
    const api = puerto(() => registro([]));
    await expect(
      correr({ bd: b, api }, trabajo({}, { importacionId: "no-es-uuid" })),
    ).rejects.toBeInstanceOf(ErrorDatos);
    expect(api.periodos).toEqual([]);
    expect(b.registro.fallar).toEqual([]);
  });

  it("importación inexistente en el estudio o de otro cliente: error de datos, sin llamar al puerto ni cerrar nada", async () => {
    for (const importacion of [
      null,
      {
        id: IMPORTACION,
        cliente_id: "0194a1b2-0000-7000-8000-0000000000c2",
        estado: "en_curso",
        periodos: ["202610"],
        ruc: RUC,
      },
    ]) {
      const b = bd({ importacion });
      const api = puerto(() => registro([]));
      await expect(correr({ bd: b, api })).rejects.toBeInstanceOf(ErrorDatos);
      expect(api.periodos).toEqual([]);
      expect(b.registro.fallar).toEqual([]);
    }
  });

  it("importación ya cerrada: termina bien sin llamar al puerto ni escribir", async () => {
    for (const estado of ["completada", "fallida"]) {
      const b = bd({
        importacion: {
          id: IMPORTACION,
          cliente_id: CLIENTE,
          estado,
          periodos: ["202610"],
          ruc: RUC,
        },
      });
      const api = puerto(() => registro([]));
      expect(await correr({ bd: b, api })).toEqual({ omitida: true });
      expect(api.periodos).toEqual([]);
      expect(b.registro.completar).toEqual([]);
    }
  });
});

describe("importarHistorial: lectura y escritura", () => {
  it("lee del periodo más reciente al más antiguo con el RUC de la importación y escribe una vez con conteos", async () => {
    const b = bd();
    const api = puerto((p) =>
      registro(p === "202610" ? dosDe(rucValido(1)) : [], "compras"),
    );
    const r = await correr({ bd: b, api });
    expect(api.periodos).toEqual(["202610", "202609"]);
    expect(r).toEqual({
      periodosLeidos: 2,
      periodosSinDatos: 0,
      candidatas: 1,
      sinCriterio: 0,
    });
    expect(b.registro.completar).toHaveLength(1);
    expect(b.registro.completar[0]!.resumen).toEqual({
      periodos_leidos: 2,
      periodos_sin_datos: [],
      candidatas: 1,
      sin_criterio: 0,
    });
    expect(b.registro.fallar).toEqual([]);
  });

  it("un periodo sin registro (ErrorDatos del puerto) queda como «sin datos» y los demás se leen", async () => {
    const b = bd();
    const api = puerto((p) =>
      p === "202610" ? new ErrorDatos() : registro(dosDe(rucValido(1))),
    );
    const r = await correr({ bd: b, api });
    expect(r).toEqual({
      periodosLeidos: 1,
      periodosSinDatos: 1,
      candidatas: 1,
      sinCriterio: 0,
    });
    expect(b.registro.completar[0]!.resumen).toMatchObject({
      periodos_leidos: 1,
      periodos_sin_datos: ["202610"],
    });
  });

  it("todos los periodos sin datos: se completa con cero candidatas", async () => {
    const b = bd();
    const r = await correr({ bd: b, api: puerto(() => new ErrorDatos()) });
    expect(r).toEqual({
      periodosLeidos: 0,
      periodosSinDatos: 2,
      candidatas: 0,
      sinCriterio: 0,
    });
    expect(b.registro.completar[0]!.candidatas).toEqual([]);
  });

  it("T10: las filas cuyo documento la BD rechazaría no son candidatas y no tumban la importación", async () => {
    const b = bd();
    const bueno = rucValido(1);
    const filas = [
      ...dosDe(bueno),
      ...dosDe("2070000003"), // tipo 6 (por omisión) con 10 dígitos
      ...dosDe("207000000345"), // tipo 6 con 12 dígitos
      ...dosDe("--"), // sin ningún carácter alfanumérico
      ...dosDe("12345678", { tipoDocContraparte: "1" }), // DNI: sí
      ...dosDe("ABC", { tipoDocContraparte: "XYZ" }), // tipo de documento fuera de la gramática: el dominio ya la descarta
    ];
    const r = await correr({ bd: b, api: puerto(() => registro(filas)) });
    const guardadas = b.registro.completar[0]!.candidatas as Array<{
      doc_tipo: string;
      doc_numero: string;
    }>;
    expect(guardadas.map((c) => `${c.doc_tipo}:${c.doc_numero}`)).toEqual([
      "1:12345678",
      `6:${bueno}`,
    ]);
    expect(r).toMatchObject({ candidatas: 2, sinCriterio: 0 });
  });

  it("esCandidataGuardable: tipo 6 exige 11 dígitos; los demás tipos, la gramática de la BD", () => {
    const c = (tipo: string, numero: string) =>
      ({
        proveedor: { tipo, numero },
        razonSocial: null,
        destino: null,
        conteos: { DG: 1, DGNG: 0, DNG: 0, mixto: 0, total: 1 },
        periodosConProveedor: 1,
      }) as never;
    expect(esCandidataGuardable(c("6", "20700000002"))).toBe(true);
    expect(esCandidataGuardable(c("6", "2070000000A"))).toBe(false);
    expect(esCandidataGuardable(c("1", "12345678"))).toBe(true);
    expect(esCandidataGuardable(c("1", "-"))).toBe(false);
    expect(esCandidataGuardable(c("1", "A-B"))).toBe(true);
    expect(esCandidataGuardable(c("1", "A".repeat(21)))).toBe(false);
    expect(esCandidataGuardable(c("123", "1"))).toBe(false);
  });
});

describe("importarHistorial: respuestas ilegibles", () => {
  it("libro distinto o filas que no son lista: respuesta inconsistente (datos) y la importación queda fallida", async () => {
    for (const r of [
      registro([], "ventas"),
      registro("x"),
      { libro: "compras" },
    ]) {
      const b = bd();
      await expect(
        correr({ bd: b, api: puerto(() => r) }),
      ).rejects.toBeInstanceOf(ErrorDatos);
      expect(b.registro.fallar).toEqual(["datos_invalidos"]);
      expect(b.registro.completar).toEqual([]);
    }
  });

  it("más filas que el tope de una descarga: datos inválidos, sin escribir candidatas", async () => {
    const b = bd();
    const filas = new Array<FilaPropuestaSire>(TOPE_FILAS + 1).fill(
      fila(rucValido(1)),
    );
    await expect(
      correr({ bd: b, api: puerto(() => registro(filas)) }),
    ).rejects.toBeInstanceOf(ErrorDatos);
    expect(b.registro.fallar).toEqual(["datos_invalidos"]);
    expect(b.registro.completar).toEqual([]);
  });

  it("una fila con montos que no son texto, o con un monto que no es decimal, es ilegible: datos inválidos", async () => {
    for (const malas of [
      [null],
      [fila(rucValido(1), { biDg: 100 as never })],
      [fila(rucValido(1), { biDg: "no-es-monto" })],
    ]) {
      const b = bd();
      await expect(
        correr({ bd: b, api: puerto(() => registro(malas)) }),
      ).rejects.toBeInstanceOf(ErrorDatos);
      expect(b.registro.fallar).toEqual(["datos_invalidos"]);
    }
  });

  it("campos opcionales que no son texto se tratan como ausentes (RUC por omisión, sin razón social)", async () => {
    const b = bd();
    const ruc = rucValido(1);
    const filas = dosDe(ruc, {
      tipoDocContraparte: 6 as never,
      razonSocialContraparte: 5 as never,
      tipo: undefined as never,
    });
    await correr({ bd: b, api: puerto(() => registro(filas)) });
    expect(b.registro.completar[0]!.candidatas).toMatchObject([
      { doc_tipo: "6", doc_numero: ruc, razon_social: null },
    ]);
  });

  it("un RUC que no es texto cuenta como sin proveedor", async () => {
    const b = bd();
    const filas = dosDe(null as never);
    const r = await correr({ bd: b, api: puerto(() => registro(filas)) });
    expect(r).toMatchObject({ candidatas: 0 });
  });
});

describe("importarHistorial: fallos y cierre de la importación", () => {
  it("credencial rechazada: la importación se cierra como credencial_invalida y el error sale", async () => {
    const b = bd();
    await expect(
      correr({ bd: b, api: puerto(() => new ErrorCredencial()) }),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(b.registro.fallar).toEqual(["credencial_invalida"]);
  });

  it("el portal cambió: se cierra como portal_cambio", async () => {
    const b = bd();
    await expect(
      correr({ bd: b, api: puerto(() => new ErrorPortal()) }),
    ).rejects.toBeInstanceOf(ErrorPortal);
    expect(b.registro.fallar).toEqual(["portal_cambio"]);
  });

  it("fallo transitorio con reintentos pendientes: no se cierra (008 reintenta)", async () => {
    const b = bd();
    await expect(
      correr(
        { bd: b, api: puerto(() => new ErrorTransitorio()) },
        trabajo({ intentos: 2 }),
      ),
    ).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(b.registro.fallar).toEqual([]);
  });

  it("fallo transitorio en el último intento: se cierra como sunat_no_responde", async () => {
    const b = bd();
    await expect(
      correr(
        { bd: b, api: puerto(() => new ErrorTransitorio()) },
        trabajo({ intentos: 3 }),
      ),
    ).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(b.registro.fallar).toEqual(["sunat_no_responde"]);
  });

  it("sin configuración de la cola se trata como cero reintentos: el primer fallo transitorio cierra", async () => {
    const b = bd();
    await expect(
      correr({
        bd: b,
        api: puerto(() => new ErrorTransitorio()),
        reintentos: null,
      }),
    ).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(b.registro.fallar).toEqual(["sunat_no_responde"]);
  });

  it("un error de la BD al completar (red, bloqueo) es transitorio: se reintenta, y solo se cierra en el último intento", async () => {
    const e = Object.assign(new Error("x"), { code: "40P01" });
    const b = bd({ errorCompletar: e });
    const api = puerto(() => registro(dosDe(rucValido(1))));
    await expect(correr({ bd: b, api })).rejects.toBeDefined();
    expect(b.registro.fallar).toEqual([]);
    await expect(
      correr({ bd: b, api }, trabajo({ intentos: 3 })),
    ).rejects.toBeDefined();
    expect(b.registro.fallar).toEqual(["sunat_no_responde"]);
  });

  it("55000 al completar (cerrada mientras se leía): termina bien sin cerrar de nuevo", async () => {
    const b = bd({
      errorCompletar: Object.assign(new Error("x"), { code: "55000" }),
    });
    const r = await correr({
      bd: b,
      api: puerto(() => registro(dosDe(rucValido(1)))),
    });
    expect(r).toEqual({ omitida: true });
    expect(b.registro.fallar).toEqual([]);
  });

  it("22023 al completar: no se reintenta; se cierra como datos_invalidos", async () => {
    const b = bd({
      errorCompletar: Object.assign(new Error("x"), { code: "22023" }),
    });
    await expect(
      correr({ bd: b, api: puerto(() => registro(dosDe(rucValido(1)))) }),
    ).rejects.toBeInstanceOf(ErrorDatos);
    expect(b.registro.fallar).toEqual(["datos_invalidos"]);
  });

  it("si no se puede cerrar (ya cerrada, BD caída) el error original sale igual", async () => {
    const b = bd({
      errorFallar: Object.assign(new Error("x"), { code: "55000" }),
    });
    await expect(
      correr({ bd: b, api: puerto(() => new ErrorCredencial()) }),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(b.registro.fallar).toEqual([]);
  });
});

/** RUC de proveedor de prueba de 11 dígitos (la gramática no exige dígito verificador). */
function rucValido(n: number): string {
  return `207${String(n).padStart(8, "0")}`;
}
