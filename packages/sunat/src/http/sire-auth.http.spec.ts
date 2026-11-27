import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANARIOS,
  CLIENT_ID,
  RUTAS,
  URL_REAL,
  capturar,
  credencial,
  crearEntorno,
  cuerpoToken,
  esperarError,
  relojVirtual,
  sinSecretos,
  type EntornoFalso,
} from "./pruebas/ayudas-http.js";
import { HttpSireAuth } from "./sire-auth.http.js";

// Contrato (plan 041, «Contratos» y «Endpoints»; spec CA-2, CA-12):
//  - `new HttpSireAuth({ fetch?, ahora?, urlsDePrueba?: { seguridad, sire } })` implementa SireAuth. `urlsDePrueba`
//    reemplaza solo el ORIGEN (esquema+host+puerto); el adaptador añade la ruta. Sin él, el host es
//    https://api-seguridad.sunat.gob.pe. Nunca se lee de variables de entorno.
//  - Ruta: POST /v1/clientessol/{client_id}/oauth2/token/ con `application/x-www-form-urlencoded` y EXACTAMENTE los 6
//    campos grant_type=password, scope=https://api-sire.sunat.gob.pe, client_id, client_secret, username={ruc}{usuarioSol},
//    password. Sin `Authorization`. Los secretos solo van en el cuerpo (nunca en ruta, query ni cabeceras).
//  - 200 {access_token, expires_in} -> { token, expiraEn = ahora() + expires_in segundos }.
//  - 400/401 -> ErrorCredencial; 429/5xx/timeout/red -> ErrorTransitorioSire; 200 sin access_token, o expires_in no
//    entero positivo, o cuerpo que no es JSON -> ErrorPortalSire; 3xx -> ErrorPortalSire sin seguir la redirección.
//  - `client_id` fuera de [A-Za-z0-9-]{1,64} -> ErrorCredencial SIN llamar a la red.
//  - Los errores no llevan el cuerpo de la respuesta ni ningún dato de entrada (CA-12).
const AHORA = new Date("2026-11-27T15:00:00.000Z");

let ent: EntornoFalso;
beforeEach(async () => {
  ent = await crearEntorno();
});
afterEach(async () => {
  await ent.cerrar();
});

function auth(extra: ConstructorParameters<typeof HttpSireAuth>[0] = {}): HttpSireAuth {
  return new HttpSireAuth({ urlsDePrueba: ent.urlsDePrueba, ahora: () => AHORA, ...extra });
}

describe("HttpSireAuth · petición", () => {
  it("envía el formulario exacto de 6 campos, sin Authorization, a la ruta del cliente", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken() });
    await auth().obtenerToken(credencial({ usuarioSol: "MODDATOS", ruc: "20700000002" }));
    const p = ent.seguridad.peticionesDe("POST", RUTAS.token());
    expect(p).toHaveLength(1);
    expect(p[0]!.cabeceras["content-type"]).toMatch(/^application\/x-www-form-urlencoded/i);
    expect(p[0]!.cabeceras["authorization"]).toBeUndefined();
    expect(p[0]!.queryCruda).toBe("");
    expect(p[0]!.formulario).toEqual({
      grant_type: "password",
      scope: "https://api-sire.sunat.gob.pe",
      client_id: CLIENT_ID,
      client_secret: CANARIOS.clientSecret,
      username: "20700000002MODDATOS",
      password: CANARIOS.claveSol,
    });
    expect(ent.seguridad.sinGuion).toHaveLength(0);
  });

  it("codifica bien los caracteres especiales de la clave SOL (ida y vuelta exacta)", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken() });
    const rara = "a&b=c+d%e é/ñ#?";
    await auth().obtenerToken(credencial({ claveSol: rara }));
    expect(ent.seguridad.peticiones[0]!.formulario!["password"]).toBe(rara);
  });

  it("no pone secretos en la ruta, la query ni las cabeceras", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken() });
    await auth().obtenerToken(credencial());
    const p = ent.seguridad.peticiones[0]!;
    const fuera = JSON.stringify({ r: p.ruta, q: p.queryCruda, c: p.cabeceras });
    expect(fuera).not.toContain(CANARIOS.clientSecret);
    expect(fuera).not.toContain(CANARIOS.claveSol);
  });

  it("solo habla con el host de seguridad (nada al host del SIRE)", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken() });
    await auth().obtenerToken(credencial());
    expect(ent.sire.peticiones).toHaveLength(0);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("sin urlsDePrueba usa el host real y la ruta del plan (con fetch inyectado, sin red)", async () => {
    const vistas: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFalso = ((url: string | URL | Request, init?: RequestInit) => {
      vistas.push({ url: String(url), init });
      return Promise.resolve(Response.json(cuerpoToken()));
    }) as typeof fetch;
    await new HttpSireAuth({ fetch: fetchFalso, ahora: () => AHORA }).obtenerToken(credencial());
    expect(vistas).toHaveLength(1);
    expect(vistas[0]!.url).toBe(`${URL_REAL.seguridad}${RUTAS.token()}`);
    expect(vistas[0]!.init?.method).toBe("POST");
    expect(vistas[0]!.init?.redirect).toBe("manual");
    expect(vistas[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect((vistas[0]!.init!.signal as AbortSignal).aborted).toBe(false);
  });

  it("cada llamada pide un token nuevo (la caché es de 008, no del adaptador)", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken({ access_token: "T1" }) }, { json: cuerpoToken({ access_token: "T2" }) });
    const a = auth();
    expect((await a.obtenerToken(credencial())).token).toBe("T1");
    expect((await a.obtenerToken(credencial())).token).toBe("T2");
    expect(ent.seguridad.peticiones).toHaveLength(2);
  });
});

