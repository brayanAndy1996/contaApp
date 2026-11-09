import type { ContextoCompras, ErrorCompras } from "../../lib/compras";

// Ayudas comunes de las acciones de compras (spec 015, T7 a T9). Sin JSX ni montos: solo decide qué se recarga
// tras una respuesta del servidor y cómo se avisa. La pantalla (T10) entrega `alAvisar` a un `aria-live`.

/** Cómo avisa una acción a la pantalla: un texto y si fue bien o mal. */
export type AlAvisar = (texto: string, tipo: "ok" | "error") => void;

/** Códigos tras los cuales la fila quedó vieja en pantalla: se recarga para que el usuario revise y repita. */
const CODIGOS_FILA_VIEJA = new Set([
  "version_obsoleta",
  "revisar_de_nuevo",
  "fila_cambiada",
  "fila_excluida",
  "no_excluida",
  "no_descartable",
]);

/** Tras una escritura que salió bien: la fila viene del servidor y el resumen cambió (D-4, sin actualización optimista). */
export async function recargarTrasExito(
  contexto: ContextoCompras,
  compraId: string,
): Promise<void> {
  await Promise.all([
    contexto.recargarFila(compraId),
    contexto.recargarResumen(),
  ]);
}

/** Tras un error del servidor: recarga la fila solo si lo que se veía quedó viejo. */
export async function recargarTrasError(
  contexto: ContextoCompras,
  compraId: string,
  error: ErrorCompras,
): Promise<void> {
  if (CODIGOS_FILA_VIEJA.has(error.codigo)) {
    await contexto.recargarFila(compraId);
  }
}

/** Comprobante legible: «F001-3064». */
export const comprobanteDe = (f: { serie: string; numero: string }): string =>
  `${f.serie}-${f.numero}`;
