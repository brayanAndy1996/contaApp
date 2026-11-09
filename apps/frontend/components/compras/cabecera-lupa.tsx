"use client";

import type { CabeceraLupa } from "@contapp/shared";
import type { ReactNode } from "react";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { MENSAJES_LUPA as L, etiquetaTipo } from "../../lib/lupa-compras";

// Cabecera de la lupa (spec 016, CA-14, RF-091): RUC, razón social, «Proveedor nuevo», tipo, serie-número, fecha,
// moneda, tipo de cambio y origen de la serie. Todo es texto del servidor ya validado: React lo escapa, nada se
// interpreta como HTML. El tipo de cambio se muestra tal como llega (cadena decimal).

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-gray-700">{etiqueta}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function CabeceraLupaCompra({ cabecera }: { cabecera: CabeceraLupa }) {
  const C = L.cabecera;
  return (
    <section aria-label={L.secciones.cabecera} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{L.secciones.cabecera}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
        <Dato etiqueta={C.ruc}>{cabecera.ruc}</Dato>
        <Dato etiqueta={C.razonSocial}>
          <span>{cabecera.razonSocial ?? C.sinDato}</span>
          {cabecera.proveedorNuevo && (
            <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium">
              {M.proveedorNuevo}
            </span>
          )}
        </Dato>
        <Dato etiqueta={C.tipo}>{etiquetaTipo(cabecera.tipo)}</Dato>
        <Dato etiqueta={C.comprobante}>{`${cabecera.serie}-${cabecera.numero}`}</Dato>
        <Dato etiqueta={C.fecha}>{cabecera.fecha}</Dato>
        <Dato etiqueta={C.moneda}>{cabecera.moneda}</Dato>
        <Dato etiqueta={C.tipoCambio}>{cabecera.tipoCambio ?? C.sinDato}</Dato>
        <Dato etiqueta={C.origenSerie}>
          {cabecera.origenSerie === null ? C.sinDato : L.origenSerie[cabecera.origenSerie]}
        </Dato>
      </dl>
    </section>
  );
}
