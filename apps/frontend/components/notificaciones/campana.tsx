"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EVENTO_NOTIFICACIONES_CAMBIO,
  formatoConteo,
  MENSAJES_NOTIFICACIONES as M,
  obtenerNoLeidas,
  suscribirAvisos,
} from "../../lib/notificaciones";
import { PanelNotificaciones } from "./panel-notificaciones";

// Campana de la barra superior (spec 017, D-11; CA-16). Muestra el conteo de no leídas («99+» desde 100), que se
// vuelve a leer al cambiar de página, al recibir un aviso en vivo (stream único por pestaña), al reconectar y al
// marcar notificaciones. Si el conteo falla, la campana queda sin número y sin alerta: no estorba la navegación.
// Panel (T18a, P-5; RF-096): Esc y un clic fuera lo cierran; el foco entra al panel al abrirse y vuelve a la campana al
// cerrarse (salvo que el clic fuera haya caído en otro control, que conserva el foco).
export function Campana() {
  const pathname = usePathname();
  const [noLeidas, setNoLeidas] = useState<number | null>(null);
  const [abierta, setAbierta] = useState(false);
  const contenedor = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);

  const cerrar = useCallback((devolverFoco = true) => {
    setAbierta(false);
    if (devolverFoco) boton.current?.focus();
  }, []);

  useEffect(() => {
    if (!abierta) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") cerrar();
    };
    const alPulsar = (e: MouseEvent) => {
      const destino = e.target;
      if (!(destino instanceof Node)) return;
      if (contenedor.current?.contains(destino)) return;
      // Un clic en otro control (enlace, botón, campo) se queda con el foco; en un espacio vacío vuelve a la campana.
      const enControl =
        destino instanceof Element &&
        destino.closest("a, button, input, select, textarea, [tabindex]") !== null;
      cerrar(!enControl);
    };
    document.addEventListener("keydown", alTeclear);
    // Se escucha `click` (no `pointerdown`): el foco que el navegador mueve al pulsar ya se asentó y el nuestro no lo pisa.
    document.addEventListener("click", alPulsar, true);
    return () => {
      document.removeEventListener("keydown", alTeclear);
      document.removeEventListener("click", alPulsar, true);
    };
  }, [abierta, cerrar]);

  const refrescar = useCallback(async () => {
    setNoLeidas(await obtenerNoLeidas());
  }, []);

  // Al cambiar de página (y la primera vez).
  useEffect(() => {
    void refrescar();
  }, [pathname, refrescar]);

  useEffect(() => suscribirAvisos(() => void refrescar()), [refrescar]);

  useEffect(() => {
    const alCambiar = () => void refrescar();
    window.addEventListener(EVENTO_NOTIFICACIONES_CAMBIO, alCambiar);
    return () =>
      window.removeEventListener(EVENTO_NOTIFICACIONES_CAMBIO, alCambiar);
  }, [refrescar]);

  const conConteo = noLeidas !== null && noLeidas > 0;
  return (
    <div ref={contenedor} className="relative ml-auto">
      <button
        ref={boton}
        type="button"
        aria-label={
          conConteo ? M.campanaConConteo(formatoConteo(noLeidas)) : M.campana
        }
        aria-expanded={abierta}
        aria-haspopup="dialog"
        onClick={() => (abierta ? cerrar() : setAbierta(true))}
        className="relative rounded border px-2 py-1"
      >
        <span aria-hidden="true">🔔</span>
        {conConteo && (
          <span
            data-testid="conteo-notificaciones"
            className="ml-1 rounded bg-red-600 px-1 text-xs text-white"
          >
            {formatoConteo(noLeidas)}
          </span>
        )}
      </button>
      {abierta && <PanelNotificaciones alCerrar={() => cerrar()} />}
    </div>
  );
}
