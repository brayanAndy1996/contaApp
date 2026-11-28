import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CANARIOS,
  PERIODO,
  crearEntorno,
  credencial,
  CLIENT_ID,
  RUC,
  RUTAS,
  fixture,
  cuerpoTicket,
  archivo,
  registroTicket,
  zip,
} from "./ayudas-http.js";
import { sinColumna } from "./ayudas-txt.js";
import { analizarZip, diagnosticarZip, lineasEstructura, nombreSeguro, pareceTextoPlano } from "./estructura-zip.js";
import { ZIP_RARO, noEsZip, zipManual, zipRaro } from "./zip-manual.js";
import {
  CUERPO_422_FALSO,
  CUERPO_503_FALSO,
  contratoDiagnostico,
  contratoLibro,
  contratoRegistro,
  contratoToken,
  credencialesDelEntorno,
  crearFetchObservado,
  describirFallo,
  diagnosticoActivo,
  guionarSolicitudRegistroFalsa,
  informeRegistro,
  lineaFallo,
  lineaToken,
  lineaTotales,
  lineasLibro,
  nuevasObservaciones,
  prepararServidorFalso,
  sumarTotalesP5,
  TICKET_REGISTRO_FALSO,
  VARIABLES_CONTRATO,
  type ServidorContratoFalso,
} from "./contrato-sire.js";

// Prueba normal (sin SUNAT, sin .env, sin esperas): comprueba el núcleo de la prueba de contrato manual contra el
// servidor falso en 127.0.0.1 y que su salida y sus guardas cumplen CA-15 (solo formas; solo POST del token y GET).
const sinEsperar = (): Promise<void> => Promise.resolve();
const rucs = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "..", "fixtures", "rucs-prueba.json"), "utf8")) as {
  ruc: string;
  razonSocial: string;
}[];

describe("contrato SIRE contra el servidor falso", () => {
  let srv: ServidorContratoFalso;
  beforeAll(async () => {
    srv = await prepararServidorFalso();
    srv.entrada.dormir = sinEsperar;
  });
  afterAll(async () => {
    await srv.cerrar();
  });

  it("token y los dos libros pasan con forma completa y solo hacen POST del token y GET", async () => {
    const { informe: t, token } = await contratoToken(srv.entrada);
    expect(t.tokenNoVacio).toBe(true);
    expect(t.segundosDeVida).toBeGreaterThan(0);
    expect(t.campos).toEqual(expect.arrayContaining(["access_token", "expires_in"]));

    const compras = await contratoLibro(srv.entrada, token, "compras");
    const ventas = await contratoLibro(srv.entrada, token, "ventas");
    for (const i of [compras, ventas]) {
      expect(i.error).toBeNull();
      expect(i.ticket.estados).toEqual(["01", "04"]);
      expect(i.ticket.partes).toBe(1);
      expect(i.archivos).toHaveLength(1);
      expect(i.archivos[0]).toMatchObject({ zipLegible: true, encabezadoCoincide: true, faltantes: [], sobrantes: [] });
      expect(i.filas).toMatchObject({
        fechaInvalida: 0,
        monedaInvalida: 0,
        montoInvalido: 0,
        tipoCambioInvalido: 0,
        tipoInvalido: 0,
        numeroVacio: 0,
      });
      expect(i.filas?.total).toBeGreaterThan(0);
    }
    expect(compras.archivos[0]?.columnas).toBe(80);
    expect(ventas.archivos[0]?.columnas).toBe(40);
    // El fixture trae NC negativas y USD con TC (P-5): el informe lo cuenta sin mostrar valores.
    expect(compras.filas?.notasCredito).toBeGreaterThan(0);
    expect(compras.filas?.notasCreditoConTotalNegativo).toBe(compras.filas?.notasCredito);
    expect(compras.filas?.usd).toBe(compras.filas?.usdConTipoCambio);

    const metodos = srv.sire.peticiones.map((p) => p.metodo);
    expect(metodos.every((m) => m === "GET")).toBe(true);
    expect(srv.sire.sinGuion).toHaveLength(0);
  });

  it("la salida no contiene valores: ni RUC, razones sociales, canarios, tickets ni números largos", async () => {
    const lineas: string[] = [];
    const entrada = { ...srv.entrada, emitir: (l: string) => lineas.push(l) };
    const { token } = await contratoToken(entrada);
    await contratoLibro(entrada, token, "compras");
    await contratoLibro(entrada, token, "ventas");
    const salida = lineas.join("\n");
    expect(lineas.length).toBeGreaterThanOrEqual(7);
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);

    const fixtures = [fixture("compras-propuesta-202610.txt"), fixture("ventas-propuesta-202610.txt")];
    const celdasDeDatos = fixtures
      .flatMap((b) => Buffer.from(b).toString("utf8").split("\n").slice(1))
      .flatMap((fila) => fila.split("|"))
      .filter((c) => c.length >= 6 && c !== PERIODO);
    expect(celdasDeDatos.length).toBeGreaterThan(0);
    for (const v of [
      ...rucs.flatMap((r) => [r.ruc, r.razonSocial]),
      ...Object.values(CANARIOS),
      "202610000001",
      "202610000002",
      ...celdasDeDatos,
    ]) {
      expect(salida.includes(v), "la salida repite un valor de los datos").toBe(false);
    }
    expect(/\d{8,}/.test(salida), "la salida trae un número largo").toBe(false);
  });

  it("un encabezado sin una columna requerida queda como error de encabezado y nombra la columna que falta", async () => {
    const { token } = await contratoToken(srv.entrada);
    const original = srv.sire.peticionesDe("GET", RUTAS.archivo).length;
    srv.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: "202610000009" } });
    srv.sire.guionar("GET", RUTAS.ticket, {
      json: cuerpoTicket([registroTicket("202610000009", "04", [archivo("falta-columna.zip")])]),
    });
    srv.sire.guionar("GET", RUTAS.archivo, {
      bytes: zip("falta-columna.txt", sinColumna(fixture("compras-propuesta-202610.txt"), "Total CP")),
    });
    const i = await contratoLibro(srv.entrada, token, "compras");
    expect(srv.sire.peticionesDe("GET", RUTAS.archivo).length).toBe(original + 1);
    expect(i.error).toEqual({ clase: "ErrorPortalSire", detalle: "encabezado" });
    expect(i.filas).toBeNull();
    expect(i.archivos[0]).toMatchObject({ zipLegible: true, columnas: 79, encabezadoCoincide: false, faltantes: ["Total CP"] });
    expect(lineasLibro("202610", i).join("\n")).toContain("FALLÓ ErrorPortalSire encabezado");
  });
});

