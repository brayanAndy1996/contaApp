"use client";

import { igvEstimadoVistaSchema } from "@contapp/shared";
import { Badge, Card, CardTitle } from "../ui";
import { MENSAJES_PRORRATA as M } from "../../lib/prorrata";

// IGV estimado del mes (spec 026, T13; CA-5, R-7, U-8, D-8). Los componentes y el resultado vienen calculados del servidor:
// aquí solo se muestran, como lista de definiciones. El «saldo a favor» va en valor absoluto (la etiqueta ya dice el signo).

const sinSigno = (monto: string): string => (monto.startsWith("-") ? monto.slice(1) : monto);

function Linea({ etiqueta, valor, destacado = false }: { etiqueta: string; valor: string; destacado?: boolean }) {
  return (
    <div className={destacado ? "flex flex-wrap items-baseline justify-between gap-x-4 border-t border-linea pt-3" : "flex flex-wrap items-baseline justify-between gap-x-4"}>
      <dt className={destacado ? "font-bold text-tinta" : "text-tinta-media"}>{etiqueta}</dt>
      <dd className={destacado ? "cifras m-0 text-lg font-extrabold text-tinta" : "cifras m-0 text-tinta"}>{valor}</dd>
    </div>
  );
}

export function IgvEstimado({ igv }: { igv: unknown }) {
  const analizado = igvEstimadoVistaSchema.safeParse(igv);
  const i = analizado.success ? analizado.data : null;
  return (
    <Card aria-labelledby="titulo-igv">
      <CardTitle id="titulo-igv">{M.tituloIgv}</CardTitle>
      {i?.estado === "calculado" && (
        <>
          <dl className="m-0 flex min-w-0 flex-col gap-2 text-sm">
            <Linea etiqueta={M.componentes.igvVentas} valor={i.igvVentas} />
            <Linea etiqueta={M.componentes.creditoDg} valor={i.creditoDg} />
            <Linea etiqueta={M.componentes.igvDgng} valor={i.igvDgng} />
            <Linea etiqueta={M.componentes.creditoDgng} valor={i.creditoDgng} />
            <Linea etiqueta={M.componentes.igvDng} valor={i.igvDng} />
            <Linea etiqueta={M.situacion[i.situacion]} valor={sinSigno(i.resultado)} destacado />
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tono="neutro">{M.estadoCompras[i.estadoPeriodoCompras]}</Badge>
          </div>
          {(i.avisos ?? []).length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm text-aviso">
              {(i.avisos ?? []).map((a) => (
                <li key={a}>{M.avisosIgv[a]}</li>
              ))}
            </ul>
          )}
          <p className="m-0 text-[13px] text-tinta-suave">{M.notaEstimado}</p>
        </>
      )}
      {i?.estado === "no_estimable" && <p className="m-0 text-sm text-tinta-media">{M.noEstimable[i.motivo]}</p>}
    </Card>
  );
}
