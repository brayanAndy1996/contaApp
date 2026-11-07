import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agregarCompraSchema,
  aceptarSugerenciaSchema,
  calcularCompraSchema,
  clasificarCompraSchema,
  descartarCompraSchema,
  destinoCompraSchema,
  editarCompraSchema,
  estadoPeriodoRespuestaSchema,
  estadoPeriodoSchema,
  excluirCompraSchema,
  montoDecimalSchema,
  periodoComprasSchema,
  restaurarCompraSchema,
  versionBaseSchema,
} from "./index.js";

// Spec 014 · T2 (rojo). Esquemas zod y DTOs de entrada de las acciones de compras (D-5, D-13, D-15, D-16;
// CA-5, CA-18, CA-19). Contrato fijado por estas pruebas (plan 014, Contratos: HTTP; archivos en
// packages/shared/src/compras/, exportados por compras/index.ts y por el índice de shared):
//  - montoDecimalSchema: cadena decimal canónica de NUMERIC(14,2): signo opcional, hasta 12 enteros sin
//    ceros a la izquierda, hasta 2 decimales, rango ±999999999999.99. Solo cadenas: un `number` se rechaza
//    siempre (el dinero nunca viaja como number). Rechaza 3 decimales (0.005, 0.015), notación científica,
//    vacío, espacios y separadores de miles. Admite negativos (notas de crédito).
//  - periodoComprasSchema: AAAAMM con mes 01-12 (el rechazo del futuro es del servicio, no del esquema).
//  - versionBaseSchema: entero positivo (>= 1); no admite 0, negativos, decimales ni cadenas.
//  - destinoCompraSchema: "DG" | "DGNG" | "DNG".
//  - clasificarCompraSchema {versionBase, destino}; editarCompraSchema {versionBase, cambios};
//    calcularCompraSchema {cambios} (sin versionBase, D-16); aceptarSugerenciaSchema {versionBase, regla,
//    confirmar?, dato?}; excluirCompraSchema {versionBase, motivo?}; restaurarCompraSchema y
//    descartarCompraSchema {versionBase}.
//  - `cambios` / `montos`: subconjunto de las 10 columnas de 010 (biDg, igvDg, biDgng, igvDgng, biDng,
//    igvDng, noGravado, isc, icbper, otrosTributos), cada una un montoDecimal. El `total` no se edita: nunca
//    llega a los datos parseados. Las claves desconocidas se descartan (z.object), así que un tenantId o
//    usuarioId del cuerpo no viaja.
//  - aceptarSugerenciaSchema: `regla` ∈ R-ISC | R-MIX | R-RED | R-NEW | R-GP; `confirmar` booleano;
//    `dato` es {gravado: montoDecimal} o {destino: Destino} (lo que pide el 422 requiere_dato).
//  - excluirCompraSchema.motivo: cadena de hasta 200 caracteres, opcional.
//  - agregarCompraSchema {tipo, serie, numero, proveedor: {tipo, numero, razonSocial}, fecha, moneda,
//    tipoCambio?, montos}: tipo 2 dígitos, serie 1 a 4 caracteres [0-9A-Z], número 1 a 8 dígitos, fecha
//    AAAA-MM-DD real, moneda "PEN" | "USD"; tipoCambio obligatorio en USD y prohibido en PEN (cadena con
//    hasta 4 enteros y 3 decimales, mayor que cero, como en 012); montos es un montoDecimal por columna.
//  - estadoPeriodoSchema: "abierto" | "revisado" | "generado"; estadoPeriodoRespuestaSchema
//    {estado, por: uuid | null, en: fecha ISO | null} (respuesta de revisar y reabrir).
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

const COLUMNAS = ["biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng", "noGravado", "isc", "icbper", "otrosTributos"] as const;