describe("contrato SIRE · registro presentado de compras (5.51) contra el servidor falso", () => {
  let srv: ServidorContratoFalso;
  let token: Awaited<ReturnType<typeof contratoToken>>["token"];
  beforeAll(async () => {
    srv = await prepararServidorFalso();
    srv.entrada.dormir = sinEsperar;
    token = (await contratoToken(srv.entrada)).token;
  });
  afterAll(async () => {
    await srv.cerrar();
  });
  const solicitudes = () => srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro());
  const T_PEN = TICKET_REGISTRO_FALSO.PEN;
  const T_USD = TICKET_REGISTRO_FALSO.USD;
  const zipRegistro = (nombre: string, txt: string) => ({ nombre, zip: zip(nombre.replace(".zip", ".txt"), fixture(txt)) });
  /** Guiona la solicitud (70 con PEN/USD → un ticket cada una) y el ticket de cada moneda con el fixture que se indique. */
  function guionarMonedas(pen: string, usd: string): void {
    guionarSolicitudRegistroFalsa(srv.sire);
    const partes = new Map([
      [T_PEN, zipRegistro("registro-pen.zip", pen)],
      [T_USD, zipRegistro("registro-usd.zip", usd)],
    ]);
    // Cada ticket sale «01» una vez y luego «04» (el contador es de este guion, no del servidor).
    const consultas = new Map<string, number>();
    srv.sire.guionar("GET", RUTAS.ticket, (p) => {
      const t = p.query["numTicket"] ?? "";
      const parte = partes.get(t);
      if (parte === undefined) return { estado: 404 };
      const n = (consultas.get(t) ?? 0) + 1;
      consultas.set(t, n);
      return { json: cuerpoTicket([registroTicket(t, n === 1 ? "01" : "04", n === 1 ? [] : [archivo(parte.nombre)])]) };
    });
    srv.sire.guionar("GET", RUTAS.archivo, (p) => {
      const parte = [...partes.values()].find((x) => x.nombre === p.query["nomArchivoReporte"]);
      return parte === undefined ? { estado: 404 } : { bytes: parte.zip, cabeceras: { "content-type": "application/zip" } };
    });
  }
  const PEN = "compras-registro-202610-pen.txt";
  const USD = "compras-registro-202610-usd.txt";
  const VACIO = "compras-registro-202610-solo-encabezado.txt";
  const MIXTO = "compras-registro-202610-mixto.txt";
  const sin1070 = { estado: 422, json: { cod: "1070", msg: "No existen datos" } } as const;

  it("modo normal: pide codProceso 70 con PEN y luego con USD, sigue cada ticket hasta el archivo e informa por moneda", async () => {
    const antes = solicitudes().length;
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    expect(i.error).toBeNull();
    const pedidas = solicitudes().slice(antes);
    expect(pedidas.map((p) => [p.query["codProceso"], p.query["codMoneda"]])).toEqual([["70", "PEN"], ["70", "USD"]]);
    expect(pedidas.every((p) => p.query["codTipoArchivo"] === "0" && p.query["codOrigen"] === "2" && p.query["lisPeriodos"] === PERIODO)).toBe(true);
    expect(pedidas.every((p) => p.query["codOrigenEnvio"] === undefined)).toBe(true);
    for (const [moneda, esperadas] of [["PEN", 8], ["USD", 3]] as const) {
      const m = i.porMoneda[moneda];
      expect(m.solicitud).toMatchObject({ codProceso: "70", codMoneda: moneda, estado: 200, campos: ["numTicket"], devolvioTicket: true, errorSunat: null, codigosSunat: [] });
      expect(m.sinDatos).toBe(false);
      expect(m.ticket.estados).toEqual(["01", "04"]);
      expect(m.archivos).toHaveLength(1);
      expect(m.archivos[0]).toMatchObject({ zipLegible: true, columnas: 80, encabezadoCoincide: true, faltantes: [], sobrantes: [], filas: esperadas });
      expect(m.filasPorMoneda).toEqual({ [moneda]: esperadas });
      expect(m.filas?.total).toBe(esperadas);
      expect(m.filas).toMatchObject({ fechaInvalida: 0, monedaInvalida: 0, montoInvalido: 0, tipoCambioInvalido: 0, tipoInvalido: 0, numeroVacio: 0 });
    }
    expect(i.porMoneda.USD.filas?.usd).toBe(3);
    expect(i.filas?.total).toBe(11);
    const salida = lineas.join("\n");
    expect(salida).toContain("registro-presentado 202610 PEN: solicitud codProceso 70 codMoneda PEN HTTP 200");
    expect(salida).toContain("registro-presentado 202610 USD: solicitud codProceso 70 codMoneda USD HTTP 200");
    expect(salida).toContain("devolvió ticket sí");
    expect(salida).toContain("encabezado igual al de la propuesta de compras sí");
    expect(salida).toContain("columna Moneda PEN 8");
    expect(salida).toContain("columna Moneda USD 3");
    expect(salida).toContain("P-5 · NC");
    expect(salida).toContain("registro-presentado 202610: total");
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);
    expect(srv.sire.peticiones.every((p) => p.metodo === "GET" || p.metodo === "POST")).toBe(true);
  });

  it("una moneda sin datos (422 con cod 1070) y la otra con filas: no es fallo; la sin datos no sigue ticket", async () => {
    guionarMonedas(PEN, USD);
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), (p) => (p.query["codMoneda"] === "USD" ? sin1070 : { json: { numTicket: T_PEN } }));
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    expect(i.error).toBeNull();
    expect(i.porMoneda.PEN.sinDatos).toBe(false);
    expect(i.porMoneda.USD).toMatchObject({ sinDatos: true, solicitud: { estado: 422, devolvioTicket: false }, archivos: [], filas: null });
    expect(i.porMoneda.USD.solicitud?.codigosSunat).toEqual(["1070"]);
    expect(i.porMoneda.USD.ticket.consultas).toBe(0);
    expect(i.filas?.total).toBe(8);
    expect(lineas.join("\n")).toContain("registro-presentado 202610 USD: sin datos");
  });

  it("TXT con solo encabezado en una moneda cuenta como «sin datos» de esa moneda (con ticket y archivo legibles)", async () => {
    guionarMonedas(PEN, VACIO);
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.error).toBeNull();
    expect(i.porMoneda.USD).toMatchObject({ sinDatos: true, filasPorMoneda: {} });
    expect(i.porMoneda.USD.archivos[0]).toMatchObject({ zipLegible: true, filas: 0 });
    expect(i.porMoneda.USD.ticket.estados).toEqual(["01", "04"]);
    expect(i.porMoneda.PEN.sinDatos).toBe(false);
  });

  it("PEN y USD sin datos (422 1070 o solo encabezado, cualquier combinación): error sin_datos y las dos monedas «sin datos»", async () => {
    for (const [pen, usd] of [
      [VACIO, VACIO],
      ["1070", "1070"],
      ["1070", VACIO],
      [VACIO, "1070"],
    ] as const) {
      guionarMonedas(pen === "1070" ? PEN : pen, usd === "1070" ? USD : usd);
      srv.sire.guionar("GET", RUTAS.solicitarRegistro(), (p) => {
        const moneda = p.query["codMoneda"] === "USD" ? usd : pen;
        return moneda === "1070" ? sin1070 : { json: { numTicket: p.query["codMoneda"] === "USD" ? T_USD : T_PEN } };
      });
      const lineas: string[] = [];
      const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
      expect(i.porMoneda.PEN.sinDatos && i.porMoneda.USD.sinDatos, `${pen}/${usd}: las dos monedas sin datos`).toBe(true);
      expect(i.filas).toBeNull();
      expect(i.error).toEqual({ clase: "ErrorDatosSire", detalle: "sin_datos" });
      expect(lineas.join("\n")).toContain("FALLÓ ErrorDatosSire sin_datos");
    }
  });

  it("SUNAT rechaza la solicitud (422 1061 u otro): imprime el HTTP y solo cod y msg (sin números largos) y NO lo toma por «sin datos»", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), {
      estado: 422,
      json: { cod: "422", msg: "Unprocessable Entity", errors: [{ cod: "1061", msg: `El campo 'codMoneda' es nulo o vacio ${RUC}` }], detalle: "NO-IMPRIMIR-ESTO", numTicket: CANARIOS.token },
    });
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    expect(i.porMoneda.PEN.sinDatos).toBe(false);
    expect(i.porMoneda.PEN.solicitud).toMatchObject({ codProceso: "70", codMoneda: "PEN", estado: 422, devolvioTicket: false, errorSunat: { cod: "1061", msg: "Unprocessable Entity" } });
    expect(i.porMoneda.PEN.solicitud?.codigosSunat).toEqual(["422", "1061"]);
    expect(i.porMoneda.PEN.fallos).toHaveLength(1);
    expect(i.filas).toBeNull();
    expect(i.error?.clase).toBe("ErrorPortalSire");
    expect(i.error?.detalle).toBe("solicitud_rechazada");
    const salida = lineas.join("\n");
    expect(salida).toContain("HTTP 422");
    expect(salida).toContain("codigosSunat {422,1061}");
    expect(salida).toContain("cod 1061 msg «El campo 'codMoneda' es nulo o vacio #»");
    for (const v of [RUC, "NO-IMPRIMIR-ESTO", CANARIOS.token]) expect(salida.includes(v), "la salida repite un valor del cuerpo").toBe(false);
  });

  it("cod o msg con formas raras se imprimen como «?»", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 400, json: { cod: "<script>alert(1)</script>", msg: "linea\ncon salto" } });
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.porMoneda.PEN.solicitud?.errorSunat).toEqual({ cod: "?", msg: "?" });
    expect(i.porMoneda.PEN.solicitud?.codigosSunat).toEqual([]);
  });

  it("una fila de otra moneda en el TXT de PEN se cuenta por forma (PEN 8, USD 1) y las formas de las filas salen aunque el cliente falle", async () => {
    guionarMonedas(MIXTO, USD);
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    expect(i.porMoneda.PEN.filasPorMoneda).toEqual({ PEN: 8, USD: 1 });
    expect(i.porMoneda.PEN.filas?.total).toBe(9);
    // El cliente corta en la primera moneda con error: USD no se lee.
    expect(i.porMoneda.USD.archivos).toHaveLength(0);
    expect(i.filas).toBeNull();
    expect(lineas.join("\n")).toContain("columna Moneda PEN 8, USD 1");
  });

  it("un encabezado distinto del de la propuesta se informa con las columnas que faltan y sobran, solo en la moneda afectada", async () => {
    guionarMonedas(PEN, USD);
    srv.sire.guionar("GET", RUTAS.archivo, (p) => {
      const nombre = p.query["nomArchivoReporte"] ?? "";
      const base = fixture(nombre === "registro-pen.zip" ? PEN : USD);
      return {
        bytes: zip("x.txt", nombre === "registro-usd.zip" ? sinColumna(base, "Total CP") : base),
        cabeceras: { "content-type": "application/zip" },
      };
    });
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.porMoneda.PEN.archivos[0]).toMatchObject({ encabezadoCoincide: true, faltantes: [], sobrantes: [] });
    expect(i.porMoneda.USD.archivos[0]).toMatchObject({ columnas: 79, encabezadoCoincide: false, faltantes: ["Total CP"], sobrantes: [] });
    expect(i.porMoneda.USD.filas).toBeNull();
    expect(i.error).toEqual({ clase: "ErrorPortalSire", detalle: "encabezado" });
  });

  it("la salida del registro no contiene valores: ni RUC, razones sociales, canarios, tickets ni celdas de datos de PEN y USD", async () => {
    guionarMonedas(PEN, USD);
    const lineas: string[] = [];
    await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    const salida = lineas.join("\n");
    expect(lineas.length).toBeGreaterThanOrEqual(10);
    const celdas = [PEN, USD]
      .flatMap((f) => Buffer.from(fixture(f)).toString("utf8").split("\n").slice(1))
      .flatMap((fila) => fila.split("|"))
      .filter((c) => c.length >= 6 && c !== PERIODO);
    expect(celdas.length).toBeGreaterThan(0);
    for (const v of [...rucs.flatMap((r) => [r.ruc, r.razonSocial]), ...Object.values(CANARIOS), T_PEN, T_USD, ...celdas]) {
      expect(salida.includes(v), "la salida repite un valor de los datos").toBe(false);
    }
    expect(/\d{8,}/.test(salida), "la salida trae un número largo").toBe(false);
  });
});

