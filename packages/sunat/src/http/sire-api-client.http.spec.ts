import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PropuestaSire, SolicitudPropuesta, TokenSire } from "../puertos.js";
import { AlmacenTicketsMemoria, type AlmacenTicketsSire } from "./almacen-tickets.js";
import {
  CANARIOS,
  PERIODO,
  RUC,
  RUTAS,
  URL_REAL,
  archivo,
  capturar,
  columnaDe,
  contarFilas,
  crearEntorno,
  cuerpoTicket,
  esperarError,
  fixture,
  guionarFlujo,
  parteCompras,
  parteVentas,
  registroTicket,
  relojVirtual,
  sinSecretos,
  zip,
  type EntornoFalso,
  type RelojVirtual,
} from "./pruebas/ayudas-http.js";
import { conPeriodo } from "./pruebas/ayudas-txt.js";
import type { RespuestaFalsa } from "./pruebas/servidor-sire-falso.js";
import { HttpSireApiClient } from "./sire-api-client.http.js";
import type { OpcionesHttpSire } from "./sire-auth.http.js";

// Contrato (plan 041 «Contratos», «Endpoints», «Decisiones»; spec CA-8, CA-9, CA-11, CA-12, CA-13):
//  - `new HttpSireApiClient({ fetch?, ahora?, dormir?, almacenTickets?, urlsDePrueba?: { seguridad, sire } })` implementa SireApiClient.
//    `urlsDePrueba.sire` reemplaza solo el ORIGEN; el adaptador añade las rutas de `RUTAS` (ayudas-http). Todas las
//    peticiones son GET con `Authorization: Bearer {token.token}` hacia el host del SIRE, con `redirect: "manual"` y un
//    `AbortSignal` de timeout. Nunca llama al host de seguridad. No reintenta por su cuenta (los reintentos son de 008).
//  - Pasos: exportar (RCE: codTipoArchivo=0&codOrigenEnvio=2; RVIE: codTipoArchivo=0) -> {numTicket};
//    consultaestadotickets (perIni=perFin=periodo, page=1, perPage=20, numTicket); archivoreporte por cada parte
//    (nomArchivoReporte, codTipoArchivoReporte, perTributario, codProceso, numTicket, codLibro=080000|140000).
//  - La solicitud puede traer `claveReanudacion` (texto opaco, p. ej. "{tenantId}:{clienteId}"; llega en 041/T6 a `puertos.ts`).
//    Con `almacenTickets` Y `claveReanudacion`, un ticket que no termina en el presupuesto se guarda (valor = solo el
//    numTicket, TTL 1 h) y el siguiente intento lo retoma sin exportar de nuevo; al terminar (bien o mal) se borra. La clave
//    del almacén incluye `claveReanudacion`, el libro y el periodo. Sin `claveReanudacion` no se guarda nada.
//  - Errores: ver la tabla `CASOS_HTTP`; todos sin secretos (CA-12). Detalles literales del plan.
const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const COMPRAS = { ruc: RUC, periodo: PERIODO, libro: "compras" } as const;
const VENTAS = { ruc: RUC, periodo: PERIODO, libro: "ventas" } as const;
const CLAVE = "TENANT-1:CLIENTE-1";
const T = "202610000001";

let ent: EntornoFalso;
let reloj: RelojVirtual;
beforeEach(async () => {
  ent = await crearEntorno();
  reloj = relojVirtual();
});
afterEach(async () => {
  await ent.cerrar();
});

function cliente(extra: OpcionesHttpSire = {}): HttpSireApiClient {
  return new HttpSireApiClient({ urlsDePrueba: ent.urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir, ...extra });
}
function conClave(base: SolicitudPropuesta, clave: string = CLAVE): SolicitudPropuesta {
  const s = { ...base, claveReanudacion: clave };
  return s;
}
function filas(p: PropuestaSire): unknown[] {
  return p.filas;
}
function numeros(p: PropuestaSire): string[] {
  return (p.filas as { numero: string }[]).map((f) => f.numero);
}

