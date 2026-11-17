"use client";

import type { MontosVentaDto } from "@contapp/shared";
import {
  MENSAJES_VENTAS as M,
  NOMBRE_TIPO_COMPROBANTE,
  type ResumenVentasConEstado,
} from "../../lib/ventas";
import {
  Alert,
  Card,
  CardDescription,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui";

// Resumen de ventas en soles (spec 013, D11; RF-056). Todas las cifras las calcula el servidor (con
// notas de crédito restando y USD convertido); aquí solo se muestran las cadenas recibidas.

const COLUMNAS_MONTO: ReadonlyArray<[keyof MontosVentaDto, string]> = [
  ["baseGravada", "Base gravada"],
  ["igv", "IGV"],
  ["exonerada", "Exonerada"],
  ["inafecta", "Inafecta"],
  ["isc", "ISC"],
  ["icbper", "ICBPER"],
  ["otros", "Otros"],
  ["total", "Total"],
];

const MONTO = "px-2";

export function ResumenVentas({ resumen }: { resumen: ResumenVentasConEstado | null }) {
  return (
    <Card aria-label="Resumen">
      <CardTitle>Resumen</CardTitle>
      <CardDescription>{M.importesEnSoles}</CardDescription>
      {resumen && resumen.avisos.includes("usd_sin_tipo_cambio") && (
        <Alert tono="aviso" role="status">
          {M.avisoUsdSinTipoCambio}
        </Alert>
      )}
      {resumen && (resumen.excluidas ?? 0) > 0 && (
        <p role="note" className="m-0 text-sm text-tinta-media">
          {M.excluidas(resumen.excluidas ?? 0)}
        </p>
      )}
      {resumen && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="px-2 py-1.5">
                Tipo
              </TableHead>
              <TableHead scope="col" className={`${MONTO} py-1.5 text-right`}>
                Cantidad
              </TableHead>
              {COLUMNAS_MONTO.map(([clave, titulo]) => (
                <TableHead key={clave} scope="col" className={`${MONTO} py-1.5 text-right`}>
                  {titulo}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {resumen.porTipo.map((t) => (
              <TableRow key={t.tipo}>
                <TableHead
                  scope="row"
                  className="border-b-0 px-2 py-1.5 text-sm font-normal text-tinta"
                  title={NOMBRE_TIPO_COMPROBANTE[t.tipo]}
                >
                  {t.tipo}
                </TableHead>
                <TableCell numerico className={`${MONTO} py-1.5`}>
                  {t.cantidad}
                </TableCell>
                {COLUMNAS_MONTO.map(([clave]) => (
                  <TableCell key={clave} numerico className={`${MONTO} py-1.5`}>
                    {t[clave]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="border-t border-linea">
              <TableHead scope="row" className="border-b-0 px-2 py-1.5 text-sm font-bold text-tinta">
                Total
              </TableHead>
              <TableCell numerico className={`${MONTO} py-1.5`}>
                {resumen.total.cantidad}
              </TableCell>
              {COLUMNAS_MONTO.map(([clave]) => (
                <TableCell key={clave} numerico className={`${MONTO} py-1.5`}>
                  {resumen.total[clave]}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </Card>
  );
}
