import { useSyncExternalStore } from "react";

// Ancho de la pantalla para lo que cambia de estructura y no solo de estilo (spec 024, D-10): a 390 px los filtros pasan
// a un `Dialog` y el detalle ocupa la pantalla. Es el mismo corte que el `md` de Tailwind (768 px). Sin `matchMedia`
// (servidor, pruebas sin simular) se asume escritorio.

const CONSULTA_MOVIL = "(max-width: 767px)";

function suscribir(alCambiar: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const lista = window.matchMedia(CONSULTA_MOVIL);
  lista.addEventListener("change", alCambiar);
  return () => lista.removeEventListener("change", alCambiar);
}

const leer = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(CONSULTA_MOVIL).matches
    : false;

/** `true` en pantallas angostas (celular). */
export function useEsMovil(): boolean {
  return useSyncExternalStore(suscribir, leer, () => false);
}