describe("HttpSireAuth · respuesta", () => {
  it("devuelve token y expiraEn = ahora + expires_in", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken({ access_token: "TOK-1", expires_in: 3600 }) });
    const r = await auth().obtenerToken(credencial());
    expect(r.token).toBe("TOK-1");
    expect(r.expiraEn).toBeInstanceOf(Date);
    expect(r.expiraEn.getTime()).toBe(AHORA.getTime() + 3_600_000);
  });

  it("expira según el expires_in recibido y el reloj inyectado", async () => {
    const reloj = relojVirtual(new Date("2027-01-01T00:00:00.000Z"));
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpoToken({ expires_in: 90 }) });
    const r = await auth({ ahora: reloj.ahora }).obtenerToken(credencial());
    expect(r.expiraEn.getTime()).toBe(new Date("2027-01-01T00:01:30.000Z").getTime());
  });

  it("no depende de que la respuesta traiga token_type", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: { access_token: "TOK-2", expires_in: 600 } });
    expect((await auth().obtenerToken(credencial())).token).toBe("TOK-2");
  });

  it.each([
    ["sin access_token", { expires_in: 3600 }],
    ["access_token vacío", { access_token: "", expires_in: 3600 }],
    ["access_token no es texto", { access_token: 12345, expires_in: 3600 }],
    ["sin expires_in", { access_token: "T" }],
    ["expires_in cero", { access_token: "T", expires_in: 0 }],
    ["expires_in negativo", { access_token: "T", expires_in: -5 }],
    ["expires_in no numérico", { access_token: "T", expires_in: "pronto" }],
    ["expires_in nulo", { access_token: "T", expires_in: null }],
    ["expires_in fraccionario", { access_token: "T", expires_in: 1.5 }],
  ])("200 %s -> ErrorPortalSire", async (_caso, cuerpo) => {
    ent.seguridad.guionar("POST", RUTAS.token(), { json: cuerpo });
    const e = await capturar(auth().obtenerToken(credencial()));
    esperarError(e, "ErrorPortalSire");
    esperarError(e, "ErrorPortal");
    sinSecretos(e);
  });

  it.each([
    ["texto que no es JSON", { texto: "<html>mantenimiento</html>" }],
    ["cuerpo vacío", { texto: "" }],
    ["JSON que no es objeto", { json: ["a"] }],
  ])("200 con %s -> ErrorPortalSire", async (_caso, respuesta) => {
    ent.seguridad.guionar("POST", RUTAS.token(), respuesta);
    esperarError(await capturar(auth().obtenerToken(credencial())), "ErrorPortalSire");
  });
});

