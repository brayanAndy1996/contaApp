"use client";

import { useState } from "react";
import type { VentaDto } from "@contapp/shared";
import { MENSAJES_VENTAS as M, NOMBRE_TIPO_COMPROBANTE } from "../../lib/ventas";

// Grilla de ventas del periodo (spec 013, D10; RF-052). Virtualizada a mano: solo se pintan las filas que
// caben en la ventana de desplazamiento más un margen, con filas de alto fijo y dos filas separadoras
// ocultas que conservan la altura total. Los montos y los textos del SIRE se muestran tal como llegan
// (React los escapa); aquí no se convierte, suma ni da formato a ningún monto.

const ALTO_FILA = 36;
const ALTO_VENTANA = 480;
const MARGEN_FILAS = 8;

const COLUMNAS = [
  "Tipo",
  "Comprobante",
  "Fecha",
  "Documento",
  "Moneda",
  "T. cambio",
  "Base gravada",
  "IGV",
  "Exonerada",
  "Inafecta",
  "ISC",
  "ICBPER",
  "Otros",
  "Total",
] as const;

const CELDA = "whitespace-nowrap px-2";
const CELDA_MONTO = `${CELDA} text-right tabular-nums`;

function FilaVenta({
  v,
  alQuitar,
}: {
  v: VentaDto;
  alQuitar?: (v: VentaDto) => void;
}) {
  return (
    <tr style={{ height: ALTO_FILA }} className="border-t">
      <td className={CELDA} title={NOMBRE_TIPO_COMPROBANTE[v.tipo]}>
        {v.tipo}
      </td>
      <td className={CELDA}>
        {v.serie}-{v.numero}
        {v.origen === "manual" && (
          <span className="ml-2 rounded border px-1 text-xs">Manual</span>
        )}
        {v.origen === "manual" && alQuitar && (
          <button
            type="button"
            onClick={() => alQuitar(v)}
            className="ml-2 rounded border px-2 text-xs"
          >
            {M.quitar}
          </button>
        )}
      </td>
      <td className={CELDA}>{v.fechaEmision}</td>
      <td className={CELDA}>
        {v.tipoDocContraparte ? `${v.tipoDocContraparte} ` : ""}
        {v.docContraparte}
      </td>
      <td className={CELDA}>{v.moneda}</td>
      <td className={CELDA_MONTO}>{v.tipoCambio ?? ""}</td>
      <td className={CELDA_MONTO}>{v.baseGravada}</td>
      <td className={CELDA_MONTO}>{v.igv}</td>
      <td className={CELDA_MONTO}>{v.exonerada}</td>
      <td className={CELDA_MONTO}>{v.inafecta}</td>
      <td className={CELDA_MONTO}>{v.isc}</td>
      <td className={CELDA_MONTO}>{v.icbper}</td>
      <td className={CELDA_MONTO}>{v.otros}</td>
      <td className={CELDA_MONTO}>{v.total}</td>
    </tr>
  );
}

export function GrillaVentas({
  filas,
  alQuitar,
}: {
  filas: VentaDto[];
  /** «Quitar» solo en las ventas de origen `manual` y solo si la pantalla lo pasa (`sire.clasificar`, cliente activo). */
  alQuitar?: (v: VentaDto) => void;
}) {
  const [desplazamiento, setDesplazamiento] = useState(0);

  const inicio = Math.max(
    0,
    Math.floor(desplazamiento / ALTO_FILA) - MARGEN_FILAS,
  );
  const fin = Math.min(
    filas.length,
    Math.ceil((desplazamiento + ALTO_VENTANA) / ALTO_FILA) + MARGEN_FILAS,
  );
  const visibles = filas.slice(inicio, fin);

  return (
    <div
      tabIndex={0}
      onScroll={(e) => setDesplazamiento(e.currentTarget.scrollTop)}
      style={{ maxHeight: ALTO_VENTANA }}
      className="overflow-auto rounded border"
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{M.tablaVentas}</caption>
        <thead className="sticky top-0 bg-white">
          <tr>
            {COLUMNAS.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={`${CELDA} py-2 ${i >= 5 ? "text-right" : ""}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {inicio > 0 && (
            <tr aria-hidden="true" style={{ height: inicio * ALTO_FILA }}>
              <td colSpan={COLUMNAS.length} />
            </tr>
          )}
          {visibles.map((v) => (
            <FilaVenta key={v.id} v={v} alQuitar={alQuitar} />
          ))}
          {fin < filas.length && (
            <tr
              aria-hidden="true"
              style={{ height: (filas.length - fin) * ALTO_FILA }}
            >
              <td colSpan={COLUMNAS.length} />
            </tr>
          )}
          {filas.length === 0 && (
            <tr>
              <td colSpan={COLUMNAS.length} className="px-2 py-3">
                {M.sinVentas}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
