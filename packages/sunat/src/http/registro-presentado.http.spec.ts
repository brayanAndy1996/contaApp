import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegistroPresentadoSire, SolicitudRegistroPresentado, TokenSire } from "../puertos.js";
import { AlmacenTicketsMemoria, type AlmacenTicketsSire } from "./almacen-tickets.js";
import {
  CANARIOS,
  PERIODO,
  RUC,
  RUTAS,
  archivo,
  capturar,
  crearEntorno,
  cuerpoTicket,
  esperarError,
  fixture,
  guionarFlujo,
  parteCompras,
  registroTicket,
  relojVirtual,
  sinSecretos,
  zip,
  type EntornoFalso,
  type ParteFalsa,
  type RelojVirtual,
} from "./pruebas/ayudas-http.js";
import type { GuionRespuesta, PeticionFalsa } from "./pruebas/servidor-sire-falso.js";
import { HttpSireApiClient } from "./sire-api-client.http.js";
import type { OpcionesHttpSire } from "./sire-auth.http.js";

// Registro presentado de compras (spec 041, CA-13; plan «P-3 · Registro presentado», servicio 5.51 del manual RCE v28).
// Decisiones del usuario (2026-11-28):
//  - P-3a `codProceso`: pide 01 y, si SUNAT responde «sin datos», reintenta UNA sola vez con 02 (nunca más, ni 00 ni 70).
//    «Sin datos» = 422 al solicitar (p. ej. cod 1070) o un TXT válido con solo el encabezado (plan, «Decisiones»).
//  - P-3b `codMoneda`: se omite; solo si SUNAT responde que lo exige se harían dos solicitudes (PEN y USD) y se unirían las
//    filas. El plan NO fija con qué respuesta el servidor falso modela «SUNAT exige moneda»: esa prueba queda `it.todo`.
// Flujo: GET 5.51 -> {numTicket}; luego el mismo ticket (5.31) y archivo (5.32, codLibro=080000) que la propuesta, con el
// codProceso/perTributario que devuelva el ticket. Clave del almacén: `{claveReanudacion}:compras:{per}:registro`.
const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const SOLICITUD: SolicitudRegistroPresentado = { ruc: RUC, periodo: PERIODO };
const CLAVE = "TENANT-1:CLIENTE-1";
const CLAVE_ALMACEN = `${CLAVE}:compras:${PERIODO}:registro`;
const T = "202610000001";
const T2 = "202610000002";
const COL_NUMERO = "Nro CP o Doc. Nro Inicial (Rango)";

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
function conClave(base: SolicitudRegistroPresentado = SOLICITUD): SolicitudRegistroPresentado {
  return { ...base, claveReanudacion: CLAVE };
}
function numeros(r: RegistroPresentadoSire): string[] {
  return r.filas.map((f) => f.numero);
}
function solicitudes(): PeticionFalsa[] {
  return ent.sire.peticionesDe("GET", RUTAS.solicitarRegistro());
}
function procesosPedidos(): (string | undefined)[] {
  return solicitudes().map((p) => p.query["codProceso"]);
}

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

