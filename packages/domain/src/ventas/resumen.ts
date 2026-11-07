// Resumen de ventas por tipo de comprobante (spec 013, D11, RF-056, CA-9). Todo en soles, con Money.
// Una fila USD se convierte columna por columna con el método de 010 D7 (`redondearSunat(columna × tc)`)
// y su total es la suma de las siete columnas convertidas; una USD sin tipo de cambio no se suma: sale en
// `sinConvertir`. Las notas de crédito traen montos negativos y restan. Pura y sin mutar la entrada.
import { Money, TipoCambio, redondearSunat } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import type { Entero } from "../texto/entero";
import { COLUMNAS_VENTA, COMPONENTES_VENTA } from "./columnas";
import type { ColumnaVenta, MontosVenta } from "./columnas";

export interface FilaResumenVenta extends MontosVenta {
  readonly clave: string;
  readonly tipo: string;
  readonly moneda: Moneda;
  /** Cadena decimal; solo importa en USD. */
  readonly tipoCambio?: string | null;
}

export interface TotalesVenta extends MontosVenta {
  readonly cantidad: Entero;
}

export interface TotalesPorTipo extends TotalesVenta {
  readonly tipo: string;
}

export interface VentaSinConvertir {
  readonly clave: string;
  readonly moneda: Moneda;
}

export interface ResumenVentas {
  readonly porTipo: readonly TotalesPorTipo[];
  readonly total: TotalesVenta;
  readonly sinConvertir: readonly VentaSinConvertir[];
  readonly avisos: readonly "usd_sin_tipo_cambio"[];
}

type Soles = Readonly<Record<ColumnaVenta, Money>>;

interface Acumulado {
  cantidad: Entero;
  readonly filas: Soles[];
}

/** Tipo de cambio utilizable de una fila USD, o `null` si falta o no es válido. */
function tipoCambioDe(f: FilaResumenVenta): TipoCambio | null {
  const tc = f.tipoCambio;
  if (typeof tc !== "string" || tc === "") return null;
  try {
    return TipoCambio.desde(tc);
  } catch {
    // TipoCambio.desde solo lanza FactorInvalidoError: un tipo de cambio ilegible equivale a no tenerlo.
    return null;
  }
}

/** Una fila PEN suma tal como llegó (la descuadrada no se corrige). */
function enSolesPen(f: FilaResumenVenta): Soles {
  const m = {} as Record<ColumnaVenta, Money>;
  for (const c of COLUMNAS_VENTA) m[c] = Money.desde(f[c], "PEN");
  return m;
}

/** Cada componente × tc con redondearSunat; el total es la suma de los componentes convertidos. */
function enSolesUsd(f: FilaResumenVenta, tc: TipoCambio): Soles {
  const m = {} as Record<ColumnaVenta, Money>;
  for (const c of COMPONENTES_VENTA) {
    // redondearSunat conserva la moneda (USD): se reexpresa en PEN por su cadena canónica.
    m[c] = Money.desde(redondearSunat(Money.desde(f[c], "USD").por(tc)).toString(), "PEN");
  }
  m.total = Money.suma(
    COMPONENTES_VENTA.map((c) => m[c]),
    "PEN",
  );
  return m;
}

function sumar(filas: readonly Soles[]): MontosVenta {
  const s = {} as Record<ColumnaVenta, string>;
  for (const c of COLUMNAS_VENTA) {
    s[c] = Money.suma(
      filas.map((m) => m[c]),
      "PEN",
    ).toString();
  }
  return s;
}

function compararTexto(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Resume las filas del periodo por tipo (ordenado) y en total, todo en soles. */
export function resumirVentas(filas: readonly FilaResumenVenta[]): ResumenVentas {
  const porTipo = new Map<string, Acumulado>();
  const sinConvertir: VentaSinConvertir[] = [];
  for (const f of filas) {
    let soles: Soles;
    if (f.moneda === "USD") {
      const tc = tipoCambioDe(f);
      if (tc === null) {
        sinConvertir.push({ clave: f.clave, moneda: f.moneda });
        continue;
      }
      soles = enSolesUsd(f, tc);
    } else {
      soles = enSolesPen(f);
    }
    let acc = porTipo.get(f.tipo);
    if (acc === undefined) {
      acc = { cantidad: 0, filas: [] };
      porTipo.set(f.tipo, acc);
    }
    acc.cantidad++;
    acc.filas.push(soles);
  }
  const tipos = [...porTipo.keys()].sort(compararTexto);
  const resumen: TotalesPorTipo[] = tipos.map((tipo) => {
    const acc = porTipo.get(tipo) as Acumulado;
    return { tipo, cantidad: acc.cantidad, ...sumar(acc.filas) };
  });
  const todas = [...porTipo.values()].flatMap((a) => a.filas);
  const cantidad = resumen.reduce((n, t) => n + t.cantidad, 0);
  return {
    porTipo: resumen,
    total: { cantidad, ...sumar(todas) },
    sinConvertir,
    avisos: sinConvertir.length > 0 ? ["usd_sin_tipo_cambio"] : [],
  };
}
