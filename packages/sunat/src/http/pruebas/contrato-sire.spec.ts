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
  lineaFallo,
  lineaToken,
  lineaTotales,
  lineasLibro,
  lineasRegistro,
  nuevasObservaciones,
  prepararServidorFalso,
  sumarTotalesP5,
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
  const T_DATOS = "202610000003";
  const T_VACIO = "202610000004";
  const zipRegistro = (nombre: string, txt: string) => ({ nombre, zip: zip(nombre.replace(".zip", ".txt"), fixture(txt)) });
  /** Ticket `T_DATOS` con el registro del fixture y `T_VACIO` con solo el encabezado. */
  function guionarTickets(): void {
    const partes = new Map([
      [T_DATOS, zipRegistro("registro-con-datos.zip", "compras-registro-202610.txt")],
      [T_VACIO, zipRegistro("registro-vacio.zip", "compras-registro-202610-solo-encabezado.txt")],
    ]);
    srv.sire.guionar("GET", RUTAS.ticket, (p) => {
      const t = p.query["numTicket"] ?? "";
      const parte = partes.get(t);
      return parte === undefined ? { estado: 404 } : { json: cuerpoTicket([registroTicket(t, "04", [archivo(parte.nombre)])]) };
    });
    srv.sire.guionar("GET", RUTAS.archivo, (p) => {
      const parte = [...partes.values()].find((x) => x.nombre === p.query["nomArchivoReporte"]);
      return parte === undefined ? { estado: 404 } : { bytes: parte.zip, cabeceras: { "content-type": "application/zip" } };
    });
  }

  it("con datos en 01: una sola solicitud sin codMoneda, encabezado igual al de la propuesta y formas válidas", async () => {
    const antes = solicitudes().length;
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    expect(i.error).toBeNull();
    expect(i.sinDatos).toBe(false);
    expect(i.codProcesoConDatos).toBe("01");
    const pedidas = solicitudes().slice(antes);
    expect(pedidas).toHaveLength(1);
    expect(pedidas[0]?.query["codProceso"]).toBe("01");
    expect(pedidas[0]?.query["codMoneda"]).toBeUndefined();
    expect(i.solicitudes).toMatchObject([{ codProceso: "01", estado: 200, campos: ["numTicket"], errorSunat: null }]);
    expect(i.ticket.estados).toEqual(["01", "04"]);
    expect(i.archivos[0]).toMatchObject({ zipLegible: true, columnas: 80, encabezadoCoincide: true, faltantes: [], sobrantes: [] });
    expect(i.filas?.total).toBeGreaterThan(0);
    expect(i.filas).toMatchObject({ fechaInvalida: 0, monedaInvalida: 0, montoInvalido: 0, tipoCambioInvalido: 0, tipoInvalido: 0, numeroVacio: 0 });
    const salida = lineas.join("\n");
    expect(salida).toContain("registro-presentado 202610: total");
    expect(salida).toContain("con datos en codProceso 01");
    expect(salida).toContain("encabezado igual al de la propuesta de compras sí");
    expect(salida).toContain("P-5 · NC");
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);
    expect(srv.sire.peticiones.every((p) => p.metodo === "GET")).toBe(true);
  });

  it("01 rechazado con 422 «sin datos» (cod 1070): pide 02 una vez y el informe dice con cuál obtuvo datos", async () => {
    guionarTickets();
    const antes = solicitudes().length;
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), (p) =>
      p.query["codProceso"] === "01" ? { estado: 422, json: { cod: "1070", msg: "No existen datos" } } : { json: { numTicket: T_DATOS } },
    );
    const i = await contratoRegistro(srv.entrada, token);
    expect(solicitudes().slice(antes).map((p) => p.query["codProceso"])).toEqual(["01", "02"]);
    expect(i.codProcesoConDatos).toBe("02");
    expect(i.sinDatos).toBe(false);
    expect(i.error).toBeNull();
    expect(i.solicitudes.map((x) => [x.codProceso, x.estado, x.errorSunat?.cod ?? null])).toEqual([
      ["01", 422, "1070"],
      ["02", 200, null],
    ]);
    expect(lineasRegistro(i).join("\n")).toContain("con datos en codProceso 02");
  });

  it("01 con TXT solo con encabezado y 02 sin datos: «sin datos en 01 y 02», dos solicitudes y ninguna más", async () => {
    guionarTickets();
    const antes = solicitudes().length;
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { json: { numTicket: T_VACIO } });
    const i = await contratoRegistro(srv.entrada, token);
    expect(solicitudes().slice(antes).map((p) => p.query["codProceso"])).toEqual(["01", "02"]);
    expect(i.sinDatos).toBe(true);
    expect(i.codProcesoConDatos).toBeNull();
    expect(i.filas).toBeNull();
    expect(i.error).toEqual({ clase: "ErrorDatosSire", detalle: "sin_datos" });
    const salida = lineasRegistro(i).join("\n");
    expect(salida).toContain("sin datos en 01 y 02");
    expect(salida).toContain("solicitud 2 codProceso 02");
  });

  it("422 sin datos (1070) en 01 y en 02: «sin datos en 01 y 02»", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 422, json: { cod: "1070", msg: "No existen datos" } });
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.sinDatos).toBe(true);
    expect(i.solicitudes.map((x) => x.codProceso)).toEqual(["01", "02"]);
    expect(i.archivos).toHaveLength(0);
  });

  it("SUNAT exige moneda o rechaza: imprime el HTTP y solo cod y msg (sin números largos) y NO lo toma por «sin datos»", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), {
      estado: 422,
      json: { cod: "1101", msg: `Debe indicar codMoneda para el RUC ${RUC}`, detalle: "NO-IMPRIMIR-ESTO", numTicket: CANARIOS.token },
    });
    const lineas: string[] = [];
    const i = await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    expect(i.sinDatos).toBe(false);
    expect(i.codProcesoConDatos).toBeNull();
    expect(i.error?.clase).toBe("ErrorDatos");
    expect(i.solicitudes[0]).toMatchObject({ codProceso: "01", estado: 422, errorSunat: { cod: "1101", msg: "Debe indicar codMoneda para el RUC #" } });
    const salida = lineas.join("\n");
    expect(salida).toContain("HTTP 422");
    expect(salida).toContain("cod 1101 msg «Debe indicar codMoneda para el RUC #»");
    for (const v of [RUC, "NO-IMPRIMIR-ESTO", CANARIOS.token]) expect(salida.includes(v), "la salida repite un valor del cuerpo").toBe(false);
  });

  it("cod o msg con formas raras se imprimen como «?»", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 400, json: { cod: "<script>alert(1)</script>", msg: "linea\ncon salto" } });
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.solicitudes[0]?.errorSunat).toEqual({ cod: "?", msg: "?" });
  });

  it("la salida del registro no contiene valores: ni RUC, razones sociales, canarios, tickets ni celdas de datos", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { json: { numTicket: T_DATOS } });
    guionarTickets();
    const lineas: string[] = [];
    await contratoRegistro({ ...srv.entrada, emitir: (l) => lineas.push(l) }, token);
    const salida = lineas.join("\n");
    expect(lineas.length).toBeGreaterThanOrEqual(5);
    const celdas = Buffer.from(fixture("compras-registro-202610.txt"))
      .toString("utf8")
      .split("\n")
      .slice(1)
      .flatMap((fila) => fila.split("|"))
      .filter((c) => c.length >= 6 && c !== PERIODO);
    expect(celdas.length).toBeGreaterThan(0);
    for (const v of [...rucs.flatMap((r) => [r.ruc, r.razonSocial]), ...Object.values(CANARIOS), T_DATOS, T_VACIO, ...celdas]) {
      expect(salida.includes(v), "la salida repite un valor de los datos").toBe(false);
    }
    expect(/\d{8,}/.test(salida), "la salida trae un número largo").toBe(false);
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
    expect(i.solicitudes.map((x) => [x.codProceso, x.estado, x.errorSunat?.cod])).toEqual([
      ["01", 422, "1138"],
      ["02", 422, "1138"],
    ]);
    expect(i.solicitudes[0]?.codigosSunat).toEqual(["422", "1138", "1139"]);
    expect(i.sinDatos).toBe(false);
    expect(i.error?.clase).toBe("ErrorDatos");
    const fallos = lineas.filter((l) => l.includes("FALLO HTTP"));
    expect(fallos).toHaveLength(2);
    expect(fallos[0]).toBe(
      "[contrato-sire] registro-presentado 202610: FALLO HTTP 422 en solicitud codProceso 01 · " +
        `${i.fallos[0]?.ms} ms · cuerpo {cod,msg,exc,errors,datos} · ` +
        "SUNAT cod 422 msg «Unprocessable Entity - Se presentaron errores de validación que impidieron completar el Request» · " +
        "errors[2]: cod 1138 msg «codProceso no válido para el RUC #» | cod 1139 msg «Parámetro rechazado»",
    );
    expect(lineas.join("\n")).not.toContain("cod ? ");
    sinValores(lineas.join("\n"));
    expect(lineas.every((l) => l.startsWith("[contrato-sire]"))).toBe(true);
  });

  it("un 422 con 1070 solo dentro de la lista de errores sigue contando como «sin datos»", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), {
      estado: 422,
      json: { cod: "422", msg: "Unprocessable Entity", errors: [{ cod: "1070", msg: "No existen datos" }] },
    });
    const i = await contratoRegistro(srv.entrada, token);
    expect(i.sinDatos).toBe(true);
    expect(i.solicitudes.map((x) => x.errorSunat?.cod)).toEqual(["1070", "1070"]);
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
    expect(registro.solicitudes).toHaveLength(2);
    expect(registro.fallos).toHaveLength(2);
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

  it("no pasa por el flujo normal: el modo normal sigue pidiendo 01 y, si no hay datos, 02 una vez, sin codMoneda", async () => {
    srv.sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 422, json: { cod: "422", msg: "x", errors: [{ cod: "1070", msg: "sin datos" }] } });
    const antes = srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro()).length;
    await contratoRegistro(srv.entrada, token);
    const pedidas = srv.sire.peticionesDe("GET", RUTAS.solicitarRegistro()).slice(antes);
    expect(pedidas.map((p) => [p.query["codProceso"], p.query["codMoneda"]])).toEqual([["01", undefined], ["02", undefined]]);
  });
});
