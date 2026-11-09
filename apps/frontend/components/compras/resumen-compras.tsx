"use client";

import type { ResumenComprasVista } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { conMiles, iguales } from "../../lib/montos-compras";

// Resumen del periodo de compras (spec 015, D-12; RF-068, RF-069, CA-15). Todas las cifras las calcula el
// servidor; aquí solo se muestran las cadenas recibidas, con miles. La diferencia lleva signo y texto (no solo
// color). El resumen es del periodo entero, no del filtro de la grilla, y lo dice.

type Casillero = keyof typeof M.casilleros;

const CASILLEROS: readonly Casillero[] = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
  "total",
];

export const TEXTOS_RESUMEN = {
  casillero: "Casillero",
  alcance: "Periodo entero: no cambia con los filtros de la grilla.",
  particion: "Con IGV y sin IGV",
  aumenta: "aumenta",
  disminuye: "disminuye",
  sinCambio: "sin cambio",
} as const;

const MONTO = "px-2 text-right tabular-nums";

/** Diferencia con signo y texto: «+5.00 (aumenta)», «-12.00 (disminuye)», «0.00 (sin cambio)». */
export function diferenciaConTexto(diferencia: string): string {
  if (iguales(diferencia, "0.00")) {
    return `${conMiles(diferencia)} (${TEXTOS_RESUMEN.sinCambio})`;
  }
  if (diferencia.startsWith("-")) {
    return `${conMiles(diferencia)} (${TEXTOS_RESUMEN.disminuye})`;
  }
  return `+${conMiles(diferencia)} (${TEXTOS_RESUMEN.aumenta})`;
}

export function ResumenCompras({
  resumen,
}: {
  resumen: ResumenComprasVista | null;
}) {
  const sinConvertir = resumen?.filasSinConvertir.length ?? 0;
  return (
    <section aria-label={M.tituloResumen} className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{M.tituloResumen}</h2>
      <p className="text-sm">
        <strong>{M.periodoEntero}</strong>. {TEXTOS_RESUMEN.alcance}
      </p>
      {resumen && sinConvertir > 0 && (
        <p
          role="status"
          className="rounded bg-amber-50 p-3 text-sm text-amber-900"
        >
          {M.avisoSinConvertir(sinConvertir)}
        </p>
      )}
      {resumen && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th scope="col" className="px-2 py-1">
                    {TEXTOS_RESUMEN.casillero}
                  </th>
                  <th scope="col" className={`${MONTO} py-1`}>
                    {M.columnaOriginal}
                  </th>
                  <th scope="col" className={`${MONTO} py-1`}>
                    {M.columnaVigente}
                  </th>
                  <th scope="col" className={`${MONTO} py-1`}>
                    {M.columnaDiferencia}
                  </th>
                </tr>
              </thead>
              <tbody>
                {CASILLEROS.map((c) => (
                  <tr key={c} className="border-t">
                    <th scope="row" className="px-2 py-1 font-normal">
                      {M.casilleros[c]}
                    </th>
                    <td className={MONTO}>
                      {conMiles(resumen.casilleros.original[c])}
                    </td>
                    <td className={MONTO}>
                      {conMiles(resumen.casilleros.vigente[c])}
                    </td>
                    <td className={MONTO}>
                      {diferenciaConTexto(resumen.casilleros.diferencia[c])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table
              aria-label={TEXTOS_RESUMEN.particion}
              className="w-full text-left text-sm"
            >
              <thead>
                <tr>
                  <th scope="col" className="px-2 py-1">
                    {TEXTOS_RESUMEN.casillero}
                  </th>
                  <th scope="col" className={`${MONTO} py-1`}>
                    {M.filasConIgv(resumen.conIgv.n)}
                  </th>
                  <th scope="col" className={`${MONTO} py-1`}>
                    {M.filasSinIgv(resumen.sinIgv.n)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {CASILLEROS.map((c) => (
                  <tr key={c} className="border-t">
                    <th scope="row" className="px-2 py-1 font-normal">
                      {M.casilleros[c]}
                    </th>
                    <td className={MONTO}>
                      {conMiles(resumen.conIgv.casilleros[c])}
                    </td>
                    <td className={MONTO}>
                      {conMiles(resumen.sinIgv.casilleros[c])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