describe("contrato SIRE · observación del registro por moneda (sin el cliente)", () => {
  let srv: ServidorContratoFalso;
  beforeAll(async () => {
    srv = await prepararServidorFalso();
  });
  afterAll(async () => {
    await srv.cerrar();
  });

  /** Hace a mano lo que hará el cliente (PEN y USD, ticket y archivo de cada uno) con el fetch observado y devuelve el informe. */
  async function recorrer(monedas: readonly ("PEN" | "USD")[]): Promise<ReturnType<typeof informeRegistro>> {
    const obs = nuevasObservaciones("compras", { ruc: RUC, periodo: PERIODO });
    const origenSire = srv.entrada.urlsDePrueba!.sire;
    const f = crearFetchObservado({
      base: globalThis.fetch,
      origenesPermitidos: [origenSire, srv.entrada.urlsDePrueba!.seguridad],
      origenSeguridad: srv.entrada.urlsDePrueba!.seguridad,
      obs,
    });
    const pedir = (ruta: string, q: Record<string, string>): Promise<Response> =>
      f(`${origenSire}${ruta}?${new URLSearchParams(q)}`, { method: "GET" });
    const tickets: Partial<Record<"PEN" | "USD", string>> = {};
    for (const m of monedas) {
      const r = await pedir(RUTAS.solicitarRegistro(), { codTipoArchivo: "0", codProceso: "70", codOrigen: "2", lisPeriodos: PERIODO, codMoneda: m });
      if (r.ok) tickets[m] = ((await r.json()) as { numTicket: string }).numTicket;
    }
    for (const m of monedas) {
      const t = tickets[m];
      if (t === undefined) continue;
      await pedir(RUTAS.ticket, { numTicket: t });
      const r = await pedir(RUTAS.ticket, { numTicket: t });
      const nombre = ((await r.json()) as { registros: { archivoReporte: { nomArchivoReporte: string }[] }[] }).registros[0]?.archivoReporte[0]?.nomArchivoReporte ?? "";
      await pedir(RUTAS.archivo, { nomArchivoReporte: nombre, numTicket: t });
    }
    return informeRegistro(PERIODO, 1, obs, null, null);
  }

  it("atribuye la solicitud por codMoneda y el ticket y el archivo por numTicket: dos tickets, dos informes", async () => {
    const i = await recorrer(["PEN", "USD"]);
    expect(i.porMoneda.PEN.solicitud).toMatchObject({ codProceso: "70", codMoneda: "PEN", estado: 200, devolvioTicket: true });
    expect(i.porMoneda.USD.solicitud).toMatchObject({ codProceso: "70", codMoneda: "USD", estado: 200, devolvioTicket: true });
    expect(i.porMoneda.PEN.ticket.estados).toEqual(["01", "04"]);
    expect(i.porMoneda.USD.ticket.estados).toEqual(["01", "04"]);
    expect(i.porMoneda.PEN).toMatchObject({ filasPorMoneda: { PEN: 8 }, sinDatos: false });
    expect(i.porMoneda.USD).toMatchObject({ filasPorMoneda: { USD: 3 }, sinDatos: false });
    expect(i.porMoneda.PEN.archivos[0]?.encabezadoCoincide).toBe(true);
    expect(i.porMoneda.PEN.filas?.total).toBe(8);
    expect(i.porMoneda.USD.filas?.usdConTipoCambio).toBe(3);
  });

  it("422 al solicitar una moneda: queda en su informe (con cod/msg) y la otra no se ve afectada", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), (p) =>
      p.query["codMoneda"] === "PEN" ? { estado: 422, json: { cod: "422", msg: "x", errors: [{ cod: "1070", msg: "sin datos" }] } } : { json: { numTicket: TICKET_REGISTRO_FALSO.USD } },
    );
    const i = await recorrer(["PEN", "USD"]);
    expect(i.porMoneda.PEN).toMatchObject({ sinDatos: true, solicitud: { estado: 422, devolvioTicket: false }, archivos: [] });
    expect(i.porMoneda.PEN.fallos).toHaveLength(1);
    expect(i.porMoneda.USD).toMatchObject({ sinDatos: false, filasPorMoneda: { USD: 3 } });
    expect(i.porMoneda.USD.fallos).toHaveLength(0);
  });
});

