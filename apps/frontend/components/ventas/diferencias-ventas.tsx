"use client";

import type { DiferenciaVentasDto } from "@contapp/shared";
import { MENSAJES_VENTAS as M } from "../../lib/ventas";

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
    <section
      aria-label={M.tituloDiferencias}
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-medium">{M.tituloDiferencias}</h2>
      {diferencias && diferencias.length === 0 && (
        <p className="text-sm">{M.sinDiferencias}</p>
      )}
      {diferencias && diferencias.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1">
                  Comprobante
                </th>
                <th scope="col" className="px-2 py-1">
                  Origen guardado
                </th>
                <th scope="col" className="px-2 py-1">
                  Valor del SIRE
                </th>
              </tr>
            </thead>
            <tbody>
              {diferencias.map((d) => (
                <tr key={d.clave} className="border-t align-top">
                  <td className="whitespace-nowrap px-2 py-1">
                    {d.serie}-{d.numero}
                  </td>
                  <td className="px-2 py-1">
                    {d.origenExistente === "manual" ? "Manual" : "SIRE"}
                  </td>
                  <td className="px-2 py-1">
                    <ul>
                      {d.campos.map((c) => (
                        <li key={c}>
                          {ETIQUETA_CAMPO[c] ?? c}: {d.valoresSire[c] ?? "-"}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
