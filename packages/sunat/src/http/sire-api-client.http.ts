/**
 * `HttpSireApiClient` (plan 041): exportar → ticket → descargar partes → leer → mapear. Solo GET al host del SIRE con
 * `Authorization: Bearer`; no reintenta por su cuenta (los reintentos son de 008) y no conserva el token. Sin logger:
 * errores con mensaje fijo y `detalle` literal (CA-11, CA-12).
 */
import { z } from "zod";
import {
  ErrorDatos,
  ErrorDatosSire,
  ErrorPortalSire,
  ErrorTransitorio,
  ErrorTransitorioSire,
  TokenRechazadoError,
} from "../errores.js";
import type {
  FilaPropuestaSire,
  LibroSire,
  PropuestaSire,
  RegistroPresentadoSire,
  SireApiClient,
  SolicitudPropuesta,
  SolicitudRegistroPresentado,
  TokenSire,
} from "../puertos.js";
import type { AlmacenTicketsSire } from "./almacen-tickets.js";
import {
  COD_LIBRO,
  COD_SIN_DATOS_REGISTRO,
  GRAMATICA_PERIODO,
  GRAMATICA_RUC,
  MAX_BYTES_JSON,
  MAX_BYTES_ZIP,
  MONEDAS_REGISTRO,
  PARAMETROS_EXPORTAR,
  PRESUPUESTO_OPERACION_MS,
  RUTA_ARCHIVO,
  RUTA_TICKET,
  TIMEOUT_API_MS,
  TIMEOUT_DESCARGA_MS,
  TTL_TICKET_MS,
  armarUrl,
  type MonedaRegistro,
  parametrosRegistro,
  rutaExportar,
  rutaRegistroPresentado,
} from "./endpoints.js";
import { origenes, parsearJson, type OpcionesHttpSire } from "./sire-auth.http.js";
import { interpretarConsultaTicket, planEsperaTicket, type ParteTicket } from "./ticket.js";
import { pedir, type ContextoHttp } from "./transporte.js";
import { mismoEncabezado } from "./txt/encabezados.js";
import { leerTxt, type TxtLeido } from "./txt/leer-txt.js";
import { mapearCompras } from "./txt/mapeo-compras.js";
import { mapearVentas } from "./txt/mapeo-ventas.js";
import type { EsperadoTxt } from "./txt/valores.js";
import { TOPE_ZIP_DESCOMPRIMIDO_TOTAL, extraerTxtDeZip } from "./zip-seguro.js";

/** Número de ticket que devuelve la exportación (va solo como parámetro de query). */
const GRAMATICA_TICKET = /^[A-Za-z0-9_-]{1,64}$/;
/** `nomArchivoReporte`: nombre plano, sin rutas, controles ni «..». */
const GRAMATICA_NOMBRE_ARCHIVO = /^[A-Za-z0-9._-]{1,200}$/;

const esquemaExportar = z.object({ numTicket: z.string().regex(GRAMATICA_TICKET) });

/** Lo que el TXT de una propuesta necesita para validarse contra la solicitud. */
export type ContextoLectura = EsperadoTxt;

/**
 * Operación que nombra la clave del almacén (H-041-2-4, P-3): la propuesta y el registro presentado de cada moneda no
 * comparten ticket. Debe coincidir con `OperacionTicketSire` de `@contapp/queue`.
 */
type OperacionTicket = "propuesta" | "registro-pen" | "registro-usd";
const OPERACION_REGISTRO: Readonly<Record<MonedaRegistro, OperacionTicket>> = { PEN: "registro-pen", USD: "registro-usd" };

/** Ticket del registro de una moneda tras la fase de solicitud: `retomado` si vino del almacén (no de esta solicitud). */
interface TicketRegistro {
  numTicket: string;
  retomado: boolean;
}

/** Estado de lectura compartido por todas las partes de una operación: encabezado de la 1.ª parte y bytes acumulados. */
interface EstadoLectura {
  primero: readonly string[] | undefined;
  acumulado: number;
}

/** Ticket listo para descargar. */
interface TicketListo {
  numTicket: string;
  codProceso: string;
  perTributario: string;
  partes: ParteTicket[];
}

export class HttpSireApiClient implements SireApiClient {
  private readonly fetch: typeof fetch | undefined;
  private readonly ahora: () => Date;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly almacen: AlmacenTicketsSire | undefined;
  private readonly origen: string;

