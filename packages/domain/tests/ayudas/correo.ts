// Spec 028 · T1: ayudas de las pruebas de dominio de correo (constructores de entradas y verificación del HTML).
// Las entradas se tipan con `Parameters<typeof …>[0]` para no fijar nombres de tipos que el plan no da.
import { expect } from "vitest";
import { armarCorreoAviso, armarCorreoPendientes, armarCorreoResumen, escaparHtml } from "../../src/index";

export type EntradaAviso = Parameters<typeof armarCorreoAviso>[0];
export type EntradaResumen = Parameters<typeof armarCorreoResumen>[0];
export type EntradaPendientes = Parameters<typeof armarCorreoPendientes>[0];

export const ENLACES = {
  pantalla: "https://app.contapp.test/ir?estudio=0b6f3c1e&pantalla=buzon_cliente&cliente=77ab01cd",
  baja: "https://app.contapp.test/baja?t=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
} as const;

export const FECHA = new Date("2026-11-24T12:05:00Z"); // 24/11/2026 07:05 en Lima

export function avisoBuzon(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { razonSocial: `Cliente-${n}-SAC`, categoria: "Coactiva", fecha: new Date(FECHA.getTime() + n * 60_000), ...extra };
}

export function entradaAviso(avisos: readonly unknown[], extra: Record<string, unknown> = {}): EntradaAviso {
  return {
    tipo: "buzon_critico",
    estudio: "Estudio Quispe",
    avisos,
    total: avisos.length,
    enlaces: { ...ENLACES },
    ...extra,
  } as unknown as EntradaAviso;
}

export function cliente(razonSocial: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { razonSocial, nuevos: 0, criticosNuevos: 0, pendientesAtender: 0, compras: null, ventas: null, ...extra };
}

export function entradaResumen(clientes: readonly unknown[], extra: Record<string, unknown> = {}): EntradaResumen {
  return {
    estudio: "Estudio Quispe",
    dia: "2026-11-24",
    clientes,
    clientesMas: 0,
    periodo: "202610",
    diferidos: [],
    enlaces: { ...ENLACES },
    ...extra,
  } as unknown as EntradaResumen;
}

export function entradaPendientes(diferidos: readonly unknown[], extra: Record<string, unknown> = {}): EntradaPendientes {
  return { estudio: "Estudio Quispe", diferidos, enlaces: { ...ENLACES }, ...extra } as unknown as EntradaPendientes;
}

/** Cuenta ocurrencias (sin solaparse) de `aguja` en `texto`. */
export function contar(texto: string, aguja: string | RegExp): number {
  if (typeof aguja === "string") return texto.split(aguja).length - 1;
  const g = aguja.global ? aguja : new RegExp(aguja.source, `${aguja.flags}g`);
  return [...texto.matchAll(g)].length;
}

/** Quita las etiquetas y deja el texto visible del HTML. */
export function textoVisible(html: string): string {
  return html.replace(/<head[\s\S]*?<\/head>/gi, " ").replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, " ").replace(/<[^>]*>/g, " ");
}

const ETIQUETAS_PROHIBIDAS = new Set([
  "img", "script", "style", "link", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "textarea",
  "select", "svg", "math", "base", "video", "audio", "source", "track", "picture", "canvas", "portal",
]);
const ATRIBUTOS_PROHIBIDOS = new Set(["src", "srcset", "background", "action", "formaction", "data", "poster", "xlink:href", "ping", "srcdoc"]);

/**
 * Verifica que el HTML no tenga etiquetas ni atributos peligrosos, que todo `href` sea uno de los enlaces dados (escapado) y que, fuera
 * de las etiquetas, no quede ningún `<` ni `>` (todo texto de usuario va escapado). Devuelve los problemas encontrados.
 */
export function problemasHtml(html: string, enlacesPermitidos: readonly string[]): string[] {
  const problemas: string[] = [];
  const permitidos = new Set(enlacesPermitidos.map((e) => escaparHtml(e)));
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w:-]*)([^>]*)>/g)) {
    const nombre = (m[1] ?? "").toLowerCase();
    const resto = m[2] ?? "";
    if (ETIQUETAS_PROHIBIDAS.has(nombre)) problemas.push(`etiqueta <${nombre}>`);
    if (nombre === "meta" && /http-equiv/i.test(resto)) problemas.push("meta http-equiv");
    // Valores entre comillas primero (href, style); después los nombres de atributo.
    for (const v of resto.matchAll(/\b([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const attr = (v[1] ?? "").toLowerCase();
      const valor = v[2] ?? v[3] ?? "";
      if (attr === "href" && !permitidos.has(valor)) problemas.push(`href fuera de los enlaces dados: ${valor}`);
      if (attr === "style" && /url\s*\(|@import|expression\s*\(|javascript:/i.test(valor)) problemas.push(`style con recurso externo: ${valor}`);
    }
    const sinValores = resto.replace(/"[^"]*"|'[^']*'/g, '""');
    for (const a of sinValores.matchAll(/(?:^|\s)([a-zA-Z:-]+)(?=\s*=|\s|\/|$)/g)) {
      const attr = (a[1] ?? "").toLowerCase();
      if (attr.startsWith("on")) problemas.push(`atributo ${attr}`);
      if (ATRIBUTOS_PROHIBIDOS.has(attr)) problemas.push(`atributo ${attr}`);
    }
  }
  if (/[<>]/.test(textoVisible(html).replace(/<!--[\s\S]*?-->/g, ""))) problemas.push("texto visible con < o > sin escapar");
  return problemas;
}

/** Aserción: el HTML es seguro (CA-7). */
export function esperarHtmlSeguro(html: string, enlaces: readonly string[] = [ENLACES.pantalla, ENLACES.baja]): void {
  expect(html).not.toMatch(/<\s*(?:img|script|style|iframe|object|embed|form|svg|link)\b/i);
  expect(problemasHtml(html, enlaces)).toEqual([]);
}

/**
 * Aserción: `f` lanza un error de la propia validación. Un «x is not a function» (export ausente) NO cuenta: en el rojo, las pruebas
 * de entradas inválidas deben fallar por la falta de implementación y no pasar por accidente.
 */
export function esperarLanza(f: () => unknown): void {
  let error: unknown;
  try {
    f();
  } catch (e) {
    error = e;
  }
  expect(error, "debía lanzar").toBeInstanceOf(Error);
  expect((error as Error).message).not.toMatch(/is not a function|is not defined|Cannot read prop/);
}
