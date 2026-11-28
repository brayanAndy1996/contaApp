import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANARIOS,
  SECRETOS,
  capturar,
  claseError,
  crearEntorno,
  esperarError,
  sinSecretos,
  type EntornoFalso,
} from "./pruebas/ayudas-http.js";
import { pedir, type ContextoHttp } from "./transporte.js";

// Contrato de `transporte.ts` (plan 041, «transporte.ts» y Decisiones; spec CA-2, CA-11, CA-12):
//  - `pedir({ url, metodo, cabeceras?, cuerpo?, contexto, timeoutMs, maxBytes, fetch? }): Promise<{ estado, cabeceras, cuerpo }>`
//    hace UNA petición con `fetch` (el inyectado o el global), `redirect: "manual"` y `signal: AbortSignal.timeout(timeoutMs)`.
//    Devuelve `{ estado, cabeceras (nombres en minúsculas), cuerpo: Uint8Array }` SOLO para 2xx; todo lo demás lanza.
//  - `contexto` "token" (OAuth) o "api" (SIRE). Mapeo:
//        token: 400/401 -> ErrorCredencial; 429/5xx -> ErrorTransitorioSire("servidor"); 3xx -> ErrorPortalSire.
//        api:   401 -> TokenRechazadoError; 403 -> ErrorCredencial; 422 -> ErrorDatos; 404/429/5xx -> ErrorTransitorioSire;
//               3xx -> ErrorPortalSire. (Otros 4xx: ErrorPortalSire "respuesta_inesperada"; no se prueban.)
//  - Fallo de `fetch`: TimeoutError/AbortError -> ErrorTransitorioSire("timeout"); cualquier otro (red, ECONNRESET) ->
//    ErrorTransitorioSire("red").
//  - El cuerpo se lee con tope `maxBytes` contando los bytes realmente leídos (no se confía en `Content-Length`): al pasarse
//    cancela el flujo y lanza ErrorPortalSire("respuesta_inesperada"). Exactamente `maxBytes` es válido.
//  - Los errores no incluyen el cuerpo de la respuesta, la URL, las cabeceras ni la causa original (CA-12).
let ent: EntornoFalso;
beforeEach(async () => {
  ent = await crearEntorno();
});
afterEach(async () => {
  await ent.cerrar();
});

const base = (ctx: ContextoHttp = "api") => ({ contexto: ctx, timeoutMs: 10_000, maxBytes: 1_048_576 });

