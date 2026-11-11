"use client";

import type { EstadoPeriodoRespuesta } from "@contapp/shared";
import type { EstadoPeriodoCompras } from "../../lib/compras";
import { reabrirPeriodoVentas, revisarPeriodoVentas } from "../../lib/ventas";
import { EstadoPeriodo } from "../compras/estado-periodo";

// Estado del periodo de ventas (spec 012b, T15; P-1, P-9; CA-10): abierto, revisado y generado, con «Marcar como
// revisado» y «Reabrir» (con `estadoVisto`) exactamente como en compras. Reutiliza `EstadoPeriodo` con las rutas
// de ventas; el bloqueo de las escrituras lo calcula la página con `bloqueoPorEstado`. Ocultar botones es
// comodidad: el backend valida (RNF-007).

const ACCIONES_VENTAS = {
  revisar: revisarPeriodoVentas,
  reabrir: reabrirPeriodoVentas,
} as const;

export function EstadoPeriodoVentas({
  clienteId,
  periodo,
  estado,
  clasificar,
  aprobarGenerar,
  archivado,
  en,
  alCambiar,
  alRecargar,
}: {
  clienteId: string;
  periodo: string;
  estado: EstadoPeriodoCompras;
  /** `sire.clasificar`: marcar como revisado. */
  clasificar: boolean;
  /** `sire.aprobar_generar`: reabrir. */
  aprobarGenerar: boolean;
  archivado: boolean;
  /** Cuándo se marcó el periodo, o `null` si no se sabe. */
  en: string | null;
  alCambiar: (respuesta: EstadoPeriodoRespuesta) => void;
  /** 409 `estado_invalido`: el estado de la página quedó viejo y hay que volver a pedirlo. */
  alRecargar: () => void;
}) {
  return (
    <EstadoPeriodo
      contexto={{
        clienteId,
        periodo,
        estado,
        permisos: { ver: true, descargar: false, clasificar, aprobarGenerar },
      }}
      archivado={archivado}
      en={en}
      alCambiar={alCambiar}
      alRecargar={alRecargar}
      acciones={ACCIONES_VENTAS}
    />
  );
}
