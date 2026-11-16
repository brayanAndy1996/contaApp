"use client";

import type { DestinoCompra, FilaCompraVista } from "@contapp/shared";
import { useCallback } from "react";
import type { ContextoCompras } from "../../lib/compras";
import { destinoDe } from "../../lib/montos-compras";
import { ofreceRecordar } from "../../lib/reglas";
import type { AlAvisar } from "../compras/accion-compras";
import { RecordarProveedor } from "./recordar-proveedor";

// Enganche de «Recordar» para la grilla, la masiva y la lupa (spec 021, T14; CA-1, P-2). Decide con `ofreceRecordar`
// ANTES de montar el aviso (sin `reglas.gestionar`, sin las reglas del cliente o con una regla activa del proveedor
// con ese destino no se monta nada) y, al guardar, pide a la página que vuelva a leer las reglas.

/** El destino único de una fila clasificada; `null` si está por clasificar, es mixta o no tiene base. */
export function destinoRecordable(
  fila: Pick<FilaCompraVista, "clasificada" | "excluida" | "montos">,
): DestinoCompra | null {
  if (!fila.clasificada || fila.excluida) return null;
  const destino = destinoDe(fila.montos);
  return destino === "DG" || destino === "DGNG" || destino === "DNG" ? destino : null;
}

export function RecordarTrasClasificar({
  contexto,
  compraIds,
  proveedor,
  destino,
  alAvisar,
  alTerminar,
}: {
  contexto: ContextoCompras;
  compraIds: readonly string[];
  proveedor: { tipo: string; numero: string; razonSocial?: string | null };
  destino: DestinoCompra;
  alAvisar?: AlAvisar;
  /** Se llama al guardar o al vencer el aviso: quien lo muestra lo quita. */
  alTerminar: () => void;
}) {
  const reglas = contexto.reglas;
  const puedeGestionar = contexto.permisos.gestionarReglas === true;
  const recargar = reglas?.recargar;

  const terminar = useCallback(
    (motivo: "recordada" | "expirada") => {
      if (motivo === "recordada") {
        void Promise.resolve(recargar?.()).catch(() => {
          // La página vuelve a leer las reglas en la próxima carga.
        });
      }
      alTerminar();
    },
    [recargar, alTerminar],
  );

  if (reglas === undefined || !ofreceRecordar(reglas.lista, proveedor, destino, puedeGestionar)) {
    return null;
  }

  return (
    <RecordarProveedor
      clienteId={contexto.clienteId}
      compraIds={compraIds}
      proveedor={proveedor}
      destino={destino}
      reglas={reglas.lista}
      puedeGestionar={puedeGestionar}
      alAvisar={alAvisar}
      alTerminar={terminar}
    />
  );
}
