"use client";

import type { DiferenciaComprasDto } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { conMiles } from "../../lib/montos-compras";
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
    <section
      id={ANCLA_DIFERENCIAS}
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
                  {COLUMNAS.comprobante}
                </th>
                <th scope="col" className="px-2 py-1">
                  {COLUMNAS.origen}
                </th>
                <th scope="col" className="px-2 py-1">
                  {COLUMNAS.valor}
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
                    {d.origenExistente === "manual"
                      ? COLUMNAS.origenManual
                      : COLUMNAS.origenSire}
                  </td>
                  <td className="px-2 py-1">
                    <ul>
                      {d.campos.map((c) => (
                        <li key={c}>
                          {etiquetaDe(c)}:{" "}
                          {valorDe(c, d.valoresSire[c])}
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
