"use client";

import type { MesVista } from "@contapp/shared";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { fechaCorta, fechaHoraLima } from "../../lib/fechas";
import { conMiles } from "../../lib/montos-compras";
import { MENSAJES_PRORRATA as M, etiquetaPeriodo } from "../../lib/prorrata";
import { cn } from "../../lib/utils";

// Tabla mes a mes de la ventana de prorrata (spec 026, T13; CA-3, CA-4, CA-9, R-2b, R-5, D-8). Presentacional: los 12 meses y
// su origen los arma el servidor. Los montos son cadenas con signo que solo se formatean con `conMiles`, como en compras y todo texto del contador (motivo,
// nombre) se pinta como texto de React. Bajo 768 px la tabla se apila por fila (tarjetas), sin desplazamiento horizontal:
// cada celda lleva la etiqueta de su columna en `data-etiqueta`.

const CELDA =
  "px-2 py-2 align-top max-md:flex max-md:gap-2 max-md:px-0 max-md:py-1 max-md:before:w-28 max-md:before:shrink-0 max-md:before:font-semibold max-md:before:text-tinta-suave max-md:before:content-[attr(data-etiqueta)]";
const NUMERO = "md:whitespace-nowrap md:text-right";
const CABECERA = "px-2 py-2";

type TonoOrigen = "ok" | "info" | "aviso" | "error" | "neutro";

function origenDe(mes: MesVista): { texto: string; tono: TonoOrigen } {
  if (mes.origen === "declarado") {
    return mes.declaracion?.tipo === "rectificatoria"
      ? { texto: M.origen.rectificatoria, tono: "info" }
      : { texto: M.origen.declarado, tono: "ok" };
  }
  if (mes.origen === "manual") return { texto: M.origen.manual, tono: "aviso" };
  if (mes.origen === "sire") return { texto: M.origen.sire, tono: "neutro" };
  return { texto: M.origen.falta, tono: "error" };
}

export function TablaMeses({
  meses,
  puedeGestionar,
  alIngresar,
  alHistorial,
}: {
  meses: readonly MesVista[];
  puedeGestionar: boolean;
  alIngresar: (periodo: string) => void;
  alHistorial: (periodo: string) => void;
}) {
  return (
    <div className="min-w-0 md:overflow-hidden md:rounded-tarjeta md:border md:border-linea md:bg-hoja md:shadow-tarjeta">
      <Table desplazable={false} aria-label={M.tablaMeses} className="max-md:block">
        <TableHeader className="max-md:sr-only">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={CABECERA}>{M.columnas.mes}</TableHead>
            <TableHead scope="col" className={cn(CABECERA, "md:text-right")}>{M.columnas.gravadas}</TableHead>
            <TableHead scope="col" className={cn(CABECERA, "md:text-right")}>{M.columnas.exportaciones}</TableHead>
            <TableHead scope="col" className={cn(CABECERA, "md:text-right")}>{M.columnas.noGravadas}</TableHead>
            <TableHead scope="col" className={cn(CABECERA, "md:text-right")}>{M.columnas.total}</TableHead>
            <TableHead scope="col" className={CABECERA}>{M.columnas.origen}</TableHead>
            <TableHead scope="col" className={CABECERA}>{M.columnaAcciones}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-md:block">
          {meses.map((m) => {
            const origen = origenDe(m);
            const etiqueta = etiquetaPeriodo(m.periodo);
            const sinDeclaracion = m.origen !== "declarado";
            return (
              <TableRow
                key={m.periodo}
                id={`mes-${m.periodo}`}
                className="scroll-mt-20 align-top max-md:mb-3 max-md:flex max-md:flex-col max-md:rounded-control max-md:border max-md:border-linea max-md:bg-hoja max-md:p-3 max-md:shadow-tarjeta"
              >
                <TableCell data-etiqueta={M.columnas.mes} className={cn(CELDA, "font-semibold md:whitespace-nowrap")}>
                  {etiqueta}
                </TableCell>
                <TableCell data-etiqueta={M.columnas.gravadas} className={cn(CELDA, "cifras", NUMERO)}>{conMiles(m.gravadas)}</TableCell>
                <TableCell data-etiqueta={M.columnas.exportaciones} className={cn(CELDA, "cifras", NUMERO)}>{conMiles(m.exportaciones)}</TableCell>
                <TableCell data-etiqueta={M.columnas.noGravadas} className={cn(CELDA, "cifras", NUMERO)}>{conMiles(m.noGravadas)}</TableCell>
                <TableCell data-etiqueta={M.columnas.total} className={cn(CELDA, "cifras", NUMERO)}>{conMiles(m.total)}</TableCell>
                <TableCell data-etiqueta={M.columnas.origen} className={cn(CELDA, "min-w-0 break-words")}>
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <Badge tono={origen.tono}>{origen.texto}</Badge>
                    {m.declaracion && (
                      <span className="text-[13px] text-tinta-suave">
                        {M.detalleDeclaracion(m.declaracion.numeroOrden, fechaCorta(m.declaracion.fechaPresentacion), m.declaracion.presentaciones)}
                      </span>
                    )}
                    {m.origen === "manual" && m.manual && (
                      <>
                        <span className="text-[13px] text-tinta-suave">{M.detalleManual(m.manual.autor.nombre, fechaHoraLima(m.manual.guardadoEn))}</span>
                        <span className="min-w-0 break-words text-[13px] text-tinta-media">{m.manual.motivo}</span>
                      </>
                    )}
                    {m.avisos.map((a) => (
                      <span key={a} className="text-[13px] text-aviso">
                        {M.avisosMes[a]}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell data-etiqueta={M.columnaAcciones} className={CELDA}>
                  <div className="flex min-w-0 flex-wrap gap-2">
                    {puedeGestionar && sinDeclaracion && (
                      <Button
                        type="button"
                        variant="secundario"
                        size="sm"
                        aria-label={M.ingresarAMano(m.periodo)}
                        onClick={() => alIngresar(m.periodo)}
                        className="max-lg:h-11"
                      >
                        {M.botonIngresar}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="terciario"
                      size="sm"
                      aria-label={M.historial(m.periodo)}
                      onClick={() => alHistorial(m.periodo)}
                      className="max-lg:h-11"
                    >
                      {M.botonHistorial}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
