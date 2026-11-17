// Adaptador en memoria de `SolPortal` (spec 023, D-1, D-2; `SOL_PORTAL=mock`).
//
// Origen del buzón de un RUC, en este orden: `inyectar` -> `{dirFixtures}/{ruc}.json` -> buzón GENERADO. El generado es
// determinista por RUC (hash FNV-1a del RUC; sin reloj ni azar) y trae las cuatro categorías críticas, comunes, texto y
// HTML y adjuntos PDF, XML y uno hostil.
//
// Orden de cada llamada: latencia -> cuenta -> `fallar` -> gramática del RUC -> centinela `clave-errada` -> caso inyectado
// con error -> datos. Todo rechazo propio es un error de `errores.ts` con mensaje fijo: nunca lleva usuario, clave, RUC
// ni ruta. El mock no conserva la credencial (solo el RUC en `leidosMarcados()`, para las pruebas).
import { realpath, open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ErrorCredencial, ErrorDatos, ErrorTransitorio } from "../errores.js";
import type {
  AdjuntoSol,
  CredencialSol,
  MensajeSol,
  MetadatosMensajeSol,
  PaginaMensajesSol,
  SolPortal,
} from "../puertos.js";

/** Adjunto de un fixture o de `inyectar`: `base64` (bytes reales) o `tamano` (bytes sintéticos, sin materializarlos). */
export interface AdjuntoFixtureSol {
  idSunat: string;
  nombre: string;
  base64?: string;
  tamano?: number;
}

export interface MensajeFixtureSol
  extends Omit<MetadatosMensajeSol, "adjuntos"> {
  contenido: { formato: "texto" | "html"; cuerpo: string };
  adjuntos: AdjuntoFixtureSol[];
}

export interface FixtureBuzonSol {
  mensajes: MensajeFixtureSol[];
}

export type CasoSolInyectado = FixtureBuzonSol | { error: Error };
export type ModoFallaSolPortal = "credencial" | "transitorio" | null;

export interface OpcionesMockSolPortal {
  /** Carpeta de `{ruc}.json`. Por defecto `fixtures/sol/buzon` del repo, resuelta desde este archivo. */
  dirFixtures?: string;
  /** Latencia simulada por llamada, en ms (`SOL_MOCK_LATENCIA_MS`; 0 por defecto). */
  latenciaMs?: number;
  /** Tamaño del buzón generado (mínimo 8, por defecto 12). */
  mensajesGenerados?: number;
}

/** Tope de un fixture en disco (1 MiB), como los de XML. */
const TOPE_BYTES_FIXTURE = 1_048_576;
const MAX_MENSAJES = 5000;
const MIN_GENERADOS = 8;
const GENERADOS_POR_DEFECTO = 12;
const RE_RUC = /^[0-9]{11}$/;
const RE_CURSOR = /^s1_([0-9a-z]{1,8})$/;
const RE_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CLAVE_ERRADA = "clave-errada";

/** Carpeta de fixtures del buzón por defecto, resuelta desde este archivo (igual en `src` y `dist`), no desde el `cwd`. */
function dirFixturesBuzonPorDefecto(): string {
  return resolve(__dirname, "../../../../fixtures/sol/buzon");
}