describe("totales P-5/P-6 de varios periodos", () => {
  const forma = (extra: Record<string, number>) => ({
    total: 10,
    fechaInvalida: 0,
    monedaInvalida: 0,
    montoInvalido: 0,
    tipoCambioInvalido: 0,
    tipoInvalido: 0,
    numeroVacio: 0,
    tiposVistos: [],
    monedasVistas: [],
    usd: 0,
    usdConTipoCambio: 0,
    notasCredito: 0,
    notasCreditoConTotalNegativo: 0,
    notasDebito: 0,
    boletas: 0,
    boletasSinDocumento: 0,
    sinDocumento: 0,
    filasConMontoNegativo: 0,
    ...extra,
  });

  it("suma NC, ND, USD con TC, boletas, sin documento y negativos de todos los informes; un periodo sin datos no suma ni falla", () => {
    const t = sumarTotalesP5(3, [
      { filas: forma({ notasCredito: 2, notasCreditoConTotalNegativo: 2, usd: 1, usdConTipoCambio: 1, filasConMontoNegativo: 2 }), error: null },
      { filas: forma({ notasDebito: 1, boletas: 4, boletasSinDocumento: 3, sinDocumento: 3 }), error: null },
      { filas: null, error: { detalle: "sin_datos" } },
      { filas: null, error: { detalle: "codificacion" } },
    ]);
    expect(t).toMatchObject({
      periodos: 3,
      filas: 20,
      notasCredito: 2,
      notasCreditoConTotalNegativo: 2,
      notasDebito: 1,
      usd: 1,
      usdConTipoCambio: 1,
      boletas: 4,
      boletasSinDocumento: 3,
      sinDocumento: 3,
      filasConMontoNegativo: 2,
      erroresCodificacion: 1,
    });
    expect(lineaTotales(t)).toBe(
      "[contrato-sire] totales P-5/P-6 (3 periodo(s), compras+ventas+registro): filas 20 · NC 2 (total negativo 2) · ND 1 · USD 1 (con TC 1) · " +
        "boletas 4 (sin documento 3) · sin documento 3 · filas con algún monto negativo 2 · errores de codificación (P-6) 1",
    );
  });
});

