"use client";

import type { DiferenciaComprasDto } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { conMiles } from "../../lib/montos-compras";
import { Card, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { ANCLA_DIFERENCIAS } from "./descarga-compras";

// Región «Diferencias de la última descarga» (spec 015, D-14; 014 D-18): los comprobantes que el SIRE trajo
// con valores distintos a los ya guardados, con el campo y el valor del SIRE. Avisan; no se aplica ni se
// corrige nada desde aquí. El texto del SIRE se muestra como texto (React lo escapa).

const ETIQUETA_CAMPO: Readonly<Record<string, string>> = {
  ...M.casilleros,
  fecha: M.campos.fecha,
  fechaEmision: M.campos.fecha,
  moneda: M.campos.moneda,
  tipoCambio: M.campos.tipoCambio,
  razonSocial: M.campos.razonSocial,
  tipoDoc: M.campos.tipoDoc,
  documento: M.campos.documento,
};

const COLUMNAS = {
  comprobante: "Comprobante",
  origen: "Origen guardado",
  valor: "Valor del SIRE",
  origenManual: "Manual",
  origenSire: "SIRE",
} as const;

const etiquetaDe = (campo: string): string =>
  Object.hasOwn(ETIQUETA_CAMPO, campo) ? (ETIQUETA_CAMPO[campo] ?? campo) : campo;

/** Solo los casilleros son montos: el resto (documento, fecha, moneda) se muestra tal cual. */
function valorDe(campo: string, valor: string | undefined): string {
  if (valor === undefined) return "-";
  return Object.hasOwn(M.casilleros, campo) ? conMiles(valor) : valor;
}

export function DiferenciasCompras({
  diferencias,
}: {
  diferencias: DiferenciaComprasDto[] | null;
}) {
  return (
    <Card id={ANCLA_DIFERENCIAS} aria-label={M.tituloDiferencias}>
      <CardTitle>{M.tituloDiferencias}</CardTitle>
      {diferencias && diferencias.length === 0 && (
        <p className="m-0 text-sm text-tinta-suave">{M.sinDiferencias}</p>
      )}
      {diferencias && diferencias.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{COLUMNAS.comprobante}</TableHead>
              <TableHead scope="col">{COLUMNAS.origen}</TableHead>
              <TableHead scope="col">{COLUMNAS.valor}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diferencias.map((d) => (
              <TableRow key={d.clave} className="align-top">
                <TableCell className="whitespace-nowrap font-mono text-[13px]">
                  {d.serie}-{d.numero}
                </TableCell>
                <TableCell>
                  {d.origenExistente === "manual"
                    ? COLUMNAS.origenManual
                    : COLUMNAS.origenSire}
                </TableCell>
                <TableCell>
                  <ul className="m-0 list-none p-0">
                    {d.campos.map((c) => (
                      <li key={c}>
                        {etiquetaDe(c)}:{" "}
                        {valorDe(c, d.valoresSire[c])}
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
