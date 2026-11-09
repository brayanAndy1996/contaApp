"use client";

import type { FilaCompraVista, InformeMasiva } from "@contapp/shared";
import { useEffect, useRef } from "react";
import {
  MENSAJES_COMPRAS as M,
  mensajeDeRechazoMasivo,
} from "../../lib/compras";
import { comprobanteDe } from "./accion-compras";

// Informe de una acción masiva (spec 015, D-8, CA-7): «N aplicadas» y la lista de rechazadas con el comprobante y
// un motivo legible por código. Las masivas son parciales: lo rechazado no impide lo aplicado. Solo muestra; las
// `version_obsoleta` las recarga quien lanzó la masiva (`BarraMasiva`). El comprobante sale de las filas cargadas;
// si una fila ya no está, se muestra el id corto.

/** Comprobante de una compra por su id, o el id corto si la fila no está cargada. */
export function comprobanteDeId(
  filas: readonly FilaCompraVista[],
  id: string,
): string {
  const fila = filas.find((f) => f.id === id);
  return fila ? comprobanteDe(fila) : id.slice(0, 8);
}

export function InformeMasivo({
  informe,
  filas,
  alCerrar,
}: {
  informe: InformeMasiva;
  filas: readonly FilaCompraVista[];
  alCerrar: () => void;
}) {
  const cerrar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cerrar.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={M.informeMasivo}
      onKeyDown={(e) => {
        if (e.key === "Escape") alCerrar();
      }}
      className="flex max-h-[80vh] w-[32rem] max-w-full flex-col gap-3 overflow-auto rounded border bg-white p-4 shadow-lg"
    >
      <h3 className="text-base font-medium">{M.informeMasivo}</h3>
      <p className="text-sm font-medium">{M.aplicadas(informe.aplicadas)}</p>
      {informe.rechazadas.length > 0 && (
        <>
          <p className="text-sm font-medium text-red-700">
            {M.rechazadas(informe.rechazadas.length)}
          </p>
          <table aria-label={M.tablaRechazadas} className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th scope="col" className="py-1 pr-3">
                  {M.columnas.comprobante}
                </th>
                <th scope="col" className="py-1">
                  {M.columnaMotivo}
                </th>
              </tr>
            </thead>
            <tbody>
              {informe.rechazadas.map((r) => (
                <tr key={r.compraId} className="border-t">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {comprobanteDeId(filas, r.compraId)}
                  </td>
                  <td className="py-1">{mensajeDeRechazoMasivo(r.codigo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <button
        ref={cerrar}
        type="button"
        onClick={alCerrar}
        className="w-fit rounded border px-3 py-1 text-sm"
      >
        {M.cerrar}
      </button>
    </div>
  );
}
