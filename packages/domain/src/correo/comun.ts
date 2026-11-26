// Spec 028 · T8: piezas comunes de las plantillas de correo (validación estricta de la entrada y plantilla HTML fija). Interno al módulo:
// no se exporta del índice. Lógica pura, sin IO ni reloj.
import { ErrorCorreo } from "./errores";
import { escaparHtml, lineaUsuario } from "./texto";

export type TipoAvisoCorreo = "buzon_critico" | "credencial_invalida" | "plan_limite";

/** Asunto, texto plano y HTML de un correo ya armado. */
export interface CorreoArmado {
  readonly asunto: string;
  readonly texto: string;
  readonly html: string;
}

/** Enlaces del correo: la pantalla a abrir y la baja de este tipo de aviso (ambos http o https). */
export interface EnlacesCorreo {
  readonly pantalla: string;
  readonly baja: string;
}

/** Tipos de aviso por orden canónico (el de las secciones de diferidos). */
export const TIPOS_AVISO: readonly TipoAvisoCorreo[] = ["buzon_critico", "credencial_invalida", "plan_limite"];

export const ETIQUETA_TIPO: Readonly<Record<TipoAvisoCorreo, string>> = {
  buzon_critico: "Coactivas y avisos críticos del buzón",
  credencial_invalida: "Clave SOL inválida",
  plan_limite: "Límite del plan",
};

/** Máximo de puntos de código de un nombre dentro del asunto (razón social, estudio, recurso). */
export const MAX_ASUNTO = 60;
/** Máximo de puntos de código de un nombre dentro del cuerpo. */
export const MAX_CUERPO = 120;

type Obj = Readonly<Record<string, unknown>>;

export function objeto(v: unknown, campo: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ErrorCorreo(campo);
  return v as Obj;
}

/** El objeto solo puede traer las claves permitidas (nada de RUC, asunto ni contenido de mensajes: R-6). */
export function soloClaves(o: Obj, permitidas: readonly string[], campo: string): void {
  for (const k of Object.keys(o)) if (!permitidas.includes(k)) throw new ErrorCorreo(campo);
}

export function lista(v: unknown, campo: string): readonly unknown[] {
  if (!Array.isArray(v)) throw new ErrorCorreo(campo);
  return v as readonly unknown[];
}

export function texto(v: unknown, campo: string): string {
  if (typeof v !== "string") throw new ErrorCorreo(campo);
  return v;
}

export function textoONulo(v: unknown, campo: string): string | null {
  return v === null ? null : texto(v, campo);
}

/** Entero con `min` como mínimo. */
export function entero(v: unknown, min: number, campo: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new ErrorCorreo(campo);
  return v;
}

export function tipoAviso(v: unknown, campo: string): TipoAvisoCorreo {
  if (typeof v !== "string" || !(TIPOS_AVISO as readonly string[]).includes(v)) throw new ErrorCorreo(campo);
  return v as TipoAvisoCorreo;
}

/** Enlace http(s) sin espacios ni controles. Las comillas, `&` y `<` se aceptan: se escapan en el atributo. */
function enlace(v: unknown, campo: string): string {
  if (typeof v !== "string" || !/^https?:\/\/[^\s\p{Cc}\p{Cf}]+$/iu.test(v)) throw new ErrorCorreo(campo);
  return v;
}

export function enlaces(v: unknown): EnlacesCorreo {
  const o = objeto(v, "enlaces");
  soloClaves(o, ["pantalla", "baja"], "enlaces");
  return { pantalla: enlace(o["pantalla"], "enlaces"), baja: enlace(o["baja"], "enlaces") };
}

/** Nombre del estudio para el pie y el asunto: una línea, sin controles ni nada enlazable (`lineaUsuario`); «Tu estudio» si queda vacío. */
export function nombreEstudio(v: unknown, max: number): string {
  return lineaUsuario(texto(v, "estudio"), max) || "Tu estudio";
}

export function plural(n: number, singular: string, pluralForma: string): string {
  return `${n} ${n === 1 ? singular : pluralForma}`;
}

