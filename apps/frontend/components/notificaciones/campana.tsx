"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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
export function Campana() {
  const pathname = usePathname();
  const [noLeidas, setNoLeidas] = useState<number | null>(null);
  const [abierta, setAbierta] = useState(false);

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
    <div className="relative ml-auto">
      <button
        type="button"
        aria-label={
          conConteo ? M.campanaConConteo(formatoConteo(noLeidas)) : M.campana
        }
        aria-expanded={abierta}
        aria-haspopup="dialog"
        onClick={() => setAbierta((a) => !a)}
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
      {abierta && <PanelNotificaciones alCerrar={() => setAbierta(false)} />}
    </div>
  );
}
