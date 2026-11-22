// Un mes de la ventana de prorrata (spec 026, R-2, R-2b, R-5; CA-3): precedencia declarado (PDT 621
// vigente) > manual > SIRE (ventas de 013) > falta. Montos de entrada como cadenas decimales
// canónicas (nunca `number`); salida en Money (soles). Pura y sin mutar la entrada.
import { Money } from "../dinero/index";
import { columnaUsdEnSoles, tipoCambioUtil } from "../ventas/conversion";
import { ProrrataError } from "./errores";
import { asegurarPeriodo } from "./ventana";

/** Presentación del PDT 621 = `Declaracion621` de `sunat` sin el periodo (el de su MesFuente). */
export interface Presentacion {
  readonly numeroOrden: string;
  readonly fechaPresentacion: string;
  readonly tipo: "original" | "rectificatoria";
  readonly ventasGravadasBase: string;
  readonly ventasGravadasIgv: string;
  readonly exportaciones: string;
  readonly noGravadas: string;
  readonly igvAdquisicionesDg: string;
  readonly igvAdquisicionesDgng: string;
  readonly prorrataUsada: string | null;
}

/** Montos del mes ingresado a mano (versión vigente, no eliminada). */
export interface MontosMes {
  readonly gravadas: string;
  readonly exportaciones: string;
  readonly noGravadas: string;
}

export interface TotalesSirePen {
  readonly baseGravada: string;
  readonly exonerada: string;
  readonly inafecta: string;
}

/** Fila USD del SIRE: se convierte columna por columna como `resumirVentas` de 013. */
export interface FilaUsdSire extends TotalesSirePen {
  readonly tipoCambio: string | null;
}

/** Totales de ventas SIRE del periodo: sumas PEN (SQL) y filas USD individuales. */
export interface TotalesSire {
  readonly pen: TotalesSirePen;
  readonly usd: readonly FilaUsdSire[];
}

export interface MesFuente {
  readonly periodo: string;
  readonly declaraciones: readonly Presentacion[];
  readonly manual: MontosMes | null;
  /** `null` = periodo de ventas no cargado; cargado sin filas = ceros. */
  readonly sire: TotalesSire | null;
}

export type OrigenMes = "declarado" | "manual" | "sire" | "falta";
export type AvisoMes = "usd_sin_tipo_cambio" | "sire_sin_exportaciones" | "manual_reemplazado";

export interface MesProrrata {
  readonly periodo: string;
  readonly origen: OrigenMes;
  readonly gravadas: Money;
  readonly exportaciones: Money;
  readonly noGravadas: Money;
  /** gravadas + exportaciones + noGravadas (puede ser negativo por notas de crédito). */
  readonly total: Money;
  readonly avisos: readonly AvisoMes[];
}

const NUMERO_ORDEN = /^[0-9]{1,15}$/;

// Marca de los meses armados por resolverMes: calcularProrrata no acepta objetos armados a mano.
const MESES_RESUELTOS = new WeakSet<object>();

/** `true` si `m` salió de resolverMes (no se puede falsificar con un objeto de la misma forma). */
export function esMesResuelto(m: unknown): m is MesProrrata {
  return typeof m === "object" && m !== null && MESES_RESUELTOS.has(m);
}

