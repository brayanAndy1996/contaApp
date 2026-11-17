"use client";

import type { ComparacionFila } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { MENSAJES_LUPA as L } from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";

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
      <h3 className="text-sm font-semibold text-tinta">{L.secciones.comparacion}</h3>
      {!hayXml && <p className="text-sm text-tinta-media">{T.sinXmlNota}</p>}
      <Table aria-label={T.tabla}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">{T.columna}</TableHead>
            <TableHead scope="col" className="text-right">{T.sire}</TableHead>
            <TableHead scope="col" className="text-right">{T.xml}</TableHead>
            <TableHead scope="col" className="pl-4">{T.estado}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filas.map((f) => {
            const estado = f.xml === null ? T.sinXml : f.difiere ? T.difiere : T.coincide;
            return (
              <TableRow
                key={f.columna}
                data-difiere={f.difiere ? "true" : "false"}
                className={f.difiere ? "bg-aviso-fondo font-medium text-aviso hover:bg-aviso-fondo" : "text-tinta"}
              >
                <TableHead scope="row" className="whitespace-normal border-0 py-2 text-sm font-normal text-inherit">
                  {T.columnas[f.columna]}
                </TableHead>
                <TableCell numerico className="py-2">{conMiles(f.sire)}</TableCell>
                <TableCell numerico className="py-2">
                  {f.xml === null ? L.cabecera.sinDato : conMiles(f.xml)}
                </TableCell>
                <TableCell className="py-2 pl-4 text-left">
                  <span>{estado}</span>
                  {f.difiere && f.regla !== undefined && (
                    <Badge tono="aviso" className="ml-2 h-auto min-h-6 whitespace-normal border border-aviso-borde py-0.5">
                      {`${f.regla} · ${M.hallazgos[f.regla]}`}
                    </Badge>
                  )}
                  {f.difiere && f.explicacion !== undefined && (
                    <p className="text-xs font-normal">{f.explicacion}</p>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