/** Almacén de memoria que además anota lo que se le hizo. */
class AlmacenEspia implements AlmacenTicketsSire {
  readonly interno: AlmacenTicketsMemoria;
  readonly guardados: { clave: string; numTicket: string; ttlMs: number }[] = [];
  readonly borrados: string[] = [];
  constructor(ahora: () => Date) {
    this.interno = new AlmacenTicketsMemoria(ahora);
  }
  leer(clave: string): Promise<string | null> {
    return this.interno.leer(clave);
  }
  async guardar(clave: string, numTicket: string, ttlMs: number): Promise<void> {
    this.guardados.push({ clave, numTicket, ttlMs });
    await this.interno.guardar(clave, numTicket, ttlMs);
  }
  async borrar(clave: string): Promise<void> {
    this.borrados.push(clave);
    await this.interno.borrar(clave);
  }
}

describe("HttpSireApiClient · compras (RCE)", () => {
  it("exporta, consulta el ticket, descarga y devuelve las filas del TXT", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    const r = await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe(PERIODO);
    expect(filas(r)).toHaveLength(contarFilas(fixture("compras-propuesta-202610.txt")));
    expect(ent.sire.sinGuion).toHaveLength(0);
    expect(ent.seguridad.peticiones).toHaveLength(0);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("usa las rutas y parámetros del plan, todo GET con Bearer", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras("n1.zip")] });
    await cliente().descargarPropuesta(TOKEN, COMPRAS);
    const [exportar, ticket, descarga] = ent.sire.peticiones;
    expect([exportar!.ruta, ticket!.ruta, descarga!.ruta]).toEqual([RUTAS.exportarRce(), RUTAS.ticket, RUTAS.archivo]);
    expect(exportar!.query).toEqual({ codTipoArchivo: "0", codOrigenEnvio: "2" });
    expect(ticket!.query).toEqual({ perIni: PERIODO, perFin: PERIODO, page: "1", perPage: "20", numTicket: T });
    expect(descarga!.query).toEqual({
      nomArchivoReporte: "n1.zip",
      codTipoArchivoReporte: "00",
      perTributario: PERIODO,
      codProceso: "10",
      numTicket: T,
      codLibro: "080000",
    });
    for (const p of ent.sire.peticiones) {
      expect(p.metodo).toBe("GET");
      expect(p.cabeceras["authorization"]).toBe(`Bearer ${CANARIOS.token}`);
    }
  });

  it("cada petición lleva redirect manual y un AbortSignal vivo (timeout por petición)", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    const vistas: RequestInit[] = [];
    const f = ((u: string | URL | Request, init?: RequestInit) => {
      vistas.push(init ?? {});
      return globalThis.fetch(u, init);
    }) as typeof fetch;
    await cliente({ fetch: f }).descargarPropuesta(TOKEN, COMPRAS);
    expect(vistas).toHaveLength(3);
    for (const init of vistas) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.signal as AbortSignal).aborted).toBe(false);
    }
  });

  it("sin urlsDePrueba usa los hosts reales (con fetch inyectado: sin red)", async () => {
    const urls: string[] = [];
    const f = ((u: string | URL | Request) => {
      urls.push(String(u));
      return Promise.resolve(
        urls.length === 1
          ? Response.json({ numTicket: T })
          : Response.json(cuerpoTicket([registroTicket(T, "03")])),
      );
    }) as typeof fetch;
    const e = await capturar(new HttpSireApiClient({ fetch: f, ahora: reloj.ahora, dormir: reloj.dormir }).descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorDatosSire", "ticket_con_errores");
    expect(urls[0]!.startsWith(`${URL_REAL.sire}${RUTAS.exportarRce()}?`)).toBe(true);
    expect(urls[1]!.startsWith(`${URL_REAL.sire}${RUTAS.ticket}?`)).toBe(true);
  });
});

