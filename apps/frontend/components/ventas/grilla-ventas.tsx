"use client";

import { useEffect, useRef, useState } from "react";
import type { VentaDto } from "@contapp/shared";
import { MENSAJES_VENTAS as M, NOMBRE_TIPO_COMPROBANTE } from "../../lib/ventas";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  anilloFoco,
} from "../ui";

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

// Alto fijo de 36 px (P-2): las celdas no llevan relleno vertical y los botones de fila son compactos.
const CELDA = "whitespace-nowrap px-2 py-0";
// Bajo 1024 px un pseudo-elemento amplía el área táctil a 44 px de alto sin cambiar el tamaño visual (P-2, regla 5).
const BOTON_FILA =
  "relative ml-2 h-7 px-2 text-xs max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-2 max-lg:before:min-h-11 max-lg:before:-translate-y-px max-lg:before:content-['']";

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
    <TableRow
      style={{ height: ALTO_FILA }}
      data-resaltada={resaltada ? "true" : undefined}
      className={`${resaltada ? "bg-aviso-fondo hover:bg-aviso-fondo" : ""} ${exclusion ? "text-tinta-suave" : ""}`}
    >
      <TableCell className={CELDA} title={NOMBRE_TIPO_COMPROBANTE[v.tipo]}>
        {v.tipo}
      </TableCell>
      <TableCell className={`${CELDA} font-mono`}>
        {v.serie}-{v.numero}
        {v.origen === "manual" && (
          <Badge tono="neutro" className="ml-2 h-5 px-2 font-sans">
            Manual
          </Badge>
        )}
        {!v.cuadra && (
          <Badge tono="error" className="ml-2 h-5 px-2 font-sans">
            {M.noCuadra}
          </Badge>
        )}
        {exclusion && (
          <Badge
            tono="aviso"
            className="ml-2 h-5 px-2 font-sans"
            title={M.motivoDeExclusion(exclusion.motivo)}
          >
            {M.marcaExcluida}
            <span className="font-normal">{M.motivoDeExclusion(exclusion.motivo)}</span>
          </Badge>
        )}
        {v.origen === "manual" && alQuitar && (
          <Button
            type="button"
            variant="secundario"
            disabled={bloqueo !== null}
            title={bloqueo ?? undefined}
            onClick={() => alQuitar(v)}
            className={`${BOTON_FILA} font-sans`}
          >
            {M.quitar}
          </Button>
        )}
        {!exclusion && alExcluir && (
          <Button
            type="button"
            variant="secundario"
            aria-label={M.excluirComprobante(clave)}
            disabled={bloqueo !== null}
            title={bloqueo ?? undefined}
            onClick={() => alExcluir(v)}
            className={`${BOTON_FILA} font-sans`}
          >
            {M.excluir}
          </Button>
        )}
        {exclusion && alRestaurar && (
          <Button
            type="button"
            variant="secundario"
            aria-label={`${M.restaurar} ${clave}`}
            disabled={bloqueo !== null}
            title={bloqueo ?? undefined}
            onClick={() => alRestaurar(v)}
            className={`${BOTON_FILA} font-sans`}
          >
            {M.restaurar}
          </Button>
        )}
      </TableCell>
      <TableCell className={CELDA}>{v.fechaEmision}</TableCell>
      <TableCell className={`${CELDA} font-mono`}>
        {v.tipoDocContraparte ? `${v.tipoDocContraparte} ` : ""}
        {v.docContraparte}
      </TableCell>
      <TableCell className={CELDA}>{v.moneda}</TableCell>
      <TableCell numerico className={CELDA}>{v.tipoCambio ?? ""}</TableCell>
      <TableCell numerico className={CELDA}>{v.baseGravada}</TableCell>
      <TableCell numerico className={CELDA}>{v.igv}</TableCell>
      <TableCell numerico className={CELDA}>{v.exonerada}</TableCell>
      <TableCell numerico className={CELDA}>{v.inafecta}</TableCell>
      <TableCell numerico className={CELDA}>{v.isc}</TableCell>
      <TableCell numerico className={CELDA}>{v.icbper}</TableCell>
      <TableCell numerico className={CELDA}>{v.otros}</TableCell>
      <TableCell numerico className={CELDA}>{v.total}</TableCell>
    </TableRow>
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
      className={`overflow-auto rounded-control border border-linea bg-hoja ${anilloFoco}`}
    >
      <Table desplazable={false}>
        <caption className="sr-only">{M.tablaVentas}</caption>
        <TableHeader className="sticky top-0 z-10 shadow-[0_1px_0_var(--color-linea)]">
          <TableRow className="hover:bg-hoja-alterna">
            {COLUMNAS.map((c, i) => (
              <TableHead
                key={c}
                scope="col"
                className={`${CELDA} py-2 ${i >= 5 ? "text-right" : ""}`}
              >
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
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
            <TableRow>
              <TableCell colSpan={COLUMNAS.length} className="px-2 py-3 text-tinta-suave">
                {M.sinVentas}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
