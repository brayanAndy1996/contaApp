import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CANARIOS,
  PERIODO,
  RUTAS,
  fixture,
  cuerpoTicket,
  archivo,
  registroTicket,
  zip,
} from "./ayudas-http.js";
import { sinColumna } from "./ayudas-txt.js";
import {
  contratoLibro,
  contratoToken,
  credencialesDelEntorno,
  crearFetchObservado,
  lineaToken,
  lineasLibro,
  nuevasObservaciones,
  prepararServidorFalso,
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