describe("HttpSireApiClient · ventas (RVIE)", () => {
  it("exporta con la ruta de ventas (sin codOrigenEnvio) y pide codLibro 140000", async () => {
    guionarFlujo(ent.sire, { libro: "ventas", numTicket: T, partes: [parteVentas("v1.zip")] });
    const r = await cliente().descargarPropuesta(TOKEN, VENTAS);
    expect(r.libro).toBe("ventas");
    expect(r.periodo).toBe(PERIODO);
    expect(filas(r)).toHaveLength(contarFilas(fixture("ventas-propuesta-202610.txt")));
    const [exportar, , descarga] = ent.sire.peticiones;
    expect(exportar!.ruta).toBe(RUTAS.exportarRvie());
    expect(exportar!.query).toEqual({ codTipoArchivo: "0" });
    expect(descarga!.query["codLibro"]).toBe("140000");
  });

  it("el periodo de la ruta es el pedido", async () => {
    guionarFlujo(ent.sire, { libro: "ventas", numTicket: T, periodo: "202601", partes: [parteVentas()] });
    ent.sire.guionar("GET", RUTAS.ticket, {
      json: cuerpoTicket([registroTicket(T, "04", [archivo("v.zip")], { perTributario: "202601" })]),
    });
    const txtEnero = conPeriodo(fixture("ventas-propuesta-202610.txt"), "202601");
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: zip("LE20700000002202601001404001EXP2.txt", txtEnero) });
    await cliente().descargarPropuesta(TOKEN, { ...VENTAS, periodo: "202601" });
    expect(ent.sire.peticiones[0]!.ruta).toBe(RUTAS.exportarRvie("202601"));
    expect(ent.sire.peticiones[1]!.query["perIni"]).toBe("202601");
    expect(ent.sire.peticiones[1]!.query["perFin"]).toBe("202601");
  });
});

describe("HttpSireApiClient · solicitud inválida", () => {
  it.each([
    ["periodo con barra", { ...COMPRAS, periodo: "../x" }],
    ["periodo de 5 dígitos", { ...COMPRAS, periodo: "20261" }],
    ["mes 13", { ...COMPRAS, periodo: "202613" }],
    ["mes 00", { ...COMPRAS, periodo: "202600" }],
    ["periodo con guion", { ...COMPRAS, periodo: "2026-10" }],
    ["periodo con query", { ...COMPRAS, periodo: "202610?x=1" }],
    ["ruc de 10 dígitos", { ...COMPRAS, ruc: "2070000000" }],
    ["ruc con letras", { ...COMPRAS, ruc: "2070000000A" }],
  ])("%s -> ErrorDatos sin llamar a la red", async (_caso, solicitud) => {
    const e = await capturar(cliente().descargarPropuesta(TOKEN, solicitud as SolicitudPropuesta));
    esperarError(e, "ErrorDatos");
    expect(ent.sire.peticiones).toHaveLength(0);
  });
});

describe("HttpSireApiClient · estados del ticket (CA-8)", () => {
  function ticketPorEstados(estados: string[], partes = [parteCompras()]): void {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes });
    const respuestas = estados.map<RespuestaFalsa>((estado) => ({
      json: cuerpoTicket([registroTicket(T, estado, estado === "04" || estado === "06" ? partes.map((p) => archivo(p.nombre)) : [])]),
    }));
    ent.sire.guionar("GET", RUTAS.ticket, ...respuestas);
  }

  it("01, 02 y 05 son pendientes: sigue consultando el MISMO ticket hasta 04", async () => {
    ticketPorEstados(["01", "02", "05", "04"]);
    await cliente().descargarPropuesta(TOKEN, COMPRAS);
    const consultas = ent.sire.peticionesDe("GET", RUTAS.ticket);
    expect(consultas).toHaveLength(4);
    expect(new Set(consultas.map((c) => c.query["numTicket"]))).toEqual(new Set([T]));
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce())).toHaveLength(1);
    expect(reloj.esperas).toHaveLength(3);
  });

  it("06 también es listo", async () => {
    ticketPorEstados(["06"]);
    const r = await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(filas(r).length).toBeGreaterThan(0);
  });

  it("03 -> ErrorDatosSire ticket_con_errores y no descarga nada", async () => {
    ticketPorEstados(["03"]);
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorDatosSire", "ticket_con_errores");
    sinSecretos(e);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it.each(["07", "99", "00"])("código %s -> ErrorPortalSire estado_desconocido", async (estado) => {
    ticketPorEstados([estado]);
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorPortalSire", "estado_desconocido");
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it("ticket ajeno en registros: usa el registro de su numTicket aunque no sea el primero", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras("mio.zip")] });
    ent.sire.guionar("GET", RUTAS.ticket, {
      json: cuerpoTicket([
        registroTicket("TICKET-AJENO", "04", [archivo("ajeno.zip")]),
        registroTicket(T, "04", [archivo("mio.zip")]),
      ]),
    });
    await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual(["mio.zip"]);
  });

  it("registros que no incluyen su ticket -> ErrorDatosSire respuesta_ajena y no descarga", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket("TICKET-AJENO", "04", [archivo("ajeno.zip")])]) });
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorDatosSire", "respuesta_ajena");
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it("un registro ajeno con error (03) no afecta a su ticket pendiente", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    ent.sire.guionar(
      "GET",
      RUTAS.ticket,
      { json: cuerpoTicket([registroTicket("TICKET-AJENO", "03"), registroTicket(T, "01")]) },
      { json: cuerpoTicket([registroTicket("TICKET-AJENO", "03"), registroTicket(T, "04", [archivo(parteCompras().nombre)])]) },
    );
    const r = await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(filas(r).length).toBeGreaterThan(0);
  });
});

