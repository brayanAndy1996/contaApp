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
import {
  BADGE_PARTE_LINEA,
  MENSAJES_BANDEJA as B,
  MENSAJES_BUZON as M,
  etiquetaAtencion,
  etiquetaCategoria,
  hrefMensaje,
  type EstadoAtencion,
  type FilaBandeja,
} from "../../lib/buzon";
import { cn } from "../../lib/utils";

// Lista de mensajes del buzón (spec 023, CA-6, P-9, D-4; spec 024, D-4, D-10, CA-3, CA-7, CA-11). Presentacional: la
// bandeja lee y pagina. Todo sale como texto de React (un asunto con HTML se ve literal). El crítico dice
// «Crítico · <categoría>» con texto y con el token de error, no solo con color; la atención también se dice con texto.

// A menos de 768 px la tabla se apila por fila (como `TablaReglasCliente`, 021 T23a-5; T23a-2 de 023): cada celda lleva la
// etiqueta de su columna en `data-etiqueta` y nada queda detrás de un desplazamiento interior.
const CELDA =
  "px-2 py-2 align-top max-md:flex max-md:gap-2 max-md:px-0 max-md:py-1 max-md:before:w-24 max-md:before:shrink-0 max-md:before:font-semibold max-md:before:text-tinta-suave max-md:before:content-[attr(data-etiqueta)]";
const CABECERA = "px-2 py-2";

const TONO_ATENCION = { pendiente: "aviso", atendido: "ok", historico: "neutro" } as const satisfies Record<
  EstadoAtencion,
  "aviso" | "ok" | "neutro"
>;

export interface SeleccionLista {
  ids: ReadonlySet<string>;
  alCambiar: (ids: Set<string>) => void;
}

export function ListaMensajes({
  mensajes,
  mostrarCliente = true,
  seleccion,
}: {
  mensajes: FilaBandeja[];
  /** La bandeja fijada en un cliente no repite la columna «Cliente». */
  mostrarCliente?: boolean;
  /** Casillas para el lote; solo con `buzon.atender`. */
  seleccion?: SeleccionLista;
}) {
  if (mensajes.length === 0) {
    return <p className="m-0 text-sm text-tinta-suave">{M.listaVacia}</p>;
  }

  function alternar(id: string) {
    if (!seleccion) return;
    const nuevos = new Set(seleccion.ids);
    if (nuevos.has(id)) nuevos.delete(id);
    else nuevos.add(id);
    seleccion.alCambiar(nuevos);
  }

  return (
    <div className="md:overflow-x-clip md:rounded-tarjeta md:border md:border-linea md:bg-hoja md:shadow-tarjeta">
      <Table desplazable={false} aria-label={M.tablaMensajes} className="max-md:block">
        <TableHeader className="max-md:sr-only">
          <TableRow className="hover:bg-transparent">
            {seleccion && <TableHead aria-label="Selección" className={CABECERA} />}
            {mostrarCliente && <TableHead className={CABECERA}>{B.columnaCliente}</TableHead>}
            <TableHead className={CABECERA}>{M.columnas.asunto}</TableHead>
            <TableHead className={CABECERA}>{M.columnas.categoria}</TableHead>
            <TableHead className={CABECERA}>{M.columnas.fecha}</TableHead>
            <TableHead className={CABECERA}>{M.columnas.lectura}</TableHead>
            <TableHead className={CABECERA}>{B.columnaAtencion}</TableHead>
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
                {seleccion && (
                  <TableCell className="px-2 py-2 align-top max-md:px-0 max-md:py-1">
                    {/* Bajo 1024 px la etiqueta envolvente da 44 × 44 px de área táctil. */}
                    <label className="flex items-center justify-center max-lg:-m-2 max-lg:size-11 md:size-5">
                      <input
                        type="checkbox"
                        aria-label={B.seleccionar(m.asunto)}
                        checked={seleccion.ids.has(m.id)}
                        disabled={m.cliente.archivado}
                        onChange={() => alternar(m.id)}
                        className="size-5 cursor-pointer accent-primario disabled:cursor-not-allowed disabled:opacity-45 max-lg:size-6"
                      />
                    </label>
                  </TableCell>
                )}
                {mostrarCliente && (
                  <TableCell data-etiqueta={B.columnaCliente} className={cn(CELDA, "min-w-0 break-words")}>
                    {m.cliente.razonSocial}
                    {m.cliente.archivado && <span className="ml-1 text-tinta-suave">(archivado)</span>}
                  </TableCell>
                )}
                <TableCell data-etiqueta={M.columnas.asunto} className={cn(CELDA, "min-w-0 break-words md:max-w-md")}>
                  <Link
                    href={hrefMensaje(m.cliente.id, m.id)}
                    className={cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center")}
                  >
                    {m.asunto}
                  </Link>
                </TableCell>
                <TableCell data-etiqueta={M.columnas.categoria} className={CELDA}>
                  <Badge tono={m.critico ? "error" : "neutro"} className={BADGE_PARTE_LINEA}>{m.critico ? M.critico(categoria) : categoria}</Badge>
                </TableCell>
                <TableCell data-etiqueta={M.columnas.fecha} className={cn(CELDA, "md:whitespace-nowrap")}>
                  {fechaHoraLima(m.fecha)}
                </TableCell>
                <TableCell data-etiqueta={M.columnas.lectura} className={cn(CELDA, "md:whitespace-nowrap")}>
                  {m.leidoEnSunat ? M.leidoEnSunat : M.noLeidoEnSunat}
                </TableCell>
                <TableCell data-etiqueta={B.columnaAtencion} className={CELDA}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tono={TONO_ATENCION[m.atencion.estado]}>{etiquetaAtencion(m.atencion.estado)}</Badge>
                    {m.atencion.estado === "atendido" && m.atencion.por && (
                      <span className="min-w-0 break-words text-xs text-tinta-suave">
                        {B.atencionPor(m.atencion.por.nombre)}
                      </span>
                    )}
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