describe("guardas del fetch de la prueba de contrato", () => {
  const origen = "https://api-sire.sunat.gob.pe";
  const seguridad = "https://api-seguridad.sunat.gob.pe";
  const crear = () => {
    const llamadas: string[] = [];
    const base: typeof fetch = (input, init) => {
      llamadas.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const f = crearFetchObservado({
      base,
      origenesPermitidos: [seguridad, origen],
      origenSeguridad: seguridad,
      obs: nuevasObservaciones("compras"),
    });
    return { f, llamadas };
  };

  it("deja pasar GET a los hosts del SIRE y el POST del token a seguridad", async () => {
    const { f, llamadas } = crear();
    await f(`${origen}/v1/x`, { method: "GET" });
    await f(`${seguridad}/v1/clientessol/abc/oauth2/token/`, { method: "POST", body: "a=b" });
    expect(llamadas).toHaveLength(2);
  });

  it("rechaza sin llamar a la red: POST fuera del token, PUT, DELETE, POST del token a otro host y hosts ajenos", async () => {
    const { f, llamadas } = crear();
    const intentos: [string, string][] = [
      ["POST", `${origen}/v1/contribuyente/migeigv/libros/rce/ajustesposteriores/web/ajustesposteriores/202610/solicitardescarga`],
      ["PUT", `${origen}/v1/x`],
      ["DELETE", `${origen}/v1/x`],
      ["POST", `${origen}/v1/clientessol/abc/oauth2/token/`],
      ["GET", "https://ejemplo.invalid/v1/x"],
      ["GET", "http://api-sire.sunat.gob.pe/v1/x"],
    ];
    for (const [metodo, url] of intentos) {
      await expect(f(url, { method: metodo }), `${metodo} ${url}`).rejects.toThrow(/^contrato: /);
    }
    expect(llamadas).toHaveLength(0);
  });
});

describe("credenciales de la prueba de contrato", () => {
  const completo = (extra: Record<string, string> = {}): Record<string, string> => ({
    SIRE_CONTRATO_CLIENT_ID: "cid-0000",
    SIRE_CONTRATO_CLIENT_SECRET: CANARIOS.clientSecret,
    SIRE_CONTRATO_RUC: "20700000002",
    SIRE_CONTRATO_USUARIO: "USUARIOSOL",
    SIRE_CONTRATO_CLAVE: CANARIOS.claveSol,
    SIRE_CONTRATO_PERIODO: "202610",
    ...extra,
  });
  const hoy = new Date("2026-11-27T12:00:00Z");

  it("lee las seis variables", () => {
    const r = credencialesDelEntorno(completo(), hoy);
    expect(r.periodo).toBe("202610");
    expect(r.credencial).toMatchObject({ clientId: "cid-0000", ruc: "20700000002", usuarioSol: "USUARIOSOL" });
  });

  it("acepta varios periodos separados por comas (con espacios y repetidos), en el orden dado", () => {
    const r = credencialesDelEntorno(completo({ SIRE_CONTRATO_PERIODO: "202510, 202509,202508,202510" }), hoy);
    expect(r.periodos).toEqual(["202510", "202509", "202508"]);
    expect(r.periodo).toBe("202510");
  });

  it("un periodo malo o futuro dentro de la lista falla sin repetir el valor", () => {
    for (const malo of ["202510,202513", "202510,202611", "202510,,202509", "202510;202509", "202510,abc"]) {
      const f = (): unknown => credencialesDelEntorno(completo({ SIRE_CONTRATO_PERIODO: malo }), hoy);
      expect(f).toThrow("SIRE_CONTRATO_PERIODO");
      expect(f).not.toThrow(/202513|202611|abc/);
    }
  });

  it("si faltan, nombra las variables y no repite ningún valor", () => {
    const env = completo();
    delete env["SIRE_CONTRATO_CLAVE"];
    delete env["SIRE_CONTRATO_RUC"];
    let mensaje = "";
    try {
      credencialesDelEntorno(env, hoy);
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain("SIRE_CONTRATO_CLAVE");
    expect(mensaje).toContain("SIRE_CONTRATO_RUC");
    for (const valor of [CANARIOS.clientSecret, "USUARIOSOL", "cid-0000"]) expect(mensaje).not.toContain(valor);
    expect(VARIABLES_CONTRATO).toHaveLength(6);
  });

  it("exige RUC de 11 dígitos y un periodo AAAAMM pasado, sin repetir el valor", () => {
    const casos: [Record<string, string>, string, string][] = [
      [{ SIRE_CONTRATO_RUC: "123" }, "SIRE_CONTRATO_RUC", "123"],
      [{ SIRE_CONTRATO_PERIODO: "202613" }, "SIRE_CONTRATO_PERIODO", "202613"],
      [{ SIRE_CONTRATO_PERIODO: "202611" }, "SIRE_CONTRATO_PERIODO", "202611"],
      [{ SIRE_CONTRATO_PERIODO: "202701" }, "SIRE_CONTRATO_PERIODO", "202701"],
    ];
    for (const [extra, variable, valor] of casos) {
      expect(() => credencialesDelEntorno(completo(extra), hoy)).toThrow(variable);
      expect(() => credencialesDelEntorno(completo(extra), hoy)).not.toThrow(new RegExp(`${valor}\\b`));
    }
  });
});

describe("formato de la salida", () => {
  it("la línea del token solo lleva tiempo, nombres de campo y vida", () => {
    expect(lineaToken({ ms: 12, tokenNoVacio: true, segundosDeVida: 3600, campos: ["access_token", "expires_in"] })).toBe(
      "[contrato-sire] token: 12 ms · campos access_token,expires_in · vida 3600 s",
    );
  });
});

describe("contrato SIRE · diagnóstico de fallos HTTP (solo cod/msg y claves)", () => {
  let srv: ServidorContratoFalso;
  let token: Awaited<ReturnType<typeof contratoToken>>["token"];
  const PROHIBIDOS = ["NO-IMPRIMIR-EXC", "NO-IMPRIMIR-VALOR", "NO-IMPRIMIR-TICKET", "NO-IMPRIMIR-DETALLE", RUC, CANARIOS.token, "202610000003"];
  const sinValores = (salida: string): void => {
    for (const v of PROHIBIDOS) expect(salida.includes(v), "la salida repite un valor del cuerpo de error").toBe(false);
    expect(/\d{8,}/.test(salida), "la salida trae un número largo").toBe(false);
  };
  beforeAll(async () => {
    srv = await prepararServidorFalso({ errores: true });
    srv.entrada.dormir = sinEsperar;
    token = (await contratoToken(srv.entrada)).token;
  });
  afterAll(async () => {
    await srv.cerrar();
  });

  it("422 de 5.51 con lista de errores: imprime HTTP, claves de primer nivel y cod/msg de principal y lista; el cod ya no sale «?»", async () => {
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    // La solicitud de PEN se rechaza: no hay reintento de codProceso ni de moneda.
    expect(i.porMoneda.PEN.solicitud).toMatchObject({ codProceso: "70", codMoneda: "PEN", estado: 422, errorSunat: { cod: "1138" } });
    expect(i.porMoneda.PEN.solicitud?.codigosSunat).toEqual(["422", "1138", "1139"]);
    expect(i.porMoneda.PEN.sinDatos).toBe(false);
    expect(i.error).toMatchObject({ clase: "ErrorPortalSire", detalle: "solicitud_rechazada" });
    const fallos = lineas.filter((l) => l.includes("FALLO HTTP"));
    expect(fallos).toHaveLength(1);
    expect(fallos[0]).toBe(
      "[contrato-sire] registro-presentado 202610 PEN: FALLO HTTP 422 en solicitud codMoneda PEN · " +
        `${i.porMoneda.PEN.fallos[0]?.ms} ms · cuerpo {cod,msg,exc,errors,datos} · ` +
        "SUNAT cod 422 msg «Unprocessable Entity - Se presentaron errores de validación que impidieron completar el Request» · " +
        "errors[2]: cod 1138 msg «codProceso no válido para el RUC #» | cod 1139 msg «Parámetro rechazado»",
    );
    expect(lineas.join("\n")).not.toContain("cod ? ");
    sinValores(lineas.join("\n"));
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);
  });

  it("un 422 con 1070 solo dentro de la lista de errores sigue contando como «sin datos» de esa moneda", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), {
      estado: 422,
      json: { cod: "422", msg: "Unprocessable Entity", errors: [{ cod: "1070", msg: "No existen datos" }] },
    });
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.porMoneda.PEN.sinDatos).toBe(true);
    expect(i.porMoneda.USD.sinDatos).toBe(true);
    expect(i.error).toEqual({ clase: "ErrorDatosSire", detalle: "sin_datos" });
    expect(i.porMoneda.PEN.solicitud?.errorSunat?.cod).toBe("1070");
    expect(i.porMoneda.USD.solicitud?.errorSunat?.cod).toBe("1070");
  });

  it("5xx de la exportación de ventas con cuerpo de error: línea con HTTP 503, claves y cod/msg de la lista; sin valores ajenos", async () => {
    guionarErrores();
    const lineas: string[] = [];
    const i = await contratoLibro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token, "ventas");
    expect(i.exportar).toBeNull();
    expect(i.error).toEqual({ clase: "ErrorTransitorioSire", detalle: "servidor" });
    expect(i.fallos).toHaveLength(1);
    const linea = lineas.find((l) => l.includes("FALLO HTTP"));
    expect(linea).toBe(
      `[contrato-sire] ventas 202610: FALLO HTTP 503 en exportar · ${i.fallos[0]?.ms} ms · cuerpo {cod,msg,errores,detalle} · ` +
        "SUNAT cod 5000 msg «Servicio no disponible» · errores[1]: cod E-77 msg «Intente luego»",
    );
    sinValores(lineas.join("\n"));
  });

  it("el fallo de ventas no oculta los demás casos: compras y el registro siguen y se informan", async () => {
    guionarErrores();
    const compras = await contratoLibro(srv.entrada, token, "compras");
    const ventas = await contratoLibro(srv.entrada, token, "ventas");
    const registro = await contratoRegistro(srv.entrada, token);
    expect(compras.error).toBeNull();
    expect(compras.filas?.total).toBeGreaterThan(0);
    expect(ventas.error).not.toBeNull();
    expect(registro.porMoneda.PEN.solicitud?.estado).toBe(422);
    expect(registro.porMoneda.PEN.fallos).toHaveLength(1);
  });

  it("cuerpo que no es JSON (HTML del 502): «cuerpo no JSON» y nada del texto", async () => {
    srv.sire.guionar("GET", RUTAS.exportarRvie(), { estado: 502, texto: "<html>NO-IMPRIMIR-DETALLE 20700000002</html>" });
    const lineas: string[] = [];
    await contratoLibro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token, "ventas");
    expect(lineas.find((l) => l.includes("FALLO HTTP"))).toMatch(/FALLO HTTP 502 en exportar · \d+ ms · cuerpo no JSON · sin cod\/msg$/);
    sinValores(lineas.join("\n"));
  });

  it("fallos del ticket y de la descarga también se imprimen, con su paso", async () => {
    guionarFlujoSano();
    srv.sire.guionar("GET", RUTAS.ticket, { estado: 500, json: { cod: "9001", msg: "Falla interna", errors: [{ cod: "9002", msg: "Reintente" }] } });
    const lineas: string[] = [];
    await contratoLibro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token, "compras");
    expect(lineas.some((l) => /FALLO HTTP 500 en ticket · \d+ ms · cuerpo \{cod,msg,errors\} · SUNAT cod 9001 msg «Falla interna» · errors\[1\]: cod 9002 msg «Reintente»$/.test(l))).toBe(true);

    guionarFlujoSano();
    srv.sire.guionar("GET", RUTAS.archivo, { estado: 403, json: { cod: "403", msg: "Prohibido" } });
    const lineas2: string[] = [];
    await contratoLibro({ ...srv.entrada, emitir: (l) => lineas2.push(l) }, token, "compras");
    expect(lineas2.some((l) => /FALLO HTTP 403 en archivo · \d+ ms · cuerpo \{cod,msg\} · SUNAT cod 403 msg «Prohibido»$/.test(l))).toBe(true);
  });

  it("fallo del token: imprime la línea y vuelve a lanzar", async () => {
    const entorno = await crearEntorno();
    try {
      entorno.seguridad.guionar("POST", RUTAS.token(CLIENT_ID), {
        estado: 401,
        json: { cod: "401", msg: "Credenciales inválidas", error_description: "NO-IMPRIMIR-DETALLE" },
      });
      const lineas: string[] = [];
      await expect(
        contratoToken({ credencial: credencial(), periodo: PERIODO, urlsDePrueba: entorno.urlsDePrueba, emitir: (l) => lineas.push(l) }),
      ).rejects.toThrow();
      expect(lineas).toHaveLength(1);
      expect(lineas[0]).toMatch(/^\[contrato-sire\] token: FALLO HTTP 401 en token · \d+ ms · cuerpo \{cod,msg,error_description\} · SUNAT cod 401 msg «Credenciales inválidas»$/);
      sinValores(lineas.join("\n"));
    } finally {
      await entorno.cerrar();
    }
  });

  it("describirFallo: msg acotado a 200 caracteres, números de 6+ dígitos tapados, cod/msg raros como «?» y tope de elementos", () => {
    const largo = "x".repeat(300);
    const f = describirFallo("solicitud", 422, 5, {
      cod: "x".repeat(40),
      msg: `${largo} 123456789`,
      "20700000002": "valor",
      errors: Array.from({ length: 15 }, (_, n) => ({ cod: n === 0 ? "123456789" : String(n), msg: n === 1 ? "con\nsalto" : `m${n}` })),
    });
    expect(f.principal?.cod).toBe("?");
    expect(f.principal?.msg).toBe("x".repeat(200));
    expect(f.claves).toEqual(["cod", "msg", "?", "errors"]);
    expect(f.listas[0]?.total).toBe(15);
    expect(f.listas[0]?.items).toHaveLength(10);
    expect(f.listas[0]?.items[0]).toEqual({ cod: "?", msg: "m0" });
    expect(f.listas[0]?.items[1]).toEqual({ cod: "1", msg: "?" });
    expect(lineaFallo("[contrato-sire] x", f)).not.toMatch(/\d{8,}/);
  });

  function guionarErrores(): void {
    srv.sire.guionar("GET", RUTAS.exportarRvie(), { estado: 503, json: CUERPO_503_FALSO });
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 422, json: CUERPO_422_FALSO });
    guionarFlujoSano();
  }
  function guionarFlujoSano(): void {
    const sano = prepararFlujoSano();
    srv.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: "202610000001" } });
    srv.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "04", [archivo(sano.nombre)])]) }));
    srv.sire.guionar("GET", RUTAS.archivo, { bytes: sano.zip, cabeceras: { "content-type": "application/zip" } });
  }
  function prepararFlujoSano(): { nombre: string; zip: Uint8Array } {
    return { nombre: "compras-sano.zip", zip: zip("compras-sano.txt", fixture("compras-propuesta-202610.txt")) };
  }
});

