"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { MENSAJES_GASTOS as M, umbralDeTexto } from "../../lib/gastos";
import { Button, Input, Label } from "../ui";

// Umbral de sospecha del estudio (spec 027, R-11, CA-10): entero de 1 a 20. Valida antes de enviar (el servidor vuelve a
// validar); sin permiso el campo queda deshabilitado y no hay botón. `alGuardar` recibe el umbral ya validado.

export function Umbral({
  valor,
  puedeCambiar,
  ocupado,
  alGuardar,
  alInvalido,
}: {
  valor: number;
  puedeCambiar: boolean;
  ocupado: boolean;
  alGuardar: (umbral: number) => void;
  alInvalido: () => void;
}) {
  const id = useId();
  const [texto, setTexto] = useState(String(valor));
  // Una lectura nueva del servidor (tras guardar o un conflicto) deja el valor vigente.
  useEffect(() => setTexto(String(valor)), [valor]);

  function enviar(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const umbral = umbralDeTexto(texto);
    if (umbral === null) alInvalido();
    else alGuardar(umbral);
  }

  return (
    <form onSubmit={enviar} noValidate className="flex flex-wrap items-end gap-3">
      <div className="flex w-40 max-w-full flex-col gap-1.5">
        <Label htmlFor={id}>{M.campoUmbral}</Label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          step={1}
          value={texto}
          disabled={!puedeCambiar}
          onChange={(e) => setTexto(e.target.value)}
          className="cifras max-lg:h-11"
        />
      </div>
      {puedeCambiar && (
        <Button type="submit" disabled={ocupado} className="max-lg:h-11">
          {M.guardarUmbral}
        </Button>
      )}
    </form>
  );
}