/** «AAAA-MM-DD» (calendario válido) → «dd/mm/aaaa». */
export function diaLegible(dia: unknown): string {
  const m = typeof dia === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia) : null;
  if (m === null) throw new ErrorCorreo("dia");
  const [, a, mes, d] = m as unknown as [string, string, string, string];
  const f = new Date(Date.UTC(Number(a), Number(mes) - 1, Number(d)));
  if (f.getUTCFullYear() !== Number(a) || f.getUTCMonth() !== Number(mes) - 1 || f.getUTCDate() !== Number(d)) throw new ErrorCorreo("dia");
  return `${d}/${mes}/${a}`;
}

/** «AAAAMM» (mes 01–12) → «AAAA-MM». */
export function periodoLegible(periodo: unknown): string {
  const m = typeof periodo === "string" ? /^(\d{4})(0[1-9]|1[0-2])$/.exec(periodo) : null;
  if (m === null) throw new ErrorCorreo("periodo");
  return `${m[1] ?? ""}-${m[2] ?? ""}`;
}

export interface DiferidoCorreo {
  readonly tipo: TipoAvisoCorreo;
  readonly cantidad: number;
}

/** Diferidos {tipo, cantidad ≥ min} sin tipos repetidos, en orden canónico. */
export function diferidos(v: unknown, minCantidad: number): readonly DiferidoCorreo[] {
  const vistos = new Map<TipoAvisoCorreo, number>();
  for (const e of lista(v, "diferidos")) {
    const o = objeto(e, "diferidos");
    soloClaves(o, ["tipo", "cantidad"], "diferidos");
    const tipo = tipoAviso(o["tipo"], "diferidos");
    if (vistos.has(tipo)) throw new ErrorCorreo("diferidos");
    vistos.set(tipo, entero(o["cantidad"], minCantidad, "diferidos"));
  }
  return TIPOS_AVISO.flatMap((tipo) => (vistos.has(tipo) ? [{ tipo, cantidad: vistos.get(tipo) ?? 0 }] : []));
}

/** Línea «<etiqueta>: <cantidad>» de un diferido. */
export function lineaDiferido(d: DiferidoCorreo): string {
  return `${ETIQUETA_TIPO[d.tipo]}: ${d.cantidad}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Plantilla HTML fija: tablas con estilos en línea, sin imágenes, scripts, hojas de estilo ni URL fuera de los dos enlaces recibidos.

const FUENTE = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#1f2937;";

/** Fila de la tabla con `htmlInterno` (ya escapado) dentro de la celda. */
export function filaHtml(htmlInterno: string, estilo = ""): string {
  return `<tr><td style="padding:4px 24px;${estilo}">${htmlInterno}</td></tr>`;
}

/** Texto (sin escapar) → HTML de una fila de párrafo. */
export function parrafoHtml(t: string): string {
  return filaHtml(escaparHtml(t));
}

export interface PartesHtml {
  readonly titulo: string;
  /** Filas ya armadas con `filaHtml`; todo valor de usuario va escapado. */
  readonly filas: readonly string[];
  readonly enlaces: EnlacesCorreo;
  readonly etiquetaPantalla: string;
  readonly etiquetaBaja: string;
  readonly estudio: string;
}

function enlaceHtml(url: string, etiqueta: string): string {
  return `<a href="${escaparHtml(url)}" style="color:#1d4ed8;">${escaparHtml(etiqueta)}</a>`;
}

export function envolverHtml(p: PartesHtml): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="es"><head><meta charset="utf-8"></head>',
    '<body style="margin:0;padding:0;background-color:#f4f5f7;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:16px;">',
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;${FUENTE}">`,
    `<tr><td style="padding:20px 24px 8px 24px;font-size:18px;line-height:24px;font-weight:bold;">${escaparHtml(p.titulo)}</td></tr>`,
    ...p.filas,
    filaHtml(enlaceHtml(p.enlaces.pantalla, p.etiquetaPantalla), "padding-top:16px;padding-bottom:16px;"),
    `<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;line-height:18px;color:#6b7280;">${escaparHtml(p.estudio)} · ContApp<br>${enlaceHtml(p.enlaces.baja, p.etiquetaBaja)}</td></tr>`,
    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

/** Cierre común del texto plano: los dos enlaces y el pie «<estudio> · ContApp». */
export function pieTexto(e: EnlacesCorreo, etiquetaPantalla: string, etiquetaBaja: string, estudio: string): string[] {
  return ["", `${etiquetaPantalla}: ${e.pantalla}`, `${etiquetaBaja}: ${e.baja}`, "", `${estudio} · ContApp`];
}
