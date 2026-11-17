import Link from "next/link";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  enlace,
} from "../ui";
import { fechaHoraLima } from "../../lib/fechas";
import { MENSAJES_BUZON as M, etiquetaCategoria, hrefMensaje, type MensajeBuzonFila } from "../../lib/buzon";
import { cn } from "../../lib/utils";

// Lista mínima de mensajes del buzón de un cliente (spec 023, CA-6, P-9, D-4). Presentacional: la página lee y
// pagina. Todo sale como texto de React (un asunto con HTML se ve literal). El crítico dice «Crítico · <categoría>»
// con texto, no solo con color.

export function ListaMensajes({ clienteId, mensajes }: { clienteId: string; mensajes: MensajeBuzonFila[] }) {
  if (mensajes.length === 0) {
    return <p className="m-0 text-sm text-tinta-suave">{M.listaVacia}</p>;
  }
  return (
    <Table aria-label={M.tablaMensajes}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{M.columnas.asunto}</TableHead>
          <TableHead>{M.columnas.categoria}</TableHead>
          <TableHead>{M.columnas.fecha}</TableHead>
          <TableHead>{M.columnas.lectura}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mensajes.map((m) => {
          const categoria = etiquetaCategoria(m.categoria);
          return (
            <TableRow key={m.id}>
              <TableCell className="min-w-48 max-w-md break-words">
                <Link
                  href={hrefMensaje(clienteId, m.id)}
                  className={cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center")}
                >
                  {m.asunto}
                </Link>
              </TableCell>
              <TableCell>
                <Badge tono={m.critico ? "error" : "neutro"}>{m.critico ? M.critico(categoria) : categoria}</Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap">{fechaHoraLima(m.fecha)}</TableCell>
              <TableCell className="whitespace-nowrap">
                {m.leidoEnSunat ? M.leidoEnSunat : M.noLeidoEnSunat}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
