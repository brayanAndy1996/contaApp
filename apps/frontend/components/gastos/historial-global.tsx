import type { HistorialGlobalVista } from "@contapp/shared";
import { etiquetaAutor } from "../../lib/autor";
import { fechaHoraLima } from "../../lib/fechas";
import { MENSAJES_GASTOS as M } from "../../lib/gastos";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { CABECERA, CELDA, FILA, MARCO_TABLA } from "./estilos";

// Historial de cambios del diccionario global (spec 027, D-2, D-4): una fila por cambio, el más reciente primero, con la
// acción, la palabra, el autor y la fecha en hora de Lima. «Ver más» pide la página siguiente. Todo texto del servidor se
// pinta como texto.

export function HistorialGlobal({
  items,
  hayMas,
  cargandoMas,
  alVerMas,
}: {
  items: HistorialGlobalVista["items"];
  hayMas: boolean;
  cargandoMas: boolean;
  alVerMas: () => void;
}) {
  if (items.length === 0) return <p className="m-0 text-tinta-media">{M.sinHistorial}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className={MARCO_TABLA}>
        <Table desplazable={false} role="table" aria-label={M.tituloHistorial} className="max-md:block">
          <TableHeader role="rowgroup" className="max-md:sr-only">
            <TableRow role="row" className="hover:bg-transparent">
              <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.fecha}</TableHead>
              <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.accion}</TableHead>
              <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.palabra}</TableHead>
              <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.autor}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody role="rowgroup" className="max-md:block">
            {items.map((c) => (
              <TableRow key={c.id} role="row" className={FILA}>
                <TableCell role="cell" data-etiqueta={M.columnas.fecha} className={CELDA}>
                  {fechaHoraLima(c.ocurridaEn)}
                </TableCell>
                <TableCell role="cell" data-etiqueta={M.columnas.accion} className={CELDA}>
                  {M.accion[c.accion]}
                </TableCell>
                <TableCell role="cell" data-etiqueta={M.columnas.palabra} className={`${CELDA} font-mono font-semibold`}>
                  {c.palabra}
                </TableCell>
                <TableCell role="cell" data-etiqueta={M.columnas.autor} className={CELDA}>
                  {etiquetaAutor(c.autor)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hayMas && (
        <div>
          <Button variant="secundario" disabled={cargandoMas} onClick={alVerMas} className="max-lg:h-11">
            {M.verMas}
          </Button>
        </div>
      )}
    </div>
  );
}