describe("HttpSireApiClient · varias partes y nombres (CA-9)", () => {
  const P1 = zip("p1.txt", fixture("compras-propuesta-202610-parte1.txt"));
  const P2 = zip("p2.txt", fixture("compras-propuesta-202610-parte2.txt"));
  const P2_DISTINTA = zip("p2.txt", fixture("compras-propuesta-202610-parte2-encabezado-distinto.txt"));

  it("descarga todas las partes en el orden del ticket y concatena las filas en ese orden", async () => {
    guionarFlujo(ent.sire, {
      libro: "compras",
      numTicket: T,
      partes: [
        { nombre: "parte-1.zip", zip: P1 },
        { nombre: "parte-2.zip", zip: P2 },
      ],
    });
    const r = await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual(["parte-1.zip", "parte-2.zip"]);
    const col = "Nro CP o Doc. Nro Inicial (Rango)";
    const esperados = [...columnaDe(fixture("compras-propuesta-202610-parte1.txt"), col), ...columnaDe(fixture("compras-propuesta-202610-parte2.txt"), col)];
    expect(r.libro).toBe("compras");
    expect(numeros(r)).toEqual(esperados);
  });

  it("el orden es el del ticket aunque los nombres estén al revés", async () => {
    guionarFlujo(ent.sire, {
      libro: "compras",
      numTicket: T,
      partes: [
        { nombre: "z-parte-2.zip", zip: P2 },
        { nombre: "a-parte-1.zip", zip: P1 },
      ],
    });
    const r = await cliente().descargarPropuesta(TOKEN, COMPRAS);
    const col = "Nro CP o Doc. Nro Inicial (Rango)";
    expect(numeros(r)).toEqual([
      ...columnaDe(fixture("compras-propuesta-202610-parte2.txt"), col),
      ...columnaDe(fixture("compras-propuesta-202610-parte1.txt"), col),
    ]);
  });

  it("encabezados distintos entre partes -> ErrorPortalSire encabezado, sin filas a medias", async () => {
    guionarFlujo(ent.sire, {
      libro: "compras",
      numTicket: T,
      partes: [
        { nombre: "parte-1.zip", zip: P1 },
        { nombre: "parte-2.zip", zip: P2_DISTINTA },
      ],
    });
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorPortalSire", "encabezado");
    sinSecretos(e);
  });

  it.each([
    ["con ..", "../x.zip"],
    ["con barra", "a/b.zip"],
    ["con barra invertida", "a\\b.zip"],
    ["con NUL", "a\u0000b.zip"],
    ["con salto de línea", "a\nb.zip"],
    ["con tabulación", "a\tb.zip"],
    ["solo ..", ".."],
    ["con .. en medio", "a/../b.zip"],
    ["vacío", ""],
  ])("nomArchivoReporte %s -> ErrorPortalSire nombre_archivo y NO descarga", async (_caso, nombre) => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket(T, "04", [archivo(nombre)])]) });
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorPortalSire", "nombre_archivo");
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it.each([
    [{ nomArchivoReporte: "a.zip", codTipoAchivoReporte: null }, "null"],
    [{ nomArchivoReporte: "a.zip", codTipoArchivoReporte: null }, "null"],
    [{ nomArchivoReporte: "a.zip", codTipoAchivoReporte: "01" }, "01"],
    [{ nomArchivoReporte: "a.zip", codTipoArchivoReporte: "02" }, "02"],
  ])("tipo de archivo %j se envía como codTipoArchivoReporte=%s", async (parte, esperado) => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras("a.zip")] });
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket(T, "04", [parte])]) });
    await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)[0]!.query["codTipoArchivoReporte"]).toBe(esperado);
  });

  it("el archivo recibido que no es un ZIP -> ErrorPortalSire zip_invalido", async () => {
    for (const cuerpo of [new TextEncoder().encode("<html>Mantenimiento</html>"), new Uint8Array(0), parteCompras().zip.subarray(0, 30)]) {
      ent.sire.reiniciar();
      guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras("a.zip")] });
      ent.sire.guionar("GET", RUTAS.archivo, { bytes: cuerpo });
      esperarError(await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS)), "ErrorPortalSire", "zip_invalido");
    }
  });
});

