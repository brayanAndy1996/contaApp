"use client";

import { useEffect, useRef } from "react";
import { useRestaurarFoco } from "../../lib/restaurar-foco";
import { Button } from "../ui";
import { MENSAJES_VENTAS as M } from "../../lib/ventas";

// Confirmación de una acción que no se deshace sola (spec 013, D23): revertir una justificación o quitar una venta
// agregada a mano. Es un `alertdialog`: el foco entra en «Cancelar» (la opción segura), Escape cancela y mientras
// la acción está en curso los dos botones quedan deshabilitados. El texto lo arma la pantalla; aquí no hay lógica.

export function ConfirmarAccion({
  mensaje,
  ocupado,
  alConfirmar,
  alCancelar,
}: {
  mensaje: string;
  ocupado: boolean;
  alConfirmar: () => void;
  alCancelar: () => void;
}) {
  const cancelar = useRef<HTMLButtonElement>(null);

  useRestaurarFoco();
  useEffect(() => {
    cancelar.current?.focus();
  }, []);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-describedby="confirmar-accion-texto"
      aria-label={M.confirmar}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      className="flex w-full max-w-xl flex-col gap-4 rounded-tarjeta border border-aviso-borde bg-hoja p-5 text-tinta shadow-flotante"
    >
      <p id="confirmar-accion-texto" className="m-0 text-sm">
        {mensaje}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={ocupado} onClick={alConfirmar} className="max-lg:h-11">
          {M.confirmar}
        </Button>
        <Button
          ref={cancelar}
          type="button"
          variant="secundario"
          disabled={ocupado}
          onClick={alCancelar}
          className="max-lg:h-11"
        >
          {M.cancelar}
        </Button>
      </div>
    </div>
  );
}