describe("HttpSireAuth · errores HTTP", () => {
  it.each([400, 401])("%i -> ErrorCredencial", async (estado) => {
    ent.seguridad.guionar("POST", RUTAS.token(), { estado, json: { error: "invalid_grant" } });
    const e = await capturar(auth().obtenerToken(credencial()));
    esperarError(e, "ErrorCredencial");
    sinSecretos(e);
  });

  it.each([429, 500, 502, 503, 504])("%i -> ErrorTransitorio", async (estado) => {
    ent.seguridad.guionar("POST", RUTAS.token(), { estado, json: { error: "x" } });
    const e = await capturar(auth().obtenerToken(credencial()));
    esperarError(e, "ErrorTransitorioSire");
    esperarError(e, "ErrorTransitorio");
    sinSecretos(e);
  });

  it("el cuerpo del error de SUNAT se descarta: un canario en él no sale en el error", async () => {
    const eco = `echo ${CANARIOS.clientSecret} ${CANARIOS.claveSol} ${CANARIOS.token}`;
    for (const estado of [400, 401, 500]) {
      ent.seguridad.guionar("POST", RUTAS.token(), { estado, json: { error: eco, error_description: eco } });
      sinSecretos(await capturar(auth().obtenerToken(credencial())));
    }
  });

  it("un error de red (socket cortado) -> ErrorTransitorio sin secretos", async () => {
    ent.seguridad.guionar("POST", RUTAS.token(), { cortar: true });
    const e = await capturar(auth().obtenerToken(credencial()));
    esperarError(e, "ErrorTransitorioSire", "red");
    sinSecretos(e);
  });

  it("un timeout del fetch (TimeoutError / AbortError) -> ErrorTransitorio con detalle timeout", async () => {
    for (const nombre of ["TimeoutError", "AbortError"]) {
      const fetchFalso = (() => Promise.reject(new DOMException("agotado", nombre))) as typeof fetch;
      const e = await capturar(new HttpSireAuth({ fetch: fetchFalso, ahora: () => AHORA }).obtenerToken(credencial()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      sinSecretos(e);
    }
  });

  it("un fetch que falla con un mensaje que trae secretos no los filtra", async () => {
    const fetchFalso = (() => {
      const causa = Object.assign(new Error(`connect ECONNRESET ${CANARIOS.clientSecret} ${CANARIOS.claveSol}`), { code: "ECONNRESET" });
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: causa }));
    }) as typeof fetch;
    const e = await capturar(new HttpSireAuth({ fetch: fetchFalso, ahora: () => AHORA }).obtenerToken(credencial()));
    esperarError(e, "ErrorTransitorio");
    sinSecretos(e);
  });

  it.each([301, 302, 307, 308])("%i no se sigue: ErrorPortalSire y el destino no recibe nada", async (estado) => {
    ent.seguridad.guionar("POST", RUTAS.token(), { estado, cabeceras: { location: `${ent.ajeno.origen}/robar` } });
    const e = await capturar(auth().obtenerToken(credencial()));
    esperarError(e, "ErrorPortalSire");
    sinSecretos(e);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });
});

describe("HttpSireAuth · client_id fuera de gramática", () => {
  it.each([
    ["vacío", ""],
    ["con barra", "a/b"],
    ["con punto-punto", "../x"],
    ["con espacio", "id con espacio"],
    ["con query", "x?y=1"],
    ["con porcentaje", "%2e%2e"],
    ["con barra invertida", "a\\b"],
    ["con salto de línea", "a\nb"],
    ["con arroba", "a@b"],
    ["de 65 caracteres", "a".repeat(65)],
    ["con tilde", "cliént"],
  ])("%s -> ErrorCredencial sin llamar a la red", async (_caso, clientId) => {
    let llamadas = 0;
    const fetchFalso = (() => {
      llamadas += 1;
      return Promise.resolve(Response.json(cuerpoToken()));
    }) as typeof fetch;
    const e = await capturar(new HttpSireAuth({ fetch: fetchFalso, ahora: () => AHORA }).obtenerToken(credencial({ clientId })));
    esperarError(e, "ErrorCredencial");
    sinSecretos(e);
    expect(llamadas).toBe(0);
  });

  it("acepta la gramática completa (letras, dígitos y guiones, hasta 64)", async () => {
    const largo = `${"aZ09-".repeat(12)}abcd`; // 64
    expect(largo).toHaveLength(64);
    ent.seguridad.guionar("POST", RUTAS.token(largo), { json: cuerpoToken() });
    await auth().obtenerToken(credencial({ clientId: largo }));
    expect(ent.seguridad.peticionesDe("POST", RUTAS.token(largo))).toHaveLength(1);
  });
});

describe("HttpSireAuth · canarios", () => {
  it("el token de la respuesta solo se devuelve; nunca se registra en el error de otra llamada", async () => {
    ent.seguridad.guionar(
      "POST",
      RUTAS.token(),
      { json: cuerpoToken() },
      { estado: 500, json: { token_previo: CANARIOS.token } },
    );
    const a = auth();
    expect((await a.obtenerToken(credencial())).token).toBe(CANARIOS.token);
    sinSecretos(await capturar(a.obtenerToken(credencial())));
  });
});
