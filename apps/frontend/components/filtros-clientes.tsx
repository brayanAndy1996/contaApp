"use client";

import type {
  EstadoCredencial,
  FiltrosClientes as FiltrosApi,
} from "@contapp/shared";
import {
  ETIQUETA_ESTADO,
  OPCIONES_CREDENCIAL,
  Q_MAX,
} from "../lib/clientes";

// Filtros del listado de clientes (spec 007a, D7). Controlado: el padre decide cuándo pedir los datos
// (el texto de búsqueda se espera un momento antes de enviarse). Solo presentación.

export interface EstadoFiltros {
  responsable: string;
  credencial: EstadoCredencial | "";
  archivados: boolean;
  q: string;
}

export const FILTROS_VACIOS: EstadoFiltros = {
  responsable: "",
  credencial: "",
  archivados: false,
  q: "",
};

/** Filtros de la API a partir del estado de la pantalla (omite los vacíos). */
export function filtrosDeEstado(estado: EstadoFiltros): FiltrosApi {
  return {
    ...(estado.responsable ? { responsable: estado.responsable } : {}),
    ...(estado.credencial ? { credencial: estado.credencial } : {}),
    ...(estado.archivados ? { archivados: true } : {}),
    ...(estado.q.trim() ? { q: estado.q.trim() } : {}),
  };
}

interface Props {
  valor: EstadoFiltros;
  onCambio: (siguiente: EstadoFiltros) => void;
  responsables: { usuarioId: string; nombre: string }[];
}

export function FiltrosClientes({ valor, onCambio, responsables }: Props) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Responsable
        <select
          value={valor.responsable}
          onChange={(e) => onCambio({ ...valor, responsable: e.target.value })}
          className="rounded border px-3 py-2"
        >
          <option value="">Todos</option>
          <option value="ninguno">Sin responsable</option>
          {responsables.map((m) => (
            <option key={m.usuarioId} value={m.usuarioId}>
              {m.nombre}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Credencial
        <select
          value={valor.credencial}
          onChange={(e) =>
            onCambio({
              ...valor,
              credencial: e.target.value as EstadoCredencial | "",
            })
          }
          className="rounded border px-3 py-2"
        >
          <option value="">Todas</option>
          {OPCIONES_CREDENCIAL.map((estado) => (
            <option key={estado} value={estado}>
              {ETIQUETA_ESTADO[estado]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Buscar
        <input
          type="text"
          value={valor.q}
          maxLength={Q_MAX}
          placeholder="RUC o razón social"
          onChange={(e) => onCambio({ ...valor, q: e.target.value })}
          className="rounded border px-3 py-2"
        />
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          checked={valor.archivados}
          onChange={(e) => onCambio({ ...valor, archivados: e.target.checked })}
        />
        Mostrar archivados
      </label>
    </div>
  );
}
