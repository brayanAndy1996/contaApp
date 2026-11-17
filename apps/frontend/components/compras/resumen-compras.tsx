"use client";

import type { ResumenComprasVista } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { conMiles, iguales } from "../../lib/montos-compras";
import {
  Alert,
  Card,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cifra,
} from "../ui";

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
  alcance: "no cambia con los filtros de la grilla.",
  particion: "Con IGV y sin IGV",
  aumenta: "aumenta",
  disminuye: "disminuye",
  sinCambio: "sin cambio",
} as const;

const MONTO = cifra;
const CABECERA_MONTO = "text-right";

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
    <Card aria-label={M.tituloResumen}>
      <div className="flex flex-col gap-1">
        <CardTitle>{M.tituloResumen}</CardTitle>
        <p className="m-0 text-sm text-tinta-suave">
          <strong className="text-tinta-media">{M.periodoEntero}</strong>: {TEXTOS_RESUMEN.alcance}
        </p>
      </div>
      {resumen && sinConvertir > 0 && (
        <Alert tono="aviso" role="status">
          {M.avisoSinConvertir(sinConvertir)}
        </Alert>
      )}
      {resumen && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{TEXTOS_RESUMEN.casillero}</TableHead>
                <TableHead scope="col" className={CABECERA_MONTO}>
                  {M.columnaOriginal}
                </TableHead>
                <TableHead scope="col" className={CABECERA_MONTO}>
                  {M.columnaVigente}
                </TableHead>
                <TableHead scope="col" className={CABECERA_MONTO}>
                  {M.columnaDiferencia}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CASILLEROS.map((c) => (
                <TableRow key={c}>
                  <TableHead scope="row" className="text-sm font-normal text-tinta">
                    {M.casilleros[c]}
                  </TableHead>
                  <TableCell className={MONTO}>{conMiles(resumen.casilleros.original[c])}</TableCell>
                  <TableCell className={MONTO}>{conMiles(resumen.casilleros.vigente[c])}</TableCell>
                  <TableCell className={MONTO}>{diferenciaConTexto(resumen.casilleros.diferencia[c])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Table aria-label={TEXTOS_RESUMEN.particion}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{TEXTOS_RESUMEN.casillero}</TableHead>
                <TableHead scope="col" className={CABECERA_MONTO}>
                  {M.filasConIgv(resumen.conIgv.n)}
                </TableHead>
                <TableHead scope="col" className={CABECERA_MONTO}>
                  {M.filasSinIgv(resumen.sinIgv.n)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CASILLEROS.map((c) => (
                <TableRow key={c}>
                  <TableHead scope="row" className="text-sm font-normal text-tinta">
                    {M.casilleros[c]}
                  </TableHead>
                  <TableCell className={MONTO}>{conMiles(resumen.conIgv.casilleros[c])}</TableCell>
                  <TableCell className={MONTO}>{conMiles(resumen.sinIgv.casilleros[c])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Card>
  );
}
