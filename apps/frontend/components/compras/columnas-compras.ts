import {
  columnPinningFeature,
  columnSizingFeature,
  createColumnHelper,
  tableFeatures,
} from "@tanstack/react-table";
import type { ColumnaMontoCompra, FilaCompraVista } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { iguales, sumar } from "../../lib/montos-compras";

// Columnas de la grilla de compras (spec 015, D-5, P-5, P-8; RF-061). Solo describe: id, encabezado, ancho,
// región fija y grupo por casillero. El pintado de cada celda es de `grilla-compras.tsx`. Aquí no se
// convierte ni suma ningún monto salvo la separación «con IGV»/«sin IGV», que pasa por `montos-compras.ts`.

/** Funciones de TanStack Table 9 que usa la grilla: columnas fijas (inicio/fin) y anchos. */
export const FEATURES_COMPRAS = tableFeatures({
  columnPinningFeature,
  columnSizingFeature,
});

const ayudante = createColumnHelper<typeof FEATURES_COMPRAS, FilaCompraVista>();

/** Textos propios de la grilla (los demás salen de `MENSAJES_COMPRAS`). */
export const TEXTOS_GRILLA = {
  sinRazonSocial: "(sin razón social)",
  actualizada: "Actualizada",
  historial: M.historial,
  abrirHistorial: (comprobante: string) =>
    `${M.historial} de ${comprobante}`,
  grupoIdentidad: "Comprobante y proveedor",
  grupoDatos: "Datos",
  grupoFin: "Total y acciones",
  seccion: (titulo: string, n: number) => `${titulo} (${n})`,
  filaSeleccionada: "Seleccionada",
  alertaDe: (reglas: string) => `${M.conAlerta}: ${reglas}`,
} as const;

/** Encabezado visible corto y nombre completo (para lectores de pantalla y `title`). */
interface Encabezado {
  corto: string;
  completo: string;
}

const base = (completo: string): Encabezado => ({ corto: "Base", completo });
const igv = (completo: string): Encabezado => ({ corto: "IGV", completo });
const simple = (completo: string): Encabezado => ({ corto: completo, completo });

export const ENCABEZADOS: Readonly<Record<string, Encabezado>> = {
  seleccionar: simple(M.columnas.seleccionar),
  tipo: simple(M.columnas.tipo),
  comprobante: simple(M.columnas.comprobante),
  proveedor: simple(M.columnas.proveedor),
  fecha: simple(M.columnas.fecha),
  moneda: simple(M.columnas.moneda),
  destino: simple(M.columnas.destino),
  alertas: simple(M.conAlerta),
  biDg: base(M.casilleros.biDg),
  igvDg: igv(M.casilleros.igvDg),
  biDgng: base(M.casilleros.biDgng),
  igvDgng: igv(M.casilleros.igvDgng),
  biDng: base(M.casilleros.biDng),
  igvDng: igv(M.casilleros.igvDng),
  noGravado: simple(M.casilleros.noGravado),
  isc: simple(M.casilleros.isc),
  icbper: simple(M.casilleros.icbper),
  otrosTributos: simple("Otros"),
  total: simple(M.casilleros.total),
  lupa: simple(M.columnas.lupa),
  acciones: simple(M.columnas.acciones),
};

/** Las 10 columnas de monto en el orden de RF-061 (más el total, que va fijo a la derecha). */
export const COLUMNAS_MONTO_GRILLA = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
] as const satisfies readonly ColumnaMontoCompra[];

export const esMonto = (id: string): id is ColumnaMontoCompra | "total" =>
  id === "total" || (COLUMNAS_MONTO_GRILLA as readonly string[]).includes(id);

