import type { HallazgoVista } from "@contapp/shared";
import { MENSAJES_GASTOS as M } from "../../lib/gastos";
import { Badge } from "../ui";

// Chip «Posible gasto no deducible» (spec 027, D-1). Con el puntaje del hallazgo R-GP de 027; sin puntaje si el hallazgo es el
// de 011 que ya estaba guardado; nada si la compra no tiene R-GP. El puntaje lo calcula el servidor: aquí solo se muestra.

/** El puntaje del R-GP, `null` si es el de la forma vieja (sin puntaje), o `undefined` si no hay R-GP. */
export function puntajeGasto(hallazgos: readonly HallazgoVista[]): number | null | undefined {
  const h = hallazgos.find((x) => x.regla === "R-GP");
  if (!h) return undefined;
  const s = h.sugerencia;
  return s !== null && s.tipo === "excluir" && "puntaje" in s ? s.puntaje : null;
}

export function ChipGasto({ hallazgos }: { hallazgos: readonly HallazgoVista[] }) {
  const puntaje = puntajeGasto(hallazgos);
  if (puntaje === undefined) return null;
  return (
    <Badge tono="error" className="h-auto min-h-5 min-w-0 max-w-full whitespace-normal px-2 py-0.5">
      {puntaje === null ? M.chipSinPuntaje : M.chip(puntaje)}
    </Badge>
  );
}
