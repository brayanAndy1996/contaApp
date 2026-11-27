/**
 * Spec 041 · T10 · Ronda adversarial 1 (CAJA NEGRA). Solo spec, plan (Contratos) e interfaz pública de `@contapp/sunat`.
 * Todo contra el servidor SUNAT falso en 127.0.0.1 con fixtures sintéticos; nada sale a internet ni duerme.
 * Cada `it` reúne variantes de un mismo ataque y falla con la lista de variantes que no se comportaron como pide la spec.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ErrorDatos,
  ErrorDatosSire,
  ErrorPortal,
  ErrorPortalSire,
  HttpSireApiClient,
  HttpSireAuth,
  type PropuestaSire,
  type SolicitudPropuesta,
  type TokenSire,
} from "../index.js";
import {
  CANARIOS,
  PERIODO,
  RUC,
  RUTAS,
  archivo,
  contarFilas,
  credencial,
  crearEntorno,
  cuerpoTicket,
  cuerpoToken,
  fixture,
  guionarFlujo,
  registroTicket,
  relojVirtual,
  sinSecretos,
  zip,
  type EntornoFalso,
  type ParteFalsa,
  type RelojVirtual,
} from "./pruebas/ayudas-http.js";
import { aBytes, conCelda, conPeriodo, indiceColumna, leerTabla, zipSyncDe } from "./pruebas/ayudas-txt.js";

const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const T = "202610000001";
const TXT_C = "20700000002-20261101-1030-propuesta.txt";
const TXT_V = "LE20700000002202611001404001EXP2.txt";
const COMPRAS = () => fixture("compras-propuesta-202610.txt");
const VENTAS = () => fixture("ventas-propuesta-202610.txt");
const RS_PROV = "Apellidos Nombres/ Razón  Social";

let ent: EntornoFalso;
let reloj: RelojVirtual;
beforeEach(async () => {
  ent = await crearEntorno();
  reloj = relojVirtual();
});
afterEach(async () => {
  await ent.cerrar();
});

function cliente(): HttpSireApiClient {
  return new HttpSireApiClient({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });
}
function auth(): HttpSireAuth {
  return new HttpSireAuth({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });
}
function parte(nombreZip: string, z: Uint8Array): ParteFalsa {
  return { nombre: nombreZip, zip: z };
}
function parteTxt(libro: "compras" | "ventas", txt: Uint8Array, nombreZip = "p1.zip"): ParteFalsa {
  return parte(nombreZip, zip(libro === "compras" ? TXT_C : TXT_V, txt));
}

type Resultado = { r: PropuestaSire; e?: undefined } | { r?: undefined; e: unknown };
async function bajar(libro: "compras" | "ventas", partes: ParteFalsa[]): Promise<Resultado> {
  ent.sire.reiniciar();
  guionarFlujo(ent.sire, { libro, numTicket: T, partes });
  try {
    return { r: await cliente().descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro }) };
  } catch (e) {
    return { e };
  }
}
/** «ErrorPortalSire:zip_invalido», «ok(9 filas)», etc. */
function forma(x: Resultado): string {
  if (x.r !== undefined) return `ok(${x.r.filas.length} filas)`;
  const e = x.e as { constructor?: { name?: string }; detalle?: unknown };
  return `${e.constructor?.name ?? typeof e}:${String(e.detalle ?? "-")}`;
}
function esPortal(x: Resultado, detalle?: string): boolean {
  return x.e instanceof ErrorPortalSire && (detalle === undefined || x.e.detalle === detalle);
}
function esDatos(x: Resultado, ...detalles: string[]): boolean {
  return x.e instanceof ErrorDatosSire && (detalles.length === 0 || detalles.includes(x.e.detalle));
}

