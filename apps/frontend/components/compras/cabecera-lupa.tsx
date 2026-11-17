"use client";

import type { CabeceraLupa } from "@contapp/shared";
import type { ReactNode } from "react";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { MENSAJES_LUPA as L, etiquetaTipo } from "../../lib/lupa-compras";
import { MENSAJES_REGLAS as R } from "../../lib/reglas";
import { Badge } from "../ui";

// Cabecera de la lupa (spec 016, CA-14, RF-091): RUC, razón social, «Proveedor nuevo», tipo, serie-número, fecha,
// moneda, tipo de cambio y origen de la serie. Todo es texto del servidor ya validado: React lo escapa, nada se
// interpreta como HTML. El tipo de cambio se muestra tal como llega (cadena decimal).

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs font-semibold text-tinta-suave">{etiqueta}</dt>
      <dd className="text-sm text-tinta">{children}</dd>
    </div>
  );
}

export function CabeceraLupaCompra({
  cabecera,
  segunHistorial = false,
}: {
  cabecera: CabeceraLupa;
  /** La fila vigente la clasificó R-HIS (spec 021): se rotula con texto, no solo con color. */
  segunHistorial?: boolean;
}) {
  const C = L.cabecera;
  return (
    <section aria-label={L.secciones.cabecera} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-tinta">{L.secciones.cabecera}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
        <Dato etiqueta={C.ruc}>
          <span className="font-mono">{cabecera.ruc}</span>
        </Dato>
        <Dato etiqueta={C.razonSocial}>
          <span>{cabecera.razonSocial ?? C.sinDato}</span>
          {cabecera.proveedorNuevo && (
            <Badge tono="aviso" className="ml-2">
              {M.proveedorNuevo}
            </Badge>
          )}
          {segunHistorial && (
            <Badge tono="ok" className="ml-2">
              {R.segunHistorial}
            </Badge>
          )}
        </Dato>
        <Dato etiqueta={C.tipo}>{etiquetaTipo(cabecera.tipo)}</Dato>
        <Dato etiqueta={C.comprobante}>
          <span className="font-mono">{`${cabecera.serie}-${cabecera.numero}`}</span>
        </Dato>
        <Dato etiqueta={C.fecha}>{cabecera.fecha}</Dato>
        <Dato etiqueta={C.moneda}>{cabecera.moneda}</Dato>
        <Dato etiqueta={C.tipoCambio}>
          <span className="cifras">{cabecera.tipoCambio ?? C.sinDato}</span>
        </Dato>
        <Dato etiqueta={C.origenSerie}>
          {cabecera.origenSerie === null ? C.sinDato : L.origenSerie[cabecera.origenSerie]}
        </Dato>
      </dl>
    </section>
  );
}
