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
import { Input, Label, Select } from "./ui";

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
      <Label className="w-full sm:w-auto">
        Responsable
        <Select
          value={valor.responsable}
          onChange={(e) => onCambio({ ...valor, responsable: e.target.value })}
          className="max-lg:h-11 sm:w-52"
        >
          <option value="">Todos</option>
          <option value="ninguno">Sin responsable</option>
          {responsables.map((m) => (
            <option key={m.usuarioId} value={m.usuarioId}>
              {m.nombre}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-full sm:w-auto">
        Credencial
        <Select
          value={valor.credencial}
          onChange={(e) =>
            onCambio({
              ...valor,
              credencial: e.target.value as EstadoCredencial | "",
            })
          }
          className="max-lg:h-11 sm:w-48"
        >
          <option value="">Todas</option>
          {OPCIONES_CREDENCIAL.map((estado) => (
            <option key={estado} value={estado}>
              {ETIQUETA_ESTADO[estado]}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-full sm:w-auto">
        Buscar
        <Input
          type="text"
          value={valor.q}
          maxLength={Q_MAX}
          placeholder="RUC o razón social"
          onChange={(e) => onCambio({ ...valor, q: e.target.value })}
          className="max-lg:h-11 sm:w-64"
        />
      </Label>
      <Label className="min-h-10 flex-row items-center gap-2 font-normal text-tinta max-lg:min-h-11">
        <input
          type="checkbox"
          checked={valor.archivados}
          onChange={(e) => onCambio({ ...valor, archivados: e.target.checked })}
          className="size-5 cursor-pointer accent-primario max-lg:size-6"
        />
        Mostrar archivados
      </Label>
    </div>
  );
}