// ── Errores HTTP por paso (CA-11) y secretos (CA-12) ─────────────────────────────────────────────────────
type Paso = "exportar" | "ticket" | "archivo";
const PASOS: Paso[] = ["exportar", "ticket", "archivo"];
function rutaDe(paso: Paso): string {
  return paso === "exportar" ? RUTAS.exportarRce() : paso === "ticket" ? RUTAS.ticket : RUTAS.archivo;
}
/** Flujo sano con UN paso reemplazado por la respuesta dada. */
function guionarConFalla(paso: Paso, respuesta: RespuestaFalsa): void {
  guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
  ent.sire.guionar("GET", rutaDe(paso), respuesta);
}
function noLlamadosDespuesDe(paso: Paso): void {
  const despues = PASOS.slice(PASOS.indexOf(paso) + 1);
  for (const p of despues) expect(ent.sire.peticionesDe("GET", rutaDe(p)), `no debía llamar a ${p}`).toHaveLength(0);
  expect(ent.sire.peticionesDe("GET", rutaDe(paso)), "no reintenta por su cuenta").toHaveLength(1);
}

const ECO = { error: `${CANARIOS.token} ${CANARIOS.clientSecret} ${CANARIOS.claveSol}` };
const CASOS_HTTP: [number, Parameters<typeof esperarError>[1], string | undefined][] = [
  [401, "TokenRechazadoError", undefined],
  [403, "ErrorCredencial", undefined],
  [422, "ErrorDatos", undefined],
  [429, "ErrorTransitorioSire", "servidor"],
  [500, "ErrorTransitorioSire", "servidor"],
  [502, "ErrorTransitorioSire", "servidor"],
  [503, "ErrorTransitorioSire", "servidor"],
  [504, "ErrorTransitorioSire", "servidor"],
];

