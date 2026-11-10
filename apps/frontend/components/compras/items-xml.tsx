"use client";

import type { ItemXml } from "@contapp/shared";
import { MENSAJES_LUPA as L, etiquetaAfectacion } from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";

// Ítems del XML (spec 016, CA-14, RF-092). La descripción es texto del XML: React la escapa y un `<script>` se ve
// como texto. Cantidad y precio unitario conservan el texto exacto del XML (hasta 10 decimales); valor, IGV, ISC
// e ICBPER son montos de 2 decimales y solo reciben formato de miles.

export function ItemsXml({
  items,
  hayXml,
}: {
  items: readonly ItemXml[];
  hayXml: boolean;
}) {
  const T = L.items;
  return (
    <section aria-label={L.secciones.items} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{L.secciones.items}</h3>
      {!hayXml ? (
        <p className="text-sm">{T.sinXml}</p>
      ) : items.length === 0 ? (
        <p className="text-sm">{T.sinItems}</p>
      ) : (
        <div className="max-h-64 overflow-auto">
          <table aria-label={T.tabla} className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th scope="col" className="py-1 pr-2">{T.descripcion}</th>
                <th scope="col" className="py-1 pr-2 text-right">{T.cantidad}</th>
                <th scope="col" className="py-1 pr-2">{T.unidad}</th>
                <th scope="col" className="py-1 pr-2 text-right">{T.precioUnitario}</th>
                <th scope="col" className="py-1 pr-2 text-right">{T.valor}</th>
                <th scope="col" className="py-1 pr-2">{T.afectacion}</th>
                <th scope="col" className="py-1 pr-2 text-right">{T.igv}</th>
                <th scope="col" className="py-1 pr-2 text-right">{T.isc}</th>
                <th scope="col" className="py-1 text-right">{T.icbper}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="py-1 pr-2 break-words">{item.descripcion}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{item.cantidad}</td>
                  <td className="py-1 pr-2">{item.unidad}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{item.precioUnitario}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{conMiles(item.valor)}</td>
                  <td className="py-1 pr-2">{etiquetaAfectacion(item.afectacion)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{conMiles(item.igv)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{conMiles(item.isc)}</td>
                  <td className="py-1 text-right tabular-nums">{conMiles(item.icbper)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