// ── ZIP ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("adv · ZIP", () => {
  it("entradas con ruta, directorio o ZIP anidado -> ErrorPortalSire zip_invalido", async () => {
    const txt = COMPRAS();
    const casos: Record<string, Uint8Array> = {
      "../x.txt": zipSyncDe("../x.txt", txt),
      "/abs.txt": zipSyncDe("/abs.txt", txt),
      "./x.txt": zipSyncDe("./x.txt", txt),
      "sub\\x.txt": zipSyncDe("sub\\x.txt", txt),
      "dir/x.txt": zipSyncDe("dir/x.txt", txt),
      "C:/x.txt": zipSyncDe("C:/x.txt", txt),
      "carpeta/ (solo directorio)": zipSyncDe("carpeta/", new Uint8Array(0)),
      "x.zip (ZIP dentro del ZIP)": zipSyncDe("x.zip", zip(TXT_C, txt)),
    };
    const fallos: string[] = [];
    for (const [caso, z] of Object.entries(casos)) {
      const x = await bajar("compras", [parte("p1.zip", z)]);
      if (!esPortal(x, "zip_invalido")) fallos.push(`${caso} -> ${forma(x)}`);
    }
    expect(fallos).toEqual([]);
  });

  it("CRC falso o tamaño descomprimido declarado falso (entrada deflate) -> zip_invalido", async () => {
    const base = Buffer.from(zipSyncDe(TXT_C, COMPRAS()));
    const finCentral = base.length - 22;
    expect(base.readUInt32LE(finCentral)).toBe(0x06054b50);
    const central = base.readUInt32LE(finCentral + 16);
    expect(base.readUInt32LE(central)).toBe(0x02014b50);
    expect(base.readUInt16LE(8)).toBe(8); // deflate

    const crcFalso = Buffer.from(base);
    crcFalso.writeUInt32LE((crcFalso.readUInt32LE(14) ^ 0x5a5a5a5a) >>> 0, 14);
    crcFalso.writeUInt32LE((crcFalso.readUInt32LE(central + 16) ^ 0x5a5a5a5a) >>> 0, central + 16);

    const tamFalso = Buffer.from(base);
    const real = tamFalso.readUInt32LE(22);
    tamFalso.writeUInt32LE(Math.floor(real / 2), 22);
    tamFalso.writeUInt32LE(Math.floor(real / 2), central + 24);

    const fallos: string[] = [];
    for (const [caso, z] of [["crc", crcFalso], ["tamano", tamFalso]] as const) {
      const x = await bajar("compras", [parte("p1.zip", new Uint8Array(z))]);
      if (!esPortal(x, "zip_invalido")) fallos.push(`${caso} -> ${forma(x)}`);
    }
    expect(fallos).toEqual([]);
  });

  it("dos ZIP concatenados en un mismo archivo (contrabando de una 2.ª entrada) -> zip_invalido", async () => {
    const a = zip("a.txt", COMPRAS());
    const b = zip("b.txt", fixture("compras-propuesta-202610-ruc-ajeno.txt"));
    const x = await bajar("compras", [parte("p1.zip", new Uint8Array(Buffer.concat([a, b])))]);
    expect(forma(x)).toBe("ErrorPortalSire:zip_invalido");
  });
});

