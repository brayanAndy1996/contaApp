"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui";
import { fechaCorta, fechaHoraLima } from "../../lib/fechas";
import { MENSAJES_PRORRATA as M, leerHistorialMes, type HistorialMesVista } from "../../lib/prorrata";
import { cn } from "../../lib/utils";

// Historial de un mes (spec 026, T13; CA-3, CA-4, D-4, R-5): las presentaciones del PDT 621 (la original y las rectificatorias
// se conservan) y las versiones del mes manual, en el orden que manda el servidor. Todo, incluido el motivo, se pinta como
// texto. Bajo 768 px cada fila se apila (sin desplazamiento horizontal).

const CELDA =
  "px-2 py-2 align-top max-md:flex max-md:gap-2 max-md:px-0 max-md:py-1 max-md:before:w-28 max-md:before:shrink-0 max-md:before:font-semibold max-md:before:text-tinta-suave max-md:before:content-[attr(data-etiqueta)]";
const NUMERO = "md:whitespace-nowrap md:text-right";
const FILA =
  "align-top max-md:mb-3 max-md:flex max-md:flex-col max-md:rounded-control max-md:border max-md:border-linea max-md:bg-hoja max-md:p-3";

const SIN_MONTO = "—";

export function HistorialMes({ clienteId, periodo, alCerrar }: { clienteId: string; periodo: string; alCerrar: () => void }) {
  const [historial, setHistorial] = useState<HistorialMesVista | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    setHistorial(null);
    setError(null);
    leerHistorialMes(clienteId, periodo)
      .then((r) => {
        if (!vigente) return;
        if (r.ok) setHistorial(r.datos);
        else if (r.status !== 401) setError(r.mensaje);
      })
      .catch(() => {
        if (vigente) setError(M.errorCarga);
      });
    return () => {
      vigente = false;
    };
  }, [clienteId, periodo]);

  const vacio = historial !== null && historial.declaraciones.length === 0 && historial.manual.length === 0;
  const H = M.columnasHistorial;

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent mostrarCerrar={false} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{M.tituloHistorial(periodo)}</DialogTitle>
          <DialogDescription>{M.descripcionHistorial}</DialogDescription>
        </DialogHeader>
        {error && <Alert tono="error">{error}</Alert>}
        {historial === null && !error && <p className="m-0 text-sm text-tinta-suave">{M.cargandoHistorial}</p>}
        {vacio && <p className="m-0 text-sm text-tinta-suave">{M.sinHistorial}</p>}
        {historial && historial.declaraciones.length > 0 && (
          <Table desplazable={false} aria-label={M.tablaDeclaraciones} className="max-md:block">
            <TableHeader className="max-md:sr-only">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{H.numeroOrden}</TableHead>
                <TableHead scope="col">{H.tipo}</TableHead>
                <TableHead scope="col">{H.fecha}</TableHead>
                <TableHead scope="col">{M.columnas.gravadas}</TableHead>
                <TableHead scope="col">{M.columnas.exportaciones}</TableHead>
                <TableHead scope="col">{M.columnas.noGravadas}</TableHead>
                <TableHead scope="col">{H.prorrataUsada}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-md:block">
              {historial.declaraciones.map((d) => (
                <TableRow key={d.numeroOrden} className={FILA}>
                  <TableCell data-etiqueta={H.numeroOrden} className={CELDA}>{d.numeroOrden}</TableCell>
                  <TableCell data-etiqueta={H.tipo} className={CELDA}>{M.tipoDeclaracion[d.tipo]}</TableCell>
                  <TableCell data-etiqueta={H.fecha} className={CELDA}>{fechaCorta(d.fechaPresentacion)}</TableCell>
                  <TableCell data-etiqueta={M.columnas.gravadas} className={cn(CELDA, "cifras", NUMERO)}>{d.gravadas}</TableCell>
                  <TableCell data-etiqueta={M.columnas.exportaciones} className={cn(CELDA, "cifras", NUMERO)}>{d.exportaciones}</TableCell>
                  <TableCell data-etiqueta={M.columnas.noGravadas} className={cn(CELDA, "cifras", NUMERO)}>{d.noGravadas}</TableCell>
                  <TableCell data-etiqueta={H.prorrataUsada} className={cn(CELDA, "cifras", NUMERO)}>
                    {d.prorrataUsada === null ? SIN_MONTO : M.porcentaje(d.prorrataUsada)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {historial && historial.manual.length > 0 && (
          <Table desplazable={false} aria-label={M.tablaVersiones} className="max-md:block">
            <TableHeader className="max-md:sr-only">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{H.version}</TableHead>
                <TableHead scope="col">{H.accion}</TableHead>
                <TableHead scope="col">{M.columnas.gravadas}</TableHead>
                <TableHead scope="col">{M.columnas.exportaciones}</TableHead>
                <TableHead scope="col">{M.columnas.noGravadas}</TableHead>
                <TableHead scope="col">{H.motivo}</TableHead>
                <TableHead scope="col">{H.autor}</TableHead>
                <TableHead scope="col">{H.en}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-md:block">
              {historial.manual.map((v) => (
                <TableRow key={v.version} className={FILA}>
                  <TableCell data-etiqueta={H.version} className={CELDA}>{v.version}</TableCell>
                  <TableCell data-etiqueta={H.accion} className={CELDA}>{M.accionManual[v.accion]}</TableCell>
                  <TableCell data-etiqueta={M.columnas.gravadas} className={cn(CELDA, "cifras", NUMERO)}>{v.montos?.gravadas ?? SIN_MONTO}</TableCell>
                  <TableCell data-etiqueta={M.columnas.exportaciones} className={cn(CELDA, "cifras", NUMERO)}>{v.montos?.exportaciones ?? SIN_MONTO}</TableCell>
                  <TableCell data-etiqueta={M.columnas.noGravadas} className={cn(CELDA, "cifras", NUMERO)}>{v.montos?.noGravadas ?? SIN_MONTO}</TableCell>
                  <TableCell data-etiqueta={H.motivo} className={cn(CELDA, "min-w-0 break-words")}>{v.motivo}</TableCell>
                  <TableCell data-etiqueta={H.autor} className={cn(CELDA, "min-w-0 break-words")}>{v.autor.nombre}</TableCell>
                  <TableCell data-etiqueta={H.en} className={cn(CELDA, "md:whitespace-nowrap")}>{fechaHoraLima(v.en)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DialogFooter>
          <Button type="button" variant="secundario" onClick={alCerrar} className="max-lg:h-11">
            {M.cerrar}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