  constructor(o: OpcionesHttpSire = {}) {
    this.fetch = o.fetch;
    this.ahora = o.ahora ?? (() => new Date());
    this.dormir = o.dormir ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.almacen = o.almacenTickets;
    this.origen = origenes(o).sire;
  }

  /**
   * Gestión del ticket guardado (decisiones de la ronda 2): se guarda UNA vez justo tras exportar y se borra solo al
   * validar todas las partes o ante un error permanente. Un `ErrorTransitorio` o un `TokenRechazadoError`, en la consulta
   * o en la descarga, lo conservan para el siguiente intento.
   */
  async descargarPropuesta(token: TokenSire, solicitud: SolicitudPropuesta): Promise<PropuestaSire> {
    const { ruc, periodo, libro } = solicitud;
    if (!GRAMATICA_RUC.test(ruc) || !GRAMATICA_PERIODO.test(periodo) || (libro !== "compras" && libro !== "ventas")) {
      throw new ErrorDatos();
    }
    const inicio = this.ahora().getTime();
    const clave = this.claveAlmacen(solicitud.claveReanudacion, libro, periodo, "propuesta");
    const contexto: ContextoLectura = { ruc, periodo };
    let propuesta: PropuestaSire;
    try {
      const url = armarUrl(this.origen, rutaExportar(libro, periodo), PARAMETROS_EXPORTAR[libro]);
      const ticket = await this.obtenerTicketListo(token, url, periodo, clave, inicio);
      propuesta =
        libro === "compras"
          ? { libro, periodo, filas: await this.leerPartes(token, libro, ticket, inicio, (txt) => mapearCompras(txt, contexto)) }
          : { libro, periodo, filas: await this.leerPartes(token, libro, ticket, inicio, (txt) => mapearVentas(txt, contexto)) };
    } catch (e) {
      const conservar = e instanceof ErrorTransitorio || e instanceof TokenRechazadoError;
      if (!conservar && clave !== null) await this.almacen!.borrar(clave);
      throw e;
    }
    if (clave !== null) await this.almacen!.borrar(clave);
    return propuesta;
  }

  /**
   * Spec 025 / CA-13, plan P-3: registro de compras presentado (5.51, `codProceso` 70) con el flujo de ticket, `leerPartes` y
   * `mapearCompras` de la propuesta. Un ticket por moneda (PEN y luego USD, claves `…:compras:{per}:registro-pen|-usd`):
   * (1) por moneda, retomar su ticket guardado o solicitarlo y guardarlo (SUNAT procesa los dos a la vez); (2) por moneda, en el
   * mismo orden, esperar su ticket y leer sus partes. Todo en UN presupuesto de 90 s y un acumulado de 256 MiB (H-5, H-7).
   * «Sin datos» por moneda: 422 con un `cod` de `COD_SIN_DATOS_REGISTRO` o TXT con solo encabezado; las dos sin datos →
   * `ErrorDatosSire("sin_datos")`. Los dos tickets se borran solo al terminar (éxito, sin datos o error permanente); un
   * `ErrorTransitorio` o un `TokenRechazadoError` los conserva. No se devuelven filas de una sola moneda.
   */
  async descargarRegistroPresentado(token: TokenSire, solicitud: SolicitudRegistroPresentado): Promise<RegistroPresentadoSire> {
    const { ruc, periodo } = solicitud;
    if (!GRAMATICA_RUC.test(ruc) || !GRAMATICA_PERIODO.test(periodo)) throw new ErrorDatos();
    const inicio = this.ahora().getTime();
    const claves = {} as Record<MonedaRegistro, string | null>;
    for (const m of MONEDAS_REGISTRO) {
      claves[m] = this.claveAlmacen(solicitud.claveReanudacion, "compras", periodo, OPERACION_REGISTRO[m]);
    }
    const contexto: ContextoLectura = { ruc, periodo };
    const borrarTodas = async (): Promise<void> => {
      for (const m of MONEDAS_REGISTRO) {
        const clave = claves[m];
        if (clave !== null) await this.almacen!.borrar(clave);
      }
    };
    const filas: FilaPropuestaSire[] = [];
    try {
      // (1) Solicitudes: las dos antes de esperar ninguna. `null` = sin datos al solicitar.
      const tickets = {} as Record<MonedaRegistro, TicketRegistro | null>;
      for (const m of MONEDAS_REGISTRO) tickets[m] = await this.ticketRegistro(token, periodo, m, claves[m], inicio);

      // (2) Espera y lectura, en el mismo orden, con encabezado y acumulado compartidos.
      const lectura: EstadoLectura = { primero: undefined, acumulado: 0 };
      const vistos = new Set<string>();
      for (const m of MONEDAS_REGISTRO) {
        const t = tickets[m];
        if (t === null) continue;
        const listo = await this.esperarTicketRegistro(token, periodo, m, t, claves[m], inicio);
        if (listo === null) continue;
        const deMoneda = await this.leerPartes(
          token,
          "compras",
          listo,
          inicio,
          (txt) => {
            const mapeadas = mapearCompras(txt, contexto);
            // `codMoneda` es un filtro: una fila de otra moneda es una respuesta ajena (falla cerrado).
            if (mapeadas.some((f) => f.moneda !== m)) throw new ErrorDatosSire("respuesta_ajena");
            return mapeadas;
          },
          lectura,
        );
        const propios = new Set<string>();
        for (const f of deMoneda) {
          const c = claveComprobante(f);
          // Un comprobante en las dos monedas no se deduplica: montos distintos quedarían ocultos.
          if (vistos.has(c)) throw new ErrorPortalSire("respuesta_inesperada");
          propios.add(c);
        }
        for (const c of propios) vistos.add(c);
        for (const f of deMoneda) filas.push(f);
      }
      if (filas.length === 0) throw new ErrorDatosSire("sin_datos");
    } catch (e) {
      const conservar = e instanceof ErrorTransitorio || e instanceof TokenRechazadoError;
      if (!conservar) await borrarTodas();
      throw e;
    }
    await borrarTodas();
    return { libro: "compras", periodo, filas };
  }

