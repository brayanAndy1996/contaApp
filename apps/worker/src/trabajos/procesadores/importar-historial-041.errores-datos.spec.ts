// Spec 041 · T20 (rojo) · H-1 de la revisión final del arquitecto: `reglas.historial.importar` (BD y puerto falsos, sin PG ni Redis).
// Hoy todo `ErrorDatos` cuenta como «periodo sin datos» y el trabajo sigue; con SIRE_CLIENT=http un periodo rechazado por
// `ErrorDatosSire` (fila_invalida, columna_no_soportada, respuesta_ajena, ticket_con_errores) queda fuera de la deducción sin aviso
// (contra CA-7 «no se pierde en silencio»). Regla:
//  - `ErrorDatos` plano (el del mock) y `ErrorDatosSire("sin_datos")` -> periodo sin datos (`periodos_sin_datos`) y sigue.
//  - Cualquier otro `ErrorDatosSire` -> el trabajo FALLA con el error de datos (`error/datos_invalidos`, como un `ErrorDatos`
//    fuera de «sin datos»): importación `fallida` con motivo `datos_invalidos`, sin leer los periodos siguientes, sin completar ni
//    marcar el periodo como sin datos, y sin secretos en el error.
import {
  ErrorDatos,
  ErrorDatosSire,
  type DetalleDatosSire,
  type FilaPropuestaSire,
  type SireApiClient,
} from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import { importarHistorial } from "./importar-historial.js";

const IMPORTACION = "0194a1b2-0000-7000-8000-0000000000c1";
const CLIENTE = "0194a1b2-0000-7000-8000-0000000000c2";
const RUC = "20700000002";
const PROV = "20100070970";
const TOKEN_CANARIO = "CANARIO-TOKEN-h1";

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
      return {
        rows: [
          {
            id: IMPORTACION,
            cliente_id: CLIENTE,
            estado: "en_curso",
            periodos,
            ruc: RUC,
          },
        ],
        rowCount: 1,
      };
    },
  };
  return {
    db: {
      withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx),
    } as never,
    completar,
    fallar,
  };
}

const CERO = "0.00";
function fila(periodo: string, numero: string): FilaPropuestaSire {
  return {
    tipo: "01",
    serie: "F001",
    numero,
    rucContraparte: PROV,
    fechaEmision: `${periodo.slice(0, 4)}-${periodo.slice(4)}-15`,
    moneda: "PEN",
    biDg: "100.00",
    igvDg: CERO,
    biDgng: CERO,
    igvDgng: CERO,
    biDng: CERO,
    igvDng: CERO,
    noGravado: CERO,
    isc: CERO,
    icbper: CERO,
    otros: CERO,
    total: "100.00",
  } as FilaPropuestaSire;
}

function puerto(
  responder: (periodo: string) => FilaPropuestaSire[] | Error,
): SireApiClient & { llamadas: string[] } {
  const llamadas: string[] = [];
  return {
    llamadas,
    descargarPropuesta: async () => {
      throw new Error("no se usa");
    },
    descargarRegistroPresentado: async (
      _t: unknown,
      s: { periodo: string },
    ) => {
      llamadas.push(s.periodo);
      const r = responder(s.periodo);
      if (r instanceof Error) throw r;
      return { libro: "compras", periodo: s.periodo, filas: r };
    },
  } as never;
}

const correr = (b: ReturnType<typeof bd>, api: SireApiClient) =>
  importarHistorial({
    db: b.db,
    sireApi: api,
    config: {
      obtener: async () => new Map([["sire", { reintentos: 3 }]]) as never,
    },
  })({
    trabajo: {
      id: "j-h1",
      tenantId: "t-h1",
      clienteId: CLIENTE,
      ruc: RUC,
      tipo: "reglas.historial.importar",
      parametros: { importacionId: IMPORTACION },
      intentos: 0,
      creadoPor: "u-h1",
    },
    conToken: (usar) => usar(TOKEN_CANARIO),
  });

async function capturar(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("se esperaba que el trabajo fallara y terminó bien");
}