function esObjeto(o: unknown): o is Record<string, unknown> {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

function objeto(o: unknown): Record<string, unknown> {
  if (!esObjeto(o)) throw new ProrrataError("ENTRADA_INVALIDA");
  return o;
}

/** Cadena canónica de Money en soles (lanza MontoInvalidoError o MontoFueraDeRangoError). */
function soles(valor: unknown): Money {
  return Money.desde(valor as string, "PEN");
}

/** Número de orden sin ceros a la izquierda, para compararlo como número (10 > 9). */
function ordenCanonico(valor: unknown): string {
  if (typeof valor !== "string" || !NUMERO_ORDEN.test(valor)) throw new ProrrataError("ENTRADA_INVALIDA");
  return valor.replace(/^0+(?=[0-9])/, "");
}

function compararOrden(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Presentación vigente: la de mayor número de orden (R-5), sin importar el tipo ni el orden de la lista. */
function vigente(declaraciones: readonly unknown[]): Record<string, unknown> {
  let mejor: Record<string, unknown> | null = null;
  let mejorOrden = "";
  for (const d of declaraciones) {
    const p = objeto(d);
    const orden = ordenCanonico(p.numeroOrden);
    // Se validan los montos de todas las presentaciones, no solo de la vigente.
    soles(p.ventasGravadasBase);
    soles(p.exportaciones);
    soles(p.noGravadas);
    if (mejor === null || compararOrden(orden, mejorOrden) > 0) {
      mejor = p;
      mejorOrden = orden;
    }
  }
  return mejor as Record<string, unknown>;
}

function mes(
  periodo: string,
  origen: OrigenMes,
  gravadas: Money,
  exportaciones: Money,
  noGravadas: Money,
  avisos: AvisoMes[],
): MesProrrata {
  const m: MesProrrata = Object.freeze({
    periodo,
    origen,
    gravadas,
    exportaciones,
    noGravadas,
    total: Money.suma([gravadas, exportaciones, noGravadas], "PEN"),
    avisos: Object.freeze([...avisos].sort()),
  });
  MESES_RESUELTOS.add(m);
  return m;
}

function desdeSire(periodo: string, sire: Record<string, unknown>): MesProrrata {
  const pen = objeto(sire.pen);
  if (!Array.isArray(sire.usd)) throw new ProrrataError("ENTRADA_INVALIDA");
  const gravadas: Money[] = [soles(pen.baseGravada)];
  const noGravadas: Money[] = [soles(pen.exonerada), soles(pen.inafecta)];
  const avisos: AvisoMes[] = ["sire_sin_exportaciones"];
  let sinTipoCambio = false;
  for (const f of sire.usd as readonly unknown[]) {
    const fila = objeto(f);
    // Montos validados aunque la fila no se convierta (ninguno entra como `number`).
    for (const c of [fila.baseGravada, fila.exonerada, fila.inafecta]) Money.desde(c as string, "USD");
    const tc = tipoCambioUtil(fila.tipoCambio);
    if (tc === null) {
      sinTipoCambio = true;
      continue;
    }
    gravadas.push(columnaUsdEnSoles(fila.baseGravada as string, tc));
    noGravadas.push(columnaUsdEnSoles(fila.exonerada as string, tc));
    noGravadas.push(columnaUsdEnSoles(fila.inafecta as string, tc));
  }
  if (sinTipoCambio) avisos.push("usd_sin_tipo_cambio");
  return mes(periodo, "sire", Money.suma(gravadas, "PEN"), Money.cero("PEN"), Money.suma(noGravadas, "PEN"), avisos);
}

/** Resuelve el origen y los montos de un mes de la ventana (R-5). */
export function resolverMes(fuente: MesFuente): MesProrrata {
  const f = objeto(fuente);
  const periodo = asegurarPeriodo(f.periodo);
  if (!Array.isArray(f.declaraciones)) throw new ProrrataError("ENTRADA_INVALIDA");
  const manual = f.manual === null ? null : objeto(f.manual);
  const sire = f.sire === null ? null : objeto(f.sire);
  const montosManual =
    manual === null ? null : ([soles(manual.gravadas), soles(manual.exportaciones), soles(manual.noGravadas)] as const);

  if (f.declaraciones.length > 0) {
    const p = vigente(f.declaraciones as readonly unknown[]);
    return mes(
      periodo,
      "declarado",
      soles(p.ventasGravadasBase),
      soles(p.exportaciones),
      soles(p.noGravadas),
      montosManual === null ? [] : ["manual_reemplazado"],
    );
  }
  if (montosManual !== null) return mes(periodo, "manual", ...montosManual, []);
  if (sire !== null) return desdeSire(periodo, sire);
  const cero = Money.cero("PEN");
  return mes(periodo, "falta", cero, cero, cero, []);
}
