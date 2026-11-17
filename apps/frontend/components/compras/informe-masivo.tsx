"use client";

import type { FilaCompraVista, InformeMasiva } from "@contapp/shared";
import { useEffect, useRef, type KeyboardEvent } from "react";
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
import { useRestaurarFoco } from "../../lib/restaurar-foco";
import { comprobanteDe } from "./accion-compras";

// Informe de una acción masiva (spec 015, D-8, CA-7): «N aplicadas» y la lista de rechazadas con el comprobante y
// un motivo legible por código. Las masivas son parciales: lo rechazado no impide lo aplicado. Solo muestra; las
// `version_obsoleta` las recarga quien lanzó la masiva (`BarraMasiva`). El comprobante sale de las filas cargadas;
// si una fila ya no está, se muestra el id corto.

const FOCALIZABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const raiz = useRef<HTMLDivElement>(null);

  // Al cerrar, el foco vuelve al control que abrió el informe (antes del efecto que lo mueve adentro).
  useRestaurarFoco();
  useEffect(() => {
    cerrar.current?.focus();
  }, []);

  // `aria-modal`: Tab y Shift+Tab ciclan dentro del informe; Esc lo cierra.
  function alTeclear(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      alCerrar();
      return;
    }
    if (e.key !== "Tab" || !raiz.current) return;
    const lista = Array.from(raiz.current.querySelectorAll<HTMLElement>(FOCALIZABLES));
    const primero = lista[0];
    const ultimo = lista[lista.length - 1];
    if (!primero || !ultimo) return;
    const activo = document.activeElement;
    if (e.shiftKey && (activo === primero || activo === raiz.current)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && activo === ultimo) {
      e.preventDefault();
      primero.focus();
    } else if (!raiz.current.contains(activo)) {
      e.preventDefault();
      (e.shiftKey ? ultimo : primero).focus();
    }
  }

  return (
    <div
      ref={raiz}
      role="dialog"
      aria-modal="true"
      aria-label={M.informeMasivo}
      onKeyDown={alTeclear}
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
      <Button ref={cerrar} variant="secundario" onClick={alCerrar} className="w-fit max-lg:h-11">
        {M.cerrar}
      </Button>
    </div>
  );
}