/** Un ticket del servidor falso: su estado y, si está listo, sus partes (ZIP) y los campos extra del registro. */
interface TicketFalso {
  estado: string;
  partes?: ParteFalsa[];
  extra?: Record<string, unknown>;
}
/** Guiona ticket (5.31) y archivo (5.32) por `numTicket`; un ticket que no está en el mapa no figura en `registros`. */
function guionarTickets(mapa: Record<string, TicketFalso>): void {
  ent.sire.guionar("GET", RUTAS.ticket, (p) => {
    const nt = p.query["numTicket"] ?? "";
    const t = mapa[nt];
    if (t === undefined) return { json: cuerpoTicket([]) };
    const listo = t.estado === "04" || t.estado === "06";
    const archivos = listo ? (t.partes ?? []).map((x) => archivo(x.nombre)) : [];
    return { json: cuerpoTicket([registroTicket(nt, t.estado, archivos, t.extra)]) };
  });
  ent.sire.guionar("GET", RUTAS.archivo, (p) => {
    const parte = (mapa[p.query["numTicket"] ?? ""]?.partes ?? []).find((x) => x.nombre === p.query["nomArchivoReporte"]);
    return parte === undefined ? { estado: 404 } : { bytes: parte.zip, cabeceras: { "content-type": "application/zip" } };
  });
}
function parteRegistro(nombre = "20700000002-registro-202610.zip", txt = "compras-registro-202610.txt"): ParteFalsa {
  return { nombre, zip: zip("20700000002-registro-202610.txt", fixture(txt)) };
}
function parteSoloEncabezado(nombre = "vacio.zip"): ParteFalsa {
  return parteRegistro(nombre, "compras-registro-202610-solo-encabezado.txt");
}
function solicitar(...respuestas: GuionRespuesta[]): void {
  ent.sire.guionar("GET", RUTAS.solicitarRegistro(), ...respuestas);
}
/** Flujo sano: solicitar -> T, ticket 04 con una parte de registro. */
function flujoSano(partes: ParteFalsa[] = [parteRegistro()]): void {
  solicitar({ json: { numTicket: T } });
  guionarTickets({ [T]: { estado: "04", partes } });
}

