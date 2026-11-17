"use client";

import type { FilaCompraVista, InformeMasiva } from "@contapp/shared";
import { useEffect, useRef } from "react";
import {
  MENSAJES_COMPRAS as M,
  mensajeDeRechazoMasivo,
} from "../../lib/compras";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  panelDialogo,
} from "../ui";
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
      className={panelDialogo}
    >
      <h3 className="m-0 font-titulo text-lg font-bold">{M.informeMasivo}</h3>
      <p className="m-0 text-sm font-semibold">{M.aplicadas(informe.aplicadas)}</p>
      {informe.rechazadas.length > 0 && (
        <>
          <p className="m-0 text-sm font-semibold text-error">
            {M.rechazadas(informe.rechazadas.length)}
          </p>
          <Table aria-label={M.tablaRechazadas}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{M.columnas.comprobante}</TableHead>
                <TableHead scope="col">{M.columnaMotivo}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {informe.rechazadas.map((r) => (
                <TableRow key={r.compraId}>
                  <TableCell className="whitespace-nowrap py-2 font-mono">
                    {comprobanteDeId(filas, r.compraId)}
                  </TableCell>
                  <TableCell className="py-2">{mensajeDeRechazoMasivo(r.codigo)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <Button ref={cerrar} variant="secundario" onClick={alCerrar} className="w-fit">
        {M.cerrar}
      </Button>
    </div>
  );
}