/** Grupo de encabezado de cada columna del centro (casilleros DG, DGNG, DNG, no gravado, ISC, ICBPER, otros). */
export const GRUPO_DE_COLUMNA: Readonly<Record<string, string>> = {
  fecha: TEXTOS_GRILLA.grupoDatos,
  moneda: TEXTOS_GRILLA.grupoDatos,
  destino: TEXTOS_GRILLA.grupoDatos,
  alertas: TEXTOS_GRILLA.grupoDatos,
  biDg: "DG",
  igvDg: "DG",
  biDgng: "DGNG",
  igvDgng: "DGNG",
  biDng: "DNG",
  igvDng: "DNG",
  noGravado: M.casilleros.noGravado,
  isc: M.casilleros.isc,
  icbper: M.casilleros.icbper,
  otrosTributos: "Otros tributos",
};

export const IDS_INICIO = ["seleccionar", "tipo", "comprobante", "proveedor"];
export const IDS_FIN = ["total", "lupa", "acciones"];

/** Texto de un monto de la fila por id de columna (siempre cadena del servidor). */
export function montoDeFila(fila: FilaCompraVista, id: ColumnaMontoCompra | "total"): string {
  return fila.montos[id];
}

export const COLUMNAS_COMPRAS = ayudante.columns([
  ayudante.display({ id: "seleccionar", header: M.columnas.seleccionar, size: 44 }),
  ayudante.accessor((f) => f.tipo, { id: "tipo", header: M.columnas.tipo, size: 56 }),
  ayudante.accessor((f) => `${f.serie}-${f.numero}`, {
    id: "comprobante",
    header: M.columnas.comprobante,
    size: 156,
  }),
  ayudante.accessor((f) => f.proveedor.razonSocial ?? "", {
    id: "proveedor",
    header: M.columnas.proveedor,
    size: 250,
  }),
  ayudante.accessor((f) => f.fecha, { id: "fecha", header: M.columnas.fecha, size: 100 }),
  ayudante.accessor((f) => f.moneda, { id: "moneda", header: M.columnas.moneda, size: 92 }),
  ayudante.display({ id: "destino", header: M.columnas.destino, size: 96 }),
  ayudante.display({ id: "alertas", header: M.conAlerta, size: 300 }),
  ...COLUMNAS_MONTO_GRILLA.map((id) =>
    ayudante.accessor((f) => montoDeFila(f, id), {
      id,
      header: M.casilleros[id],
      size: 112,
    }),
  ),
  ayudante.accessor((f) => f.montos.total, {
    id: "total",
    header: M.casilleros.total,
    size: 124,
  }),
  ayudante.display({ id: "lupa", header: M.columnas.lupa, size: 56 }),
  ayudante.display({ id: "acciones", header: M.columnas.acciones, size: 200 }),
]);

/** Estado inicial de las columnas fijas: identidad a la izquierda, total y acciones a la derecha (P-8). */
export const FIJAS_COMPRAS = { start: IDS_INICIO, end: IDS_FIN } as const;

// ---------------------------------------------------------------------------------------------
// Separación «con IGV» / «sin IGV» / «excluidas» (D-5)
// ---------------------------------------------------------------------------------------------

export type SeccionCompras = "con_igv" | "sin_igv" | "excluidas";

export const ORDEN_SECCIONES: readonly SeccionCompras[] = ["con_igv", "sin_igv", "excluidas"];

export const TITULO_SECCION: Readonly<Record<SeccionCompras, string>> = {
  con_igv: M.grupoConIgv,
  sin_igv: M.grupoSinIgv,
  excluidas: M.grupoExcluidas,
};

const CACHE_SECCION = new WeakMap<FilaCompraVista, SeccionCompras>();

/** Excluida; si no, «sin IGV» cuando la suma de los tres IGV es 0.00 (014 D-8); si no, «con IGV». */
export function seccionDe(fila: FilaCompraVista): SeccionCompras {
  const guardada = CACHE_SECCION.get(fila);
  if (guardada) return guardada;
  const seccion: SeccionCompras = fila.excluida
    ? "excluidas"
    : iguales(sumar([fila.montos.igvDg, fila.montos.igvDgng, fila.montos.igvDng]), "0.00")
      ? "sin_igv"
      : "con_igv";
  CACHE_SECCION.set(fila, seccion);
  return seccion;
}