describe("HttpSireApiClient · códigos HTTP de la API (CA-11)", () => {
  for (const paso of PASOS) {
    it.each(CASOS_HTTP)(`${paso} · HTTP %i -> %s`, async (estado, clase, detalle) => {
      guionarConFalla(paso, { estado, json: ECO });
      const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
      esperarError(e, clase, detalle);
      sinSecretos(e);
      noLlamadosDespuesDe(paso);
    });
  }

  it("404 del archivo -> ErrorTransitorio", async () => {
    guionarConFalla("archivo", { estado: 404, json: ECO });
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorTransitorioSire");
    sinSecretos(e);
  });

  for (const paso of PASOS) {
    it.each([301, 302, 307, 308])(`${paso} · redirección %i no se sigue -> ErrorPortalSire`, async (estado) => {
      guionarConFalla(paso, { estado, cabeceras: { location: `${ent.ajeno.origen}/robar` } });
      const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
      esperarError(e, "ErrorPortalSire");
      sinSecretos(e);
      expect(ent.ajeno.peticiones, "el destino de la redirección no debe recibir nada (ni el token)").toHaveLength(0);
      noLlamadosDespuesDe(paso);
    });
  }

  it.each([
    ["exportar", { json: {} }],
    ["exportar", { json: { numTicket: 123 } }],
    ["exportar", { json: { numTicket: "" } }],
    ["exportar", { json: [] }],
    ["exportar", { texto: "<html>no es json</html>" }],
    ["ticket", { json: { registros: "x" } }],
    ["ticket", { json: [] }],
    ["ticket", { texto: "<html>no es json</html>" }],
    ["archivo", { texto: "<html>Mantenimiento</html>" }],
  ] as [Paso, RespuestaFalsa][])("200 que no cumple el esquema (%s %j) -> ErrorPortalSire", async (paso, respuesta) => {
    guionarConFalla(paso, respuesta);
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorPortalSire");
    sinSecretos(e);
    noLlamadosDespuesDe(paso);
  });

  it.each(["exportar", "ticket"] as Paso[])("%s · una respuesta JSON de más de 1 MiB (sin content-length) -> ErrorPortalSire", async (paso) => {
    guionarConFalla(paso, { repetirBytes: { byte: 0x20, total: 2 * 1_048_576 }, sinContentLength: true, cabeceras: { "content-type": "application/json" } });
    esperarError(await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS)), "ErrorPortalSire");
  });

  it.each(PASOS)("%s · un socket cortado (ECONNRESET) -> ErrorTransitorioSire red", async (paso) => {
    guionarConFalla(paso, { cortar: true });
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorTransitorioSire", "red");
    sinSecretos(e);
    noLlamadosDespuesDe(paso);
  });

  it.each([
    [1, "exportar"],
    [2, "ticket"],
    [3, "archivo"],
  ] as [number, Paso][])("la petición %i (%s) con timeout -> ErrorTransitorioSire timeout", async (n, paso) => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    let k = 0;
    const f = ((u: string | URL | Request, init?: RequestInit) => {
      k += 1;
      return k === n
        ? Promise.reject(Object.assign(new DOMException(`agotado ${CANARIOS.token}`, "TimeoutError"), { cause: CANARIOS.claveSol }))
        : globalThis.fetch(u, init);
    }) as typeof fetch;
    const e = await capturar(cliente({ fetch: f }).descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorTransitorioSire", "timeout");
    sinSecretos(e);
    expect(ent.sire.peticionesDe("GET", rutaDe(paso))).toHaveLength(0);
  });
});

describe("HttpSireApiClient · secretos (CA-12)", () => {
  it("el token solo viaja en Authorization al host del SIRE; no hay nada en ruta, query ni cuerpo", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    await cliente().descargarPropuesta(TOKEN, COMPRAS);
    expect(ent.sire.peticiones.length).toBeGreaterThanOrEqual(3);
    for (const p of ent.sire.peticiones) {
      expect(p.cabeceras["authorization"]).toBe(`Bearer ${CANARIOS.token}`);
      const resto = `${p.ruta}?${p.queryCruda}\n${p.cuerpo}\n${Object.entries(p.cabeceras).filter(([k]) => k !== "authorization").map(([k, v]) => `${k}:${v}`).join("\n")}`;
      for (const s of [CANARIOS.token, CANARIOS.clientSecret, CANARIOS.claveSol]) expect(resto).not.toContain(s);
    }
    expect(ent.seguridad.peticiones).toHaveLength(0);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("un error de SUNAT que repite el token en su cuerpo no lo filtra al error ni al stack", async () => {
    for (const paso of PASOS) {
      for (const estado of [401, 403, 422, 500]) {
        ent.sire.reiniciar();
        guionarConFalla(paso, { estado, json: ECO });
        sinSecretos(await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS)));
      }
    }
  });
});

