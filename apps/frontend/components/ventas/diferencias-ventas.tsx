"use client";

import type { DiferenciaVentasDto } from "@contapp/shared";
import { MENSAJES_VENTAS as M } from "../../lib/ventas";
import {
  Badge,
  Card,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui";

// Región «Diferencias de la última descarga» (spec 013, D16; CA-11): los comprobantes que el SIRE trajo con
// valores distintos a los ya guardados, con el campo y el valor del SIRE. El texto del SIRE se muestra como
// texto (React lo escapa); no se aplica ni se corrige nada desde aquí.

const ETIQUETA_CAMPO: Readonly<Record<string, string>> = {
  fechaEmision: M.campos.fecha,
  moneda: M.campos.moneda,
  tipoCambio: M.campos.tipoCambio,
  tipoDocContraparte: M.campos.tipoDoc,
  docContraparte: M.campos.documento,
  baseGravada: M.campos.baseGravada,
  igv: M.campos.igv,
  exonerada: M.campos.exonerada,
  inafecta: M.campos.inafecta,
  isc: M.campos.isc,
  icbper: M.campos.icbper,
  otros: M.campos.otros,
  total: M.campos.total,
};

export function DiferenciasVentas({
  diferencias,
}: {
  diferencias: DiferenciaVentasDto[] | null;
}) {
  return (
    <Card aria-label={M.tituloDiferencias}>
      <CardTitle>{M.tituloDiferencias}</CardTitle>
      {diferencias && diferencias.length === 0 && (
        <p className="m-0 text-sm text-tinta-suave">{M.sinDiferencias}</p>
      )}
      {diferencias && diferencias.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="px-2 py-1.5">
                Comprobante
              </TableHead>
              <TableHead scope="col" className="px-2 py-1.5">
                Origen guardado
              </TableHead>
              <TableHead scope="col" className="px-2 py-1.5">
                Valor del SIRE
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diferencias.map((d) => (
              <TableRow key={d.clave}>
                <TableCell className="whitespace-nowrap px-2 py-2 align-top font-mono">
                  {d.serie}-{d.numero}
                </TableCell>
                <TableCell className="px-2 py-2 align-top">
                  <Badge tono={d.origenExistente === "manual" ? "info" : "neutro"}>
                    {d.origenExistente === "manual" ? "Manual" : "SIRE"}
                  </Badge>
                </TableCell>
                <TableCell className="px-2 py-2 align-top">
                  <ul className="m-0 p-0">
                    {d.campos.map((c) => (
                      <li key={c}>
                        {ETIQUETA_CAMPO[c] ?? c}: {d.valoresSire[c] ?? "-"}
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
