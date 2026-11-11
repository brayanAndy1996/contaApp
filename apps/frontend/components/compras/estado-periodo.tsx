"use client";

import { useState } from "react";
import type { EstadoPeriodoRespuesta } from "@contapp/shared";
import { fechaCorta } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  reabrirPeriodoCompras,
  revisarPeriodoCompras,
  type ContextoCompras,
  type EstadoPeriodoCompras,
  type PermisosCompras,
  type ResultadoCompras,
} from "../../lib/compras";
import { ConfirmarAccion } from "../ventas/confirmar-accion";

// Estado del periodo (spec 015, D-13; RF-071, 014 D-9, DU-23; CA-13). Insignia `abierto` / `revisado` /
// `generado`; «Marcar como revisado» (`sire.clasificar`) y «Reabrir» (`sire.aprobar_generar`) piden
// confirmación. Reabrir envía `{ estadoVisto }` con el estado que la pantalla mostraba: si el periodo ya cambió,
// el servidor responde 409 `estado_invalido` y la pantalla recarga el estado. Ocultar botones es comodidad: el
// backend vuelve a validar (RNF-007).

export const TEXTOS_ESTADO = {
  titulo: "Estado del periodo",
  avisoReproceso: "Habrá que generar el archivo de nuevo.",
} as const;

/**
 * Motivo legible por el que la grilla es de solo lectura, o `null` si se puede modificar (D-13). Orden: cliente
 * archivado, sin `sire.clasificar`, periodo generado (nadie edita) y periodo revisado sin `sire.aprobar_generar`.
 */
export function calcularSoloLectura(o: {
  archivado: boolean;
  permisos: PermisosCompras;
  estado: EstadoPeriodoCompras;
}): string | null {
  if (o.archivado) return M.soloLectura.clienteArchivado;
  if (!o.permisos.clasificar) return M.soloLectura.sinPermiso;
  if (o.estado === "generado") return M.soloLectura.generado;
  if (o.estado === "revisado" && !o.permisos.aprobarGenerar) {
    return M.soloLectura.revisadoSinAprobar;
  }
  return null;
}

/** Acción que espera confirmación; `reabrir` recuerda el estado que la persona vio al pulsar (DU-23). */
type Pendiente =
  | { tipo: "revisar" }
  | { tipo: "reabrir"; estadoVisto: "revisado" | "generado" };

/** Las dos llamadas del estado del periodo: compras por defecto; ventas (012b) pasa las suyas. */
export interface AccionesEstadoPeriodo {
  revisar: (
    clienteId: string,
    periodo: string,
  ) => Promise<ResultadoCompras<EstadoPeriodoRespuesta>>;
  reabrir: (
    clienteId: string,
    periodo: string,
    datos: { estadoVisto: "revisado" | "generado" },
  ) => Promise<ResultadoCompras<EstadoPeriodoRespuesta>>;
}

const ACCIONES_COMPRAS: AccionesEstadoPeriodo = {
  revisar: revisarPeriodoCompras,
  reabrir: reabrirPeriodoCompras,
};

export function EstadoPeriodo({
  contexto,
  archivado,
  en,
  alCambiar,
  alRecargar,
  acciones = ACCIONES_COMPRAS,
}: {
  contexto: Pick<ContextoCompras, "clienteId" | "periodo" | "permisos" | "estado">;
  archivado: boolean;
  /** Cuándo se marcó el periodo (de la última respuesta de revisar o reabrir), o `null` si no se sabe. */
  en: string | null;
  /** El servidor cambió el estado: la página lo guarda y recarga el resumen. */
  alCambiar: (respuesta: EstadoPeriodoRespuesta) => void;
  /** 409 `estado_invalido`: el estado de la página quedó viejo y hay que volver a pedirlo. */
  alRecargar: () => void;
  /** Otro libro (ventas, 012b) con las mismas reglas de estado; sin esto, las de compras. */
  acciones?: AccionesEstadoPeriodo;
}) {
  const { clienteId, periodo, permisos, estado } = contexto;
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const puedeRevisar =
    estado === "abierto" && permisos.clasificar && !archivado;
  /** El estado que se reabriría (el que la pantalla muestra), o `null` si no se puede reabrir. */
  const reabrible =
    estado !== "abierto" && permisos.aprobarGenerar && !archivado
      ? estado
      : null;

  const mensajeConfirmacion =
    pendiente === null
      ? ""
      : pendiente.tipo === "revisar"
        ? M.confirmarRevisado
        : pendiente.estadoVisto === "generado"
          ? `${M.confirmarReabrir("generado")} ${TEXTOS_ESTADO.avisoReproceso}`
          : M.confirmarReabrir("revisado");

  async function ejecutar() {
    const accion = pendiente;
    if (accion === null || ocupado) return;
    setOcupado(true);
    setAviso(null);
    setError(null);
    try {
      const r =
        accion.tipo === "revisar"
          ? await acciones.revisar(clienteId, periodo)
          : await acciones.reabrir(clienteId, periodo, {
              estadoVisto: accion.estadoVisto,
            });
      setPendiente(null);
      if (r.ok) {
        setAviso(
          accion.tipo === "revisar" ? M.periodoRevisado : M.periodoReabierto,
        );
        alCambiar(r.datos);
      } else if (r.status !== 401) {
        setError(r.mensaje);
        // 409 `estado_invalido`: otra persona ya cambió el estado; se vuelve a pedir.
        if (r.codigo === "estado_invalido") alRecargar();
      }
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section
      aria-label={TEXTOS_ESTADO.titulo}
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-medium">{TEXTOS_ESTADO.titulo}</h2>
      <div className="flex flex-wrap items-center gap-3">
        <span
          data-estado={estado}
          className="rounded-full border px-3 py-1 text-sm font-medium"
        >
          {M.estado[estado]}
        </span>
        {en !== null && estado !== "abierto" && (
          <span className="text-sm">{M.estadoPor(fechaCorta(en))}</span>
        )}
        {puedeRevisar && (
          <button
            type="button"
            disabled={ocupado || pendiente !== null}
            onClick={() => {
              setAviso(null);
              setError(null);
              setPendiente({ tipo: "revisar" });
            }}
            className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          >
            {M.marcarRevisado}
          </button>
        )}
        {reabrible !== null && (
          <button
            type="button"
            disabled={ocupado || pendiente !== null}
            onClick={() => {
              setAviso(null);
              setError(null);
              setPendiente({ tipo: "reabrir", estadoVisto: reabrible });
            }}
            className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          >
            {M.reabrir}
          </button>
        )}
      </div>

      {pendiente !== null && mensajeConfirmacion !== "" && (
        <ConfirmarAccion
          mensaje={mensajeConfirmacion}
          ocupado={ocupado}
          alConfirmar={() => void ejecutar()}
          alCancelar={() => setPendiente(null)}
        />
      )}

      <div aria-live="polite">
        {aviso && (
          <p role="status" className="text-sm">
            {aviso}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