describe("montoDecimalSchema (NUMERIC(14,2), D-5)", () => {
  it.each(["0", "0.00", "1", "12.5", "100.00", "770.00", "-5.00", "-0.01", "999999999999.99", "-999999999999.99", "0.01"])("acepta %j", (v) => {
    expect(ok(montoDecimalSchema, v)).toBe(true);
  });

  it.each(["0.005", "0.015", "1.234", "100.001", "0.999"])("rechaza más de 2 decimales (%j)", (v) => {
    expect(ok(montoDecimalSchema, v)).toBe(false);
  });

  it.each(["1000000000000.00", "-1000000000000.00", "9999999999999.99", "99999999999999999999"])("rechaza fuera de rango (%j)", (v) => {
    expect(ok(montoDecimalSchema, v)).toBe(false);
  });

  it.each(["", " ", "abc", "1e3", "1E2", "0x10", "1,000.00", "1,5", " 1.00", "1.00 ", "NaN", "Infinity", "--1"])("rechaza lo que no es decimal canónico (%j)", (v) => {
    expect(ok(montoDecimalSchema, v)).toBe(false);
  });

  it.each([100, 0, -5, 1.5, 0.1 + 0.2, NaN, Infinity, null, undefined, true, {}, [], ["1.00"]])("rechaza un valor que no es cadena (%j): ningún monto es number", (v) => {
    expect(ok(montoDecimalSchema, v)).toBe(false);
  });

  it("devuelve la cadena tal cual, sin convertirla", () => {
    expect(montoDecimalSchema.safeParse("12.50").data).toBe("12.50");
  });
});

describe("periodoComprasSchema (AAAAMM)", () => {
  it.each(["202610", "202601", "202612", "202501"])("acepta %j", (p) => {
    expect(ok(periodoComprasSchema, p)).toBe(true);
  });
  it.each(["202600", "202613", "20261", "2026100", "2026-10", "abcdef", " 202610", "202610 ", "", "２０２６１０", 202610, null, undefined])("rechaza %j", (p) => {
    expect(ok(periodoComprasSchema, p)).toBe(false);
  });
});

describe("versionBaseSchema (D-2)", () => {
  it.each([1, 2, 10, 1000])("acepta %j", (v) => {
    expect(ok(versionBaseSchema, v)).toBe(true);
  });
  it.each([0, -1, 1.5, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, "1", "", null, undefined, true])("rechaza %j", (v) => {
    expect(ok(versionBaseSchema, v)).toBe(false);
  });
});

describe("destinoCompraSchema", () => {
  it.each(["DG", "DGNG", "DNG"])("acepta %j", (d) => {
    expect(ok(destinoCompraSchema, d)).toBe(true);
  });
  it.each(["dg", "DGN", "XX", "", "DG ", null, 1, undefined])("rechaza %j", (d) => {
    expect(ok(destinoCompraSchema, d)).toBe(false);
  });
});

describe("clasificarCompraSchema", () => {
  const valido = { versionBase: 3, destino: "DNG" };
  it("acepta versionBase y destino", () => {
    expect(datos(clasificarCompraSchema, valido)).toMatchObject(valido);
  });
  it.each([
    ["sin versionBase", { destino: "DNG" }],
    ["sin destino", { versionBase: 3 }],
    ["destino inválido", { versionBase: 3, destino: "XX" }],
    ["versionBase 0", { versionBase: 0, destino: "DG" }],
    ["versionBase como cadena", { versionBase: "3", destino: "DG" }],
    ["no es objeto", "DNG"],
    ["null", null],
  ])("rechaza %s", (_n, v) => {
    expect(ok(clasificarCompraSchema, v)).toBe(false);
  });
  it("descarta claves desconocidas (tenantId, usuarioId, clienteId)", () => {
    const d = datos(clasificarCompraSchema, { ...valido, tenantId: randomUUID(), usuarioId: randomUUID(), clienteId: randomUUID() });
    expect(Object.keys(d).sort()).toEqual(["destino", "versionBase"]);
  });
});