describe("contrato SIRE · modo diagnóstico de 5.51", () => {
  let srv: ServidorContratoFalso;
  let token: Awaited<ReturnType<typeof contratoToken>>["token"];
  afterAll(async () => {
    await srv.cerrar();
  });
  beforeAll(async () => {
    srv = await prepararServidorFalso({ errores: true });
    token = (await contratoToken(srv.entrada)).token;
  });

  it("está apagado por defecto: solo SIRE_CONTRATO_DIAGNOSTICO=1 lo enciende", () => {
    expect(diagnosticoActivo({})).toBe(false);
    expect(diagnosticoActivo({ SIRE_CONTRATO_DIAGNOSTICO: "0" })).toBe(false);
    expect(diagnosticoActivo({ SIRE_CONTRATO_DIAGNOSTICO: "true" })).toBe(false);
    expect(diagnosticoActivo({ SIRE_CONTRATO_DIAGNOSTICO: "1" })).toBe(true);
  });

  it("hace 12 GET de 5.51 en secuencia (70, 01, 02, 00 × sin codMoneda, PEN, USD) e imprime solo HTTP, tiempo y cod/msg", async () => {
    // Todas dan 422 (modo errores), salvo codProceso 70, que devuelve numTicket: solo se informa, no se sigue.
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), (p) =>
      p.query["codProceso"] === "70" ? { json: { numTicket: "202610000003" } } : { estado: 422, json: CUERPO_422_FALSO },
    );
    const antes = srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro()).length;
    const lineas: string[] = [];
    const v = await contratoDiagnostico({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    const pedidas = srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro()).slice(antes);
    expect(pedidas.map((p) => `${p.query["codProceso"]}/${p.query["codMoneda"] ?? "-"}`)).toEqual([
      "70/-", "70/PEN", "70/USD", "01/-", "01/PEN", "01/USD", "02/-", "02/PEN", "02/USD", "00/-", "00/PEN", "00/USD",
    ]);
    expect(pedidas.every((p) => p.query["codTipoArchivo"] === "0" && p.query["codOrigen"] === "2" && p.query["lisPeriodos"] === PERIODO)).toBe(true);
    expect(pedidas.every((p) => (p.cabeceras["authorization"] ?? "").startsWith("Bearer "))).toBe(true);
    expect(v).toHaveLength(12);
    // Solo GET y nada más que la solicitud (no se sigue el flujo del ticket aunque 70 devuelva numTicket).
    expect(srv.sire.peticiones.slice(-12).every((p) => p.metodo === "GET" && p.ruta === RUTAS.solicitarRegistro())).toBe(true);

    expect(lineas[0]).toBe("[contrato-sire] diagnóstico 5.51 202610: 12 variantes, solo GET, en secuencia");
    expect(lineas).toHaveLength(13);
    expect(lineas[1]).toMatch(/^\[contrato-sire\] diagnóstico 5\.51 202610: codProceso 70 sin codMoneda: HTTP 200 · \d+ ms · devolvió numTicket \(no se sigue el flujo\)$/);
    expect(lineas[2]).toContain("codProceso 70 codMoneda PEN: HTTP 200");
    expect(lineas[4]).toMatch(
      /codProceso 01 sin codMoneda: HTTP 422 · \d+ ms · SUNAT cod 422 msg «Unprocessable Entity - [^»]+» · errors\[2\]: cod 1138 msg «codProceso no válido para el RUC #» \| cod 1139 msg «Parámetro rechazado»$/,
    );
    const salida = lineas.join("\n");
    for (const x of ["NO-IMPRIMIR-EXC", "NO-IMPRIMIR-VALOR", "NO-IMPRIMIR-TICKET", RUC, CANARIOS.token, "202610000003", "cuerpo {"]) {
      expect(salida.includes(x), "el diagnóstico repite un valor o el cuerpo").toBe(false);
    }
    expect(/\d{8,}/.test(salida), "el diagnóstico trae un número largo").toBe(false);
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);
  });

  it("no pasa por el flujo normal: el modo normal pide solo codProceso 70, una vez con PEN y una con USD, sin variantes ni reintentos", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 422, json: { cod: "422", msg: "x", errors: [{ cod: "1070", msg: "sin datos" }] } });
    const antes = srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro()).length;
    await contratoRegistro(srv.entrada, token);
    const pedidas = srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro()).slice(antes);
    expect(pedidas.map((p) => [p.query["codProceso"], p.query["codMoneda"]])).toEqual([["70", "PEN"], ["70", "USD"]]);
  });
});

