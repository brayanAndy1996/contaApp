import { useEffect, useRef } from "react";

// Devuelve el foco al elemento que lo tenía cuando el componente se montó (el botón que abrió un diálogo) al
// desmontarse (spec 012b, T23a, P-2; RF-096). Se llama ANTES de cualquier efecto que mueva el foco dentro del
// diálogo. Si el elemento ya no está en la página (p. ej. la fila excluida desapareció del previo) no hace nada.
export function useRestaurarFoco(): void {
  const origen = useRef<Element | null>(null);
  useEffect(() => {
    if (origen.current === null) origen.current = document.activeElement;
    return () => {
      const el = origen.current;
      if (el instanceof HTMLElement && el !== document.body && el.isConnected) el.focus();
    };
  }, []);
}
