"use client";

import { VISTAS_COMPRAS, type VistaCompras } from "@contapp/shared";
import { useEffect, useRef, useState } from "react";
import {
  MENSAJES_COMPRAS as M,
  TOPE_SELECCION,
  type FiltrosCompras,
} from "../../lib/compras";
import { MENSAJES_REGLAS as R } from "../../lib/reglas";

// Filtros y selección del listado de compras (spec 015, T5; D-4, D-8; CA-2, CA-12). Los filtros no filtran en el
// navegador: cada cambio sube a la página, que vuelve a pedir el listado al servidor con esos parámetros. La
// búsqueda (RUC, razón social o serie-número) espera un retardo corto tras la última tecla para no pedir por letra.

/** Largo máximo de la búsqueda (`BUSQUEDA_MAX` de `shared`). */
const BUSQUEDA_MAX = 100;
/** Retardo por omisión de la búsqueda, en milisegundos. */
export const RETARDO_BUSQUEDA_MS = 300;

/** Fuera los caracteres de control: el servidor los rechaza (una línea, sin tabulaciones ni saltos). */
const sinControles = (texto: string): string => texto.replace(/\p{Cc}/gu, "");

export function FiltrosListado({
  filtros,
  alCambiar,
  retardoMs = RETARDO_BUSQUEDA_MS,
}: {
  filtros: FiltrosCompras;
  alCambiar: (filtros: FiltrosCompras) => void;
  retardoMs?: number;
}) {
  const [texto, setTexto] = useState(filtros.q);
  // Lo último que dio la página: el temporizador de la búsqueda no debe pisar un filtro cambiado en medio.
  const vigentes = useRef(filtros);
  vigentes.current = filtros;
  const aviso = useRef(alCambiar);
  aviso.current = alCambiar;

  useEffect(() => {
    const buscada = texto.trim();
    if (buscada === vigentes.current.q.trim()) return;
    const temporizador = setTimeout(() => {
      aviso.current({ ...vigentes.current, q: buscada });
    }, retardoMs);
    return () => clearTimeout(temporizador);
  }, [texto, retardoMs]);

  return (
    <form
      role="search"
      aria-label={M.filtros}
      className="flex flex-wrap items-end gap-4 text-sm"
      onSubmit={(e) => {
        // Enter busca de inmediato; nunca recarga la página.
        e.preventDefault();
        const buscada = texto.trim();
        if (buscada !== filtros.q.trim()) alCambiar({ ...filtros, q: buscada });
      }}
    >
      <fieldset className="flex items-center gap-3">
        <legend className="sr-only">{M.filtros}</legend>
        {VISTAS_COMPRAS.map((vista: VistaCompras) => (
          <label key={vista} className="flex items-center gap-1">
            <input
              type="radio"
              name="vista-compras"
              value={vista}
              checked={filtros.vista === vista}
              onChange={() => alCambiar({ ...filtros, vista })}
            />
            {M.vistas[vista]}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={filtros.alertas}
          onChange={(e) => alCambiar({ ...filtros, alertas: e.target.checked })}
        />
        {M.filtroAlertas}
      </label>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={filtros.proveedorNuevo}
          onChange={(e) =>
            alCambiar({ ...filtros, proveedorNuevo: e.target.checked })
          }
        />
        {M.filtroProveedorNuevo}
      </label>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={filtros.segunHistorial === true}
          onChange={(e) =>
            alCambiar({ ...filtros, segunHistorial: e.target.checked })
          }
        />
        {R.segunHistorial}
      </label>
      <label className="flex min-w-64 flex-col gap-1">
        {M.buscar}
        <input
          type="search"
          autoComplete="off"
          maxLength={BUSQUEDA_MAX}
          value={texto}
          onChange={(e) => setTexto(sinControles(e.target.value))}
          className="rounded border px-3 py-2"
        />
      </label>
    </form>
  );
}

/**
 * «Seleccionar las N del filtro actual» (D-8): solo con la carga terminada y con N dentro del tope (5.000); más de
 * eso pide filtrar, sin llegar al 400 del servidor. Selecciona lo cargado, que es todo el filtro.
 */
export function SeleccionDelFiltro({
  cantidad,
  cargando,
  seleccionadas,
  alSeleccionar,
}: {
  /** Compras cargadas del filtro actual. */
  cantidad: number;
  cargando: boolean;
  seleccionadas: number;
  alSeleccionar: () => void;
}) {
  if (cantidad === 0) return null;
  const demasiadas = cantidad > TOPE_SELECCION;
  const motivo = cargando
    ? M.seleccionarDelFiltroCargando
    : demasiadas
      ? M.seleccionarDemasiadas(TOPE_SELECCION)
      : null;
  const completa = seleccionadas === cantidad;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button
        type="button"
        disabled={motivo !== null || completa}
        aria-describedby={motivo !== null ? "motivo-seleccion-filtro" : undefined}
        onClick={alSeleccionar}
        className="rounded border px-3 py-1 disabled:opacity-60"
      >
        {M.seleccionarDelFiltro(cantidad)}
      </button>
      {motivo !== null && (
        <span id="motivo-seleccion-filtro" role="status">
          {motivo}
        </span>
      )}
    </div>
  );
}