describe("diagnóstico de la estructura de un ZIP (solo formas, nunca contenido)", () => {
  const txt = Buffer.from("columna|otra\n1|2\n", "utf8");
  const TOPE_IMPRESO = /«([^»]*)»/g;

  it("un ZIP que el lector lee: sin rechazo ni motivos (un descriptor de datos no lo rechaza por sí solo)", () => {
    expect(diagnosticarZip(zip("x.txt", txt))).toMatchObject({ rechazo: null, motivos: [], observaciones: [] });
    const conDescriptor = diagnosticarZip(zipManual([{ nombre: "x.txt", datos: txt, descriptor: true }]));
    expect(conDescriptor.rechazo).toBeNull();
    expect(conDescriptor.estructura.entradas[0]).toMatchObject({ descriptor: true, banderas: 0x0808 });
  });

  it("el ZIP «raro» (2 entradas, una con ruta, con descriptor de datos): firma, tamaño, EOCD, ZIP64, entradas y motivos", () => {
    const z = zipRaro();
    const d = diagnosticarZip(z);
    expect(d.rechazo).toEqual({ clase: "ErrorPortalSire", detalle: "zip_invalido" });
    expect(d.estructura).toMatchObject({ firma: "504b0304", esZip: true, bytes: z.length, eocd: true, zip64: false, entradasDeclaradas: 2 });
    expect(d.estructura.fin).toMatchObject({ alFinal: true, total: 2 });
    expect(d.estructura.entradas).toHaveLength(2);
    expect(d.estructura.entradas[0]).toMatchObject({
      indice: 1,
      extension: "txt",
      conRuta: true,
      esDirectorio: false,
      largoNombre: ZIP_RARO.nombres[0].length,
      nombre: "#/#-registro-pen-#.txt",
      metodo: 8,
      banderas: 0x0808,
      cifrado: false,
      descriptor: true,
      utf8: true,
    });
    expect(d.estructura.entradas[1]).toMatchObject({ indice: 2, conRuta: false, nombre: "LEEME-#-#.txt", metodo: 0, descriptor: true });
    expect(d.motivos).toEqual(["mas_de_una_entrada", "directorio_central_no_es_exactamente_una_entrada", "nombre_con_ruta"]);
    expect(d.observaciones).toEqual([
      "entrada_1_con_descriptor_de_datos_no_rechaza_por_si_solo",
      "entrada_2_con_descriptor_de_datos_no_rechaza_por_si_solo",
    ]);
  });

  it("motivos por defecto del ZIP: cifrado, método, CRC, directorio, truncado, basura al final y ZIP64", () => {
    const motivos = (z: Uint8Array): string[] => diagnosticarZip(z).motivos;
    expect(motivos(zipManual([{ nombre: "x.txt", datos: txt, banderasExtra: 1 }]))).toEqual(["cifrado", "cabecera_local_cifrada"]);
    expect(motivos(zipManual([{ nombre: "x.txt", datos: txt }], { crc: 0x12345678 }))).toEqual(["crc_distinto_del_declarado"]);
    expect(motivos(zipManual([{ nombre: "carpeta/", datos: new Uint8Array(0), metodo: 0 }]))).toEqual(
      expect.arrayContaining(["nombre_es_directorio", "nombre_no_termina_en_txt"]),
    );
    expect(motivos(zipManual([{ nombre: "datos.csv", datos: txt }]))).toEqual(["nombre_no_termina_en_txt"]);

    const bueno = zip("x.txt", txt);
    const metodo = Uint8Array.from(bueno);
    const central = analizarZip(bueno).fin!.inicioCentral;
    new DataView(metodo.buffer).setUint16(central + 10, 12, true);
    expect(motivos(metodo)[0]).toBe("metodo_12_no_soportado");

    expect(motivos(bueno.subarray(0, bueno.length - 5))).toEqual(["sin_eocd"]);
    expect(motivos(Uint8Array.from([...bueno, 1, 2, 3]))).toContain("eocd_no_termina_al_final_del_archivo");

    const z64 = Uint8Array.from(bueno);
    new DataView(z64.buffer).setUint16(analizarZip(bueno).fin!.posicion + 10, 0xffff, true);
    expect(analizarZip(z64).zip64).toBe(true);
    expect(motivos(z64)).toEqual(["zip64"]);
  });

  it("un archivo que no es ZIP: firma en hex y «texto plano sí/no» sin imprimir los bytes", () => {
    const html = analizarZip(noEsZip());
    expect(html).toMatchObject({ firma: "3c68746d", esZip: false, textoPlano: true, eocd: false });
    const binario = analizarZip(Uint8Array.from({ length: 100 }, (_, i) => i % 7));
    expect(binario).toMatchObject({ firma: "00010203", esZip: false, textoPlano: false });
    expect(pareceTextoPlano(new Uint8Array(0))).toBe(false);
    expect(pareceTextoPlano(Buffer.from("a".repeat(64) + "\u0000"))).toBe(true); // solo se miran los 64 primeros
    expect(pareceTextoPlano(Buffer.from("a".repeat(63) + "\u0000"))).toBe(false);
    const lineas = lineasEstructura("[contrato-sire] x", 1, diagnosticarZip(noEsZip())).join("\n");
    expect(lineas).toContain("firma 3c68746d (no es ZIP · texto plano sí)");
    expect(lineas).toContain("motivo {sin_eocd}");
    expect(lineas.includes(ZIP_RARO.contenido) || lineas.includes("html"), "la salida repite bytes del archivo").toBe(false);
  });

  it("el nombre sale con alfabeto cerrado y toda secuencia de 4+ dígitos tapada; solo la extensión; el largo es el real", () => {
    expect(nombreSeguro(Buffer.from("20700000002-registro-pen-202610.txt"))).toBe("#-registro-pen-#.txt");
    expect(nombreSeguro(Buffer.from("a123b1234c12345678d"))).toBe("a123b#c#d");
    expect(nombreSeguro(Buffer.from("raz\u00f3n social <x>.txt", "utf8"))).toBe("raz?n social ?x?.txt");
    expect(nombreSeguro(Buffer.from("x".repeat(200)))).toHaveLength(80);
    const d = diagnosticarZip(zipManual([{ nombre: "20700000002.TXT2", datos: txt }]));
    expect(d.estructura.entradas[0]).toMatchObject({ extension: "txt2", largoNombre: 16, nombre: "#.TXT2" });
  });

  it("las líneas del archivo rechazado traen motivo, firma, tamaño, EOCD, ZIP64, entradas y por entrada los campos pedidos", () => {
    const z = zipRaro();
    const lineas = lineasEstructura("[contrato-sire] registro-presentado 202610 PEN", 1, diagnosticarZip(z));
    expect(lineas).toHaveLength(4);
    expect(lineas[0]).toBe(
      "[contrato-sire] registro-presentado 202610 PEN: archivo 1 rechazado por el lector: ErrorPortalSire zip_invalido · " +
        "motivo {mas_de_una_entrada,directorio_central_no_es_exactamente_una_entrada,nombre_con_ruta} · " +
        "observaciones {entrada_1_con_descriptor_de_datos_no_rechaza_por_si_solo,entrada_2_con_descriptor_de_datos_no_rechaza_por_si_solo}",
    );
    expect(lineas[1]).toBe(
      `[contrato-sire] registro-presentado 202610 PEN: archivo 1 estructura: firma 504b0304 (ZIP sí) · ${z.length} bytes · ` +
        "EOCD sí (al final del archivo sí) · ZIP64 no · entradas en el directorio central 2",
    );
    expect(lineas[2]).toMatch(
      /archivo 1 entrada 1: ext txt · ruta sí · directorio no · nombre 47 bytes «#\/#-registro-pen-#\.txt» · método 8 · banderas 0x0808 \(cifrado no, descriptor de datos sí, UTF-8 sí\) · comprimido \d+ · descomprimido \d+ · CRC 0x[0-9a-f]{8}$/,
    );
    expect(lineas[3]).toMatch(/archivo 1 entrada 2: ext txt · ruta no · directorio no · nombre 25 bytes «LEEME-#-#\.txt» · método 0 · banderas 0x0808/);
    for (const x of ZIP_RARO.digitosEnNombres) expect(lineas.join("\n").includes(x), "la salida repite dígitos del nombre").toBe(false);
    expect(lineas.join("\n").includes(ZIP_RARO.contenido), "la salida repite el contenido del TXT").toBe(false);
    for (const l of lineas.slice(2)) for (const m of l.matchAll(TOPE_IMPRESO)) expect(/\d{4,}/.test(m[1] ?? ""), "el nombre trae 4+ dígitos").toBe(false);
  });

  it("más de 20 entradas: se imprimen 20 y se avisa cuántas faltan", () => {
    const muchas = zipManual(Array.from({ length: 25 }, (_, n) => ({ nombre: `e${n}.txt`, datos: txt })));
    const lineas = lineasEstructura("[contrato-sire] x", 1, diagnosticarZip(muchas));
    expect(lineas.filter((l) => /archivo 1 entrada \d+:/.test(l))).toHaveLength(20);
    expect(lineas[lineas.length - 1]).toContain("5 entrada(s) más sin imprimir");
  });
});

describe("contrato SIRE · estructura del archivo que el lector rechaza (servidor falso)", () => {
  let srv: ServidorContratoFalso;
  let token: Awaited<ReturnType<typeof contratoToken>>["token"];
  beforeAll(async () => {
    srv = await prepararServidorFalso({ archivosRaros: true });
    srv.entrada.dormir = sinEsperar;
    token = (await contratoToken(srv.entrada)).token;
  });
  afterAll(async () => {
    await srv.cerrar();
  });
  const archivosPedidos = () => srv.sire.peticionesDe("GET", RUTAS.archivo);

  it("PEN rechazado: imprime su estructura, la de USD (que el cliente no pidió) y la de la propuesta como referencia, sin contenido ni dígitos del nombre", async () => {
    const referenciaZip = {};
    await contratoLibro({ ...srv.entrada, referenciaZip }, token, "compras");
    const antes = archivosPedidos().length;
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, referenciaZip, emitir: (l) => lineas.push(l) }, token);

    expect(i.error).toEqual({ clase: "ErrorPortalSire", detalle: "zip_invalido" });
    expect(i.porMoneda.PEN.archivos[0]?.diagnostico.rechazo).not.toBeNull();
    expect(i.porMoneda.PEN.archivoPendiente).toBeNull();
    // El cliente corta con PEN; el archivo de USD lo pide la prueba aparte, una sola vez, con GET.
    expect(i.porMoneda.USD.archivoPendiente).toBe("bajado");
    expect(i.porMoneda.USD.archivos).toHaveLength(1);
    expect(i.porMoneda.USD.archivos[0]?.diagnostico.estructura).toMatchObject({ firma: "3c68746d", esZip: false, textoPlano: true, eocd: false });
    const pedidos = archivosPedidos().slice(antes);
    expect(pedidos.map((p) => p.query["numTicket"])).toEqual([TICKET_REGISTRO_FALSO.PEN, TICKET_REGISTRO_FALSO.USD]);
    expect(srv.sire.peticiones.every((p) => p.metodo === "GET")).toBe(true);
    expect(srv.sire.sinGuion).toHaveLength(0);

    const salida = lineas.join("\n");
    const pen = "[contrato-sire] registro-presentado 202610 PEN";
    const usd = "[contrato-sire] registro-presentado 202610 USD";
    expect(salida).toContain(`${pen}: archivo 1 rechazado por el lector: ErrorPortalSire zip_invalido · motivo {mas_de_una_entrada,`);
    expect(salida).toContain(`${pen}: archivo 1 estructura: firma 504b0304 (ZIP sí) ·`);
    expect(salida).toContain(`${pen}: archivo 1 entrada 1: ext txt · ruta sí · directorio no · `);
    expect(salida).toContain(`${pen}: archivo 1 entrada 2: ext txt · ruta no · directorio no · `);
    expect(salida).toContain(`${pen}: referencia propuesta de compras: firma 504b0304 (ZIP sí)`);
    expect(salida).toContain(`${usd}: archivo pendiente (diagnóstico): el cliente no llegó a pedirlo`);
    expect(salida).toContain(`${usd}: archivo 1 rechazado por el lector: ErrorPortalSire zip_invalido · motivo {sin_eocd}`);
    expect(salida).toContain(`${usd}: archivo 1 estructura: firma 3c68746d (no es ZIP · texto plano sí) ·`);
    expect(salida).toContain(`${usd}: referencia propuesta de compras: firma 504b0304 (ZIP sí)`);
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);

    // Nada de contenido ni de los dígitos de los nombres, del RUC, de los tickets ni de los canarios.
    for (const v of [ZIP_RARO.contenido, "CANARIO", "<html>", ...ZIP_RARO.digitosEnNombres, RUC, ...Object.values(CANARIOS), ...Object.values(TICKET_REGISTRO_FALSO)]) {
      expect(salida.includes(v), "la salida repite un valor del archivo, de los datos o de las credenciales").toBe(false);
    }
    for (const l of lineas.filter((x) => /archivo \d+ entrada \d+:/.test(x))) {
      const nombres = [...l.matchAll(/«([^»]*)»/g)].map((m) => m[1] ?? "");
      expect(nombres).toHaveLength(1);
      expect(/\d{4,}/.test(nombres[0] ?? ""), "el nombre de la entrada trae 4+ dígitos").toBe(false);
    }
  });

  it("sin la propuesta de compras descargada antes, la referencia lo dice en una línea y el registro sigue", async () => {
    const lineas: string[] = [];
    await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    const referencias = lineas.filter((l) => l.includes("referencia propuesta de compras"));
    expect(referencias).toHaveLength(2);
    expect(referencias.every((l) => l.includes("sin estructura (no se descargó la propuesta de compras de este periodo antes"))).toBe(true);
  });

  it("la propuesta de compras rechazada imprime su estructura, sin línea de referencia, y deja la estructura para el registro", async () => {
    srv.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: "202610000009" } });
    srv.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "04", [archivo("propuesta-rara.zip")])]) }));
    srv.sire.guionar("GET", RUTAS.archivo, { bytes: zipRaro(), cabeceras: { "content-type": "application/zip" } });
    const referenciaZip: Record<string, ReturnType<typeof analizarZip>> = {};
    const lineas: string[] = [];
    const i = await contratoLibro({ ...srv.entrada, referenciaZip, emitir: (l) => lineas.push(l) }, token, "compras");
    expect(i.error).toMatchObject({ clase: "ErrorPortalSire", detalle: "zip_invalido" });
    expect(lineas.some((l) => l.includes("compras 202610: archivo 1 rechazado por el lector: ErrorPortalSire zip_invalido · motivo {mas_de_una_entrada,"))).toBe(true);
    expect(lineas.some((l) => l.includes("compras 202610: archivo 1 entrada 1: ext txt · ruta sí"))).toBe(true);
    expect(lineas.some((l) => l.includes("referencia propuesta"))).toBe(false);
    expect(referenciaZip[PERIODO]).toMatchObject({ firma: "504b0304", entradasDeclaradas: 2 });
  });
});

