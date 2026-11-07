"use client";

import { useEffect, useRef } from "react";
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
      className="flex max-w-xl flex-col gap-3 rounded border border-amber-300 bg-amber-50 p-4"
    >
      <p id="confirmar-accion-texto" className="text-sm">
        {mensaje}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={ocupado}
          onClick={alConfirmar}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {M.confirmar}
        </button>
        <button
          ref={cancelar}
          type="button"
          disabled={ocupado}
          onClick={alCancelar}
          className="rounded border px-4 py-2 text-sm"
        >
          {M.cancelar}
        </button>
      </div>
    </div>
  );
}