describe("editarCompraSchema y calcularCompraSchema (D-5, D-16)", () => {
  it("editar acepta cualquier subconjunto de las 10 columnas", () => {
    expect(datos(editarCompraSchema, { versionBase: 2, cambios: { biDg: "200.00" } }).cambios).toEqual({ biDg: "200.00" });
    const todas = Object.fromEntries(COLUMNAS.map((c, i) => [c, `${i + 1}.50`]));
    expect(datos(editarCompraSchema, { versionBase: 2, cambios: todas }).cambios).toEqual(todas);
  });

  it("editar admite montos negativos", () => {
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { biDg: "-100.00", igvDg: "-18.00" } })).toBe(true);
  });

  it.each(COLUMNAS)("editar: %s rechaza más de 2 decimales, fuera de rango y number", (c) => {
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { [c]: "0.005" } })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { [c]: "1000000000000.00" } })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { [c]: 100 } })).toBe(false);
  });

  it("editar exige versionBase y cambios", () => {
    expect(ok(editarCompraSchema, { cambios: { biDg: "1.00" } })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1 })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: "biDg" })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: null })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: [] })).toBe(false);
  });

  // DU-18 (T9): editar sin ninguna columna es 400; no crea versión ni entra en deshacer. Calcular no escribe y sigue aceptándolo.
  it("DU-18: editar rechaza `cambios` vacío (al menos una columna)", () => {
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: {} })).toBe(false);
  });

  it("DU-18: editar rechaza `cambios` que solo trae claves que no son columnas (total, desconocidas)", () => {
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { total: "5.00" } })).toBe(false);
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { desconocida: "5.00" } })).toBe(false);
  });

  it("DU-18: editar con una sola columna sigue valiendo, también en cero", () => {
    expect(ok(editarCompraSchema, { versionBase: 1, cambios: { biDg: "0.00" } })).toBe(true);
  });

  it("DU-18: calcular sigue aceptando `cambios` vacío (no escribe nada)", () => {
    expect(ok(calcularCompraSchema, { cambios: {} })).toBe(true);
  });

  it("el total no se edita: no llega a los cambios parseados (se descarta o se rechaza)", () => {
    const r = editarCompraSchema.safeParse({ versionBase: 1, cambios: { biDg: "10.00", total: "5.00" } });
    if (r.success) expect((r.data as { cambios: Record<string, unknown> }).cambios).not.toHaveProperty("total");
  });

  it("una columna inventada no llega a los cambios parseados (se descarta o se rechaza)", () => {
    const r = editarCompraSchema.safeParse({ versionBase: 1, cambios: { biDg: "10.00", desconocida: "5.00", __proto__: { x: 1 } } });
    if (r.success) expect((r.data as { cambios: Record<string, unknown> }).cambios).not.toHaveProperty("desconocida");
  });

  it("calcular no lleva versionBase: acepta solo cambios y no deja pasar una versionBase del cuerpo", () => {
    const d = datos(calcularCompraSchema, { cambios: { biDg: "200.00" }, versionBase: 9 });
    expect(d.cambios).toEqual({ biDg: "200.00" });
    expect(d).not.toHaveProperty("versionBase");
  });

  it("calcular valida los montos igual que editar", () => {
    expect(ok(calcularCompraSchema, { cambios: { biDg: "0.015" } })).toBe(false);
    expect(ok(calcularCompraSchema, { cambios: { biDg: 1 } })).toBe(false);
    expect(ok(calcularCompraSchema, { cambios: { biDg: "999999999999.99" } })).toBe(true);
    expect(ok(calcularCompraSchema, {})).toBe(false);
  });
});