// ── Presupuesto y reanudación (CA-8, P-4 c, P-8) ─────────────────────────────────────────────────────────
describe("HttpSireApiClient · ticket que no termina (P-4 c)", () => {
  function pendienteSiempre(): void {
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T } });
    // Responde «pendiente» (01) para el numTicket que se pida, no solo para T.
    ent.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? T, "01")]) }));
  }

  it("sondea 0,5/1/2/4 s, no pasa de 20 s dormidos y termina en ErrorTransitorioSire ticket_pendiente", async () => {
    pendienteSiempre();
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorTransitorioSire", "ticket_pendiente");
    esperarError(e, "ErrorTransitorio");
    sinSecretos(e);
    expect(reloj.esperas.slice(0, 4)).toEqual([500, 1000, 2000, 4000]);
    expect(Math.max(...reloj.esperas)).toBeLessThanOrEqual(4000);
    expect(reloj.total()).toBeLessThanOrEqual(20_000);
    expect(reloj.total()).toBeGreaterThanOrEqual(19_500);
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket)).toHaveLength(reloj.esperas.length + 1);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it("sin almacén cae en la opción (a): el reintento exporta de nuevo", async () => {
    pendienteSiempre();
    const c = cliente();
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS)));
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS)));
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce())).toHaveLength(2);
  });

  it("con almacén y clave: guarda solo el numTicket con TTL de 1 h, y la clave lleva clave de reanudación, libro y periodo", async () => {
    pendienteSiempre();
    const almacen = new AlmacenEspia(reloj.ahora);
    await capturar(cliente({ almacenTickets: almacen }).descargarPropuesta(TOKEN, conClave(COMPRAS)));
    expect(almacen.guardados).toHaveLength(1);
    const g = almacen.guardados[0]!;
    expect(g.numTicket).toBe(T);
    expect(g.ttlMs).toBe(3_600_000);
    expect(g.clave).toContain(CLAVE);
    expect(g.clave).toContain("compras");
    expect(g.clave).toContain(PERIODO);
    expect(g.clave).not.toContain(CANARIOS.token);
    expect(await almacen.leer(g.clave)).toBe(T);
  });

  it("el reintento retoma el MISMO ticket sin exportar de nuevo y, al terminar, borra la clave", async () => {
    let listo = false;
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T } });
    const parte = parteCompras("r.zip");
    ent.sire.guionar("GET", RUTAS.ticket, () => ({ json: cuerpoTicket([registroTicket(T, listo ? "04" : "01", listo ? [archivo("r.zip")] : [])]) }));
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: parte.zip });
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    esperarError(await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS))), "ErrorTransitorioSire", "ticket_pendiente");
    const clave = almacen.guardados[0]!.clave;
    listo = true;
    const r = await c.descargarPropuesta(TOKEN, conClave(COMPRAS));

    expect(filas(r).length).toBeGreaterThan(0);
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce()), "no exporta de nuevo").toHaveLength(1);
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket).at(-1)!.query["numTicket"]).toBe(T);
    expect(almacen.borrados).toContain(clave);
    expect(await almacen.leer(clave)).toBeNull();
  });

  it("si el ticket guardado termina en error (03) también se borra", async () => {
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T } });
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket(T, "01")]) }, { json: cuerpoTicket([registroTicket(T, "01")]) });
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS)));
    const clave = almacen.guardados[0]!.clave;
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket(T, "03")]) });
    esperarError(await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS))), "ErrorDatosSire", "ticket_con_errores");
    expect(await almacen.leer(clave)).toBeNull();
  });

  it("otro estudio con el mismo cliente (otra clave de reanudación) NO reutiliza el ticket", async () => {
    pendienteSiempre();
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS, "ESTUDIO-A:CLIENTE-1")));
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS, "ESTUDIO-B:CLIENTE-1")));
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce())).toHaveLength(2);
    expect(new Set(almacen.guardados.map((g) => g.clave)).size).toBe(2);
  });

  it("otro periodo o libro con la misma clave usa otra clave de almacén", async () => {
    pendienteSiempre();
    ent.sire.guionar("GET", RUTAS.exportarRce("202609"), { json: { numTicket: "202609000001" } });
    ent.sire.guionar("GET", RUTAS.exportarRvie(), { json: { numTicket: "202610000002" } });
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS)));
    await capturar(c.descargarPropuesta(TOKEN, conClave({ ...COMPRAS, periodo: "202609" })));
    await capturar(c.descargarPropuesta(TOKEN, conClave(VENTAS)));
    expect(new Set(almacen.guardados.map((g) => g.clave)).size).toBe(3);
  });

  it("con almacén pero sin claveReanudacion no guarda nada", async () => {
    pendienteSiempre();
    const almacen = new AlmacenEspia(reloj.ahora);
    esperarError(await capturar(cliente({ almacenTickets: almacen }).descargarPropuesta(TOKEN, COMPRAS)), "ErrorTransitorioSire", "ticket_pendiente");
    expect(almacen.guardados).toHaveLength(0);
  });

  it("un ticket guardado que SUNAT ya no lista: borra, re-exporta UNA vez en ese intento y, si el ticket nuevo tampoco aparece -> ErrorDatosSire respuesta_ajena y se borra", async () => {
    pendienteSiempre();
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });
    await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS)));
    const clave = almacen.guardados[0]!.clave;
    const exportacionesPrevias = ent.sire.peticionesDe("GET", RUTAS.exportarRce()).length;
    const T2 = "202610000002";
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T2 } });
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([]) });
    esperarError(await capturar(c.descargarPropuesta(TOKEN, conClave(COMPRAS))), "ErrorDatosSire", "respuesta_ajena");
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce()).length - exportacionesPrevias, "re-exporta una sola vez").toBe(1);
    expect(almacen.guardados.at(-1)!.numTicket, "guarda el ticket nuevo").toBe(T2);
    expect(await almacen.leer(clave)).toBeNull();
  });

  it("éxito sin pendiente: guarda el ticket al exportar y deja la clave BORRADA al final", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    const almacen = new AlmacenEspia(reloj.ahora);
    await cliente({ almacenTickets: almacen }).descargarPropuesta(TOKEN, conClave(COMPRAS));
    expect(almacen.guardados).toHaveLength(1);
    const clave = almacen.guardados[0]!.clave;
    expect(almacen.borrados).toContain(clave);
    expect(await almacen.leer(clave)).toBeNull();
  });

  it("presupuesto total de 90 s por operación: si la exportación ya lo agotó, no sigue", async () => {
    ent.sire.guionar("GET", RUTAS.exportarRce(), () => {
      reloj.avanzar(91_000);
      return { json: { numTicket: T } };
    });
    ent.sire.guionar("GET", RUTAS.ticket, { json: cuerpoTicket([registroTicket(T, "04", [archivo("a.zip")])]) });
    const e = await capturar(cliente().descargarPropuesta(TOKEN, COMPRAS));
    esperarError(e, "ErrorTransitorioSire", "timeout");
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket)).toHaveLength(0);
  });
});

describe("AlmacenTicketsMemoria", () => {
  it("guarda, lee y borra; una clave ausente es null", async () => {
    const a = new AlmacenTicketsMemoria(reloj.ahora);
    expect(await a.leer("k")).toBeNull();
    await a.guardar("k", "123", 60_000);
    expect(await a.leer("k")).toBe("123");
    await a.borrar("k");
    expect(await a.leer("k")).toBeNull();
    await a.borrar("k"); // idempotente
  });

  it("respeta el TTL con el reloj inyectado y las claves no se mezclan", async () => {
    const a = new AlmacenTicketsMemoria(reloj.ahora);
    await a.guardar("k1", "111", 3_600_000);
    await a.guardar("k2", "222", 1000);
    reloj.avanzar(2000);
    expect(await a.leer("k1")).toBe("111");
    expect(await a.leer("k2")).toBeNull();
    reloj.avanzar(3_600_000);
    expect(await a.leer("k1")).toBeNull();
  });
});

describe("HttpSireApiClient · registro presentado (CA-13)", () => {
  it.todo("descargarRegistroPresentado: mismo flujo y mapeo que la propuesta de compras; «sin datos» -> ErrorDatosSire sin_datos (requiere P-3: ruta de 5.51/5.40 según Postman)");
});