  // ── Pasos ────────────────────────────────────────────────────────────────────────────────────────────────

  /** `{claveReanudacion}:{libro}:{periodo}:{operacion}` (5 partes con `claveReanudacion` = `{tenant}:{cliente}`). */
  private claveAlmacen(
    claveReanudacion: string | undefined,
    libro: LibroSire,
    periodo: string,
    operacion: OperacionTicket,
  ): string | null {
    if (this.almacen === undefined || claveReanudacion === undefined || claveReanudacion === "") return null;
    return `${claveReanudacion}:${libro}:${periodo}:${operacion}`;
  }

  /**
   * Retoma el ticket guardado o exporta y lo guarda (una vez, justo tras exportar); luego espera a que esté listo. Si SUNAT
   * ya no lista el ticket guardado, lo borra y exporta UNA vez más en este intento; el ticket nuevo sigue la regla normal
   * (si tampoco aparece: `respuesta_ajena`).
   */
  private async obtenerTicketListo(
    token: TokenSire,
    urlSolicitud: string,
    periodo: string,
    clave: string | null,
    inicio: number,
  ): Promise<TicketListo> {
    const guardado = clave === null ? null : await this.almacen!.leer(clave);
    if (guardado !== null && GRAMATICA_TICKET.test(guardado)) {
      try {
        return await this.esperarTicketListo(token, periodo, guardado, inicio);
      } catch (e) {
        if (!(e instanceof ErrorDatosSire && e.detalle === "respuesta_ajena")) throw e;
        await this.almacen!.borrar(clave!);
      }
    }
    const numTicket = await this.exportar(token, urlSolicitud, inicio);
    if (clave !== null) await this.almacen!.guardar(clave, numTicket, TTL_TICKET_MS);
    return this.esperarTicketListo(token, periodo, numTicket, inicio);
  }

  /** Pide el ticket de la exportación de la propuesta. */
  private async exportar(token: TokenSire, url: string, inicio: number): Promise<string> {
    return numTicketDe(await this.pedirJson(token, url, inicio));
  }

  /** Fase 1 del registro de una moneda: retoma su ticket guardado o lo solicita y lo guarda. `null` = sin datos. */
  private async ticketRegistro(
    token: TokenSire,
    periodo: string,
    moneda: MonedaRegistro,
    clave: string | null,
    inicio: number,
  ): Promise<TicketRegistro | null> {
    const guardado = clave === null ? null : await this.almacen!.leer(clave);
    if (guardado !== null && GRAMATICA_TICKET.test(guardado)) return { numTicket: guardado, retomado: true };
    const numTicket = await this.solicitarRegistro(token, periodo, moneda, inicio);
    if (numTicket === null) return null;
    if (clave !== null) await this.almacen!.guardar(clave, numTicket, TTL_TICKET_MS);
    return { numTicket, retomado: false };
  }