describe("aceptarSugerenciaSchema (D-4)", () => {
  it.each(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP"])("acepta la regla %s", (regla) => {
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla })).toBe(true);
  });

  it.each(["r-isc", "R-HIS", "R-ISC ", "", null, 1])("rechaza la regla %j", (regla) => {
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla })).toBe(false);
  });

  it("confirmar es booleano opcional", () => {
    expect(datos(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-ISC", confirmar: true }).confirmar).toBe(true);
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-ISC", confirmar: "true" })).toBe(false);
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-ISC", confirmar: 1 })).toBe(false);
  });

  it("dato con gravado (R-MIX): monto decimal exacto", () => {
    expect(datos(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-MIX", dato: { gravado: "8.97" } }).dato).toEqual({ gravado: "8.97" });
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-MIX", dato: { gravado: "8.971" } })).toBe(false);
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-MIX", dato: { gravado: 8.97 } })).toBe(false);
  });

  it("dato con destino (R-NEW): un destino válido", () => {
    expect(datos(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-NEW", dato: { destino: "DNG" } }).dato).toEqual({ destino: "DNG" });
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-NEW", dato: { destino: "XX" } })).toBe(false);
  });

  it("dato vacío o de otra forma no pasa", () => {
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-MIX", dato: {} })).toBe(false);
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-MIX", dato: "8.97" })).toBe(false);
    expect(ok(aceptarSugerenciaSchema, { versionBase: 1, regla: "R-MIX", dato: null })).toBe(false);
  });

  it("exige versionBase", () => {
    expect(ok(aceptarSugerenciaSchema, { regla: "R-ISC" })).toBe(false);
  });
});

describe("excluir, restaurar y descartar", () => {
  it("excluir: motivo opcional", () => {
    expect(ok(excluirCompraSchema, { versionBase: 1 })).toBe(true);
    expect(datos(excluirCompraSchema, { versionBase: 1, motivo: "zapatillas" }).motivo).toBe("zapatillas");
  });

  it("excluir: motivo de hasta 200 caracteres (200 sí, 201 no)", () => {
    expect(ok(excluirCompraSchema, { versionBase: 1, motivo: "a".repeat(200) })).toBe(true);
    expect(ok(excluirCompraSchema, { versionBase: 1, motivo: "a".repeat(201) })).toBe(false);
  });

  it("excluir: motivo que no es texto se rechaza", () => {
    expect(ok(excluirCompraSchema, { versionBase: 1, motivo: 5 })).toBe(false);
    expect(ok(excluirCompraSchema, { versionBase: 1, motivo: ["a"] })).toBe(false);
  });

  it("excluir exige versionBase", () => {
    expect(ok(excluirCompraSchema, { motivo: "x" })).toBe(false);
  });

  it.each([
    ["restaurar", restaurarCompraSchema],
    ["descartar", descartarCompraSchema],
  ] as const)("%s: solo versionBase", (_n, esquema) => {
    expect(datos(esquema, { versionBase: 4, motivo: "no va", tenantId: randomUUID() })).toEqual({ versionBase: 4 });
    expect(ok(esquema, {})).toBe(false);
    expect(ok(esquema, { versionBase: 0 })).toBe(false);
  });
});

describe("agregarCompraSchema (D-7, HU-18)", () => {
  const valido = {
    tipo: "01",
    serie: "F001",
    numero: "123",
    proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" },
    fecha: "2026-10-05",
    moneda: "PEN",
    montos: { biDg: "100.00", igvDg: "18.00" },
  };
  const con = (over: Record<string, unknown>) => ({ ...valido, ...over });

  it("acepta una compra en PEN sin tipo de cambio", () => {
    const d = datos(agregarCompraSchema, valido);
    expect(d.montos).toEqual({ biDg: "100.00", igvDg: "18.00" });
    expect(d.serie).toBe("F001");
  });

  it("acepta una compra en USD con tipo de cambio", () => {
    expect(ok(agregarCompraSchema, con({ moneda: "USD", tipoCambio: "3.300" }))).toBe(true);
    expect(ok(agregarCompraSchema, con({ moneda: "USD", tipoCambio: "3.3" }))).toBe(true);
  });

  it("USD sin tipo de cambio se rechaza", () => {
    expect(ok(agregarCompraSchema, con({ moneda: "USD" }))).toBe(false);
  });

  it("PEN con tipo de cambio se rechaza (como TC_INVALIDO de 012)", () => {
    expect(ok(agregarCompraSchema, con({ tipoCambio: "3.300" }))).toBe(false);
  });

  it.each(["0", "0.000", "-3.3", "3.3333", "abc", "", "12345.000", 3.3])("tipo de cambio inválido en USD (%j)", (tc) => {
    expect(ok(agregarCompraSchema, con({ moneda: "USD", tipoCambio: tc }))).toBe(false);
  });

  it.each(["EUR", "pen", "", null, 1])("moneda inválida (%j)", (m) => {
    expect(ok(agregarCompraSchema, con({ moneda: m }))).toBe(false);
  });

  it.each([
    ["tipo", ["1", "001", "ab", "", 1]],
    ["serie", ["", "TOOLONG", "F 01", "F-01", 1]],
    ["numero", ["", "123456789", "abc", "12 3", "-1", 1]],
    ["fecha", ["05/10/2026", "2026-13-01", "2026-02-30", "2026-10-5", "2026-10-05T00:00:00Z", "", 20261005]],
  ] as const)("campo %s inválido", (campo, malos) => {
    for (const v of malos) expect(ok(agregarCompraSchema, con({ [campo]: v })), `${campo}=${JSON.stringify(v)}`).toBe(false);
  });

  it("proveedor: tipo, número y razón social son texto", () => {
    expect(ok(agregarCompraSchema, con({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: 5 } }))).toBe(false);
    expect(ok(agregarCompraSchema, con({ proveedor: { tipo: 6, numero: "20100070970", razonSocial: "X" } }))).toBe(false);
    expect(ok(agregarCompraSchema, con({ proveedor: { tipo: "6", numero: 20100070970, razonSocial: "X" } }))).toBe(false);
    expect(ok(agregarCompraSchema, con({ proveedor: "20100070970" }))).toBe(false);
    expect(ok(agregarCompraSchema, { ...valido, proveedor: undefined })).toBe(false);
  });

  it("la razón social es texto no confiable: cualquier cadena se guarda tal cual, sin interpretarse", () => {
    const peligrosa = '=HYPERLINK("http://x")<script>alert(1)</script>';
    const d = datos(agregarCompraSchema, con({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: peligrosa } }));
    expect((d.proveedor as { razonSocial: string }).razonSocial).toBe(peligrosa);
  });

  it.each(COLUMNAS)("montos.%s: rechaza number, 3 decimales y fuera de rango", (c) => {
    expect(ok(agregarCompraSchema, con({ montos: { [c]: 100 } }))).toBe(false);
    expect(ok(agregarCompraSchema, con({ montos: { [c]: "0.015" } }))).toBe(false);
    expect(ok(agregarCompraSchema, con({ montos: { [c]: "1000000000000.00" } }))).toBe(false);
    expect(ok(agregarCompraSchema, con({ montos: { [c]: "-5.00" } }))).toBe(true);
  });

  it("el total no se envía: no llega a los montos parseados", () => {
    const r = agregarCompraSchema.safeParse(con({ montos: { biDg: "100.00", igvDg: "18.00", total: "118.00" } }));
    if (r.success) expect((r.data as { montos: Record<string, unknown> }).montos).not.toHaveProperty("total");
  });

  it("exige montos", () => {
    expect(ok(agregarCompraSchema, { ...valido, montos: undefined })).toBe(false);
    expect(ok(agregarCompraSchema, con({ montos: "100.00" }))).toBe(false);
  });

  it("descarta claves desconocidas (origen, clienteId, tenantId, version)", () => {
    const d = datos(agregarCompraSchema, con({ origen: "sire", clienteId: randomUUID(), tenantId: randomUUID(), version: 9 }));
    for (const k of ["origen", "clienteId", "tenantId", "version"]) expect(d).not.toHaveProperty(k);
  });
});

describe("estadoPeriodoSchema (D-9)", () => {
  it.each(["abierto", "revisado", "generado"])("acepta %j", (e) => {
    expect(ok(estadoPeriodoSchema, e)).toBe(true);
  });
  it.each(["cerrado", "ABIERTO", "Abierto", "", " abierto", null, 1, undefined])("rechaza %j", (e) => {
    expect(ok(estadoPeriodoSchema, e)).toBe(false);
  });

  it("respuesta de revisar y reabrir: estado, quién y cuándo", () => {
    const por = randomUUID();
    expect(datos(estadoPeriodoRespuestaSchema, { estado: "revisado", por, en: "2026-11-06T12:00:00.000Z" })).toEqual({
      estado: "revisado",
      por,
      en: "2026-11-06T12:00:00.000Z",
    });
  });

  it("un periodo abierto desde la primera descarga todavía no tiene autor ni fecha", () => {
    expect(ok(estadoPeriodoRespuestaSchema, { estado: "abierto", por: null, en: null })).toBe(true);
  });

  it.each([
    ["estado inválido", { estado: "cerrado", por: null, en: null }],
    ["por no es uuid", { estado: "revisado", por: "pepe", en: "2026-11-06T12:00:00.000Z" }],
    ["en no es fecha", { estado: "revisado", por: randomUUID(), en: "ayer" }],
    ["sin estado", { por: null, en: null }],
  ])("rechaza %s", (_n, v) => {
    expect(ok(estadoPeriodoRespuestaSchema, v)).toBe(false);
  });
});

describe("montoDecimalSchema: bigint", () => {
  it("rechaza un bigint", () => {
    expect(ok(montoDecimalSchema, 10n)).toBe(false);
  });
});