describe("HttpSireApiClient · registro presentado (CA-13, P-3)", () => {
  it("registro: solicita 5.51 por GET con codTipoArchivo=0, codOrigen=2, lisPeriodos=per, perTributario=per y codProceso de P-3a; solo Bearer al host SIRE", async () => {
    flujoSano();
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    const [primera] = ent.sire.peticiones;
    expect(primera!.metodo).toBe("GET");
    expect(primera!.ruta).toBe(RUTAS.solicitarRegistro()); // perTributario = periodo pedido, en la ruta
    expect(primera!.query).toEqual({ codTipoArchivo: "0", codProceso: "01", codOrigen: "2", lisPeriodos: PERIODO });
    expect(primera!.query["codOrigenEnvio"], "el nombre correcto es codOrigen").toBeUndefined();
    for (const p of ent.sire.peticiones) {
      expect(p.metodo).toBe("GET");
      expect(p.cabeceras["authorization"]).toBe(`Bearer ${CANARIOS.token}`);
      expect(`${p.ruta}?${p.queryCruda}\n${p.cuerpo}`).not.toContain(CANARIOS.token);
    }
    expect(ent.sire.sinGuion).toHaveLength(0);
    expect(ent.seguridad.peticiones).toHaveLength(0);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("registro: ticket 06 → 5.32 con codLibro=080000 y codProceso/perTributario del ticket → mismas FilaPropuestaSire que la propuesta con el mismo TXT", async () => {
    guionarFlujo(ent.sire, { libro: "compras", numTicket: T, partes: [parteCompras()] });
    const propuesta = await cliente().descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" });
    ent.sire.reiniciar();

    solicitar({ json: { numTicket: T } });
    guionarTickets({ [T]: { estado: "06", partes: [parteRegistro("reg.zip")], extra: { codProceso: "21", perTributario: PERIODO } } });
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);

    const descarga = ent.sire.peticionesDe("GET", RUTAS.archivo);
    expect(descarga).toHaveLength(1);
    expect(descarga[0]!.query).toEqual({
      nomArchivoReporte: "reg.zip",
      codTipoArchivoReporte: "00",
      perTributario: PERIODO,
      codProceso: "21",
      numTicket: T,
      codLibro: "080000",
    });
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket)[0]!.query).toEqual({
      perIni: PERIODO,
      perFin: PERIODO,
      page: "1",
      perPage: "20",
      numTicket: T,
    });
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe(PERIODO);
    expect(r.filas.length).toBeGreaterThan(0);
    expect(r.filas).toEqual(propuesta.filas);
  });

  it("registro: varias partes en orden; encabezado distinto entre partes → ErrorPortalSire encabezado", async () => {
    const p1 = zip("p1.txt", fixture("compras-propuesta-202610-parte1.txt"));
    const p2 = zip("p2.txt", fixture("compras-propuesta-202610-parte2.txt"));
    const p2Distinta = zip("p2.txt", fixture("compras-propuesta-202610-parte2-encabezado-distinto.txt"));

    flujoSano([
      { nombre: "z-parte-1.zip", zip: p1 },
      { nombre: "a-parte-2.zip", zip: p2 },
    ]);
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual(["z-parte-1.zip", "a-parte-2.zip"]);
    const esperados = [
      ...columna("compras-propuesta-202610-parte1.txt"),
      ...columna("compras-propuesta-202610-parte2.txt"),
    ];
    expect(numeros(r)).toEqual(esperados);

    ent.sire.reiniciar();
    flujoSano([
      { nombre: "parte-1.zip", zip: p1 },
      { nombre: "parte-2.zip", zip: p2Distinta },
    ]);
    const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(e, "ErrorPortalSire", "encabezado");
    sinSecretos(e);
  });

  it("registro: 422 al solicitar → ErrorDatos; TXT solo con encabezado → ErrorDatosSire sin_datos; ambos borran el ticket", async () => {
    // 422 al solicitar (p. ej. cod 1070): no hay ticket que guardar, pero la clave se limpia (error permanente).
    const almacen422 = new AlmacenEspia(reloj.ahora);
      solicitar({ estado: 422, json: { cod: "1070", msg: CANARIOS.token } });
    const e422 = await capturar(cliente({ almacenTickets: almacen422 }).descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e422, "ErrorDatos");
    sinSecretos(e422);
    expect(almacen422.borrados).toContain(CLAVE_ALMACEN);
    expect(await almacen422.leer(CLAVE_ALMACEN)).toBeNull();

    // TXT válido sin filas: se guardó el ticket y se borra al terminar.
    ent.sire.reiniciar();
    reloj = relojVirtual();
    const almacenVacio = new AlmacenEspia(reloj.ahora);
    solicitar({ json: { numTicket: T } });
    guionarTickets({ [T]: { estado: "04", partes: [parteSoloEncabezado()] } });
    const eVacio = await capturar(cliente({ almacenTickets: almacenVacio }).descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(eVacio, "ErrorDatosSire", "sin_datos");
    expect(almacenVacio.guardados.map((g) => g.clave)).toContain(CLAVE_ALMACEN);
    expect(almacenVacio.borrados).toContain(CLAVE_ALMACEN);
    expect(await almacenVacio.leer(CLAVE_ALMACEN)).toBeNull();
  });

  it("registro: ticket 03 → ticket_con_errores; estado desconocido → estado_desconocido; listo sin archivos → respuesta_inesperada", async () => {
    solicitar({ json: { numTicket: T } });
    guionarTickets({ [T]: { estado: "03" } });
    const e03 = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(e03, "ErrorDatosSire", "ticket_con_errores");
    sinSecretos(e03);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);

    for (const estado of ["07", "99"]) {
      ent.sire.reiniciar();
      solicitar({ json: { numTicket: T } });
      guionarTickets({ [T]: { estado } });
      esperarError(await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD)), "ErrorPortalSire", "estado_desconocido");
      expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
    }

    ent.sire.reiniciar();
    solicitar({ json: { numTicket: T } });
    guionarTickets({ [T]: { estado: "04", partes: [] } });
    esperarError(await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD)), "ErrorPortalSire", "respuesta_inesperada");
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it("registro: ticket pendiente → guarda clave …:compras:{per}:registro y lanza ticket_pendiente; el reintento retoma sin volver a solicitar", async () => {
    let listo = false;
    solicitar({ json: { numTicket: T } });
    ent.sire.guionar("GET", RUTAS.ticket, () => ({
      json: cuerpoTicket([registroTicket(T, listo ? "04" : "01", listo ? [archivo("r.zip")] : [])]),
    }));
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: parteRegistro("r.zip").zip });
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    const e = await capturar(c.descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e, "ErrorTransitorioSire", "ticket_pendiente");
    expect(almacen.guardados).toHaveLength(1);
    expect(almacen.guardados[0]).toEqual({ clave: CLAVE_ALMACEN, numTicket: T, ttlMs: 3_600_000 });
    expect(await almacen.leer(CLAVE_ALMACEN)).toBe(T);

    listo = true;
    const r = await c.descargarRegistroPresentado(TOKEN, conClave());
    expect(r.filas.length).toBeGreaterThan(0);
    expect(solicitudes(), "no solicita de nuevo").toHaveLength(1);
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket).at(-1)!.query["numTicket"]).toBe(T);
    expect(almacen.borrados).toContain(CLAVE_ALMACEN);
    expect(await almacen.leer(CLAVE_ALMACEN)).toBeNull();
  });

  it("registro y propuesta del mismo periodo y cliente no comparten ticket guardado", async () => {
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T } });
    solicitar({ json: { numTicket: T2 } });
    ent.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "01")]) }));
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    esperarError(
      await capturar(c.descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras", claveReanudacion: CLAVE })),
      "ErrorTransitorioSire",
      "ticket_pendiente",
    );
    esperarError(await capturar(c.descargarRegistroPresentado(TOKEN, conClave())), "ErrorTransitorioSire", "ticket_pendiente");

    expect(solicitudes(), "el registro solicita su propio ticket").toHaveLength(1);
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce())).toHaveLength(1);
    expect(new Set(almacen.guardados.map((g) => g.clave)).size).toBe(2);
    expect(almacen.guardados.map((g) => g.numTicket)).toEqual([T, T2]);
    expect(almacen.guardados[1]!.clave).toBe(CLAVE_ALMACEN);
  });

  it("registro: fila con RUC o Periodo ajeno → respuesta_ajena sin filas", async () => {
    for (const variante of ["compras-propuesta-202610-ruc-ajeno.txt", "compras-propuesta-202610-periodo-ajeno.txt"]) {
      ent.sire.reiniciar();
      flujoSano([{ nombre: "ajeno.zip", zip: zip("ajeno.txt", fixture(variante)) }]);
      const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      esperarError(e, "ErrorDatosSire", "respuesta_ajena");
      sinSecretos(e);
    }
  });

  it("registro: ruc o periodo fuera de gramática → ErrorDatos sin red", async () => {
    const casos: SolicitudRegistroPresentado[] = [
      { ruc: RUC, periodo: "../x" },
      { ruc: RUC, periodo: "20261" },
      { ruc: RUC, periodo: "202613" },
      { ruc: RUC, periodo: "202600" },
      { ruc: RUC, periodo: "2026-10" },
      { ruc: RUC, periodo: "202610?x=1" },
      { ruc: "2070000000", periodo: PERIODO },
      { ruc: "2070000000A", periodo: PERIODO },
    ];
    for (const s of casos) {
      esperarError(await capturar(cliente().descargarRegistroPresentado(TOKEN, s)), "ErrorDatos");
    }
    expect(ent.sire.peticiones).toHaveLength(0);
  });

  describe("registro: 401 → TokenRechazadoError conserva el ticket; 5xx/timeout → ErrorTransitorioSire conserva el ticket", () => {
    type Paso = "ticket" | "archivo";
    const RUTA_PASO: Record<Paso, () => string> = { ticket: () => RUTAS.ticket, archivo: () => RUTAS.archivo };

    for (const paso of ["ticket", "archivo"] as Paso[]) {
      it.each([
        [401, "TokenRechazadoError", undefined],
        [500, "ErrorTransitorioSire", "servidor"],
        [503, "ErrorTransitorioSire", "servidor"],
      ] as const)(`${paso} · HTTP %i -> %s y la clave del ticket sigue guardada`, async (estado, clase, detalle) => {
        flujoSano();
        ent.sire.guionar("GET", RUTA_PASO[paso](), { estado, json: { error: CANARIOS.token } });
        const almacen = new AlmacenEspia(reloj.ahora);
        const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
        esperarError(e, clase, detalle);
        sinSecretos(e);
        expect(almacen.guardados.map((g) => g.clave)).toEqual([CLAVE_ALMACEN]);
        expect(await almacen.leer(CLAVE_ALMACEN)).toBe(T);
      });
    }

    it.each([
      [2, "ticket"],
      [3, "archivo"],
    ] as [number, Paso][])("la petición %i (%s) con timeout -> ErrorTransitorioSire timeout y conserva el ticket", async (n) => {
      flujoSano();
      let k = 0;
      const f = ((u: string | URL | Request, init?: RequestInit) => {
        k += 1;
        return k === n ? Promise.reject(new DOMException("agotado", "TimeoutError")) : globalThis.fetch(u, init);
      }) as typeof fetch;
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ fetch: f, almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      expect(await almacen.leer(CLAVE_ALMACEN)).toBe(T);
    });
  });

  it("registro: 01 sin datos → pide 02 una vez; 02 sin datos → ErrorDatos", async () => {
    // a) 01 responde 422 «sin datos» (p. ej. 1070): reintenta UNA vez con 02 y sigue con el ticket nuevo.
    solicitar((p) => (p.query["codProceso"] === "01" ? { estado: 422, json: { cod: "1070" } } : { json: { numTicket: T2 } }));
    guionarTickets({ [T2]: { estado: "04", partes: [parteRegistro()] } });
    const a = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(procesosPedidos()).toEqual(["01", "02"]);
    expect(a.filas.length).toBeGreaterThan(0);
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket).every((p) => p.query["numTicket"] === T2)).toBe(true);

    // b) 01 devuelve un ticket cuyo TXT trae solo el encabezado: también es «sin datos» -> 02.
    ent.sire.reiniciar();
    solicitar((p) => ({ json: { numTicket: p.query["codProceso"] === "01" ? T : T2 } }));
    guionarTickets({
      [T]: { estado: "04", partes: [parteSoloEncabezado()] },
      [T2]: { estado: "04", partes: [parteRegistro()] },
    });
    const b = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(procesosPedidos()).toEqual(["01", "02"]);
    expect(b.filas.length).toBeGreaterThan(0);

    // c) 02 también sin datos (422): ErrorDatos y no hay una tercera solicitud (nunca 00 ni 70).
    ent.sire.reiniciar();
    solicitar({ estado: 422, json: { cod: "1070" } });
    const c = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(c, "ErrorDatos");
    sinSecretos(c);
    expect(procesosPedidos()).toEqual(["01", "02"]);

    // d) 02 también con solo el encabezado: ErrorDatosSire sin_datos y exactamente dos solicitudes.
    ent.sire.reiniciar();
    solicitar((p) => ({ json: { numTicket: p.query["codProceso"] === "01" ? T : T2 } }));
    guionarTickets({
      [T]: { estado: "04", partes: [parteSoloEncabezado("v1.zip")] },
      [T2]: { estado: "04", partes: [parteSoloEncabezado("v2.zip")] },
    });
    esperarError(await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD)), "ErrorDatosSire", "sin_datos");
    expect(procesosPedidos()).toEqual(["01", "02"]);
  });

  it("registro: un error que no es «sin datos» no pide codProceso 02", async () => {
    for (const estado of [401, 403, 500, 503]) {
      ent.sire.reiniciar();
      solicitar({ estado, json: { cod: "x" } });
      await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      expect(procesosPedidos(), `HTTP ${estado}`).toEqual(["01"]);
    }
    ent.sire.reiniciar();
    solicitar({ json: { numTicket: T } });
    guionarTickets({ [T]: { estado: "03" } });
    await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    expect(procesosPedidos(), "ticket con errores").toEqual(["01"]);
  });

  it("registro: no envía codMoneda", async () => {
    flujoSano();
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(solicitudes()).toHaveLength(1);
    for (const p of solicitudes()) {
      expect(Object.keys(p.query)).not.toContain("codMoneda");
      expect(p.queryCruda).not.toContain("codMoneda");
    }
  });

  // P-3b: el plan no fija qué respuesta del servidor falso significa «SUNAT exige moneda» (código/mensaje). No se inventa.
  it.todo("registro: si SUNAT responde que exige codMoneda, hace dos solicitudes (PEN y USD) y une las filas (falta definir la respuesta «exige moneda» del servidor falso)");
});

function columna(nombreFixture: string): string[] {
  const lineas = Buffer.from(fixture(nombreFixture)).toString("utf8").replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const i = lineas[0]!.split("|").indexOf(COL_NUMERO);
  return lineas.slice(1).map((l) => l.split("|")[i]!);
}
