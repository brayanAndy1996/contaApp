"use client";

import type { MontosVentaDto } from "@contapp/shared";
import {
  MENSAJES_VENTAS as M,
  NOMBRE_TIPO_COMPROBANTE,
  type ResumenVentasConEstado,
} from "../../lib/ventas";

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

const MONTO = "px-2 text-right tabular-nums";

export function ResumenVentas({ resumen }: { resumen: ResumenVentasConEstado | null }) {
  return (
    <section aria-label="Resumen" className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Resumen</h2>
      <p className="text-sm">{M.importesEnSoles}</p>
      {resumen && resumen.avisos.includes("usd_sin_tipo_cambio") && (
        <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          {M.avisoUsdSinTipoCambio}
        </p>
      )}
      {resumen && (resumen.excluidas ?? 0) > 0 && (
        <p role="note" className="text-sm">
          {M.excluidas(resumen.excluidas ?? 0)}
        </p>
      )}
      {resumen && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1">
                  Tipo
                </th>
                <th scope="col" className={`${MONTO} py-1`}>
                  Cantidad
                </th>
                {COLUMNAS_MONTO.map(([clave, titulo]) => (
                  <th key={clave} scope="col" className={`${MONTO} py-1`}>
                    {titulo}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resumen.porTipo.map((t) => (
                <tr key={t.tipo} className="border-t">
                  <th
                    scope="row"
                    className="px-2 py-1 font-normal"
                    title={NOMBRE_TIPO_COMPROBANTE[t.tipo]}
                  >
                    {t.tipo}
                  </th>
                  <td className={MONTO}>{t.cantidad}</td>
                  {COLUMNAS_MONTO.map(([clave]) => (
                    <td key={clave} className={MONTO}>
                      {t[clave]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <th scope="row" className="px-2 py-1">
                  Total
                </th>
                <td className={MONTO}>{resumen.total.cantidad}</td>
                {COLUMNAS_MONTO.map(([clave]) => (
                  <td key={clave} className={MONTO}>
                    {resumen.total[clave]}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