// ── TXT ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("adv · TXT", () => {
  it("bytes no UTF-8 en una FILA (no solo en el encabezado) o UTF-16 -> ErrorPortalSire, sin U+FFFD silencioso", async () => {
    const base = Buffer.from(COMPRAS());
    const i = base.indexOf("PRUEBA PROVEEDOR ISC");
    expect(i).toBeGreaterThan(0);
    const invalido = Buffer.from(base);
    invalido[i + 7] = 0xff;
    const sobrelargo = Buffer.from(base);
    sobrelargo[i + 7] = 0xc0; // «/» sobrelargo
    sobrelargo[i + 8] = 0xaf;
    const surrogate = Buffer.from(base);
    surrogate[i + 7] = 0xed; // U+D800 suelto
    surrogate[i + 8] = 0xa0;
    surrogate[i + 9] = 0x80;
    const utf16 = Buffer.from("\ufeff" + Buffer.from(VENTAS()).toString("utf8").replace(/^\ufeff/, ""), "utf16le");

    const fallos: string[] = [];
    for (const [caso, libro, b, detalle] of [
      ["0xFF en razón social", "compras", invalido, "codificacion"],
      ["UTF-8 sobrelargo", "compras", sobrelargo, "codificacion"],
      ["surrogate suelto", "compras", surrogate, "codificacion"],
      ["UTF-16LE con BOM", "ventas", utf16, undefined],
    ] as const) {
      const x = await bajar(libro, [parteTxt(libro, new Uint8Array(b))]);
      if (!esPortal(x, detalle)) fallos.push(`${caso} -> ${forma(x)}`);
    }
    expect(fallos).toEqual([]);
  });

  it("celdas de más o de menos, `|` dentro de la razón social -> fila_invalida (nunca desplazar columnas)", async () => {
    const mutar = (f: (celdas: string[], iRs: number) => void): Uint8Array => {
      const t = leerTabla(COMPRAS());
      f(t.lineas[1]!, indiceColumna(t, RS_PROV));
      return aBytes(t);
    };
    const casos: Record<string, Uint8Array> = {
      "celda final no vacía tras el | final": mutar((l) => {
        l[l.length - 1] = "X";
      }),
      "dos | finales": mutar((l) => {
        l.push("");
      }),
      "faltan celdas (79 campos)": mutar((l) => {
        l.splice(-2, 2);
      }),
      "| dentro de la razón social": mutar((l, i) => {
        l[i] = "PRUEBA|PROVEEDOR ISC S.A.C.";
      }),
      "| en la razón social y sin | final (mismo número de campos)": mutar((l, i) => {
        l[i] = "PRUEBA|770.00";
        l.pop();
      }),
    };
    const fallos: string[] = [];
    for (const [caso, txt] of Object.entries(casos)) {
      const x = await bajar("compras", [parteTxt("compras", txt)]);
      if (!esDatos(x, "fila_invalida")) fallos.push(`${caso} -> ${forma(x)}`);
    }
    expect(fallos).toEqual([]);
  });

  it("montos hostiles en ventas (formato libre) -> fila_invalida; nunca Number(), nunca redondeo", async () => {
    const hostiles = [
      "1e3", "1E+3", "5e2", "1,000", "1.000,00", "0x1F4", "0b11", "Infinity", "NaN", "+500", "500.", ".5",
      "1.005", "1837.555", "1000000000000", "--5", "5-", "５００", "500 0", "500\u00a0",
    ];
    const fallos: string[] = [];
    for (const v of hostiles) {
      const x = await bajar("ventas", [parteTxt("ventas", conCelda(VENTAS(), 1, "BI Gravada", v))]);
      if (!esDatos(x, "fila_invalida")) fallos.push(`${JSON.stringify(v)} -> ${forma(x)}`);
    }
    // Control positivo: límites de NUMERIC(14,2) y signo, exactos como cadena.
    for (const [v, esperado] of [["999999999999.99", "999999999999.99"], ["-1837.5", "-1837.50"], ["7", "7.00"]] as const) {
      const x = await bajar("ventas", [parteTxt("ventas", conCelda(VENTAS(), 1, "BI Gravada", v))]);
      const obtenido = x.r !== undefined ? (x.r.filas[0] as { baseGravada: string }).baseGravada : forma(x);
      if (obtenido !== esperado) fallos.push(`${v} -> ${obtenido} (se esperaba ${esperado})`);
    }
    expect(fallos).toEqual([]);
  });

  it("P-2: «cero» disfrazado en una columna sin equivalente (0e5, 0x0, 0.000) no pasa como cero", async () => {
    const fallos: string[] = [];
    for (const v of ["0e5", "0x0", "0.000", "-0e0", "0.0.0", "00x"]) {
      const xv = await bajar("ventas", [parteTxt("ventas", conCelda(VENTAS(), 1, "Dscto BI", v))]);
      if (!esDatos(xv, "fila_invalida")) fallos.push(`ventas Dscto BI ${JSON.stringify(v)} -> ${forma(xv)}`);
      const xc = await bajar("compras", [parteTxt("compras", conCelda(COMPRAS(), 1, "IMB", v))]);
      if (!esDatos(xc, "fila_invalida")) fallos.push(`compras IMB ${JSON.stringify(v)} -> ${forma(xc)}`);
    }
    // Controles: vacío, 0 y 0.00 sí pasan; un monto real va a columna_no_soportada.
    for (const v of ["", "0", "0.00"]) {
      const x = await bajar("ventas", [parteTxt("ventas", conCelda(VENTAS(), 1, "Dscto BI", v))]);
      if (x.e !== undefined) fallos.push(`control ${JSON.stringify(v)} -> ${forma(x)}`);
    }
    const real = await bajar("ventas", [parteTxt("ventas", conCelda(VENTAS(), 1, "Dscto BI", "0.01"))]);
    if (!esDatos(real, "columna_no_soportada")) fallos.push(`control 0.01 -> ${forma(real)}`);
    expect(fallos).toEqual([]);
  });

  it("fecha imposible o mal formada, moneda no soportada, USD sin tipo de cambio válido -> fila_invalida", async () => {
    const casos: [string, string, string, number][] = [
      ...["31/02/2026", "29/02/2025", "00/10/2026", "32/10/2026", "05/13/2026", "5/10/2026", "2026-10-05", "05/10/26", "05-10-2026", "05/10/2026 00:00"].map(
        (v) => ["Fecha de emisión", v, `fecha ${v}`, 1] as [string, string, string, number],
      ),
      ["Moneda", "pen", "moneda pen", 1],
      ["Moneda", "EUR", "moneda EUR", 1],
      ["Moneda", "", "moneda vacía", 1],
      ["Tipo de Cambio", "", "USD sin TC", 4],
      ["Tipo de Cambio", "3,300", "USD TC 3,300", 4],
      ["Tipo de Cambio", "3.3000", "USD TC 4 decimales", 4],
      ["Tipo de Cambio", "-3.300", "USD TC negativo", 4],
      ["Tipo de Cambio", "3e0", "USD TC exponente", 4],
    ];
    const fallos: string[] = [];
    for (const [col, v, caso, fila] of casos) {
      const x = await bajar("compras", [parteTxt("compras", conCelda(COMPRAS(), fila, col, v))]);
      if (!esDatos(x, "fila_invalida")) fallos.push(`${caso} -> ${forma(x)}`);
    }
    const bisiesto = await bajar("compras", [parteTxt("compras", conCelda(COMPRAS(), 1, "Fecha de emisión", "29/02/2028"))]);
    const f = bisiesto.r !== undefined ? bisiesto.r.filas[0]?.fechaEmision : forma(bisiesto);
    if (f !== "2028-02-29") fallos.push(`29/02/2028 -> ${String(f)}`);
    expect(fallos).toEqual([]);
  });
});