/** FNV-1a de 32 bits sobre el texto. */
function fnv1a(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const comparar = (a: MensajeFixtureSol, b: MensajeFixtureSol): number => {
  const d = Date.parse(b.fecha) - Date.parse(a.fecha);
  if (d !== 0) return d;
  return a.idSunat < b.idSunat ? 1 : a.idSunat > b.idSunat ? -1 : 0;
};

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function tamanoBase64(b64: string): number {
  const relleno = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - relleno;
}

/** Valida la forma de un buzón (fixture en disco o `inyectar`). Todo defecto es `ErrorDatos` de mensaje fijo. */
function validarBuzon(x: unknown): MensajeFixtureSol[] {
  if (!esObjeto(x) || !Array.isArray(x.mensajes) || x.mensajes.length > MAX_MENSAJES)
    throw new ErrorDatos();
  const ids = new Set<string>();
  for (const m of x.mensajes as unknown[]) {
    if (!esObjeto(m)) throw new ErrorDatos();
    const c = m.contenido;
    if (
      typeof m.idSunat !== "string" ||
      m.idSunat.length < 1 ||
      m.idSunat.length > 64 ||
      ids.has(m.idSunat) ||
      typeof m.asunto !== "string" ||
      typeof m.remitente !== "string" ||
      typeof m.fecha !== "string" ||
      Number.isNaN(Date.parse(m.fecha)) ||
      !(m.codigoTipo === null || typeof m.codigoTipo === "string") ||
      typeof m.leidoEnSunat !== "boolean" ||
      !esObjeto(c) ||
      (c.formato !== "texto" && c.formato !== "html") ||
      typeof c.cuerpo !== "string" ||
      !Array.isArray(m.adjuntos)
    )
      throw new ErrorDatos();
    ids.add(m.idSunat);
    const idsAdj = new Set<string>();
    for (const a of m.adjuntos as unknown[]) {
      if (
        !esObjeto(a) ||
        typeof a.idSunat !== "string" ||
        a.idSunat.length < 1 ||
        idsAdj.has(a.idSunat) ||
        typeof a.nombre !== "string"
      )
        throw new ErrorDatos();
      idsAdj.add(a.idSunat);
      const conBase64 = typeof a.base64 === "string";
      const conTamano = typeof a.tamano === "number";
      if (conBase64 === conTamano) throw new ErrorDatos();
      if (conBase64 && !RE_BASE64.test(a.base64 as string)) throw new ErrorDatos();
      if (conTamano && !(Number.isSafeInteger(a.tamano) && (a.tamano as number) >= 0))
        throw new ErrorDatos();
    }
  }
  return [...(x.mensajes as MensajeFixtureSol[])].sort(comparar);
}

/**
 * Lee `{dir}/{ruc}.json` (el RUC ya cumple la gramática). `null` si no existe. La ruta real debe quedar dentro de `dir`
 * y el archivo ser regular y de hasta 1 MiB; cualquier otro problema es `ErrorDatos` sin ruta ni RUC.
 */
async function leerFixtureBuzon(dir: string, ruc: string): Promise<unknown | null> {
  let base: string;
  try {
    base = await realpath(dir);
  } catch (e) {
    const c = codigoFs(e);
    if (c === "ENOENT" || c === "ENOTDIR") return null;
    throw new ErrorDatos();
  }
  let real: string;
  try {
    real = await realpath(join(base, `${ruc}.json`));
  } catch (e) {
    if (codigoFs(e) === "ENOENT") return null;
    throw new ErrorDatos();
  }
  if (!real.startsWith(base + sep)) throw new ErrorDatos();
  let archivo;
  try {
    archivo = await open(real, "r");
  } catch {
    throw new ErrorDatos();
  }
  try {
    const st = await archivo.stat();
    if (!st.isFile() || st.size > TOPE_BYTES_FIXTURE) throw new ErrorDatos();
    return JSON.parse(await archivo.readFile("utf8")) as unknown;
  } catch {
    throw new ErrorDatos();
  } finally {
    await archivo.close();
  }
}

function codigoFs(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

// ---- Buzón generado -------------------------------------------------------------------------------------------------

const b64 = (texto: string | Uint8Array): string => Buffer.from(texto).toString("base64");

const PDF_SINTETICO = (n: number): string =>
  b64(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n% sintético ${n}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const XML_SINTETICO = (n: number): string =>
  b64(`<?xml version="1.0" encoding="UTF-8"?>\n<anexo><nota>sintético ${n}</nota></anexo>\n`);
const EXE_HOSTIL = b64(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]));

/** Fecha ISO con zona de Lima (UTC−5) a partir de un instante fijo. */
function isoLima(msUtc: number): string {
  return `${new Date(msUtc - 5 * 3_600_000).toISOString().slice(0, 19)}-05:00`;
}

const BASE_FECHA_MS = Date.UTC(2026, 9, 31, 14, 0, 0); // 2026-10-31 09:00 en Lima: fija, sin reloj

type Plantilla = {
  asunto: (n: string) => string;
  html: boolean;
  adjuntos: (n: number, id: string) => AdjuntoFixtureSol[];
};

const sinAdjuntos = (): AdjuntoFixtureSol[] => [];
const PLANTILLAS: readonly Plantilla[] = [
  // 0 coactiva
  {
    asunto: (n) => `Resolución de Ejecución Coactiva N.° ${n}-2026/SUNAT`,
    html: false,
    adjuntos: (n, id) => [{ idSunat: `${id}-1`, nombre: `resolucion-${n}.pdf`, base64: PDF_SINTETICO(n) }],
  },
  // 1 común
  { asunto: () => "Boletín informativo: calendario de obligaciones mensuales", html: true, adjuntos: sinAdjuntos },
  // 2 determinación
  {
    asunto: (n) => `NOTIFICACIÓN DE RESOLUCIÓN DE DETERMINACIÓN N° 012-003-${n}`,
    html: true,
    adjuntos: (n, id) => [
      { idSunat: `${id}-1`, nombre: `determinacion-${n}.pdf`, base64: PDF_SINTETICO(n) },
      { idSunat: `${id}-2`, nombre: `anexo-${n}.xml`, base64: XML_SINTETICO(n) },
    ],
  },
  // 3 común
  { asunto: (n) => `Constancia de presentación de declaración ${n}`, html: false, adjuntos: sinAdjuntos },
  // 4 multa
  {
    asunto: (n) => `Res. de Multa N.° 152-002-${n}`,
    html: false,
    adjuntos: (n, id) => [{ idSunat: `${id}-1`, nombre: `multa-${n}.pdf`, base64: PDF_SINTETICO(n) }],
  },
  // 5 común
  { asunto: () => "Aviso: actualice sus datos de contacto", html: true, adjuntos: sinAdjuntos },
  // 6 requerimiento
  {
    asunto: (n) => `Requerimiento de información N.° ${n}`,
    html: false,
    adjuntos: (n, id) => [{ idSunat: `${id}-1`, nombre: `requerimiento-${n}.pdf`, base64: PDF_SINTETICO(n) }],
  },
  // 7 común
  { asunto: () => "Recordatorio de vencimiento de obligaciones del periodo", html: false, adjuntos: sinAdjuntos },
  // 8 común
  { asunto: () => "Encuesta de satisfacción del servicio SOL", html: true, adjuntos: sinAdjuntos },
  // 9 coactiva (mayúsculas) con adjunto hostil
  {
    asunto: (n) => `EMBARGO EN FORMA DE RETENCIÓN - EJECUCIÓN COACTIVA ${n}`,
    html: true,
    adjuntos: (n, id) => [
      { idSunat: `${id}-1`, nombre: "..\\..\\Windows\\sistema‮gpj.exe", base64: EXE_HOSTIL },
      { idSunat: `${id}-2`, nombre: `../../etc/embargo-${n}.pdf`, base64: PDF_SINTETICO(n) },
    ],
  },
  // 10 común
  { asunto: () => "Cambio de horario de atención en los centros de servicio", html: false, adjuntos: sinAdjuntos },
  // 11 común
  { asunto: () => "Novedades de comprobantes de pago electrónicos", html: true, adjuntos: sinAdjuntos },
];

function generarBuzon(ruc: string, cantidad: number): MensajeFixtureSol[] {
  const h = fnv1a(ruc);
  const prefijo = h.toString(16).padStart(8, "0");
  const salida: MensajeFixtureSol[] = [];
  for (let i = 0; i < cantidad; i++) {
    const p = PLANTILLAS[i % PLANTILLAS.length]!;
    const idSunat = `M${prefijo}-${String(i).padStart(5, "0")}`;
    const numero = String(((h >>> 3) + i * 7919) % 9_000_000 + 1_000_000).slice(0, 7);
    // Cada mensaje más antiguo que el anterior; el desfase por RUC solo mueve minutos.
    const ms = BASE_FECHA_MS - (i * 7 * 60 + (h % 50)) * 60_000;
    const asunto = p.asunto(numero);
    salida.push({
      idSunat,
      asunto,
      remitente: "SUNAT - BUZÓN ELECTRÓNICO (PRUEBA)",
      fecha: isoLima(ms),
      codigoTipo: null,
      leidoEnSunat: i % 3 === 2,
      contenido: p.html
        ? {
            formato: "html",
            cuerpo: `<p>Estimado contribuyente:</p><p>${asunto}</p><p>Mensaje sintético de prueba.</p>`,
          }
        : { formato: "texto", cuerpo: `Estimado contribuyente:\n${asunto}\nMensaje sintético de prueba.` },
      adjuntos: p.adjuntos(Number(numero), idSunat),
    });
  }
  return salida.sort(comparar);
}

// ---- Mock -----------------------------------------------------------------------------------------------------------

function pausa(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bytes sintéticos deterministas de `n` bytes. Solo se llama con `n` ya dentro de los topes. */
function bytesSinteticos(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

export class MockSolPortal implements SolPortal {
  private readonly dirFixtures: string;
  private readonly latenciaMs: number;
  private readonly generados: number;
  private readonly inyectados = new Map<string, CasoSolInyectado>();
  private readonly leidos = new Map<string, Set<string>>();
  private readonly marcados: { ruc: string; idSunat: string }[] = [];
  private modo: ModoFallaSolPortal = null;
  private veces: number | null = null;
  private despuesDe = 0;
  private desdeArmado = 0;
  private totalListar = 0;
  private totalObtener = 0;
  private readonly obtenerPorId = new Map<string, number>();

  constructor(opciones: OpcionesMockSolPortal = {}) {
    this.dirFixtures = opciones.dirFixtures ?? dirFixturesBuzonPorDefecto();
    const latencia = opciones.latenciaMs ?? 0;
    this.latenciaMs = Number.isFinite(latencia) && latencia > 0 ? Math.floor(latencia) : 0;
    const n = opciones.mensajesGenerados;
    this.generados =
      n === undefined || !Number.isFinite(n)
        ? GENERADOS_POR_DEFECTO
        : Math.min(MAX_MENSAJES, Math.max(MIN_GENERADOS, Math.floor(n)));
  }

  /** Sustituye el buzón de un RUC, o hace fallar con ese error toda llamada de ese RUC. */
  inyectar(ruc: string, caso: CasoSolInyectado): void {
    if (typeof ruc !== "string" || !RE_RUC.test(ruc)) throw new ErrorDatos();
    if (!("error" in caso)) validarBuzon(caso);
    this.inyectados.set(ruc, caso);
    this.leidos.delete(ruc);
  }

  /**
   * Fuerza el fallo de las llamadas (a `listarMensajes` y a `obtenerMensaje`) desde que se arma: las primeras
   * `despuesDe` pasan y las siguientes `veces` fallan (sin `veces`, hasta `fallar(null)`). Volver a armarlo reinicia la cuenta.
   */
  fallar(
    modo: ModoFallaSolPortal,
    opciones: { veces?: number; despuesDe?: number } = {},
  ): void {
    this.modo = modo;
    this.veces = modo === null ? null : (opciones.veces ?? null);
    this.despuesDe = modo === null ? 0 : (opciones.despuesDe ?? 0);
    this.desdeArmado = 0;
  }

  /** Mensajes que `obtenerMensaje` marcó como leídos, una vez cada uno. Copia. */
  leidosMarcados(): readonly { ruc: string; idSunat: string }[] {
    return this.marcados.map((m) => ({ ...m }));
  }

  llamadasObtener(): number {
    return this.totalObtener;
  }

  llamadasObtenerDe(idSunat: string): number {
    return this.obtenerPorId.get(idSunat) ?? 0;
  }

  llamadasListar(): number {
    return this.totalListar;
  }

  async listarMensajes(
    credencial: CredencialSol,
    opciones: { cursor: string | null; limite: number },
  ): Promise<PaginaMensajesSol> {
    const ruc = credencial.ruc;
    const clave = credencial.claveSol;
    const { cursor, limite } = opciones;
    this.totalListar += 1;
    await this.entrar(ruc, clave);

    if (typeof limite !== "number" || !Number.isInteger(limite) || limite < 1)
      throw new ErrorDatos();
    let desde = 0;
    if (cursor !== null) {
      const m = typeof cursor === "string" ? RE_CURSOR.exec(cursor) : null;
      desde = m === null ? 0 : parseInt(m[1]!, 36);
      if (m === null || desde < 1) throw new ErrorDatos();
    }

    const buzon = await this.buzon(ruc);
    if (desde >= buzon.length && cursor !== null) throw new ErrorDatos();
    const leidos = this.leidos.get(ruc);
    const pagina = buzon.slice(desde, desde + limite).map(
      (m): MetadatosMensajeSol => ({
        idSunat: m.idSunat,
        asunto: m.asunto,
        remitente: m.remitente,
        fecha: m.fecha,
        codigoTipo: m.codigoTipo,
        leidoEnSunat: m.leidoEnSunat || (leidos?.has(m.idSunat) ?? false),
        adjuntos: m.adjuntos.map((a) => ({ idSunat: a.idSunat, nombre: a.nombre })),
      }),
    );
    const fin = desde + pagina.length;
    return { mensajes: pagina, siguiente: fin < buzon.length ? `s1_${fin.toString(36)}` : null };
  }

  async obtenerMensaje(
    credencial: CredencialSol,
    idSunat: string,
    opciones: { maxBytesAdjunto: number; maxBytesMensaje: number },
  ): Promise<MensajeSol> {
    const ruc = credencial.ruc;
    const clave = credencial.claveSol;
    const { maxBytesAdjunto, maxBytesMensaje } = opciones;
    this.totalObtener += 1;
    if (typeof idSunat === "string")
      this.obtenerPorId.set(idSunat, (this.obtenerPorId.get(idSunat) ?? 0) + 1);
    await this.entrar(ruc, clave);

    if (
      typeof idSunat !== "string" ||
      !(maxBytesAdjunto >= 0) ||
      !(maxBytesMensaje >= 0)
    )
      throw new ErrorDatos();
    const m = (await this.buzon(ruc)).find((x) => x.idSunat === idSunat);
    if (m === undefined) throw new ErrorDatos();

    const adjuntos: AdjuntoSol[] = [];
    let acumulado = 0;
    for (const a of m.adjuntos) {
      const tamano = a.base64 !== undefined ? tamanoBase64(a.base64) : (a.tamano as number);
      // El tope se decide por el tamaño declarado: un adjunto que lo pasa no se lee ni se materializa.
      if (tamano > maxBytesAdjunto || acumulado + tamano > maxBytesMensaje) {
        adjuntos.push({ idSunat: a.idSunat, nombre: a.nombre, omitido: "tamano" });
        continue;
      }
      acumulado += tamano;
      const bytes =
        a.base64 !== undefined
          ? new Uint8Array(Buffer.from(a.base64, "base64"))
          : bytesSinteticos(tamano);
      adjuntos.push({ idSunat: a.idSunat, nombre: a.nombre, bytes });
    }

    let leidos = this.leidos.get(ruc);
    if (leidos === undefined) {
      leidos = new Set();
      this.leidos.set(ruc, leidos);
    }
    if (!leidos.has(m.idSunat)) {
      leidos.add(m.idSunat);
      this.marcados.push({ ruc, idSunat: m.idSunat });
    }
    return {
      idSunat: m.idSunat,
      contenido: { formato: m.contenido.formato, cuerpo: m.contenido.cuerpo },
      adjuntos,
      marcaLeido: true,
    };
  }

  /** Latencia, `fallar`, gramática del RUC, centinela y caso inyectado con error. */
  private async entrar(ruc: string, claveSol: string): Promise<void> {
    if (this.latenciaMs > 0) await pausa(this.latenciaMs);
    this.desdeArmado += 1;
    if (this.modo !== null && this.desdeArmado > this.despuesDe) {
      const falladas = this.desdeArmado - this.despuesDe;
      if (this.veces === null || falladas <= this.veces) {
        throw this.modo === "credencial" ? new ErrorCredencial() : new ErrorTransitorio();
      }
    }
    if (typeof ruc !== "string" || !RE_RUC.test(ruc)) throw new ErrorDatos();
    if (claveSol === CLAVE_ERRADA) throw new ErrorCredencial();
    const caso = this.inyectados.get(ruc);
    if (caso !== undefined && "error" in caso) throw caso.error;
  }

  /** Buzón del RUC ordenado de lo reciente a lo antiguo. */
  private async buzon(ruc: string): Promise<readonly MensajeFixtureSol[]> {
    const caso = this.inyectados.get(ruc);
    if (caso !== undefined && !("error" in caso)) return validarBuzon(caso);
    const delDisco = await leerFixtureBuzon(this.dirFixtures, ruc);
    if (delDisco !== null) return validarBuzon(delDisco);
    return generarBuzon(ruc, this.generados);
  }
}
