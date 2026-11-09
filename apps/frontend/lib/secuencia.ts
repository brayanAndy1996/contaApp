import { useRef } from "react";

/**
 * Cuenta las peticiones de un mismo dato para descartar las respuestas que llegan tarde (cambio de periodo o
 * de filtros). Copia del que 013 deja dentro de `ventas/page.tsx` (allí no se exporta y no se toca).
 * Uso: `const id = s.nueva(); … await …; if (!s.vigente(id)) return;`.
 */
export function useSecuencia() {
  const n = useRef(0);
  return {
    nueva: () => ++n.current,
    vigente: (id: number) => id === n.current,
    invalidar: () => {
      n.current += 1;
    },
  };
}
