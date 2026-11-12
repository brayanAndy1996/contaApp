"use client";

import { useCallback, useState } from "react";
import type { AlAvisar } from "./accion-compras";

// Un aviso, un solo anunciador (spec 018, P-2, CA-10). Cuando una acción entrega `alAvisar`, la pantalla muestra
// el error en su aviso con `role="alert"`; el mismo texto en el formulario o en la fila se muestra sin rol para que
// un lector de pantalla no lo lea dos veces. Los errores que la acción no entrega a `alAvisar` (validación local)
// conservan su `role="alert"`.

export function useErrorAnunciado(alAvisar?: AlAvisar): {
  /** Entrega el error a la pantalla (`alAvisar`) y recuerda que ya lo anuncia ella. */
  avisarError: (texto: string) => void;
  /** Rol del error local: `undefined` si la pantalla ya lo anunció, `"alert"` si solo existe aquí. */
  rolDe: (error: string | null) => "alert" | undefined;
} {
  const [anunciado, setAnunciado] = useState<string | null>(null);
  const avisarError = useCallback(
    (texto: string) => {
      if (!alAvisar) return;
      alAvisar(texto, "error");
      setAnunciado(texto);
    },
    [alAvisar],
  );
  const rolDe = (error: string | null) =>
    error !== null && error === anunciado ? undefined : "alert";
  return { avisarError, rolDe };
}
