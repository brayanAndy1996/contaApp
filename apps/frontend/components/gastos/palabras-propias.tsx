import type { PalabraPropiaVista } from "@contapp/shared";
import { etiquetaAutor } from "../../lib/autor";
import { MENSAJES_GASTOS as M, etiquetaCategoria } from "../../lib/gastos";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { CABECERA, CELDA, FILA, MARCO_TABLA } from "./estilos";

// Palabras propias del estudio (spec 027, R-4, R-7): origen (manual o aprendida al excluir), autor y estado. Desactivar o
// reactivar manda la versión de la fila (compare-and-set). Los textos del servidor se pintan siempre como texto.

export function PalabrasPropias({
  palabras,
  puedeCambiar,
  ocupado,
  alCambiar,
}: {
  palabras: readonly PalabraPropiaVista[];
  puedeCambiar: boolean;
  ocupado: boolean;
  alCambiar: (palabra: PalabraPropiaVista, activa: boolean) => void;
}) {
  return (
    <div className={MARCO_TABLA}>
      <Table desplazable={false} role="table" aria-label={M.tituloPropias} className="max-md:block">
        <TableHeader role="rowgroup" className="max-md:sr-only">
          <TableRow role="row" className="hover:bg-transparent">
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.palabra}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.categoria}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.excepciones}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.origen}</TableHead>
            <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.autor}</TableHead>
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
              <TableCell role="cell" data-etiqueta={M.columnas.origen} className={CELDA}>
                <Badge tono={p.origen === "aprendida" ? "info" : "neutro"}>{M.origen[p.origen]}</Badge>
              </TableCell>
              <TableCell role="cell" data-etiqueta={M.columnas.autor} className={CELDA}>
                {M.autorDe(etiquetaAutor(p.autor))}
              </TableCell>
              <TableCell role="cell" data-etiqueta={M.columnas.estado} className={CELDA}>
                {p.activa ? <Badge tono="ok">{M.activa}</Badge> : <Badge>{M.propiaInactiva}</Badge>}
              </TableCell>
              {puedeCambiar && (
                <TableCell role="cell" data-etiqueta={M.columnas.acciones} className={CELDA}>
                  <Button
                    variant="secundario"
                    size="sm"
                    disabled={ocupado}
                    aria-label={p.activa ? M.desactivarPropia(p.palabra) : M.reactivarPropia(p.palabra)}
                    onClick={() => alCambiar(p, !p.activa)}
                    className="max-lg:h-11"
                  >
                    {p.activa ? M.desactivar : M.reactivar}
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
