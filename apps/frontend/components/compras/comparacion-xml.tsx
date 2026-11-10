"use client";

import type { ComparacionFila } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { MENSAJES_LUPA as L } from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";

// Comparación SIRE y XML por columna (spec 016, D-9, CA-14, RF-093). Las diferencias se resaltan con texto
// («Difiere») además del fondo y el peso de letra, no solo con color. Cada diferencia lleva la regla y la
// explicación del hallazgo que la cubre (p. ej. R-MIX). Las cifras vienen del servidor: aquí solo se les da formato.

export function ComparacionXml({
  filas,
  hayXml,
}: {
  filas: readonly ComparacionFila[];
  hayXml: boolean;
}) {
  const T = L.comparacion;
  return (
    <section aria-label={L.secciones.comparacion} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{L.secciones.comparacion}</h3>
      {!hayXml && <p className="text-sm">{T.sinXmlNota}</p>}
      <table aria-label={T.tabla} className="w-full text-sm">
        <thead>
          <tr className="text-right">
            <th scope="col" className="py-1 text-left">{T.columna}</th>
            <th scope="col" className="py-1">{T.sire}</th>
            <th scope="col" className="py-1">{T.xml}</th>
            <th scope="col" className="py-1 pl-3 text-left">{T.estado}</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => {
            const estado = f.xml === null ? T.sinXml : f.difiere ? T.difiere : T.coincide;
            return (
              <tr
                key={f.columna}
                data-difiere={f.difiere ? "true" : "false"}
                className={`border-t text-right ${f.difiere ? "bg-amber-50 font-medium" : ""}`}
              >
                <th scope="row" className="py-1 text-left font-normal">
                  {T.columnas[f.columna]}
                </th>
                <td className="py-1 tabular-nums">{conMiles(f.sire)}</td>
                <td className="py-1 tabular-nums">{f.xml === null ? L.cabecera.sinDato : conMiles(f.xml)}</td>
                <td className="py-1 pl-3 text-left">
                  <span>{estado}</span>
                  {f.difiere && f.regla !== undefined && (
                    <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium">
                      {`${f.regla} · ${M.hallazgos[f.regla]}`}
                    </span>
                  )}
                  {f.difiere && f.explicacion !== undefined && (
                    <p className="text-xs font-normal">{f.explicacion}</p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
