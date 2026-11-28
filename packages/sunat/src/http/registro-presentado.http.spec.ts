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
// Decisiones de la ronda 3 (el usuario delegó lo técnico ante la evidencia de la corrida real de contrato, 2026-11-28):
//  - `codProceso` = 70 fijo (00/01/02 dan 422 cod 1026) y `codMoneda` obligatorio (sin él, 422 cod 1061).
//  - Dos solicitudes por periodo, una por moneda y en orden PEN → USD, con un ticket cada una; las dos se piden antes de
//    esperar ninguno (SUNAT las procesa a la vez); luego se espera y se lee cada ticket en el mismo orden. Un solo
//    presupuesto de 90 s para toda la operación (H-5) y un acumulado de 256 MiB entre las partes de las dos monedas (H-7).
//  - Claves del almacén: `{claveReanudacion}:compras:{per}:registro-pen` y `…:registro-usd` (5 partes, H-4). Los dos tickets se
//    borran solo al terminar la operación (éxito, sin_datos o error permanente); un error transitorio o un 401 los conserva.
//  - «Sin datos» por moneda: 422 al solicitar con algún cod de `COD_SIN_DATOS_REGISTRO` (1070) o TXT válido con solo el
//    encabezado. Una moneda sin datos no falla si la otra trae filas; las dos sin datos → ErrorDatosSire sin_datos.
//  - Otro 400/422 al solicitar (1061, 1026, cualquiera, cuerpo ilegible) → ErrorPortalSire solicitud_rechazada con
//    `codigosSunat` (solo `^\d{1,6}$`, tope 5; nunca el `msg`). Permanente y sin reintento.
//  - Unión: filas PEN y luego USD. Encabezado igual al de la 1.ª parte leída; cada fila con la moneda pedida
//    (si no, respuesta_ajena); un comprobante en las dos monedas → ErrorPortalSire respuesta_inesperada.
// Flujo de cada ticket: 5.31 y 5.32 (codLibro=080000) con el codProceso/perTributario que devuelva ese ticket.
const TOKEN: TokenSire = { token: CANARIOS.token, expiraEn: new Date("2026-11-27T16:00:00.000Z") };
const SOLICITUD: SolicitudRegistroPresentado = { ruc: RUC, periodo: PERIODO };
const CLAVE = "TENANT-1:CLIENTE-1";
const CLAVE_PEN = `${CLAVE}:compras:${PERIODO}:registro-pen`;
const CLAVE_USD = `${CLAVE}:compras:${PERIODO}:registro-usd`;
const CLAVE_PROPUESTA = `${CLAVE}:compras:${PERIODO}:propuesta`;
const T_PEN = "202610000001";
const T_USD = "202610000002";
const T_PROPUESTA = "202610000009";
const COL_NUMERO = "Nro CP o Doc. Nro Inicial (Rango)";
const MSG_SUNAT = `msg de SUNAT que repite ${CANARIOS.token}`;

