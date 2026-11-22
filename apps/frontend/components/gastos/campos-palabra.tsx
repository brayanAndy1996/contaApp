"use client";

import { useId } from "react";
import { CATEGORIAS_GND, ETIQUETA_CATEGORIA, MENSAJES_GASTOS as M } from "../../lib/gastos";
import { Input, Label, Select } from "../ui";

// Campos de una palabra del diccionario (spec 027, R-4): Palabra, Categoría y Excepciones separadas por coma. Los usan
// «Agregar palabra» del estudio y el formulario del diccionario global del super-admin. Solo captura: valida el que lo monta
// con `validarPalabra` de `lib/gastos`.

export interface ValoresPalabra {
  palabra: string;
  categoria: string;
  excepciones: string;
}

export const PALABRA_VACIA: ValoresPalabra = { palabra: "", categoria: "", excepciones: "" };

export function CamposPalabra({
  valores,
  alCambiar,
  deshabilitado = false,
  palabraFija = false,
  invalido = false,
}: {
  valores: ValoresPalabra;
  alCambiar: (valores: ValoresPalabra) => void;
  deshabilitado?: boolean;
  /** Editar: la palabra no se renombra. */
  palabraFija?: boolean;
  invalido?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${id}-palabra`}>{M.campoPalabra}</Label>
        <Input
          id={`${id}-palabra`}
          type="text"
          autoComplete="off"
          value={valores.palabra}
          disabled={deshabilitado || palabraFija}
          aria-invalid={invalido || undefined}
          onChange={(e) => alCambiar({ ...valores, palabra: e.target.value })}
          className="max-lg:h-11"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${id}-categoria`}>{M.campoCategoria}</Label>
        <Select
          id={`${id}-categoria`}
          value={valores.categoria}
          disabled={deshabilitado}
          onChange={(e) => alCambiar({ ...valores, categoria: e.target.value })}
          className="max-lg:h-11"
        >
          <option value="">{M.elegirCategoria}</option>
          {CATEGORIAS_GND.map((c) => (
            <option key={c} value={c}>
              {ETIQUETA_CATEGORIA[c]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${id}-excepciones`}>{M.campoExcepciones}</Label>
        <Input
          id={`${id}-excepciones`}
          type="text"
          autoComplete="off"
          value={valores.excepciones}
          disabled={deshabilitado}
          onChange={(e) => alCambiar({ ...valores, excepciones: e.target.value })}
          className="max-lg:h-11"
        />
      </div>
    </div>
  );
}
