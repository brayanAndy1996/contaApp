import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegistroPresentadoSire, SolicitudRegistroPresentado, TokenSire } from "../puertos.js";
import { AlmacenTicketsMemoria, type AlmacenTicketsSire } from "./almacen-tickets.js";
import {
  CANARIOS,
  PERIODO,
  RUC,
  RUTAS,
  SECRETOS,
  archivo,
  capturar,
  claseError,
  crearEntorno,
  cuerpoTicket,
  esperarError,
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
import { zipRegistroReal } from "./pruebas/zip-manual.js";
import type { GuionRespuesta, PeticionFalsa, RespuestaFalsa } from "./pruebas/servidor-sire-falso.js";
import { HttpSireApiClient } from "./sire-api-client.http.js";
import type { OpcionesHttpSire } from "./sire-auth.http.js";

// Registro presentado de compras (spec 041, CA-11 y CA-13; plan «P-3 · Registro presentado», servicio 5.51 del manual RCE v28).
// Rediseño T15g (evidencia de la corrida real de contrato con 2 RUC; decisión técnica del orquestador): `codMoneda` NO FILTRA
// en 5.51 (con PEN o con USD el archivo trae TODOS los comprobantes, cada fila con su moneda). Por eso:
//  - UNA sola solicitud por periodo: `codProceso=70` y `codMoneda=PEN` (obligatorio, sin efecto de filtro); un ticket, un archivo.
//    No hay dos solicitudes ni unión de monedas.
//  - No se verifica que la columna `Moneda` de cada fila coincida con la pedida: cada fila conserva su moneda (PEN o USD) y
//    solo se valida la forma, como en la propuesta (RUC y Periodo propios, encabezado igual entre partes, etc.).
//  - Clave del almacén: `{claveReanudacion}:compras:{per}:registro` (5 partes). El ticket se guarda una vez tras solicitar y se
//    borra solo al validar (éxito, sin_datos o error permanente); un error transitorio o un 401 lo conservan.
//  - «Sin datos»: 422 (o 400) al solicitar con algún cod de `COD_SIN_DATOS_REGISTRO` (1070) o TXT válido con solo el encabezado
//    → ErrorDatosSire sin_datos. Otro 400/422 al solicitar (1061, 1026, cualquiera, cuerpo ilegible) → ErrorPortalSire
//    solicitud_rechazada con `codigosSunat` (solo `^\d{1,6}$`, tope 5; nunca el `msg`). Permanente y sin reintento.
//  - Un comprobante repetido dentro del archivo (o entre sus partes) → ErrorPortalSire respuesta_inesperada.
//  - Si SUNAT ya no lista el ticket guardado, se solicita una vez más. Todo dentro de UN presupuesto de 90 s (H-5) y 256 MiB
//    acumulados entre las partes del ticket (H-7).
// Flujo del ticket: 5.31 y 5.32 (codLibro=080000) con el codProceso/perTributario que devuelva ese ticket.
const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const SOLICITUD: SolicitudRegistroPresentado = { ruc: RUC, periodo: PERIODO };
const CLAVE = "TENANT-1:CLIENTE-1";
const CLAVE_REGISTRO = `${CLAVE}:compras:${PERIODO}:registro`;
const CLAVE_PROPUESTA = `${CLAVE}:compras:${PERIODO}:propuesta`;
const TICKET = "202610000001";
const T_PROPUESTA = "202610000009";
const COL_NUMERO = "Nro CP o Doc. Nro Inicial (Rango)";
const MSG_SUNAT = `msg de SUNAT que repite ${CANARIOS.token}`;
const TTL_TICKET_MS = 3_600_000;

/** El archivo del registro: 8 filas PEN y 1 USD (F001-4062 con TC 3.300), con el encabezado real (col. 34 renombrada). */
const REGISTRO = "compras-registro-202610-mixto.txt";
const SOLO_ENCABEZADO = "compras-registro-202610-solo-encabezado.txt";
const PROPUESTA = "compras-propuesta-202610.txt";

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
function codigosSunatDe(e: unknown): unknown {
  return (e as { codigosSunat?: unknown }).codigosSunat;
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
  ent.sire.guionar("GET", RUTAS.archivo, (p) => servirParte(mapa, p));
}
function servirParte(mapa: Record<string, TicketFalso>, p: PeticionFalsa): RespuestaFalsa {
  const parte = (mapa[p.query["numTicket"] ?? ""]?.partes ?? []).find((x) => x.nombre === p.query["nomArchivoReporte"]);
  return parte === undefined ? { estado: 404 } : { bytes: parte.zip, cabeceras: { "content-type": "application/zip" } };
}

function bytesDe(lineas: string[]): Uint8Array {
  return new Uint8Array(Buffer.from(`${lineas.join("\n")}\n`, "utf8"));
}
function textoFixture(nombre: string): string {
  return Buffer.from(fixture(nombre)).toString("utf8");
}
function lineasDe(nombreFixture: string): string[] {
  return textoFixture(nombreFixture).split("\n").filter((l) => l !== "");
}
/** El ZIP real del registro (3 entradas) con el contenido dado. */
function zipDe(contenido: Uint8Array): Uint8Array {
  return zipRegistroReal("20700000002-registro-202610", contenido);
}
/** Parte de registro; por defecto con su fixture completo. */
function parteRegistro(nombre = "registro.zip", txt: Uint8Array = fixture(REGISTRO)): ParteFalsa {
  return { nombre, zip: zipDe(txt) };
}
function parteSoloEncabezado(): ParteFalsa {
  return parteRegistro("vacio.zip", fixture(SOLO_ENCABEZADO));
}

/** Guion de la solicitud 5.51 (una moneda sin guion no existe: la solicitud es una sola, con `codMoneda=PEN`). */
function solicitar(g: GuionRespuesta): void {
  ent.sire.guionar("GET", RUTAS.solicitarRegistro(), g);
}
function solicitarSana(): void {
  solicitar({ json: { numTicket: TICKET } });
}
/** Flujo sano: una solicitud -> TICKET, ticket 04 con las partes dadas (por defecto, el archivo del registro). */
function flujoSano(partes: ParteFalsa[] = [parteRegistro()]): void {
  solicitarSana();
  guionarTickets({ [TICKET]: { estado: "04", partes } });
}
const SIN_DATOS_422: RespuestaFalsa = { estado: 422, json: { errors: [{ cod: "1070", msg: MSG_SUNAT }] } };
const SIN_DATOS_422_PLANO: RespuestaFalsa = { estado: 422, json: { cod: "1070", msg: MSG_SUNAT } };
const SIN_DATOS_400: RespuestaFalsa = { estado: 400, json: { errors: [{ cod: "1070", msg: MSG_SUNAT }] } };

/** Las filas que daría la propuesta de compras con el mismo TXT (el mapeo es el mismo). */
async function filasComoPropuesta(nombreFixture: string) {
  ent.sire.reiniciar();
  guionarFlujo(ent.sire, {
    libro: "compras",
    numTicket: T_PROPUESTA,
    partes: [{ nombre: "propuesta.zip", zip: zip("propuesta.txt", fixture(nombreFixture)) }],
  });
  const p = await cliente().descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras" });
  ent.sire.reiniciar();
  return p.filas;
}
/** El TXT del registro con su primera fila de datos cambiada (`de` → `a`, primera aparición). */
function cambiarEnPrimeraFila(de: string, a: string): Uint8Array {
  const lineas = textoFixture(REGISTRO).split("\n");
  lineas[1] = lineas[1]!.replace(de, a);
  return new Uint8Array(Buffer.from(lineas.join("\n"), "utf8"));
}
/** El mismo TXT con una columna nueva antes de «Moneda»: encabezado distinto entre partes. */
function conColumnaNueva(txt: Uint8Array): Uint8Array {
  const lineas = Buffer.from(txt).toString("utf8").split("\n").filter((l) => l.trim() !== "");
  return bytesDe(
    lineas.map((l, i) => {
      const celdas = l.split("|");
      celdas.splice(25, 0, i === 0 ? "Columna Nueva Prueba" : "X");
      return celdas.join("|");
    }),
  );
}
function partirRegistro(): [Uint8Array, Uint8Array] {
  const [cab, ...filas] = lineasDe(REGISTRO);
  return [bytesDe([cab!, ...filas.slice(0, 4)]), bytesDe([cab!, ...filas.slice(4)])];
}
/** El archivo del registro con dos de sus filas repetidas como comprobante (la 1.ª fila PEN, con su moneda cambiada a USD). */
function conComprobanteRepetido(): Uint8Array {
  const base = lineasDe(REGISTRO);
  const filaPen = base[1]!;
  const repetida = filaPen.replace("|PEN|1.000|", "|USD|3.300|");
  expect(repetida).not.toBe(filaPen);
  return bytesDe([...base, repetida]);
}

describe("HttpSireApiClient · registro presentado (CA-11, CA-13, P-3)", () => {
  it("registro: UNA solicitud 5.51 por GET con codTipoArchivo=0, codProceso=70, codOrigen=2, lisPeriodos=per, codMoneda=PEN, perTributario=per; solo Bearer al host SIRE", async () => {
    flujoSano();
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    const pedidas = solicitudes();
    expect(pedidas, "una sola solicitud por periodo (codMoneda no filtra)").toHaveLength(1);
    const p = pedidas[0]!;
    expect(p.metodo).toBe("GET");
    expect(p.ruta).toBe(RUTAS.solicitarRegistro()); // perTributario = periodo pedido, en la ruta
    expect(p.query).toEqual({ codTipoArchivo: "0", codProceso: "70", codOrigen: "2", lisPeriodos: PERIODO, codMoneda: "PEN" });
    expect(p.query["codOrigenEnvio"], "el nombre correcto es codOrigen").toBeUndefined();
    // Orden de la operación: solicitud, ticket, archivo.
    expect(ent.sire.peticiones[0]!.ruta).toBe(RUTAS.solicitarRegistro());
    expect(ent.sire.peticiones.map((q) => q.ruta)).toEqual([RUTAS.solicitarRegistro(), RUTAS.ticket, RUTAS.archivo]);
    for (const q of ent.sire.peticiones) {
      expect(q.metodo).toBe("GET");
      expect(q.cabeceras["authorization"]).toBe(`Bearer ${CANARIOS.token}`);
      expect(`${q.ruta}?${q.queryCruda}\n${q.cuerpo}`).not.toContain(CANARIOS.token);
    }
    expect(ent.sire.sinGuion).toHaveLength(0);
    expect(ent.seguridad.peticiones).toHaveLength(0);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("registro: el ticket 06 → 5.32 con codLibro=080000 y codProceso/perTributario de su ticket → filas con el mapeo de la propuesta, cada una con su moneda (PEN y USD mezcladas SE ACEPTAN)", async () => {
    const esperadas = await filasComoPropuesta(REGISTRO);
    expect(esperadas.filter((f) => f.moneda === "PEN")).toHaveLength(8);
    expect(esperadas.filter((f) => f.moneda === "USD")).toHaveLength(1);

    solicitarSana();
    guionarTickets({
      [TICKET]: { estado: "06", partes: [parteRegistro("reg.zip")], extra: { codProceso: "21", perTributario: PERIODO } },
    });
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);

    const descargas = ent.sire.peticionesDe("GET", RUTAS.archivo);
    expect(descargas.map((p) => p.query)).toEqual([
      { nomArchivoReporte: "reg.zip", codTipoArchivoReporte: "00", perTributario: PERIODO, codProceso: "21", numTicket: TICKET, codLibro: "080000" },
    ]);
    const consultas = ent.sire.peticionesDe("GET", RUTAS.ticket);
    expect(consultas.length).toBeGreaterThan(0);
    expect(consultas[0]!.query).toEqual({ perIni: PERIODO, perFin: PERIODO, page: "1", perPage: "20", numTicket: TICKET });
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe(PERIODO);
    expect(r.filas).toEqual(esperadas);
    // La moneda de cada fila es la de la fila (no la pedida): 8 PEN y la fila USD con su tipo de cambio.
    expect(r.filas.map((f) => f.moneda)).toEqual(esperadas.map((f) => f.moneda));
    const usd = r.filas.filter((f) => f.moneda === "USD");
    expect(usd).toHaveLength(1);
    expect(usd[0]!.tipoCambio).toBe("3.300");
    expect(r.filas.filter((f) => f.moneda === "PEN").every((f) => f.tipoCambio === undefined)).toBe(true);
  });

  it("registro: el encabezado real (col. 34 «ID Proyecto Operadores/Partícipes») difiere del de la propuesta solo en una columna que no se mapea → se acepta", async () => {
    const real = lineasDe(REGISTRO)[0]!.split("|");
    const propuesta = lineasDe(PROPUESTA)[0]!.split("|");
    expect(real).toHaveLength(propuesta.length);
    const distintas = real.map((c, i) => [i + 1, c, propuesta[i]] as const).filter(([, a, b]) => a !== b);
    expect(distintas).toEqual([[34, "ID Proyecto Operadores/Partícipes", "ID Proyecto Operadores"]]);
    flujoSano();
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(numeros(r)).toEqual(columna(REGISTRO));
  });

  it("registro: archivo con solo filas USD (aunque se pidió PEN) → se acepta y salen con USD (no se verifica la moneda pedida)", async () => {
    const [cab, ...filas] = lineasDe(REGISTRO);
    const soloUsd = filas.filter((f) => f.includes("|USD|"));
    expect(soloUsd).toHaveLength(1);
    flujoSano([parteRegistro("usd.zip", bytesDe([cab!, ...soloUsd]))]);
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]!.moneda).toBe("USD");
    expect(solicitudes()[0]!.query["codMoneda"]).toBe("PEN");
  });

  it("registro: varias partes en orden; encabezado distinto entre partes → ErrorPortalSire encabezado", async () => {
    const [p1, p2] = partirRegistro();
    flujoSano([
      { nombre: "z-parte-1.zip", zip: zipDe(p1) },
      { nombre: "a-parte-2.zip", zip: zipDe(p2) },
    ]);
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual(["z-parte-1.zip", "a-parte-2.zip"]);
    expect(numeros(r)).toEqual(columna(REGISTRO));

    ent.sire.reiniciar();
    flujoSano([
      { nombre: "parte-1.zip", zip: zipDe(p1) },
      { nombre: "parte-2.zip", zip: zipDe(conColumnaNueva(p2)) },
    ]);
    const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(e, "ErrorPortalSire", "encabezado");
    sinSecretos(e);
  });

  describe("registro: «sin datos» (422 o 400 con cod 1070 al solicitar, o TXT solo con encabezado) → ErrorDatosSire sin_datos", () => {
    const casos: [string, RespuestaFalsa][] = [
      ["422 con errors[].cod 1070", SIN_DATOS_422],
      ["422 con cod plano 1070", SIN_DATOS_422_PLANO],
      ["400 con errors[].cod 1070", SIN_DATOS_400],
    ];
    it.each(casos)("%s: no sigue ningún ticket ni guarda nada", async (_nombre, respuesta) => {
      solicitar(respuesta);
      guionarTickets({ [TICKET]: { estado: "04", partes: [parteRegistro()] } });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorDatosSire", "sin_datos");
      sinSecretos(e, [...SECRETOS, MSG_SUNAT]);
      expect(solicitudes()).toHaveLength(1);
      expect(ent.sire.peticionesDe("GET", RUTAS.ticket), "no espera ningún ticket").toHaveLength(0);
      expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
      expect(almacen.guardados).toHaveLength(0);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
    });

    it("TXT válido con solo el encabezado: guarda el ticket una vez y lo borra al validar", async () => {
      flujoSano([parteSoloEncabezado()]);
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorDatosSire", "sin_datos");
      expect(almacen.guardados).toEqual([{ clave: CLAVE_REGISTRO, numTicket: TICKET, ttlMs: TTL_TICKET_MS }]);
      expect(almacen.borrados).toContain(CLAVE_REGISTRO);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
      expect(solicitudes()).toHaveLength(1);
    });
  });

  describe("registro: 422 1061, 1026 u otro código, 400 o cuerpo ilegible al solicitar → ErrorPortalSire solicitud_rechazada", () => {
    const casos: [string, RespuestaFalsa, string[]][] = [
      ["422 cod 1061", { estado: 422, json: { errors: [{ cod: "1061", msg: MSG_SUNAT }] } }, ["1061"]],
      ["422 cod 1026", { estado: 422, json: { errors: [{ cod: "1026", msg: MSG_SUNAT }] } }, ["1026"]],
      ["422 otro código", { estado: 422, json: { errors: [{ cod: "9999", msg: MSG_SUNAT }] } }, ["9999"]],
      ["400 cod 1061", { estado: 400, json: { errors: [{ cod: "1061", msg: MSG_SUNAT }] } }, ["1061"]],
      ["422 con cod plano", { estado: 422, json: { cod: "1026", msg: MSG_SUNAT } }, ["1026"]],
      ["422 con códigos fuera de gramática", { estado: 422, json: { errors: [{ cod: "12a", msg: MSG_SUNAT }, { cod: "1234567" }, { cod: "1026" }] } }, ["1026"]],
      ["422 cuerpo ilegible", { estado: 422, texto: `<html>${MSG_SUNAT}</html>` }, []],
      ["400 cuerpo ilegible", { estado: 400, texto: `no es json ${MSG_SUNAT}` }, []],
    ];
    it.each(casos)("%s", async (_nombre, respuesta, codigos) => {
      solicitar(respuesta);
      guionarTickets({ [TICKET]: { estado: "04", partes: [parteRegistro()] } });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorPortalSire", "solicitud_rechazada");
      expect(codigosSunatDe(e)).toEqual(codigos);
      sinSecretos(e, [...SECRETOS, MSG_SUNAT, "msg de SUNAT"]);
      expect(solicitudes(), "sin otra solicitud ni reintento").toHaveLength(1);
      expect(ent.sire.peticionesDe("GET", RUTAS.ticket), "no espera ningún ticket").toHaveLength(0);
      expect(almacen.guardados, "error permanente al solicitar: no hay ticket que guardar").toHaveLength(0);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
    });
  });

  // H-2 (CA-11): un 404 solo es transitorio al descargar el archivo (5.32); al solicitar (5.51) y al consultar el ticket (5.31) es
  // cambio de ruta: ErrorPortalSire permanente, sin reintento.
  it("H-2 · registro: 404 al solicitar -> ErrorPortalSire (no ErrorTransitorio), sin ticket ni reintento", async () => {
    solicitar({ estado: 404, json: { error: MSG_SUNAT } });
    guionarTickets({ [TICKET]: { estado: "04", partes: [parteRegistro()] } });
    const almacen = new AlmacenEspia(reloj.ahora);
    const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e, "ErrorPortalSire");
    expect(e).not.toBeInstanceOf(claseError("ErrorTransitorio"));
    sinSecretos(e, [...SECRETOS, MSG_SUNAT]);
    expect(solicitudes()).toHaveLength(1);
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket)).toHaveLength(0);
  });

  it("H-2 · registro: 404 al consultar el ticket -> ErrorPortalSire (no ErrorTransitorio) y no descarga", async () => {
    solicitarSana();
    ent.sire.guionar("GET", RUTAS.ticket, { estado: 404, json: { error: MSG_SUNAT } });
    ent.sire.guionar("GET", RUTAS.archivo, { bytes: new Uint8Array(0) });
    const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e, "ErrorPortalSire");
    expect(e).not.toBeInstanceOf(claseError("ErrorTransitorio"));
    sinSecretos(e, [...SECRETOS, MSG_SUNAT]);
    expect(ent.sire.peticionesDe("GET", RUTAS.ticket)).toHaveLength(1);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
  });

  it("H-2 · registro: 404 del archivo sigue siendo ErrorTransitorioSire", async () => {
    solicitarSana();
    guionarTickets({ [TICKET]: { estado: "04", partes: [{ nombre: "registro.zip", zip: zipDe(fixture(REGISTRO)) }] } });
    ent.sire.guionar("GET", RUTAS.archivo, { estado: 404, json: { error: MSG_SUNAT } });
    const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e, "ErrorTransitorioSire");
    sinSecretos(e, [...SECRETOS, MSG_SUNAT]);
  });

  it("registro: nunca pide un codProceso distinto de 70 ni más de una solicitud (y siempre con codMoneda=PEN)", async () => {
    const comprobar = (etapa: string) => {
      const pedidas = solicitudes();
      expect(pedidas, etapa).toHaveLength(1);
      expect(pedidas[0]!.query["codProceso"], etapa).toBe("70");
      expect(pedidas[0]!.query["codMoneda"], etapa).toBe("PEN");
      expect(Object.keys(pedidas[0]!.query).sort(), etapa).toEqual(["codMoneda", "codOrigen", "codProceso", "codTipoArchivo", "lisPeriodos"]);
    };

    flujoSano();
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    comprobar("sano");

    ent.sire.reiniciar();
    solicitar({ estado: 422, json: { errors: [{ cod: "1026" }] } });
    await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    comprobar("rechazada");

    ent.sire.reiniciar();
    solicitar(SIN_DATOS_422);
    await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    comprobar("sin datos");

    ent.sire.reiniciar();
    solicitarSana();
    guionarTickets({ [TICKET]: { estado: "03" } });
    await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    comprobar("ticket con errores");

    // Ticket pendiente y reintento: el segundo intento retoma el ticket y no solicita nada.
    ent.sire.reiniciar();
    solicitarSana();
    guionarTickets({ [TICKET]: { estado: "01" } });
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });
    await capturar(c.descargarRegistroPresentado(TOKEN, conClave()));
    guionarTickets({ [TICKET]: { estado: "04", partes: [parteRegistro()] } });
    await c.descargarRegistroPresentado(TOKEN, conClave());
    comprobar("pendiente y reintento");
  });

  describe("registro: ticket 03 / estado desconocido / listo sin archivos → mismo error, sin filas, borra el ticket", () => {
    const fallos: [string, TicketFalso, "ErrorDatosSire" | "ErrorPortalSire", string][] = [
      ["03", { estado: "03" }, "ErrorDatosSire", "ticket_con_errores"],
      ["07", { estado: "07" }, "ErrorPortalSire", "estado_desconocido"],
      ["99", { estado: "99" }, "ErrorPortalSire", "estado_desconocido"],
      ["04 sin archivos", { estado: "04", partes: [] }, "ErrorPortalSire", "respuesta_inesperada"],
    ];
    it.each(fallos)("ticket %s", async (_nombre, ticket, clase, detalle) => {
      solicitarSana();
      guionarTickets({ [TICKET]: ticket });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, clase, detalle);
      sinSecretos(e);
      expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(0);
      expect(almacen.guardados).toEqual([{ clave: CLAVE_REGISTRO, numTicket: TICKET, ttlMs: TTL_TICKET_MS }]);
      expect(almacen.borrados).toContain(CLAVE_REGISTRO);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
    });
  });

  it("registro: el ticket se guarda UNA vez tras solicitar, sigue guardado mientras se baja y valida el archivo, y se borra solo al validar", async () => {
    solicitarSana();
    const almacen = new AlmacenEspia(reloj.ahora);
    let guardadosAlBajar = -1;
    let borradosAlBajar = -1;
    guionarTickets({ [TICKET]: { estado: "04", partes: [parteRegistro()] } });
    ent.sire.guionar("GET", RUTAS.archivo, () => {
      guardadosAlBajar = almacen.guardados.length;
      borradosAlBajar = almacen.borrados.length;
      return { bytes: parteRegistro().zip, cabeceras: { "content-type": "application/zip" } };
    });
    const r = await cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave());
    expect(numeros(r)).toEqual(columna(REGISTRO));
    expect(guardadosAlBajar, "ya estaba guardado al pedir el archivo").toBe(1);
    expect(borradosAlBajar, "no se borra antes de validar el archivo").toBe(0);
    expect(almacen.guardados).toEqual([{ clave: CLAVE_REGISTRO, numTicket: TICKET, ttlMs: TTL_TICKET_MS }]);
    expect(almacen.borrados).toContain(CLAVE_REGISTRO);
    expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
  });

  it("registro: ticket pendiente → guarda …:registro y lanza ticket_pendiente; el reintento lo retoma con esa clave sin volver a solicitar", async () => {
    let listo = false;
    solicitarSana();
    ent.sire.guionar("GET", RUTAS.ticket, (p) => {
      const nt = p.query["numTicket"] ?? "";
      return { json: cuerpoTicket([registroTicket(nt, listo ? "04" : "01", listo ? [archivo("r.zip")] : [])]) };
    });
    ent.sire.guionar("GET", RUTAS.archivo, () => ({ bytes: parteRegistro("r.zip").zip }));
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    const e = await capturar(c.descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e, "ErrorTransitorioSire", "ticket_pendiente");
    expect(almacen.guardados).toEqual([{ clave: CLAVE_REGISTRO, numTicket: TICKET, ttlMs: TTL_TICKET_MS }]);
    expect(await almacen.leer(CLAVE_REGISTRO)).toBe(TICKET);
    expect(almacen.borrados, "un ticket pendiente no borra nada").toHaveLength(0);
    // Claves de 5 partes: ya no existen registro-pen ni registro-usd.
    expect(almacen.guardados.every((g) => g.clave.split(":").length === 5 && g.clave.endsWith(":registro"))).toBe(true);

    listo = true;
    const r = await c.descargarRegistroPresentado(TOKEN, conClave());
    expect(numeros(r)).toEqual(columna(REGISTRO));
    expect(solicitudes(), "no solicita de nuevo").toHaveLength(1);
    expect(almacen.guardados, "el reintento no guarda otra vez").toHaveLength(1);
    expect(almacen.borrados).toContain(CLAVE_REGISTRO);
    expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
  });

  describe("registro: SUNAT ya no lista el ticket guardado → se solicita UNA vez más", () => {
    const VIEJO = "202610000777";
    async function conTicketViejo(almacen: AlmacenEspia): Promise<void> {
      await almacen.guardar(CLAVE_REGISTRO, VIEJO, TTL_TICKET_MS);
      almacen.guardados.length = 0;
    }

    it("el ticket nuevo sí se lista: borra el viejo, solicita una vez, guarda el nuevo y devuelve las filas", async () => {
      flujoSano(); // solo TICKET figura en `registros`; VIEJO no
      const almacen = new AlmacenEspia(reloj.ahora);
      await conTicketViejo(almacen);
      const r = await cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave());
      expect(numeros(r)).toEqual(columna(REGISTRO));
      expect(solicitudes()).toHaveLength(1);
      expect(ent.sire.peticionesDe("GET", RUTAS.ticket)[0]!.query["numTicket"], "primero consulta el guardado").toBe(VIEJO);
      expect(almacen.guardados).toEqual([{ clave: CLAVE_REGISTRO, numTicket: TICKET, ttlMs: TTL_TICKET_MS }]);
      expect(almacen.borrados).toContain(CLAVE_REGISTRO);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
    });

    it("tampoco el nuevo se lista: ErrorDatosSire respuesta_ajena y no hay más de esa solicitud", async () => {
      solicitarSana();
      guionarTickets({}); // ningún ticket figura
      const almacen = new AlmacenEspia(reloj.ahora);
      await conTicketViejo(almacen);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorDatosSire", "respuesta_ajena");
      expect(solicitudes(), "solo una nueva solicitud").toHaveLength(1);
    });
  });

  it("registro y propuesta del mismo periodo y cliente no comparten ticket guardado (el registro usa …:registro, sin sufijo de moneda)", async () => {
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T_PROPUESTA } });
    solicitarSana();
    ent.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "01")]) }));
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    esperarError(
      await capturar(c.descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras", claveReanudacion: CLAVE })),
      "ErrorTransitorioSire",
      "ticket_pendiente",
    );
    esperarError(await capturar(c.descargarRegistroPresentado(TOKEN, conClave())), "ErrorTransitorioSire", "ticket_pendiente");

    expect(solicitudes(), "el registro solicita un único ticket").toHaveLength(1);
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce())).toHaveLength(1);
    expect(almacen.guardados.map((g) => [g.clave, g.numTicket])).toEqual([
      [CLAVE_PROPUESTA, T_PROPUESTA],
      [CLAVE_REGISTRO, TICKET],
    ]);
  });

  describe("registro: fila con RUC o Periodo ajenos → respuesta_ajena sin filas", () => {
    const casos: [string, () => Uint8Array][] = [
      ["RUC ajeno", () => cambiarEnPrimeraFila("20700000002", "20700000011")],
      ["Periodo ajeno", () => cambiarEnPrimeraFila("|202610|", "|202609|")],
    ];
    it.each(casos)("%s", async (_nombre, txt) => {
      flujoSano([parteRegistro("ajena.zip", txt())]);
      const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      esperarError(e, "ErrorDatosSire", "respuesta_ajena");
      sinSecretos(e);
    });
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

  describe("registro: comprobante repetido → ErrorPortalSire respuesta_inesperada sin filas", () => {
    it("dentro del archivo (la misma clave tipo|serie|número|tipoDoc|RUC, aunque con otra moneda y otros montos)", async () => {
      flujoSano([parteRegistro("repetido.zip", conComprobanteRepetido())]);
      const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
      sinSecretos(e);
    });

    it("entre dos partes del mismo ticket", async () => {
      const [p1] = partirRegistro();
      const [cab, ...filas] = lineasDe(REGISTRO);
      const repetidaDeLaParte1 = bytesDe([cab!, filas[0]!]);
      flujoSano([
        { nombre: "p1.zip", zip: zipDe(p1) },
        { nombre: "p2.zip", zip: zipDe(repetidaDeLaParte1) },
      ]);
      const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
    });

    it("control: mismo tipo, serie y número pero otro proveedor no es el mismo comprobante", async () => {
      const filaPen = lineasDe(REGISTRO)[1]!;
      const otroProveedor = filaPen
        .replace("|20700000011|PRUEBA PROVEEDOR ISC S.A.C.|", "|20700000096|PRUEBA PROVEEDOR GENERICO S.A.C.|")
        .replace("|PEN|1.000|", "|USD|3.300|");
      expect(otroProveedor).not.toBe(filaPen);
      flujoSano([parteRegistro("otro.zip", bytesDe([...lineasDe(REGISTRO), otroProveedor]))]);
      const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
      expect(r.filas).toHaveLength(columna(REGISTRO).length + 1);
    });
  });

  describe("registro: el presupuesto de 90 s y el acumulado de 256 MiB son del único ticket", () => {
    it("registro: agotados los 90 s al solicitar → timeout, no consulta el ticket y conserva el ticket guardado", async () => {
      flujoSano();
      ent.sire.guionar("GET", RUTAS.solicitarRegistro(), () => {
        reloj.avanzar(95_000);
        return { json: { numTicket: TICKET } };
      });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      sinSecretos(e);
      expect(ent.sire.peticionesDe("GET", RUTAS.ticket), "sin presupuesto no se pide nada más").toHaveLength(0);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBe(TICKET);
      expect(almacen.borrados).toHaveLength(0);
    });

    it("registro: agotados los 90 s tras la 1.ª parte → timeout, no pide la 2.ª y conserva el ticket", async () => {
      const [p1, p2] = partirRegistro();
      flujoSano([
        { nombre: "parte-1.zip", zip: zipDe(p1) },
        { nombre: "parte-2.zip", zip: zipDe(p2) },
      ]);
      ent.sire.guionar("GET", RUTAS.archivo, () => {
        reloj.avanzar(95_000);
        return { bytes: zipDe(p1), cabeceras: { "content-type": "application/zip" } };
      });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      sinSecretos(e);
      expect(ent.sire.peticionesDe("GET", RUTAS.archivo)).toHaveLength(1);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBe(TICKET);
      expect(almacen.borrados).toHaveLength(0);
    });

    it("registro: el acumulado de 256 MiB suma las partes del ticket → zip_invalido en la 5.ª", async () => {
      // Relleno ASCII en una columna que no se mapea: 1 KiB hex aleatorio por bloque de 16 KiB (razón ≈ 30:1, lejos de 200:1).
      const relleno = (bytes: number): string => {
        const b = Buffer.alloc(bytes, 0x41);
        for (let o = 0; o < bytes; o += 16 * 1024) b.write(randomBytes(512).toString("hex"), o, "latin1");
        return b.toString("latin1");
      };
      const grande = relleno(60 * 1024 * 1024);
      const parteGrande = (fila: number, nombre: string): ParteFalsa => {
        const [cab, ...filas] = lineasDe(REGISTRO);
        const celdas = filas[fila]!.split("|");
        celdas[3] = grande; // «CAR SUNAT»: no se mapea
        const contenido = new Uint8Array(Buffer.from(`${cab}\n${celdas.join("|")}\n`, "utf8"));
        return { nombre, zip: zipRegistroReal("parte", contenido) };
      };
      // 5 partes de 60 MiB: cada una pasa de sobra los 64 MiB por parte; la 5.ª lleva el acumulado a 300 MiB.
      const partes = [0, 1, 2, 3, 4].map((n) => parteGrande(n, `parte${n + 1}.zip`));
      for (const p of partes) expect(p.zip.length).toBeLessThan(8 * 1024 * 1024);
      flujoSano(partes);
      const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      esperarError(e, "ErrorPortalSire", "zip_invalido");
      expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual([
        "parte1.zip",
        "parte2.zip",
        "parte3.zip",
        "parte4.zip",
        "parte5.zip",
      ]);
    }, 120_000);
  });

  describe("registro: 401 → TokenRechazadoError; 5xx/timeout → ErrorTransitorioSire; conservan el ticket guardado", () => {
    type Paso = "ticket" | "archivo";
    const RUTA_PASO: Record<Paso, () => string> = { ticket: () => RUTAS.ticket, archivo: () => RUTAS.archivo };
    const casos = [
      [401, "TokenRechazadoError", undefined],
      [500, "ErrorTransitorioSire", "servidor"],
      [503, "ErrorTransitorioSire", "servidor"],
    ] as const;

    for (const paso of ["ticket", "archivo"] as Paso[]) {
      it.each(casos)(`${paso} · HTTP %i -> %s y la clave …:registro sigue guardada`, async (estado, clase, detalle) => {
        solicitarSana();
        const mapa: Record<string, TicketFalso> = { [TICKET]: { estado: "04", partes: [parteRegistro()] } };
        guionarTickets(mapa);
        ent.sire.guionar("GET", RUTA_PASO[paso](), { estado, json: { error: CANARIOS.token } });
        const almacen = new AlmacenEspia(reloj.ahora);
        const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
        esperarError(e, clase, detalle);
        sinSecretos(e);
        expect(almacen.guardados).toEqual([{ clave: CLAVE_REGISTRO, numTicket: TICKET, ttlMs: TTL_TICKET_MS }]);
        expect(await almacen.leer(CLAVE_REGISTRO)).toBe(TICKET);
        expect(almacen.borrados).toHaveLength(0);
      });
    }

    it.each(casos)("solicitud · HTTP %i -> %s y no queda ningún ticket guardado", async (estado, clase, detalle) => {
      solicitar({ estado, json: { error: CANARIOS.token } });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, clase, detalle);
      sinSecretos(e);
      expect(solicitudes()).toHaveLength(1);
      expect(almacen.guardados).toHaveLength(0);
      expect(await almacen.leer(CLAVE_REGISTRO)).toBeNull();
    });

    // Orden de las peticiones: 1 solicitud, 2 ticket, 3 archivo.
    it.each([
      [1, "solicitud"],
      [2, "ticket"],
      [3, "archivo"],
    ] as [number, string][])("la petición %i (%s) con timeout -> ErrorTransitorioSire timeout y conserva el ticket si ya estaba guardado", async (n) => {
      flujoSano();
      let k = 0;
      const f = ((u: string | URL | Request, init?: RequestInit) => {
        k += 1;
        return k === n ? Promise.reject(new DOMException("agotado", "TimeoutError")) : globalThis.fetch(u, init);
      }) as typeof fetch;
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ fetch: f, almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      expect(await almacen.leer(CLAVE_REGISTRO)).toBe(n === 1 ? null : TICKET);
      expect(almacen.borrados).toHaveLength(0);
    });
  });
});

function columna(nombreFixture: string): string[] {
  const lineas = Buffer.from(fixture(nombreFixture)).toString("utf8").replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const i = lineas[0]!.split("|").indexOf(COL_NUMERO);
  return lineas.slice(1).map((l) => l.split("|")[i]!);
}