  /**
   * Fase 2 del registro de una moneda: espera su ticket. Si SUNAT ya no lista un ticket retomado, lo borra y solicita UNA vez
   * más esa moneda (H-041-2-2); el ticket nuevo sigue la regla normal. `null` = esa nueva solicitud dijo «sin datos».
   */
  private async esperarTicketRegistro(
    token: TokenSire,
    periodo: string,
    moneda: MonedaRegistro,
    ticket: TicketRegistro,
    clave: string | null,
    inicio: number,
  ): Promise<TicketListo | null> {
    try {
      return await this.esperarTicketListo(token, periodo, ticket.numTicket, inicio);
    } catch (e) {
      if (!ticket.retomado || !(e instanceof ErrorDatosSire && e.detalle === "respuesta_ajena")) throw e;
    }
    if (clave !== null) await this.almacen!.borrar(clave);
    const numTicket = await this.solicitarRegistro(token, periodo, moneda, inicio);
    if (numTicket === null) return null;
    if (clave !== null) await this.almacen!.guardar(clave, numTicket, TTL_TICKET_MS);
    return this.esperarTicketListo(token, periodo, numTicket, inicio);
  }

  /**
   * Solicitud 5.51 de una moneda (`codProceso` 70). Un 400/422 llega como `ErrorPortalSire("solicitud_rechazada")` con los
   * códigos de SUNAT: si alguno es de «sin datos», devuelve `null`; si no, el rechazo es permanente y se propaga.
   */
  private async solicitarRegistro(
    token: TokenSire,
    periodo: string,
    moneda: MonedaRegistro,
    inicio: number,
  ): Promise<string | null> {
    const url = armarUrl(this.origen, rutaRegistroPresentado(periodo), parametrosRegistro(periodo, moneda));
    let cuerpo: unknown;
    try {
      cuerpo = await this.pedirJson(token, url, inicio, "solicitud-registro");
    } catch (e) {
      if (
        e instanceof ErrorPortalSire &&
        e.detalle === "solicitud_rechazada" &&
        e.codigosSunat.some((c) => COD_SIN_DATOS_REGISTRO.includes(c))
      ) {
        return null;
      }
      throw e;
    }
    return numTicketDe(cuerpo);
  }

  /** Consulta el ticket con el plan de espera; lanza `ticket_pendiente` si no termina y `timeout` si se agota el presupuesto. */
  private async esperarTicketListo(token: TokenSire, periodo: string, numTicket: string, inicio: number): Promise<TicketListo> {
    const url = armarUrl(this.origen, RUTA_TICKET, {
      perIni: periodo,
      perFin: periodo,
      page: "1",
      perPage: "20",
      numTicket,
    });
    const esperas = planEsperaTicket();
    for (let i = 0; ; i++) {
      const estado = interpretarConsultaTicket(await this.pedirJson(token, url, inicio), numTicket);
      if (estado.listo) {
        // Un ticket listo sin archivos no es una propuesta vacía (el TXT trae al menos el encabezado): el portal cambió.
        if (estado.partes.length === 0) throw new ErrorPortalSire("respuesta_inesperada");
        validarNombresPartes(estado.partes);
        return { numTicket, codProceso: estado.codProceso, perTributario: estado.perTributario, partes: estado.partes };
      }
      const ms = esperas[i];
      if (ms === undefined) throw new ErrorTransitorioSire("ticket_pendiente");
      // El sueño también se recorta a lo que quede del presupuesto (H-041-2-5).
      const restante = this.restante(inicio);
      if (restante <= 0) throw new ErrorTransitorioSire("timeout");
      await this.dormir(Math.min(ms, restante));
    }
  }

  /**
   * Partes en el orden del ticket y de una en una (H-041-2-6): cada una se baja, se valida (ZIP, UTF-8, encabezado igual al
   * de la 1.ª, filas) y se suelta antes de pedir la siguiente; al primer error se corta. Tope de 64 MiB descomprimidos por
   * parte y 256 MiB acumulados en la operación (CA-10, H-7): pasado el acumulado, `zip_invalido`. `lectura` se comparte entre
   * los tickets de una operación (registro: PEN y USD), así que el encabezado y el acumulado son de toda la operación.
   */
  private async leerPartes<F>(
    token: TokenSire,
    libro: LibroSire,
    ticket: TicketListo,
    inicio: number,
    mapear: (txt: TxtLeido) => F[],
    lectura: EstadoLectura = { primero: undefined, acumulado: 0 },
  ): Promise<F[]> {
    const filas: F[] = [];
    for (const parte of ticket.partes) {
      const bytes = extraerTxtDeZip(
        await this.descargarParte(token, libro, ticket, parte, inicio),
        TOPE_ZIP_DESCOMPRIMIDO_TOTAL - lectura.acumulado,
      );
      lectura.acumulado += bytes.length;
      const txt = leerTxt(bytes);
      if (lectura.primero === undefined) lectura.primero = txt.encabezado;
      else if (!mismoEncabezado(lectura.primero, txt.encabezado)) throw new ErrorPortalSire("encabezado");
      for (const f of mapear(txt)) filas.push(f);
    }
    return filas;
  }

