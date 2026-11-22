import type { PalabraGlobalVista } from "@contapp/shared";
import { MENSAJES_GASTOS as M, etiquetaCategoria } from "../../lib/gastos";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { CABECERA, CELDA, FILA, MARCO_TABLA } from "./estilos";

// Palabras globales del diccionario, vistas desde el estudio (spec 027, R-4, D-3): el estudio no las edita, solo las
// desactiva o reactiva para sí. Las palabras y las excepciones son datos del servidor y se pintan como texto.

export function PalabrasGlobales({
  palabras,
  puedeCambiar,
  ocupado,
  alCambiar,
}: {
  palabras: readonly PalabraGlobalVista[];
  puedeCambiar: boolean;
  ocupado: boolean;
  alCambiar: (palabra: PalabraGlobalVista, activa: boolean) => void;
}) {
  return (
    <div className={MARCO_TABLA}>
      <Table desplazable={false} role="table" aria-label={M.tituloGlobales} className="max-md:block">
        <TableHeader role="rowgroup" className="max-md:sr-only">
          <TableRow role="row" className="hover:bg-transparent">
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.palabra}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.categoria}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.excepciones}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.estado}</TableHead>
            {puedeCambiar && <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.acciones}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody role="rowgroup" className="max-md:block">
          {palabras.map((p) => (
            <TableRow key={p.id} role="row" className={FILA}>
              <TableCell role="cell" data-etiqueta={M.columnas.palabra} className={`${CELDA} font-mono font-semibold`}>
                {p.palabra}
              </TableCell>
              <TableCell role="cell" data-etiqueta={M.columnas.categoria} className={CELDA}>
                {etiquetaCategoria(p.categoria)}
              </TableCell>
              <TableCell role="cell" data-etiqueta={M.columnas.excepciones} className={CELDA}>
                {p.excepciones.length === 0 ? M.sinExcepciones : p.excepciones.join(", ")}
              </TableCell>
              <TableCell role="cell" data-etiqueta={M.columnas.estado} className={CELDA}>
                <Badge tono={p.desactivadaPorEstudio ? "aviso" : "ok"} className="h-auto min-h-6 whitespace-normal py-0.5">
                  {p.desactivadaPorEstudio ? M.globalDesactivada : M.activa}
                </Badge>
              </TableCell>
              {puedeCambiar && (
                <TableCell role="cell" data-etiqueta={M.columnas.acciones} className={CELDA}>
                  <Button
                    variant="secundario"
                    size="sm"
                    disabled={ocupado}
                    aria-label={p.desactivadaPorEstudio ? M.reactivarGlobal(p.palabra) : M.desactivarGlobal(p.palabra)}
                    onClick={() => alCambiar(p, p.desactivadaPorEstudio)}
                    className="max-lg:h-11"
                  >
                    {p.desactivadaPorEstudio ? M.reactivar : M.desactivar}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
