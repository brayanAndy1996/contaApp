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

/** Operación que nombra la clave del almacén (H-041-2-4): la propuesta y el registro presentado no comparten ticket. */
type OperacionTicket = "propuesta" | "registro";

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
      const ticket = await this.obtenerTicketListo(token, libro, periodo, clave, inicio);
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
   * Spec 025 / CA-13: la ruta de 5.51/5.40 depende de P-3 (aún sin resolver). Hasta entonces falla sin reintentos y sin
   * llamar a la red.
   */
  descargarRegistroPresentado(token: TokenSire, solicitud: SolicitudRegistroPresentado): Promise<RegistroPresentadoSire> {
    void token;
    void solicitud;
    return Promise.reject(new ErrorPortalSire("respuesta_inesperada"));
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
    libro: LibroSire,
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
    const numTicket = await this.exportar(token, libro, periodo, inicio);
    if (clave !== null) await this.almacen!.guardar(clave, numTicket, TTL_TICKET_MS);
    return this.esperarTicketListo(token, periodo, numTicket, inicio);
  }

  private async exportar(token: TokenSire, libro: LibroSire, periodo: string, inicio: number): Promise<string> {
    const url = armarUrl(this.origen, rutaExportar(libro, periodo), PARAMETROS_EXPORTAR[libro]);
    const r = esquemaExportar.safeParse(await this.pedirJson(token, url, inicio));
    if (!r.success) throw new ErrorPortalSire("respuesta_inesperada");
    return r.data.numTicket;
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
   * parte y 256 MiB acumulados en el periodo (CA-10): pasado el acumulado, `zip_invalido`.
   */
  private async leerPartes<F>(
    token: TokenSire,
    libro: LibroSire,
    ticket: TicketListo,
    inicio: number,
    mapear: (txt: TxtLeido) => F[],
  ): Promise<F[]> {
    const filas: F[] = [];
    let primero: readonly string[] | undefined;
    let acumulado = 0;
    for (const parte of ticket.partes) {
      const bytes = extraerTxtDeZip(
        await this.descargarParte(token, libro, ticket, parte, inicio),
        TOPE_ZIP_DESCOMPRIMIDO_TOTAL - acumulado,
      );
      acumulado += bytes.length;
      const txt = leerTxt(bytes);
      if (primero === undefined) primero = txt.encabezado;
      else if (!mismoEncabezado(primero, txt.encabezado)) throw new ErrorPortalSire("encabezado");
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

  private async pedirJson(token: TokenSire, url: string, inicio: number): Promise<unknown> {
    const r = await pedir({
      url,
      metodo: "GET",
      cabeceras: { authorization: `Bearer ${token.token}`, accept: "application/json" },
      contexto: "api",
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