// ── Filas ajenas, solicitud hostil, partes ──────────────────────────────────────────────────────────────────
describe("adv · filas ajenas y solicitud", () => {
  it("RUC o Periodo vacío en una fila, o periodo ajeno en la 2.ª parte -> ErrorDatos sin filas", async () => {
    const fallos: string[] = [];
    for (const [col, caso] of [["RUC", "RUC vacío"], ["Periodo", "Periodo vacío"]] as const) {
      const x = await bajar("compras", [parteTxt("compras", conCelda(COMPRAS(), 3, col, ""))]);
      if (!esDatos(x, "respuesta_ajena", "fila_invalida")) fallos.push(`${caso} -> ${forma(x)}`);
    }
    const ventasRucVacio = await bajar("ventas", [parteTxt("ventas", conCelda(VENTAS(), 2, "Ruc", " "))]);
    if (!esDatos(ventasRucVacio, "respuesta_ajena", "fila_invalida")) fallos.push(`ventas Ruc " " -> ${forma(ventasRucVacio)}`);
    const dosPartes = await bajar("ventas", [
      parteTxt("ventas", fixture("ventas-propuesta-202610-parte1.txt"), "v1.zip"),
      parteTxt("ventas", conPeriodo(fixture("ventas-propuesta-202610-parte2.txt"), "202609"), "v2.zip"),
    ]);
    if (!esDatos(dosPartes, "respuesta_ajena")) fallos.push(`parte 2 de otro periodo -> ${forma(dosPartes)}`);
    expect(fallos).toEqual([]);
  });

  it("periodo, RUC o libro hostiles en la solicitud -> ErrorDatos sin llamar a SUNAT", async () => {
    const casos: SolicitudPropuesta[] = [
      { ruc: RUC, periodo: "202610/../../x", libro: "compras" },
      { ruc: RUC, periodo: "2026%2F10", libro: "compras" },
      { ruc: RUC, periodo: "20261", libro: "compras" },
      { ruc: RUC, periodo: "202613", libro: "ventas" },
      { ruc: RUC, periodo: "", libro: "ventas" },
      { ruc: RUC, periodo: "202610?x=1", libro: "ventas" },
      { ruc: "2070000000X", periodo: PERIODO, libro: "compras" },
      { ruc: "", periodo: PERIODO, libro: "compras" },
      { ruc: RUC, periodo: PERIODO, libro: "otro" as "compras" },
    ];
    const fallos: string[] = [];
    for (const s of casos) {
      ent.sire.reiniciar();
      let e: unknown;
      try {
        await cliente().descargarPropuesta(TOKEN, s);
      } catch (err) {
        e = err;
      }
      const llamadas = ent.sire.peticiones.map((p) => p.ruta);
      if (!(e instanceof ErrorDatos) || llamadas.length > 0) {
        fallos.push(`${JSON.stringify(s)} -> ${forma({ e })}, llamadas ${JSON.stringify(llamadas)}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it("la misma parte listada dos veces en archivoReporte no duplica las filas", async () => {
    const p = parteTxt("compras", COMPRAS(), "repetida.zip");
    const x = await bajar("compras", [p, p]);
    const n = contarFilas(COMPRAS());
    const ok = esPortal(x) || (x.r !== undefined && x.r.filas.length === n);
    expect(ok, `obtenido ${forma(x)}; el TXT tiene ${n} filas`).toBe(true);
  });
});

// ── HTTP: redirecciones y respuestas inesperadas ────────────────────────────────────────────────────────────
describe("adv · HTTP", () => {
  it("3xx en token, exportar, ticket y archivo: no se siguen, ErrorPortal, el tercero no recibe nada, sin secretos", async () => {
    const destino = `${ent.ajeno.origen}/robar?t=${encodeURIComponent(CANARIOS.token)}&s=${CANARIOS.clientSecret}`;
    const fallos: string[] = [];

    ent.seguridad.guionar("POST", RUTAS.token(), { estado: 307, cabeceras: { location: destino } });
    let e: unknown;
    try {
      await auth().obtenerToken(credencial());
    } catch (err) {
      e = err;
    }
    if (!(e instanceof ErrorPortal)) fallos.push(`token 307 -> ${forma({ e })}`);
    if (e instanceof Error) sinSecretos(e);

    for (const [paso, estado] of [["exportar", 302], ["ticket", 308], ["archivo", 301]] as const) {
      ent.sire.reiniciar();
      guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteTxt("compras", COMPRAS())] });
      const ruta = paso === "exportar" ? RUTAS.exportarRce() : paso === "ticket" ? RUTAS.ticket : RUTAS.archivo;
      ent.sire.guionar("GET", ruta, { estado, cabeceras: { location: destino } });
      let e2: unknown;
      try {
        await cliente().descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" });
      } catch (err) {
        e2 = err;
      }
      if (!(e2 instanceof ErrorPortal)) fallos.push(`${paso} ${estado} -> ${forma({ e: e2 })}`);
      if (e2 instanceof Error) sinSecretos(e2);
    }
    expect(ent.ajeno.peticiones.map((p) => p.ruta)).toEqual([]);
    expect(fallos).toEqual([]);
  });

  it("200/204 con cuerpo fuera de esquema en exportar o ticket -> ErrorPortalSire sin secretos (aunque el cuerpo repita el token)", async () => {
    const eco = `Bearer ${CANARIOS.token}`;
    const listo = (extra: Record<string, unknown>) =>
      cuerpoTicket([registroTicket(T, "04", [archivo("p1.zip")], extra)]);
    const casos: [string, "exportar" | "ticket", Parameters<EntornoFalso["sire"]["guionar"]>[2]][] = [
      ["exportar HTML", "exportar", { texto: `<html>${eco}</html>`, cabeceras: { "content-type": "text/html" } }],
      ["exportar numTicket numérico", "exportar", { json: { numTicket: 202610000001 } }],
      ["exportar numTicket vacío", "exportar", { json: { numTicket: "" } }],
      ["exportar numTicket arreglo con eco", "exportar", { json: { numTicket: [eco] } }],
      ["exportar null", "exportar", { json: null }],
      ["exportar 204", "exportar", { estado: 204 }],
      ["ticket registros null", "ticket", { json: { paginacion: {}, registros: null, eco } }],
      ["ticket estado numérico 4", "ticket", { json: listo({ codEstadoProceso: 4 }) }],
      ["ticket estado «4»", "ticket", { json: listo({ codEstadoProceso: "4", eco }) }],
      ["ticket archivoReporte cadena", "ticket", { json: listo({ archivoReporte: "p1.zip" }) }],
      ["ticket numTicket con espacio", "ticket", { json: cuerpoTicket([registroTicket(`${T} `, "04", [archivo("p1.zip")])]) }],
    ];
    const fallos: string[] = [];
    for (const [caso, paso, respuesta] of casos) {
      ent.sire.reiniciar();
      guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteTxt("compras", COMPRAS())] });
      ent.sire.guionar("GET", paso === "exportar" ? RUTAS.exportarRce() : RUTAS.ticket, respuesta);
      let e: unknown;
      try {
        await cliente().descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" });
      } catch (err) {
        e = err;
      }
      const aceptable =
        e instanceof ErrorPortalSire || (caso === "ticket numTicket con espacio" && e instanceof ErrorDatosSire);
      if (!aceptable) fallos.push(`${caso} -> ${forma({ e })}`);
      if (e instanceof Error) sinSecretos(e);
      if (ent.sire.peticionesDe("GET", RUTAS.archivo).length > 0) fallos.push(`${caso}: descargó el archivo`);
    }
    expect(fallos).toEqual([]);
  });

  it("token 200 con expires_in o access_token inválidos -> ErrorPortal (nunca Invalid Date ni ErrorTransitorio)", async () => {
    const casos: [string, Record<string, unknown>][] = [
      ["expires_in 1e13 (fecha fuera de rango)", { expires_in: 1e13 }],
      ["expires_in negativo", { expires_in: -5 }],
      ["expires_in cadena", { expires_in: "3600" }],
      ["expires_in null", { expires_in: null }],
      ["access_token vacío", { access_token: "" }],
      ["access_token numérico", { access_token: 12345 }],
      ["access_token con CRLF (inyección de cabecera)", { access_token: `${CANARIOS.token}\r\nX-Inyectada: 1` }],
    ];
    const fallos: string[] = [];
    for (const [caso, extra] of casos) {
      ent.seguridad.reiniciar();
      ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken(extra) });
      let e: unknown;
      let token: TokenSire | undefined;
      try {
        token = await auth().obtenerToken(credencial());
      } catch (err) {
        e = err;
      }
      if (!(e instanceof ErrorPortal)) {
        const visto = token === undefined ? forma({ e }) : `resolvió con expiraEn ${String(token.expiraEn.getTime())}`;
        fallos.push(`${caso} -> ${visto}`);
      }
      if (e instanceof Error) sinSecretos(e);
    }
    expect(fallos).toEqual([]);
  });
});

// ── Secretos (canarios) en datos y errores ──────────────────────────────────────────────────────────────────
describe("adv · secretos", () => {
  it("canarios dentro de celdas inválidas no salen en el error; el resultado correcto no lleva el token", async () => {
    const fallos: string[] = [];
    for (const [col, secreto] of [
      ["Moneda", CANARIOS.token],
      ["Fecha de emisión", CANARIOS.clientSecret],
      ["BI Gravado DG", CANARIOS.claveSol],
      ["Nro Doc Identidad", `${CANARIOS.token}|${CANARIOS.claveSol}`],
    ] as const) {
      const x = await bajar("compras", [parteTxt("compras", conCelda(COMPRAS(), 2, col, secreto))]);
      if (!(x.e instanceof ErrorDatos)) fallos.push(`${col} -> ${forma(x)}`);
      if (x.e instanceof Error) sinSecretos(x.e);
    }
    const ok = await bajar("compras", [parteTxt("compras", COMPRAS())]);
    expect(ok.e).toBeUndefined();
    const serial = JSON.stringify(ok.r);
    for (const s of [CANARIOS.token, CANARIOS.clientSecret, CANARIOS.claveSol]) expect(serial).not.toContain(s);
    // La razón social devuelta es la del proveedor, nunca la del contribuyente.
    const contrib = new Set(
      leerTabla(COMPRAS()).lineas.slice(1).map((l) => l[1] ?? ""),
    );
    const prov = (ok.r?.filas ?? []).map((f) => (f as { razonSocialContraparte?: string }).razonSocialContraparte ?? "");
    for (const p of prov) if (contrib.has(p)) fallos.push(`razón social del contribuyente devuelta: ${p}`);
    expect(fallos).toEqual([]);
  });
});