// Del más reciente al más antiguo: 202610 se lee primero; 202609 y 202608 son «los demás periodos».
const PERIODOS = ["202608", "202609", "202610"] as const;
const FALLAS: DetalleDatosSire[] = [
  "fila_invalida",
  "columna_no_soportada",
  "respuesta_ajena",
  "ticket_con_errores",
];

describe("H-1 · ErrorDatosSire distinto de sin_datos hace fallar el trabajo (CA-7: no se pierde en silencio)", () => {
  it.each(FALLAS)(
    "%s en el periodo más reciente: el trabajo falla con ErrorDatos, sin leer los demás periodos ni completar",
    async (detalle) => {
      const b = bd(PERIODOS);
      const api = puerto((p) =>
        p === "202610" ? new ErrorDatosSire(detalle) : [fila(p, "1")],
      );
      const e = await capturar(correr(b, api));
      expect(e).toBeInstanceOf(ErrorDatos);
      expect(e).toMatchObject({ detalle });
      expect(api.llamadas, "no sigue con los demás periodos").toEqual([
        "202610",
      ]);
      expect(b.completar, "no completa la importación").toHaveLength(0);
      expect(
        b.fallar,
        "la importación queda fallida con el motivo de datos",
      ).toEqual(["datos_invalidos"]);
      expect(String(e) + (e as Error).stack).not.toContain(TOKEN_CANARIO);
    },
  );

  it.each(FALLAS)(
    "%s en un periodo intermedio tras uno leído: falla igual; lo ya leído no se completa y el periodo no es «sin datos»",
    async (detalle) => {
      const b = bd(PERIODOS);
      const api = puerto((p) =>
        p === "202609" ? new ErrorDatosSire(detalle) : [fila(p, p)],
      );
      const e = await capturar(correr(b, api));
      expect(e).toBeInstanceOf(ErrorDatosSire);
      expect(api.llamadas).toEqual(["202610", "202609"]);
      expect(b.completar).toHaveLength(0);
      expect(b.fallar).toEqual(["datos_invalidos"]);
    },
  );
});

describe("H-1 · sin datos sigue contando como periodo sin datos", () => {
  it("ErrorDatos plano (el del mock): periodo sin datos y sigue con los demás", async () => {
    const b = bd(PERIODOS);
    const api = puerto((p) =>
      p === "202609" ? new ErrorDatos() : [fila(p, p)],
    );
    await correr(b, api);
    expect(api.llamadas).toEqual(["202610", "202609", "202608"]);
    expect(b.completar).toHaveLength(1);
    expect(b.completar[0]!.resumen).toMatchObject({
      periodos_leidos: 2,
      periodos_sin_datos: ["202609"],
    });
    expect(b.fallar).toEqual([]);
  });

  it("ErrorDatosSire sin_datos (el 5.51 con cod 1070 o un TXT solo con encabezado): periodo sin datos y sigue", async () => {
    const b = bd(PERIODOS);
    const api = puerto((p) =>
      p === "202610" ? new ErrorDatosSire("sin_datos") : [fila(p, p)],
    );
    await correr(b, api);
    expect(api.llamadas).toEqual(["202610", "202609", "202608"]);
    expect(b.completar).toHaveLength(1);
    expect(b.completar[0]!.resumen).toMatchObject({
      periodos_leidos: 2,
      periodos_sin_datos: ["202610"],
    });
    expect(b.fallar).toEqual([]);
  });

  it("mezcla: sin_datos en un periodo y ErrorDatos plano en otro, leyendo el tercero", async () => {
    const b = bd(PERIODOS);
    const api = puerto((p) =>
      p === "202610"
        ? new ErrorDatosSire("sin_datos")
        : p === "202609"
          ? new ErrorDatos()
          : [fila(p, p)],
    );
    await correr(b, api);
    expect(b.completar[0]!.resumen).toMatchObject({
      periodos_leidos: 1,
      periodos_sin_datos: ["202610", "202609"],
    });
  });
});