type Moneda = "PEN" | "USD";
const MONEDAS: readonly Moneda[] = ["PEN", "USD"];
const T: Record<Moneda, string> = { PEN: T_PEN, USD: T_USD };
const CLAVE_DE: Record<Moneda, string> = { PEN: CLAVE_PEN, USD: CLAVE_USD };
const TXT: Record<Moneda, string> = { PEN: "compras-registro-202610-pen.txt", USD: "compras-registro-202610-usd.txt" };
const SOLO_ENCABEZADO = "compras-registro-202610-solo-encabezado.txt";

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
function monedasPedidas(): (string | undefined)[] {
  return solicitudes().map((p) => p.query["codMoneda"]);
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
function zipDe(moneda: Moneda, contenido: Uint8Array): Uint8Array {
  return zipRegistroReal(`20700000002-registro-202610-${moneda}`, contenido);
}
/** Parte de registro de la moneda; por defecto con su fixture completo. */
function parteRegistro(moneda: Moneda, nombre = `registro-${moneda.toLowerCase()}.zip`, txt: Uint8Array = fixture(TXT[moneda])): ParteFalsa {
  return { nombre, zip: zipDe(moneda, txt) };
}
function parteSoloEncabezado(moneda: Moneda): ParteFalsa {
  return parteRegistro(moneda, `vacio-${moneda.toLowerCase()}.zip`, fixture(SOLO_ENCABEZADO));
}

/** Guion de la solicitud 5.51 por `codMoneda` (una moneda sin guion responde 422 con el cod 1061, como SUNAT). */
function solicitar(porMoneda: Record<Moneda, GuionRespuesta>): void {
  ent.sire.guionar("GET", RUTAS.solicitarRegistro(), (p) => {
    const g = porMoneda[p.query["codMoneda"] as Moneda];
    if (g === undefined) return { estado: 422, json: { errors: [{ cod: "1061", msg: "El campo 'codMoneda' es nulo o vacio" }] } };
    return typeof g === "function" ? g(p) : g;
  });
}
function solicitarSanas(): void {
  solicitar({ PEN: { json: { numTicket: T_PEN } }, USD: { json: { numTicket: T_USD } } });
}
/** Flujo sano: dos solicitudes -> T_PEN y T_USD, los dos tickets 04 con una parte de registro cada uno. */
function flujoSano(pen: ParteFalsa[] = [parteRegistro("PEN")], usd: ParteFalsa[] = [parteRegistro("USD")]): void {
  solicitarSanas();
  guionarTickets({ [T_PEN]: { estado: "04", partes: pen }, [T_USD]: { estado: "04", partes: usd } });
}
const SIN_DATOS_422: RespuestaFalsa = { estado: 422, json: { errors: [{ cod: "1070", msg: MSG_SUNAT }] } };
const SIN_DATOS_422_PLANO: RespuestaFalsa = { estado: 422, json: { cod: "1070", msg: MSG_SUNAT } };

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
/** El TXT de la moneda con su primera fila de datos cambiada (`de` → `a`, primera aparición). */
function cambiarEnPrimeraFila(nombreFixture: string, de: string, a: string): Uint8Array {
  const lineas = textoFixture(nombreFixture).split("\n");
  lineas[1] = lineas[1]!.replace(de, a);
  return new Uint8Array(Buffer.from(lineas.join("\n"), "utf8"));
}
/** El mismo TXT con una columna nueva antes de «Moneda»: encabezado distinto al de la propuesta. */
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
function partirPen(): [Uint8Array, Uint8Array] {
  const [cab, ...filas] = textoFixture(TXT.PEN).split("\n").filter((l) => l !== "");
  return [bytesDe([cab!, ...filas.slice(0, 4)]), bytesDe([cab!, ...filas.slice(4)])];
}

describe("HttpSireApiClient · registro presentado (CA-11, CA-13, P-3)", () => {
  it("registro: solicita 5.51 por GET dos veces (codMoneda PEN y luego USD) con codTipoArchivo=0, codProceso=70, codOrigen=2, lisPeriodos=per, perTributario=per; solo Bearer al host SIRE", async () => {
    flujoSano();
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    const pedidas = solicitudes();
    expect(pedidas).toHaveLength(2);
    for (const [i, moneda] of MONEDAS.entries()) {
      const p = pedidas[i]!;
      expect(p.metodo).toBe("GET");
      expect(p.ruta).toBe(RUTAS.solicitarRegistro()); // perTributario = periodo pedido, en la ruta
      expect(p.query).toEqual({ codTipoArchivo: "0", codProceso: "70", codOrigen: "2", lisPeriodos: PERIODO, codMoneda: moneda });
      expect(p.query["codOrigenEnvio"], "el nombre correcto es codOrigen").toBeUndefined();
    }
    // Las dos solicitudes salen antes de esperar ningún ticket (SUNAT procesa los dos a la vez).
    expect(ent.sire.peticiones.slice(0, 2).map((p) => p.ruta)).toEqual([RUTAS.solicitarRegistro(), RUTAS.solicitarRegistro()]);
    for (const p of ent.sire.peticiones) {
      expect(p.metodo).toBe("GET");
      expect(p.cabeceras["authorization"]).toBe(`Bearer ${CANARIOS.token}`);
      expect(`${p.ruta}?${p.queryCruda}\n${p.cuerpo}`).not.toContain(CANARIOS.token);
    }
    expect(ent.sire.sinGuion).toHaveLength(0);
    expect(ent.seguridad.peticiones).toHaveLength(0);
    expect(ent.ajeno.peticiones).toHaveLength(0);
  });

  it("registro: cada ticket 06 → 5.32 con codLibro=080000 y codProceso/perTributario de su ticket → filas PEN y luego USD con el mapeo de la propuesta", async () => {
    const esperadasPen = await filasComoPropuesta(TXT.PEN);
    const esperadasUsd = await filasComoPropuesta(TXT.USD);

    solicitarSanas();
    guionarTickets({
      [T_PEN]: { estado: "06", partes: [parteRegistro("PEN", "reg-pen.zip")], extra: { codProceso: "21", perTributario: PERIODO } },
      [T_USD]: { estado: "06", partes: [parteRegistro("USD", "reg-usd.zip")], extra: { codProceso: "22", perTributario: PERIODO } },
    });
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);

    const descargas = ent.sire.peticionesDe("GET", RUTAS.archivo);
    expect(descargas.map((p) => p.query)).toEqual([
      { nomArchivoReporte: "reg-pen.zip", codTipoArchivoReporte: "00", perTributario: PERIODO, codProceso: "21", numTicket: T_PEN, codLibro: "080000" },
      { nomArchivoReporte: "reg-usd.zip", codTipoArchivoReporte: "00", perTributario: PERIODO, codProceso: "22", numTicket: T_USD, codLibro: "080000" },
    ]);
    for (const nt of [T_PEN, T_USD]) {
      const consultas = ent.sire.peticionesDe("GET", RUTAS.ticket).filter((p) => p.query["numTicket"] === nt);
      expect(consultas.length).toBeGreaterThan(0);
      expect(consultas[0]!.query).toEqual({ perIni: PERIODO, perFin: PERIODO, page: "1", perPage: "20", numTicket: nt });
    }
    expect(r.libro).toBe("compras");
    expect(r.periodo).toBe(PERIODO);
    expect(esperadasPen.length).toBeGreaterThan(0);
    expect(esperadasUsd.length).toBeGreaterThan(0);
    expect(r.filas).toEqual([...esperadasPen, ...esperadasUsd]);
    expect(r.filas.map((f) => f.moneda)).toEqual([...esperadasPen.map(() => "PEN"), ...esperadasUsd.map(() => "USD")]);
  });

  it("registro: varias partes en orden; encabezado distinto entre partes o entre monedas → ErrorPortalSire encabezado", async () => {
    const [p1, p2] = partirPen();
    flujoSano([
      { nombre: "z-parte-1.zip", zip: zipDe("PEN", p1) },
      { nombre: "a-parte-2.zip", zip: zipDe("PEN", p2) },
    ]);
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual([
      "z-parte-1.zip",
      "a-parte-2.zip",
      "registro-usd.zip",
    ]);
    expect(numeros(r)).toEqual([...columna(TXT.PEN), ...columna(TXT.USD)]);

    // Entre partes de una misma moneda.
    ent.sire.reiniciar();
    flujoSano([
      { nombre: "parte-1.zip", zip: zipDe("PEN", p1) },
      { nombre: "parte-2.zip", zip: zipDe("PEN", conColumnaNueva(p2)) },
    ]);
    const entrePartes = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(entrePartes, "ErrorPortalSire", "encabezado");
    sinSecretos(entrePartes);

    // Entre monedas: el encabezado de la parte USD no es el de la 1.ª parte leída (PEN).
    ent.sire.reiniciar();
    flujoSano([parteRegistro("PEN")], [parteRegistro("USD", "usd-distinto.zip", conColumnaNueva(fixture(TXT.USD)))]);
    const entreMonedas = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(entreMonedas, "ErrorPortalSire", "encabezado");
    sinSecretos(entreMonedas);
  });

  describe("registro: una moneda sin datos y la otra con filas", () => {
    const casos: [string, Record<Moneda, "422" | "422plano" | "encabezado" | "filas">, Moneda][] = [
      ["PEN 422 1070 (errors[].cod) + USD con filas", { PEN: "422", USD: "filas" }, "USD"],
      ["PEN solo encabezado + USD con filas", { PEN: "encabezado", USD: "filas" }, "USD"],
      ["PEN con filas + USD 422 1070 (cod plano)", { PEN: "filas", USD: "422plano" }, "PEN"],
      ["PEN con filas + USD solo encabezado", { PEN: "filas", USD: "encabezado" }, "PEN"],
    ];
    it.each(casos)("%s → devuelve solo las de la otra", async (_n, forma, conFilas) => {
      const respuesta = (m: Moneda): GuionRespuesta =>
        forma[m] === "422" ? SIN_DATOS_422 : forma[m] === "422plano" ? SIN_DATOS_422_PLANO : { json: { numTicket: T[m] } };
      solicitar({ PEN: respuesta("PEN"), USD: respuesta("USD") });
      const mapa: Record<string, TicketFalso> = {};
      for (const m of MONEDAS) {
        if (forma[m] === "filas") mapa[T[m]] = { estado: "04", partes: [parteRegistro(m)] };
        if (forma[m] === "encabezado") mapa[T[m]] = { estado: "04", partes: [parteSoloEncabezado(m)] };
      }
      guionarTickets(mapa);
      const almacen = new AlmacenEspia(reloj.ahora);
      const r = await cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave());
      expect(numeros(r)).toEqual(columna(TXT[conFilas]));
      expect(r.filas.every((f) => f.moneda === conFilas)).toBe(true);
      expect(monedasPedidas(), "pide las dos monedas aunque una no tenga datos").toEqual(["PEN", "USD"]);
      expect(await almacen.leer(CLAVE_PEN)).toBeNull();
      expect(await almacen.leer(CLAVE_USD)).toBeNull();
    });
  });

  describe("registro: PEN y USD sin datos (cualquier combinación)", () => {
    const formas = ["422", "encabezado"] as const;
    for (const pen of formas) {
      for (const usd of formas) {
        it(`PEN ${pen} + USD ${usd} → ErrorDatosSire sin_datos y borra los dos tickets`, async () => {
          const forma: Record<Moneda, (typeof formas)[number]> = { PEN: pen, USD: usd };
          solicitar({
            PEN: forma.PEN === "422" ? SIN_DATOS_422 : { json: { numTicket: T_PEN } },
            USD: forma.USD === "422" ? SIN_DATOS_422_PLANO : { json: { numTicket: T_USD } },
          });
          const mapa: Record<string, TicketFalso> = {};
          for (const m of MONEDAS) if (forma[m] === "encabezado") mapa[T[m]] = { estado: "04", partes: [parteSoloEncabezado(m)] };
          guionarTickets(mapa);
          const almacen = new AlmacenEspia(reloj.ahora);
          const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
          esperarError(e, "ErrorDatosSire", "sin_datos");
          sinSecretos(e, [...SECRETOS, MSG_SUNAT]);
          for (const m of MONEDAS) {
            if (forma[m] === "encabezado") {
              expect(almacen.guardados.map((g) => g.clave)).toContain(CLAVE_DE[m]);
              expect(almacen.borrados).toContain(CLAVE_DE[m]);
            }
            expect(await almacen.leer(CLAVE_DE[m])).toBeNull();
          }
          for (const g of almacen.guardados) expect(almacen.borrados).toContain(g.clave);
        });
      }
    }
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
    for (const moneda of MONEDAS) {
      it.each(casos)(`${moneda} · %s`, async (_nombre, respuesta, codigos) => {
        solicitar({
          PEN: moneda === "PEN" ? respuesta : { json: { numTicket: T_PEN } },
          USD: moneda === "USD" ? respuesta : { json: { numTicket: T_USD } },
        });
        guionarTickets({ [T_PEN]: { estado: "04", partes: [parteRegistro("PEN")] }, [T_USD]: { estado: "04", partes: [parteRegistro("USD")] } });
        const almacen = new AlmacenEspia(reloj.ahora);
        const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
        esperarError(e, "ErrorPortalSire", "solicitud_rechazada");
        expect(codigosSunatDe(e)).toEqual(codigos);
        sinSecretos(e, [...SECRETOS, MSG_SUNAT, "msg de SUNAT"]);
        // Sin otra solicitud: con PEN rechazada ni se pide USD; con USD rechazada ya se había pedido PEN y no hay más.
        expect(solicitudes()).toHaveLength(moneda === "PEN" ? 1 : 2);
        expect(ent.sire.peticionesDe("GET", RUTAS.ticket), "no espera ningún ticket").toHaveLength(0);
        // Error permanente: no queda ningún ticket guardado.
        for (const g of almacen.guardados) expect(almacen.borrados).toContain(g.clave);
        expect(await almacen.leer(CLAVE_PEN)).toBeNull();
        expect(await almacen.leer(CLAVE_USD)).toBeNull();
      });
    }
  });

  it("registro: nunca pide un codProceso distinto de 70 ni más de una solicitud por moneda", async () => {
    const comprobar = (etapa: string, esperadas: number) => {
      const pedidas = solicitudes();
      expect(pedidas, etapa).toHaveLength(esperadas);
      for (const p of pedidas) {
        expect(p.query["codProceso"], etapa).toBe("70");
        expect(Object.keys(p.query).sort(), etapa).toEqual(["codMoneda", "codOrigen", "codProceso", "codTipoArchivo", "lisPeriodos"]);
      }
      const porMoneda = pedidas.map((p) => p.query["codMoneda"]);
      expect(new Set(porMoneda).size, `${etapa}: una solicitud por moneda`).toBe(porMoneda.length);
    };

    flujoSano();
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    comprobar("sano", 2);

    ent.sire.reiniciar();
    solicitar({ PEN: SIN_DATOS_422, USD: { json: { numTicket: T_USD } } });
    guionarTickets({ [T_USD]: { estado: "04", partes: [parteRegistro("USD")] } });
    await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    comprobar("PEN sin datos", 2);

    ent.sire.reiniciar();
    solicitar({ PEN: { estado: 422, json: { errors: [{ cod: "1026" }] } }, USD: { json: { numTicket: T_USD } } });
    await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    comprobar("PEN rechazada", 1);

    ent.sire.reiniciar();
    solicitarSanas();
    guionarTickets({ [T_PEN]: { estado: "03" }, [T_USD]: { estado: "04", partes: [parteRegistro("USD")] } });
    await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    comprobar("ticket con errores", 2);

    // Ticket pendiente y reintento: el segundo intento retoma los dos tickets y no solicita nada.
    ent.sire.reiniciar();
    solicitarSanas();
    guionarTickets({ [T_PEN]: { estado: "01" }, [T_USD]: { estado: "01" } });
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });
    await capturar(c.descargarRegistroPresentado(TOKEN, conClave()));
    guionarTickets({ [T_PEN]: { estado: "04", partes: [parteRegistro("PEN")] }, [T_USD]: { estado: "04", partes: [parteRegistro("USD")] } });
    await c.descargarRegistroPresentado(TOKEN, conClave());
    comprobar("pendiente y reintento", 2);
  });

  describe("registro: ticket 03 / estado desconocido / listo sin archivos en cualquiera de las monedas → mismo error, sin filas, borra los dos tickets", () => {
    const fallos: [string, TicketFalso, "ErrorDatosSire" | "ErrorPortalSire", string][] = [
      ["03", { estado: "03" }, "ErrorDatosSire", "ticket_con_errores"],
      ["07", { estado: "07" }, "ErrorPortalSire", "estado_desconocido"],
      ["99", { estado: "99" }, "ErrorPortalSire", "estado_desconocido"],
      ["04 sin archivos", { estado: "04", partes: [] }, "ErrorPortalSire", "respuesta_inesperada"],
    ];
    for (const moneda of MONEDAS) {
      it.each(fallos)(`${moneda} · ticket %s`, async (_nombre, ticket, clase, detalle) => {
        solicitarSanas();
        const sano = (m: Moneda): TicketFalso => ({ estado: "04", partes: [parteRegistro(m)] });
        guionarTickets({ [T_PEN]: moneda === "PEN" ? ticket : sano("PEN"), [T_USD]: moneda === "USD" ? ticket : sano("USD") });
        const almacen = new AlmacenEspia(reloj.ahora);
        const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
        esperarError(e, clase, detalle);
        sinSecretos(e);
        expect(ent.sire.peticionesDe("GET", RUTAS.archivo).filter((p) => p.query["numTicket"] === T[moneda])).toHaveLength(0);
        expect(almacen.guardados.map((g) => g.clave)).toEqual([CLAVE_PEN, CLAVE_USD]);
        expect(almacen.borrados).toEqual(expect.arrayContaining([CLAVE_PEN, CLAVE_USD]));
        expect(await almacen.leer(CLAVE_PEN)).toBeNull();
        expect(await almacen.leer(CLAVE_USD)).toBeNull();
      });
    }
  });

  it("registro: ticket pendiente → guarda …:registro-pen y …:registro-usd y lanza ticket_pendiente; el reintento retoma los dos sin volver a solicitar", async () => {
    let listo = false;
    solicitarSanas();
    ent.sire.guionar("GET", RUTAS.ticket, (p) => {
      const nt = p.query["numTicket"] ?? "";
      const m: Moneda = nt === T_PEN ? "PEN" : "USD";
      return { json: cuerpoTicket([registroTicket(nt, listo ? "04" : "01", listo ? [archivo(`r-${m}.zip`)] : [])]) };
    });
    ent.sire.guionar("GET", RUTAS.archivo, (p) =>
      p.query["numTicket"] === T_PEN ? { bytes: parteRegistro("PEN", "r-PEN.zip").zip } : { bytes: parteRegistro("USD", "r-USD.zip").zip },
    );
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    const e = await capturar(c.descargarRegistroPresentado(TOKEN, conClave()));
    esperarError(e, "ErrorTransitorioSire", "ticket_pendiente");
    expect(almacen.guardados).toEqual([
      { clave: CLAVE_PEN, numTicket: T_PEN, ttlMs: 3_600_000 },
      { clave: CLAVE_USD, numTicket: T_USD, ttlMs: 3_600_000 },
    ]);
    expect(await almacen.leer(CLAVE_PEN)).toBe(T_PEN);
    expect(await almacen.leer(CLAVE_USD)).toBe(T_USD);
    expect(almacen.borrados, "un ticket pendiente no borra nada").toHaveLength(0);

    listo = true;
    const r = await c.descargarRegistroPresentado(TOKEN, conClave());
    expect(numeros(r)).toEqual([...columna(TXT.PEN), ...columna(TXT.USD)]);
    expect(solicitudes(), "no solicita de nuevo").toHaveLength(2);
    const consultados = new Set(ent.sire.peticionesDe("GET", RUTAS.ticket).map((p) => p.query["numTicket"]));
    expect(consultados).toEqual(new Set([T_PEN, T_USD]));
    expect(almacen.borrados).toEqual(expect.arrayContaining([CLAVE_PEN, CLAVE_USD]));
    expect(await almacen.leer(CLAVE_PEN)).toBeNull();
    expect(await almacen.leer(CLAVE_USD)).toBeNull();
  });

  it("registro (PEN y USD) y propuesta del mismo periodo y cliente no comparten ticket guardado", async () => {
    ent.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: T_PROPUESTA } });
    solicitarSanas();
    ent.sire.guionar("GET", RUTAS.ticket, (p) => ({ json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", "01")]) }));
    const almacen = new AlmacenEspia(reloj.ahora);
    const c = cliente({ almacenTickets: almacen });

    esperarError(
      await capturar(c.descargarPropuesta(TOKEN, { ruc: RUC, periodo: PERIODO, libro: "compras", claveReanudacion: CLAVE })),
      "ErrorTransitorioSire",
      "ticket_pendiente",
    );
    esperarError(await capturar(c.descargarRegistroPresentado(TOKEN, conClave())), "ErrorTransitorioSire", "ticket_pendiente");

    expect(solicitudes(), "el registro solicita un ticket por moneda").toHaveLength(2);
    expect(ent.sire.peticionesDe("GET", RUTAS.exportarRce())).toHaveLength(1);
    expect(almacen.guardados.map((g) => [g.clave, g.numTicket])).toEqual([
      [CLAVE_PROPUESTA, T_PROPUESTA],
      [CLAVE_PEN, T_PEN],
      [CLAVE_USD, T_USD],
    ]);
    expect(new Set(almacen.guardados.map((g) => g.clave)).size).toBe(3);
  });

  describe("registro: fila con RUC, Periodo o Moneda ajenos → respuesta_ajena sin filas", () => {
    const casos: [string, Moneda, () => Uint8Array][] = [
      ["RUC ajeno en la parte PEN", "PEN", () => cambiarEnPrimeraFila(TXT.PEN, "20700000002", "20700000011")],
      ["Periodo ajeno en la parte USD", "USD", () => cambiarEnPrimeraFila(TXT.USD, "|202610|", "|202609|")],
      ["fila USD dentro de la parte PEN (-mixto)", "PEN", () => fixture("compras-registro-202610-mixto.txt")],
      ["fila PEN dentro de la parte USD", "USD", () => fixture(TXT.PEN)],
    ];
    it.each(casos)("%s", async (_nombre, moneda, txt) => {
      const pen = moneda === "PEN" ? parteRegistro("PEN", "ajena.zip", txt()) : parteRegistro("PEN");
      const usd = moneda === "USD" ? parteRegistro("USD", "ajena.zip", txt()) : parteRegistro("USD");
      flujoSano([pen], [usd]);
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

  it("registro: comprobante repetido entre PEN y USD → ErrorPortalSire respuesta_inesperada sin filas", async () => {
    // La 1.ª fila PEN (F001-1040 de 20700000011) reaparece en la parte USD (con su moneda): no se deduplica, se rechaza.
    const filaPen = textoFixture(TXT.PEN).split("\n")[1]!;
    const filaUsdIgual = filaPen.replace("|PEN|1.000|", "|USD|3.300|");
    expect(filaUsdIgual).not.toBe(filaPen);
    const usdRepetido = bytesDe([...textoFixture(TXT.USD).split("\n").filter((l) => l !== ""), filaUsdIgual]);
    flujoSano([parteRegistro("PEN")], [parteRegistro("USD", "usd-repetido.zip", usdRepetido)]);
    const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
    esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
    sinSecretos(e);

    // Control: mismo tipo, serie y número pero otro proveedor no es el mismo comprobante.
    ent.sire.reiniciar();
    const otroProveedor = filaUsdIgual.replace("|20700000011|PRUEBA PROVEEDOR ISC S.A.C.|", "|20700000096|PRUEBA PROVEEDOR GENERICO S.A.C.|");
    expect(otroProveedor).not.toBe(filaUsdIgual);
    const usdOtro = bytesDe([...textoFixture(TXT.USD).split("\n").filter((l) => l !== ""), otroProveedor]);
    flujoSano([parteRegistro("PEN")], [parteRegistro("USD", "usd-otro.zip", usdOtro)]);
    const r = await cliente().descargarRegistroPresentado(TOKEN, SOLICITUD);
    expect(r.filas).toHaveLength(columna(TXT.PEN).length + columna(TXT.USD).length + 1);
  });

  describe("registro: PEN y USD comparten los 90 s y el acumulado de 256 MiB", () => {
    it("registro: agotados los 90 s tras PEN → timeout, no pide el ticket USD y conserva los dos tickets", async () => {
      flujoSano();
      // La descarga de la parte PEN consume todo el presupuesto de la operación (reloj virtual).
      ent.sire.guionar("GET", RUTAS.archivo, () => {
        reloj.avanzar(95_000);
        return { bytes: parteRegistro("PEN").zip, cabeceras: { "content-type": "application/zip" } };
      });
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      sinSecretos(e);
      expect(ent.sire.peticionesDe("GET", RUTAS.ticket).every((p) => p.query["numTicket"] === T_PEN), "USD no se consulta sin presupuesto").toBe(true);
      expect(await almacen.leer(CLAVE_PEN)).toBe(T_PEN);
      expect(await almacen.leer(CLAVE_USD)).toBe(T_USD);
      expect(almacen.borrados).toHaveLength(0);
    });

    it("registro: el acumulado de 256 MiB suma partes PEN y USD → zip_invalido", async () => {
      // Relleno ASCII en una columna que no se mapea: 1 KiB hex aleatorio por bloque de 16 KiB (razón ≈ 30:1, lejos de 200:1).
      const relleno = (bytes: number): string => {
        const b = Buffer.alloc(bytes, 0x41);
        for (let o = 0; o < bytes; o += 16 * 1024) b.write(randomBytes(512).toString("hex"), o, "latin1");
        return b.toString("latin1");
      };
      const grande = relleno(60 * 1024 * 1024);
      const parteGrande = (moneda: Moneda, fila: number, nombre: string): ParteFalsa => {
        const [cab, ...filas] = textoFixture(TXT[moneda]).split("\n").filter((l) => l !== "");
        const celdas = filas[fila]!.split("|");
        celdas[3] = grande; // «CAR SUNAT»: no se mapea
        const contenido = new Uint8Array(Buffer.from(`${cab}\n${celdas.join("|")}\n`, "utf8"));
        return { nombre, zip: zipRegistroReal("parte", contenido) };
      };
      // 2 partes PEN (120 MiB) y 3 partes USD (180 MiB): ninguna moneda pasa de 256 MiB sola, la 5.ª parte suma 300 MiB.
      const pen = [parteGrande("PEN", 0, "pen1.zip"), parteGrande("PEN", 1, "pen2.zip")];
      const usd = [parteGrande("USD", 0, "usd1.zip"), parteGrande("USD", 1, "usd2.zip"), parteGrande("USD", 2, "usd3.zip")];
      for (const p of [...pen, ...usd]) expect(p.zip.length).toBeLessThan(8 * 1024 * 1024);
      flujoSano(pen, usd);
      const e = await capturar(cliente().descargarRegistroPresentado(TOKEN, SOLICITUD));
      esperarError(e, "ErrorPortalSire", "zip_invalido");
      expect(ent.sire.peticionesDe("GET", RUTAS.archivo).map((p) => p.query["nomArchivoReporte"])).toEqual([
        "pen1.zip",
        "pen2.zip",
        "usd1.zip",
        "usd2.zip",
        "usd3.zip",
      ]);
    }, 120_000);
  });

  describe("registro: 401 → TokenRechazadoError conserva los dos tickets; 5xx/timeout → ErrorTransitorioSire conserva los dos tickets", () => {
    type Paso = "ticket" | "archivo";
    const RUTA_PASO: Record<Paso, () => string> = { ticket: () => RUTAS.ticket, archivo: () => RUTAS.archivo };

    /** Ticket y archivo de la moneda fallan; los de la otra siguen sanos. */
    function fallaEn(paso: Paso, moneda: Moneda, respuesta: RespuestaFalsa): void {
      const mapa: Record<string, TicketFalso> = {
        [T_PEN]: { estado: "04", partes: [parteRegistro("PEN")] },
        [T_USD]: { estado: "04", partes: [parteRegistro("USD")] },
      };
      guionarTickets(mapa);
      ent.sire.guionar("GET", RUTA_PASO[paso](), (p) => {
        if (p.query["numTicket"] === T[moneda]) return respuesta;
        if (paso === "ticket") {
          const nt = p.query["numTicket"] ?? "";
          const t = mapa[nt]!;
          return { json: cuerpoTicket([registroTicket(nt, t.estado, (t.partes ?? []).map((x) => archivo(x.nombre)))]) };
        }
        return servirParte(mapa, p);
      });
    }

    for (const paso of ["ticket", "archivo"] as Paso[]) {
      for (const moneda of MONEDAS) {
        it.each([
          [401, "TokenRechazadoError", undefined],
          [500, "ErrorTransitorioSire", "servidor"],
          [503, "ErrorTransitorioSire", "servidor"],
        ] as const)(`${paso} ${moneda} · HTTP %i -> %s y las dos claves siguen guardadas`, async (estado, clase, detalle) => {
          solicitarSanas();
          fallaEn(paso, moneda, { estado, json: { error: CANARIOS.token } });
          const almacen = new AlmacenEspia(reloj.ahora);
          const e = await capturar(cliente({ almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
          esperarError(e, clase, detalle);
          sinSecretos(e);
          expect(almacen.guardados.map((g) => g.clave)).toEqual([CLAVE_PEN, CLAVE_USD]);
          expect(await almacen.leer(CLAVE_PEN)).toBe(T_PEN);
          expect(await almacen.leer(CLAVE_USD)).toBe(T_USD);
          expect(almacen.borrados).toHaveLength(0);
        });
      }
    }

    // Orden de las peticiones: 1-2 solicitudes (PEN, USD), 3 ticket PEN, 4 archivo PEN, 5 ticket USD, 6 archivo USD.
    it.each([
      [3, "ticket PEN"],
      [4, "archivo PEN"],
      [5, "ticket USD"],
      [6, "archivo USD"],
    ] as [number, string][])("la petición %i (%s) con timeout -> ErrorTransitorioSire timeout y conserva los dos tickets", async (n) => {
      flujoSano();
      let k = 0;
      const f = ((u: string | URL | Request, init?: RequestInit) => {
        k += 1;
        return k === n ? Promise.reject(new DOMException("agotado", "TimeoutError")) : globalThis.fetch(u, init);
      }) as typeof fetch;
      const almacen = new AlmacenEspia(reloj.ahora);
      const e = await capturar(cliente({ fetch: f, almacenTickets: almacen }).descargarRegistroPresentado(TOKEN, conClave()));
      esperarError(e, "ErrorTransitorioSire", "timeout");
      expect(await almacen.leer(CLAVE_PEN)).toBe(T_PEN);
      expect(await almacen.leer(CLAVE_USD)).toBe(T_USD);
      expect(almacen.borrados).toHaveLength(0);
    });
  });
});

function columna(nombreFixture: string): string[] {
  const lineas = Buffer.from(fixture(nombreFixture)).toString("utf8").replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const i = lineas[0]!.split("|").indexOf(COL_NUMERO);
  return lineas.slice(1).map((l) => l.split("|")[i]!);
}