describe("pedir · éxito", () => {
  it("devuelve estado, cabeceras en minúsculas y los bytes del cuerpo", async () => {
    ent.sire.guionar("GET", "/ok", { json: { a: 1 }, cabeceras: { "X-Otra": "uno" } });
    const r = await pedir({ ...base(), url: `${ent.sire.origen}/ok`, metodo: "GET" });
    expect(r.estado).toBe(200);
    expect(r.cabeceras["x-otra"]).toBe("uno");
    expect(JSON.parse(Buffer.from(r.cuerpo).toString("utf8"))).toEqual({ a: 1 });
  });

  it("envía método, cabeceras y cuerpo tal cual", async () => {
    ent.seguridad.guionar("POST", "/t/", { json: {} });
    await pedir({
      ...base("token"),
      url: `${ent.seguridad.origen}/t/`,
      metodo: "POST",
      cabeceras: { "content-type": "application/x-www-form-urlencoded", "x-prueba": "1" },
      cuerpo: "a=1&b=dos",
    });
    const p = ent.seguridad.peticiones[0]!;
    expect(p.metodo).toBe("POST");
    expect(p.cabeceras["x-prueba"]).toBe("1");
    expect(p.formulario).toEqual({ a: "1", b: "dos" });
  });

  it("pasa a fetch redirect manual y un AbortSignal vivo", async () => {
    const vistas: RequestInit[] = [];
    const f = ((_u: string | URL | Request, init?: RequestInit) => {
      vistas.push(init ?? {});
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    await pedir({ ...base(), url: "http://127.0.0.1:9/x", metodo: "GET", fetch: f });
    expect(vistas[0]!.redirect).toBe("manual");
    expect(vistas[0]!.signal).toBeInstanceOf(AbortSignal);
    expect((vistas[0]!.signal as AbortSignal).aborted).toBe(false);
  });
});

describe("pedir · mapeo de estados", () => {
  const tabla: [ContextoHttp, number, string][] = [
    ["token", 400, "ErrorCredencial"],
    ["token", 401, "ErrorCredencial"],
    ["token", 429, "ErrorTransitorioSire"],
    ["token", 500, "ErrorTransitorioSire"],
    ["token", 503, "ErrorTransitorioSire"],
    ["token", 302, "ErrorPortalSire"],
    ["api", 401, "TokenRechazadoError"],
    ["api", 403, "ErrorCredencial"],
    ["api", 422, "ErrorDatos"],
    ["api", 404, "ErrorTransitorioSire"],
    ["api", 429, "ErrorTransitorioSire"],
    ["api", 500, "ErrorTransitorioSire"],
    ["api", 502, "ErrorTransitorioSire"],
    ["api", 503, "ErrorTransitorioSire"],
    ["api", 504, "ErrorTransitorioSire"],
    ["api", 301, "ErrorPortalSire"],
    ["api", 302, "ErrorPortalSire"],
    ["api", 307, "ErrorPortalSire"],
    ["api", 308, "ErrorPortalSire"],
  ];
  it.each(tabla)("%s · HTTP %i -> %s", async (contexto, estado, clase) => {
    ent.sire.guionar("GET", "/x", { estado, json: { error: "x" }, cabeceras: { location: `${ent.ajeno.origen}/robar` } });
    const e = await capturar(pedir({ ...base(contexto), url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, clase as Parameters<typeof esperarError>[1]);
    sinSecretos(e);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("en el contexto token un 401 NO es TokenRechazadoError", async () => {
    ent.seguridad.guionar("POST", "/t/", { estado: 401 });
    const e = await capturar(pedir({ ...base("token"), url: `${ent.seguridad.origen}/t/`, metodo: "POST", cuerpo: "a=1" }));
    esperarError(e, "ErrorCredencial");
    expect(e).not.toBeInstanceOf(claseError("TokenRechazadoError"));
  });

  it("5xx/429 llevan detalle servidor; el cuerpo de error no se copia", async () => {
    const eco = `${CANARIOS.token} ${CANARIOS.clientSecret}`;
    for (const estado of [429, 500, 503]) {
      ent.sire.guionar("GET", "/x", { estado, json: { detalle: eco } });
      const e = await capturar(pedir({ ...base(), url: `${ent.sire.origen}/x`, metodo: "GET" }));
      esperarError(e, "ErrorTransitorioSire", "servidor");
      sinSecretos(e);
    }
  });
});

describe("pedir · fallos de red", () => {
  it.each([
    ["TimeoutError", "timeout"],
    ["AbortError", "timeout"],
  ])("fetch rechaza con %s -> ErrorTransitorioSire %s", async (nombre, detalle) => {
    const f = (() => Promise.reject(new DOMException("agotado", nombre))) as typeof fetch;
    const e = await capturar(pedir({ ...base(), url: "http://127.0.0.1:9/x", metodo: "GET", fetch: f }));
    esperarError(e, "ErrorTransitorioSire", detalle);
  });

  it("fetch rechaza con TypeError(fetch failed) y causa ECONNRESET -> ErrorTransitorioSire red", async () => {
    const f = (() => {
      const causa = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: causa }));
    }) as typeof fetch;
    const e = await capturar(pedir({ ...base(), url: "http://127.0.0.1:9/x", metodo: "GET", fetch: f }));
    esperarError(e, "ErrorTransitorioSire", "red");
  });

  it("un socket cortado por el servidor -> ErrorTransitorioSire red (sin esperar)", async () => {
    ent.sire.guionar("GET", "/x", { cortar: true });
    const e = await capturar(pedir({ ...base(), url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, "ErrorTransitorioSire", "red");
  });

  it("el error no copia mensaje, URL ni causa del fallo original", async () => {
    const f = (() =>
      Promise.reject(Object.assign(new Error(`fallo en https://x.pe/?client_secret=${CANARIOS.clientSecret}&p=${CANARIOS.claveSol}`), { cause: CANARIOS.token }))) as typeof fetch;
    const e = await capturar(pedir({ ...base("token"), url: "http://127.0.0.1:9/x", metodo: "POST", cuerpo: "a=1", fetch: f }));
    esperarError(e, "ErrorTransitorio");
    sinSecretos(e);
  });
});

describe("pedir · tope de bytes", () => {
  it("un cuerpo de exactamente maxBytes pasa", async () => {
    ent.sire.guionar("GET", "/x", { repetirBytes: { byte: 0x41, total: 1000 } });
    const r = await pedir({ ...base(), maxBytes: 1000, url: `${ent.sire.origen}/x`, metodo: "GET" });
    expect(r.cuerpo.byteLength).toBe(1000);
  });

  it("un byte de más -> ErrorPortalSire respuesta_inesperada", async () => {
    ent.sire.guionar("GET", "/x", { repetirBytes: { byte: 0x41, total: 1001 } });
    const e = await capturar(pedir({ ...base(), maxBytes: 1000, url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
  });

  it("sin Content-Length (chunked) y mucho más grande que el tope -> ErrorPortalSire", async () => {
    ent.sire.guionar("GET", "/x", { repetirBytes: { byte: 0x41, total: 3_000_000 }, sinContentLength: true });
    const e = await capturar(pedir({ ...base(), maxBytes: 100_000, url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
  });

  it("no confía en Content-Length: una cabecera que miente (5) con 500 bytes reales se corta igual", async () => {
    const f = (() =>
      Promise.resolve(new Response(new Uint8Array(500).fill(65), { status: 200, headers: { "content-length": "5" } }))) as typeof fetch;
    const e = await capturar(pedir({ ...base(), maxBytes: 100, url: "http://127.0.0.1:9/x", metodo: "GET", fetch: f }));
    esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
  });

  it("al pasarse del tope cancela el flujo en lugar de leerlo entero", async () => {
    let cancelado = false;
    let enviados = 0;
    const cuerpo = new ReadableStream<Uint8Array>({
      pull(c) {
        enviados += 1;
        c.enqueue(new Uint8Array(1000).fill(66));
        if (enviados > 100_000) c.close();
      },
      cancel() {
        cancelado = true;
      },
    });
    const f = (() => Promise.resolve(new Response(cuerpo, { status: 200 }))) as typeof fetch;
    const e = await capturar(pedir({ ...base(), maxBytes: 5000, url: "http://127.0.0.1:9/x", metodo: "GET", fetch: f }));
    esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
    expect(cancelado).toBe(true);
    expect(enviados).toBeLessThan(1000);
  });
});

// Solicitud 5.51 del registro presentado (plan «P-3 · Registro presentado», rechazo de contrato): SOLO en ese contexto, un 400 o 422
// se lee el cuerpo de error (tope MAX_BYTES_JSON) y se lanza ErrorPortalSire("solicitud_rechazada") con `codigosSunat` (de
// `errors[].cod` y de `cod`; solo `^\d{1,6}$`, tope 5; nunca el `msg`). El plan no nombra el contexto: se asume
// `"solicitud-registro"` (nuevo valor de `ContextoHttp`). El transporte NO decide qué códigos son «sin datos»: los entrega todos
// y el cliente compara con `COD_SIN_DATOS_REGISTRO`. En el contexto "api" (la propuesta) un 422 sigue siendo ErrorDatos.
const CTX_REGISTRO = "solicitud-registro" as ContextoHttp;
const MSG = `El campo 'codMoneda' es nulo o vacio ${CANARIOS.token}`;

describe("pedir · solicitud 5.51: 400/422 → solicitud_rechazada con códigos", () => {
  const casos: [string, number, unknown, string[]][] = [
    ["422 errors[].cod", 422, { errors: [{ cod: "1061", msg: MSG }] }, ["1061"]],
    ["400 errors[].cod", 400, { errors: [{ cod: "1026", msg: MSG }] }, ["1026"]],
    ["422 cod de nivel superior", 422, { cod: "1070", msg: MSG }, ["1070"]],
    ["422 con varios códigos, en orden", 422, { errors: [{ cod: "1061", msg: MSG }, { cod: "1026", msg: MSG }] }, ["1061", "1026"]],
    ["422 códigos fuera de gramática descartados", 422, { errors: [{ cod: "12a" }, { cod: "1234567" }, { cod: " 1070" }, { cod: "1026\n" }, { cod: "" }, { cod: "1061" }] }, ["1061"]],
    ["422 con tope de 5 códigos", 422, { errors: ["1", "2", "3", "4", "5", "6", "7"].map((cod) => ({ cod })) }, ["1", "2", "3", "4", "5"]],
    ["422 sin códigos", 422, { errors: [], msg: MSG }, []],
  ];
  it.each(casos)("%s", async (_nombre, estado, cuerpo, codigos) => {
    ent.sire.guionar("GET", "/x", { estado, json: cuerpo });
    const e = await capturar(pedir({ ...base(CTX_REGISTRO), url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, "ErrorPortalSire", "solicitud_rechazada");
    expect((e as { codigosSunat?: unknown }).codigosSunat).toEqual(codigos);
    sinSecretos(e, [...SECRETOS, "El campo 'codMoneda'", "nulo o vacio"]);
  });

  it.each([
    [422, "<html>no es json</html>"],
    [400, ""],
    [422, "[1, 2"],
  ] as const)("HTTP %i con cuerpo ilegible (%j) → solicitud_rechazada sin códigos", async (estado, texto) => {
    ent.sire.guionar("GET", "/x", { estado, texto });
    const e = await capturar(pedir({ ...base(CTX_REGISTRO), url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, "ErrorPortalSire", "solicitud_rechazada");
    expect((e as { codigosSunat?: unknown }).codigosSunat).toEqual([]);
    sinSecretos(e);
  });

  it("el resto del mapeo no cambia en ese contexto: 401, 403 y 5xx", async () => {
    for (const [estado, clase, detalle] of [
      [401, "TokenRechazadoError", undefined],
      [403, "ErrorCredencial", undefined],
      [503, "ErrorTransitorioSire", "servidor"],
    ] as const) {
      ent.sire.guionar("GET", "/x", { estado, json: { errors: [{ cod: "1061" }] } });
      const e = await capturar(pedir({ ...base(CTX_REGISTRO), url: `${ent.sire.origen}/x`, metodo: "GET" }));
      esperarError(e, clase, detalle);
    }
  });

  it("propuesta: 422 sigue siendo ErrorDatos (y no ErrorPortalSire) aunque traiga los mismos códigos", async () => {
    ent.sire.guionar("GET", "/x", { estado: 422, json: { errors: [{ cod: "1061", msg: MSG }] } });
    const e = await capturar(pedir({ ...base("api"), url: `${ent.sire.origen}/x`, metodo: "GET" }));
    esperarError(e, "ErrorDatos");
    expect(e).not.toBeInstanceOf(claseError("ErrorPortalSire"));
    sinSecretos(e);
  });
});