describe("contrato SIRE · el diagnóstico de estructura no se activa si el lector lee los archivos", () => {
  it("registro sano: ninguna línea de estructura, referencia ni archivo pendiente, y un solo archivo pedido por moneda", async () => {
    const srv = await prepararServidorFalso();
    srv.entrada.dormir = sinEsperar;
    try {
      const { token } = await contratoToken(srv.entrada);
      const referenciaZip = {};
      await contratoLibro({ ...srv.entrada, referenciaZip }, token, "compras");
      const antes = srv.sire.peticionesDe("GET", RUTAS.archivo).length;
      const lineas: string[] = [];
      const i = await contratoRegistro({ ...srv.entrada, referenciaZip, emitir: (l) => lineas.push(l) }, token);
      expect(i.error).toBeNull();
      expect(srv.sire.peticionesDe("GET", RUTAS.archivo).length - antes).toBe(2);
      expect(i.porMoneda.PEN.archivoPendiente).toBeNull();
      expect(i.porMoneda.USD.archivoPendiente).toBeNull();
      const salida = lineas.join("\n");
      for (const x of ["estructura:", "referencia propuesta", "archivo pendiente", "rechazado por el lector", "entrada 1:"]) {
        expect(salida.includes(x), `salida normal con «${x}»`).toBe(false);
      }
    } finally {
      await srv.cerrar();
    }
  });
});
