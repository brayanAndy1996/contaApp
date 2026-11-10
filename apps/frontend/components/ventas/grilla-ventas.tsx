"use client";

import { useEffect, useRef, useState } from "react";
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
  alExcluir,
  alRestaurar,
  bloqueo,
  resaltada,
}: {
  v: VentaDto;
  alQuitar?: (v: VentaDto) => void;
  alExcluir?: (v: VentaDto) => void;
  alRestaurar?: (v: VentaDto) => void;
  bloqueo: string | null;
  resaltada: boolean;
}) {
  // `exclusion` llega con 012b; un servidor anterior no la manda y la venta cuenta como no excluida.
  const exclusion = (v as { exclusion?: VentaDto["exclusion"] }).exclusion ?? null;
  const clave = `${v.serie}-${v.numero}`;
  return (
    <tr
      style={{ height: ALTO_FILA }}
      data-resaltada={resaltada ? "true" : undefined}
      className={`border-t ${resaltada ? "bg-yellow-100" : ""} ${exclusion ? "text-gray-600" : ""}`}
    >
      <td className={CELDA} title={NOMBRE_TIPO_COMPROBANTE[v.tipo]}>
        {v.tipo}
      </td>
      <td className={CELDA}>
        {v.serie}-{v.numero}
        {v.origen === "manual" && (
          <span className="ml-2 rounded border px-1 text-xs">Manual</span>
        )}
        {!v.cuadra && (
          <span className="ml-2 rounded border border-red-700 px-1 text-xs font-medium text-red-700">
            {M.noCuadra}
          </span>
        )}
        {exclusion && (
          <span
            className="ml-2 rounded border border-gray-700 px-1 text-xs font-medium"
            title={M.motivoDeExclusion(exclusion.motivo)}
          >
            {M.marcaExcluida}
            <span className="ml-1 font-normal">{M.motivoDeExclusion(exclusion.motivo)}</span>
          </span>
        )}
        {v.origen === "manual" && alQuitar && (
          <button
            type="button"
            disabled={bloqueo !== null}
            title={bloqueo ?? undefined}
            onClick={() => alQuitar(v)}
            className="ml-2 rounded border px-2 text-xs disabled:opacity-50"
          >
            {M.quitar}
          </button>
        )}
        {!exclusion && alExcluir && (
          <button
            type="button"
            aria-label={M.excluirComprobante(clave)}
            disabled={bloqueo !== null}
            title={bloqueo ?? undefined}
            onClick={() => alExcluir(v)}
            className="ml-2 rounded border px-2 text-xs disabled:opacity-50"
          >
            {M.excluir}
          </button>
        )}
        {exclusion && alRestaurar && (
          <button
            type="button"
            aria-label={`${M.restaurar} ${clave}`}
            disabled={bloqueo !== null}
            title={bloqueo ?? undefined}
            onClick={() => alRestaurar(v)}
            className="ml-2 rounded border px-2 text-xs disabled:opacity-50"
          >
            {M.restaurar}
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
  alExcluir,
  alRestaurar,
  puedeExcluir,
  bloqueo = null,
  resaltada = null,
}: {
  filas: VentaDto[];
  /** «Quitar» solo en las ventas de origen `manual` y solo si la pantalla lo pasa (`sire.clasificar`, cliente activo). */
  alQuitar?: (v: VentaDto) => void;
  /** «Excluir» (012b, D12) en las ventas para las que `puedeExcluir` dice sí; sin esta función no hay botón. */
  alExcluir?: (v: VentaDto) => void;
  /** «Restaurar» (012b) en las ventas excluidas; sin esta función no hay botón. */
  alRestaurar?: (v: VentaDto) => void;
  /** La venta del SIRE tiene un error que bloquea la generación (la pantalla lo sabe por el previo y por «No cuadra»). */
  puedeExcluir?: (v: VentaDto) => boolean;
  /** Motivo del bloqueo de las escrituras por el estado del periodo: los botones quedan deshabilitados con este texto. */
  bloqueo?: string | null;
  /** Id de la venta que hay que ubicar y resaltar. */
  resaltada?: string | null;
}) {
  const [desplazamiento, setDesplazamiento] = useState(0);
  const contenedor = useRef<HTMLDivElement>(null);

  // Ubicar una venta: se desplaza hasta su fila (alto fijo) y se resalta.
  useEffect(() => {
    if (resaltada === null) return;
    const i = filas.findIndex((f) => f.id === resaltada);
    if (i === -1 || contenedor.current === null) return;
    const destino = Math.max(0, i * ALTO_FILA - Math.floor(ALTO_VENTANA / 2));
    contenedor.current.scrollTop = destino;
    setDesplazamiento(destino);
    if (typeof contenedor.current.scrollIntoView === "function") {
      contenedor.current.scrollIntoView({ block: "nearest" });
    }
  }, [resaltada, filas]);

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
      ref={contenedor}
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
            <FilaVenta
              key={v.id}
              v={v}
              alQuitar={alQuitar}
              alExcluir={alExcluir && (!puedeExcluir || puedeExcluir(v)) ? alExcluir : undefined}
              alRestaurar={alRestaurar}
              bloqueo={bloqueo}
              resaltada={v.id === resaltada}
            />
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
