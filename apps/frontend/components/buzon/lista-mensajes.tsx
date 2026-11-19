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

// A menos de 768 px la tabla se apila por fila (como `TablaReglasCliente`, 021 T23a-5; T23a-2 de 023): cada celda lleva la
// etiqueta de su columna en `data-etiqueta` y nada queda detrás de un desplazamiento interior.
const CELDA =
  "px-2 py-2 align-top max-md:flex max-md:gap-2 max-md:px-0 max-md:py-1 max-md:before:w-24 max-md:before:shrink-0 max-md:before:font-semibold max-md:before:text-tinta-suave max-md:before:content-[attr(data-etiqueta)]";
const CABECERA = "px-2 py-2";

export function ListaMensajes({ clienteId, mensajes }: { clienteId: string; mensajes: MensajeBuzonFila[] }) {
  if (mensajes.length === 0) {
    return <p className="m-0 text-sm text-tinta-suave">{M.listaVacia}</p>;
  }
  return (
    <div className="md:overflow-x-clip md:rounded-tarjeta md:border md:border-linea md:bg-hoja md:shadow-tarjeta">
      <Table desplazable={false} aria-label={M.tablaMensajes} className="max-md:block">
        <TableHeader className="max-md:sr-only">
          <TableRow className="hover:bg-transparent">
            <TableHead className={CABECERA}>{M.columnas.asunto}</TableHead>
            <TableHead className={CABECERA}>{M.columnas.categoria}</TableHead>
            <TableHead className={CABECERA}>{M.columnas.fecha}</TableHead>
            <TableHead className={CABECERA}>{M.columnas.lectura}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-md:block">
          {mensajes.map((m) => {
            const categoria = etiquetaCategoria(m.categoria);
            return (
              <TableRow
                key={m.id}
                className="align-top max-md:mb-3 max-md:flex max-md:flex-col max-md:rounded-control max-md:border max-md:border-linea max-md:bg-hoja max-md:p-3 max-md:shadow-tarjeta"
              >
                <TableCell data-etiqueta={M.columnas.asunto} className={cn(CELDA, "min-w-0 break-words md:max-w-md")}>
                  <Link
                    href={hrefMensaje(clienteId, m.id)}
                    className={cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center")}
                  >
                    {m.asunto}
                  </Link>
                </TableCell>
                <TableCell data-etiqueta={M.columnas.categoria} className={CELDA}>
                  <Badge tono={m.critico ? "error" : "neutro"}>{m.critico ? M.critico(categoria) : categoria}</Badge>
                </TableCell>
                <TableCell data-etiqueta={M.columnas.fecha} className={cn(CELDA, "md:whitespace-nowrap")}>
                  {fechaHoraLima(m.fecha)}
                </TableCell>
                <TableCell data-etiqueta={M.columnas.lectura} className={cn(CELDA, "md:whitespace-nowrap")}>
                  {m.leidoEnSunat ? M.leidoEnSunat : M.noLeidoEnSunat}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
