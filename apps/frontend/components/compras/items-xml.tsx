"use client";

import type { ItemXml } from "@contapp/shared";
import { MENSAJES_LUPA as L, etiquetaAfectacion } from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";

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
      <h3 className="text-sm font-semibold text-tinta">{L.secciones.items}</h3>
      {!hayXml ? (
        <p className="text-sm text-tinta-media">{T.sinXml}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-tinta-media">{T.sinItems}</p>
      ) : (
        <div className="max-h-64 overflow-auto rounded-control border border-linea">
          <Table aria-label={T.tabla} desplazable={false}>
            <TableHeader className="sticky top-0">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{T.descripcion}</TableHead>
                <TableHead scope="col" className="text-right">{T.cantidad}</TableHead>
                <TableHead scope="col">{T.unidad}</TableHead>
                <TableHead scope="col" className="text-right">{T.precioUnitario}</TableHead>
                <TableHead scope="col" className="text-right">{T.valor}</TableHead>
                <TableHead scope="col">{T.afectacion}</TableHead>
                <TableHead scope="col" className="text-right">{T.igv}</TableHead>
                <TableHead scope="col" className="text-right">{T.isc}</TableHead>
                <TableHead scope="col" className="text-right">{T.icbper}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, i) => (
                <TableRow key={i} className="align-top">
                  <TableCell className="break-words py-2">{item.descripcion}</TableCell>
                  <TableCell numerico className="py-2">{item.cantidad}</TableCell>
                  <TableCell className="py-2">{item.unidad}</TableCell>
                  <TableCell numerico className="py-2">{item.precioUnitario}</TableCell>
                  <TableCell numerico className="py-2">{conMiles(item.valor)}</TableCell>
                  <TableCell className="py-2">{etiquetaAfectacion(item.afectacion)}</TableCell>
                  <TableCell numerico className="py-2">{conMiles(item.igv)}</TableCell>
                  <TableCell numerico className="py-2">{conMiles(item.isc)}</TableCell>
                  <TableCell numerico className="py-2">{conMiles(item.icbper)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
