"use client";

import { coeficienteVistaSchema } from "@contapp/shared";
import { Card, CardTitle, enlace } from "../ui";
import { MENSAJES_PRORRATA as M, etiquetaPeriodo } from "../../lib/prorrata";
import { cn } from "../../lib/utils";

// Coeficiente de prorrata (spec 026, T13; CA-2 a CA-4, R-2b, R-3, R-4, R-6, D-8). Presentacional: el porcentaje, «provisional»,
// los meses que faltan y los avisos los decide el servidor; aquí solo se formatean (coma decimal, « %»). Todo sale como texto.

export function Coeficiente({
  coeficiente,
  puedeGestionar,
}: {
  coeficiente: unknown;
  /** Con permiso, cada mes faltante es un enlace a su fila; sin él, solo texto. */
  puedeGestionar: boolean;
}) {
  const analizado = coeficienteVistaSchema.safeParse(coeficiente);
  const c = analizado.success ? analizado.data : null;
  return (
    <Card aria-labelledby="titulo-coeficiente">
      <CardTitle id="titulo-coeficiente">{M.tituloCoeficiente}</CardTitle>
      {c?.estado === "calculado" && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="cifras m-0 font-titulo text-[34px] font-extrabold leading-tight text-tinta">{M.porcentaje(c.porcentaje)}</p>
            {c.provisional && <span className="text-sm font-semibold text-aviso">{M.provisional}</span>}
          </div>
          {c.avisos.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm text-aviso">
              {c.avisos.map((a) => (
                <li key={a}>{M.avisosCoeficiente[a]}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {c?.estado === "faltan_meses" && (
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <p className="m-0 text-tinta-media">{M.faltanMeses}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {c.faltantes.map((p) => (
              <li key={p}>
                {puedeGestionar ? (
                  <a href={`#mes-${p}`} className={cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center")}>
                    {M.ingresarFaltante(p)}
                  </a>
                ) : (
                  <span>{etiquetaPeriodo(p)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c?.estado === "no_determinable" && <p className="m-0 text-sm text-tinta-media">{M.noDeterminable[c.motivo]}</p>}
    </Card>
  );
}
