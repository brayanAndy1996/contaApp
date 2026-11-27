/**
 * `HttpSireApiClient` (plan 041): exportar → ticket → descargar partes → leer → mapear. Solo GET al host del SIRE con
 * `Authorization: Bearer`; no reintenta por su cuenta (los reintentos son de 008) y no conserva el token. Sin logger:
 * errores con mensaje fijo y `detalle` literal (CA-11, CA-12).
 */
import { z } from "zod";
import {
  ErrorDatos,
  ErrorPortalSire,
  ErrorTransitorio,
  ErrorTransitorioSire,
  TokenRechazadoError,
} from "../errores.js";
import type {
  FilaPropuestaSire,
  FilaVentaSire,
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
  GRAMATICA_PERIODO,
  GRAMATICA_RUC,
  MAX_BYTES_JSON,
  MAX_BYTES_ZIP,
  PARAMETROS_EXPORTAR,
  PRESUPUESTO_OPERACION_MS,
  RUTA_ARCHIVO,
  RUTA_TICKET,
  TIMEOUT_API_MS,
  TIMEOUT_DESCARGA_MS,
  TTL_TICKET_MS,
  armarUrl,
  rutaExportar,
} from "./endpoints.js";
import { origenes, parsearJson, type OpcionesHttpSire } from "./sire-auth.http.js";
import { interpretarConsultaTicket, planEsperaTicket, type ParteTicket } from "./ticket.js";
import { pedir } from "./transporte.js";

/** Número de ticket que devuelve la exportación (va solo como parámetro de query). */
const GRAMATICA_TICKET = /^[A-Za-z0-9_-]{1,64}$/;
/** `nomArchivoReporte`: nombre plano, sin rutas, controles ni «..». */
const GRAMATICA_NOMBRE_ARCHIVO = /^[A-Za-z0-9._-]{1,200}$/;

const esquemaExportar = z.object({ numTicket: z.string().regex(GRAMATICA_TICKET) });

/** Lo que el TXT de una propuesta necesita para validarse contra la solicitud. */
export interface ContextoLectura {
  ruc: string;
  periodo: string;
}

/**
 * ZIP → TXT → filas (lo implementa 041 · T5 en `zip-seguro.ts` y `txt/*`). Recibe TODAS las partes en el orden del
 * ticket, valida todo antes de devolver (sin filas a medias) y lanza `ErrorPortalSire`/`ErrorDatosSire`.
 */