  private async descargarParte(
    token: TokenSire,
    libro: LibroSire,
    ticket: TicketListo,
    parte: ParteTicket,
    inicio: number,
  ): Promise<Uint8Array> {
    const url = armarUrl(this.origen, RUTA_ARCHIVO, {
      nomArchivoReporte: parte.nombre,
      // El portal espera el texto «null» cuando el ticket no trae tipo (Postman).
      codTipoArchivoReporte: parte.codTipo ?? "null",
      perTributario: ticket.perTributario,
      codProceso: ticket.codProceso,
      numTicket: ticket.numTicket,
      codLibro: COD_LIBRO[libro],
    });
    const r = await pedir({
      url,
      metodo: "GET",
      cabeceras: { authorization: `Bearer ${token.token}` },
      contexto: "api",
      timeoutMs: this.timeoutPaso(inicio, TIMEOUT_DESCARGA_MS),
      maxBytes: MAX_BYTES_ZIP,
      ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
    });
    return r.cuerpo;
  }

  // ── Apoyo ───────────────────────────────────────────────────────────────────────────────────────────────

  private async pedirJson(token: TokenSire, url: string, inicio: number, contexto: ContextoHttp = "api"): Promise<unknown> {
    const r = await pedir({
      url,
      metodo: "GET",
      cabeceras: { authorization: `Bearer ${token.token}`, accept: "application/json" },
      contexto,
      timeoutMs: this.timeoutPaso(inicio, TIMEOUT_API_MS),
      maxBytes: MAX_BYTES_JSON,
      ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
    });
    return parsearJson(r.cuerpo);
  }

  /** Lo que queda del presupuesto de 90 s de la operación (puede ser ≤ 0). */
  private restante(inicio: number): number {
    return PRESUPUESTO_OPERACION_MS - (this.ahora().getTime() - inicio);
  }

  /**
   * Timeout de una petición: `min(timeout del paso, restante)` (H-041-2-5). Sin presupuesto, `ErrorTransitorioSire("timeout")`
   * sin hacer la petición.
   */
  private timeoutPaso(inicio: number, timeoutMs: number): number {
    const restante = this.restante(inicio);
    if (restante <= 0) throw new ErrorTransitorioSire("timeout");
    return Math.min(timeoutMs, restante);
  }
}

/** `numTicket` de la respuesta de una exportación o solicitud; otra forma es un cambio del portal. */
function numTicketDe(cuerpo: unknown): string {
  const r = esquemaExportar.safeParse(cuerpo);
  if (!r.success) throw new ErrorPortalSire("respuesta_inesperada");
  return r.data.numTicket;
}

/** Identidad de un comprobante del registro: `tipo|serie|numero|tipoDocContraparte|rucContraparte` (sin tipo = «6», RUC). */
function claveComprobante(f: FilaPropuestaSire): string {
  return [f.tipo, f.serie, f.numero, f.tipoDocContraparte ?? "6", f.rucContraparte].join("|");
}

/**
 * Valida los nombres de TODAS las partes antes de descargar ninguna (CA-9). Una parte repetida en `archivoReporte`
 * (H-041-1-1) es `ErrorPortalSire("respuesta_inesperada")`, no se descarta: CA-9 manda descargar todas las partes y una
 * lista con duplicados es un cambio del portal que no debe pasar en silencio (descartarla podría ocultar una parte que
 * falta). Se compara sin distinguir mayúsculas (`P1.zip` = `p1.zip`); los espacios ya los rechaza la gramática.
 */
function validarNombresPartes(partes: readonly ParteTicket[]): void {
  const vistos = new Set<string>();
  for (const p of partes) {
    if (!GRAMATICA_NOMBRE_ARCHIVO.test(p.nombre) || p.nombre.includes("..")) throw new ErrorPortalSire("nombre_archivo");
    const clave = p.nombre.toLowerCase();
    if (vistos.has(clave)) throw new ErrorPortalSire("respuesta_inesperada");
    vistos.add(clave);
  }
}