function leerPartesCompras(partes: readonly Uint8Array[], c: ContextoLectura): FilaPropuestaSire[] {
  void partes;
  void c;
  throw new Error("no implementado: lectura de ZIP/TXT de compras (041 · T5)");
}
function leerPartesVentas(partes: readonly Uint8Array[], c: ContextoLectura): FilaVentaSire[] {
  void partes;
  void c;
  throw new Error("no implementado: lectura de ZIP/TXT de ventas (041 · T5)");
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

  async descargarPropuesta(token: TokenSire, solicitud: SolicitudPropuesta): Promise<PropuestaSire> {
    const { ruc, periodo, libro } = solicitud;
    if (!GRAMATICA_RUC.test(ruc) || !GRAMATICA_PERIODO.test(periodo) || (libro !== "compras" && libro !== "ventas")) {
      throw new ErrorDatos();
    }
    const inicio = this.ahora().getTime();
    const ticket = await this.obtenerTicketListo(token, libro, periodo, solicitud.claveReanudacion, inicio);
    const partes: Uint8Array[] = [];
    for (const parte of ticket.partes) {
      this.verificarPresupuesto(inicio);
      partes.push(await this.descargarParte(token, libro, ticket, parte));
    }
    const contexto: ContextoLectura = { ruc, periodo };
    return libro === "compras"
      ? { libro, periodo, filas: leerPartesCompras(partes, contexto) }
      : { libro, periodo, filas: leerPartesVentas(partes, contexto) };
  }

  /**
   * Spec 025 / CA-13: la ruta de 5.51/5.40 depende de P-3 (aún sin resolver). Hasta entonces falla sin reintentos y sin
   * llamar a la red.
   */
  descargarRegistroPresentado(token: TokenSire, solicitud: SolicitudRegistroPresentado): Promise<RegistroPresentadoSire> {
    void token;
    void solicitud;
    return Promise.reject(new ErrorPortalSire("respuesta_inesperada"));
  }

  // ── Pasos ────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Exporta (o retoma el ticket guardado) y espera a que esté listo. Gestiona el almacén: guarda el ticket si no termina
   * en el presupuesto y lo borra cuando el ticket termina, bien o mal. Un error transitorio o un token rechazado
   * conservan lo guardado para el siguiente intento.
   */
  private async obtenerTicketListo(
    token: TokenSire,
    libro: LibroSire,
    periodo: string,
    claveReanudacion: string | undefined,
    inicio: number,
  ): Promise<TicketListo> {
    const clave =
      this.almacen !== undefined && claveReanudacion !== undefined && claveReanudacion !== ""
        ? `${claveReanudacion}:${libro}:${periodo}`
        : null;
    const guardado = clave === null ? null : await this.almacen!.leer(clave);
    const numTicket = guardado !== null && GRAMATICA_TICKET.test(guardado) ? guardado : await this.exportar(token, libro, periodo);

    try {
      const listo = await this.esperarTicket(token, periodo, numTicket, inicio);
      if (listo === null) {
        if (clave !== null) await this.almacen!.guardar(clave, numTicket, TTL_TICKET_MS);
        throw new ErrorTransitorioSire("ticket_pendiente");
      }
      if (listo === "presupuesto") {
        if (clave !== null) await this.almacen!.guardar(clave, numTicket, TTL_TICKET_MS);
        throw new ErrorTransitorioSire("timeout");
      }
      // Un ticket listo sin archivos no es una propuesta vacía (el TXT trae al menos el encabezado): el portal cambió.
      if (listo.partes.length === 0) throw new ErrorPortalSire("respuesta_inesperada");
      validarNombresPartes(listo.partes);
      if (clave !== null) await this.almacen!.borrar(clave);
      return listo;
    } catch (e) {
      const conservar = e instanceof ErrorTransitorio || e instanceof TokenRechazadoError;
      if (!conservar && clave !== null) await this.almacen!.borrar(clave);
      throw e;
    }
  }

  private async exportar(token: TokenSire, libro: LibroSire, periodo: string): Promise<string> {
    const cuerpo = await this.pedirJson(token, armarUrl(this.origen, rutaExportar(libro, periodo), PARAMETROS_EXPORTAR[libro]));
    const r = esquemaExportar.safeParse(cuerpo);
    if (!r.success) throw new ErrorPortalSire("respuesta_inesperada");
    return r.data.numTicket;
  }

  /** `null` si sigue pendiente al agotar el plan de espera; "presupuesto" si se agotó el presupuesto de la operación. */
  private async esperarTicket(
    token: TokenSire,
    periodo: string,
    numTicket: string,
    inicio: number,
  ): Promise<TicketListo | null | "presupuesto"> {
    const url = armarUrl(this.origen, RUTA_TICKET, {
      perIni: periodo,
      perFin: periodo,
      page: "1",
      perPage: "20",
      numTicket,
    });
    const esperas = planEsperaTicket();
    for (let i = 0; ; i++) {
      if (this.presupuestoAgotado(inicio)) return "presupuesto";
      const estado = interpretarConsultaTicket(await this.pedirJson(token, url), numTicket);
      if (estado.listo) {
        return { numTicket, codProceso: estado.codProceso, perTributario: estado.perTributario, partes: estado.partes };
      }
      const ms = esperas[i];
      if (ms === undefined) return null;
      await this.dormir(ms);
    }
  }

  private async descargarParte(token: TokenSire, libro: LibroSire, ticket: TicketListo, parte: ParteTicket): Promise<Uint8Array> {
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
      timeoutMs: TIMEOUT_DESCARGA_MS,
      maxBytes: MAX_BYTES_ZIP,
      ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
    });
    return r.cuerpo;
  }

  // ── Apoyo ───────────────────────────────────────────────────────────────────────────────────────────────

  private async pedirJson(token: TokenSire, url: string): Promise<unknown> {
    const r = await pedir({
      url,
      metodo: "GET",
      cabeceras: { authorization: `Bearer ${token.token}`, accept: "application/json" },
      contexto: "api",
      timeoutMs: TIMEOUT_API_MS,
      maxBytes: MAX_BYTES_JSON,
      ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
    });
    return parsearJson(r.cuerpo);
  }

  private presupuestoAgotado(inicio: number): boolean {
    return this.ahora().getTime() - inicio >= PRESUPUESTO_OPERACION_MS;
  }

  private verificarPresupuesto(inicio: number): void {
    if (this.presupuestoAgotado(inicio)) throw new ErrorTransitorioSire("timeout");
  }
}

/** Valida los nombres de TODAS las partes antes de descargar ninguna (CA-9). */
function validarNombresPartes(partes: readonly ParteTicket[]): void {
  for (const p of partes) {
    if (!GRAMATICA_NOMBRE_ARCHIVO.test(p.nombre) || p.nombre.includes("..")) throw new ErrorPortalSire("nombre_archivo");
  }
}
