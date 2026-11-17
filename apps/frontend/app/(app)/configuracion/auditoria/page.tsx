"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { Autor } from "../../../../components/autor";
import {
  lineasDetalle,
  listarAuditoria,
  MENSAJES_AUDITORIA as M,
  textoAccion,
  textoActor,
  type FilaAuditoria,
} from "../../../../lib/auditoria";
import { fechaHoraLima } from "../../../../lib/fechas";
import {
  Alert,
  Button,
  EncabezadoPagina,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui";

// Consulta de auditoría (spec 017, P-2; CA-12, CA-14): tabla paginada por fecha, sin filtros. Solo con
// `auditoria.ver` (el enlace de la barra se oculta sin el permiso; el backend responde 403). Todo es texto de React:
// una razón social con `<script>` se ve literal. Fechas en hora de Lima. La tabla se desplaza dentro de su propio
// contenedor en pantallas angostas (T18a, P-7) y «Cargar más» no pierde el foco (P-6).

/** Detalle de una fila en líneas cortas (usuario afectado, antes → después, rol, estado…). */
function Detalle({ fila }: { fila: FilaAuditoria }) {
  const lineas = lineasDetalle(fila);
  if (lineas.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-tinta-media">
      {lineas.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

export default function PaginaAuditoria() {
  const [filas, setFilas] = useState<FilaAuditoria[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);

  // P-6: tras «Cargar más» el foco pasa a la primera fila nueva; si la carga falla, se queda en el botón que sigue ahí.
  const cuerpo = useRef<HTMLTableSectionElement>(null);
  const botonMas = useRef<HTMLButtonElement>(null);
  const botonReintentar = useRef<HTMLButtonElement>(null);
  const primeraNueva = useRef<number | null>(null);

  const cargar = useCallback(async (cursor: string | null) => {
    setCargando(true);
    setError(null);
    try {
      const r = await listarAuditoria(cursor);
      if (r.status === 403) {
        setSinPermiso(true);
        return;
      }
      if (!r.ok || !r.datos) {
        if (r.status !== 401) setError(M.errorCarga);
        return;
      }
      const nuevas = r.datos.items;
      setFilas((previas) => (cursor ? [...previas, ...nuevas] : nuevas));
      setSiguiente(r.datos.siguiente);
    } catch {
      setError(M.errorCarga);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar(null);
  }, [cargar]);

  useEffect(() => {
    if (cargando || primeraNueva.current === null) return;
    const indice = primeraNueva.current;
    primeraNueva.current = null;
    const fila = filas.length > indice ? cuerpo.current?.rows[indice] : undefined;
    (fila ?? botonMas.current ?? botonReintentar.current)?.focus();
  }, [cargando, filas]);

  function cargarMas() {
    if (cargando || siguiente === null) return;
    primeraNueva.current = filas.length;
    void cargar(siguiente);
  }

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <EncabezadoPagina titulo={M.titulo} />
      {sinPermiso ? (
        <Alert tono="aviso" role="alert">
          <CircleAlert aria-hidden="true" />
          <p className="m-0">{M.sinPermiso}</p>
        </Alert>
      ) : (
        <>
          {filas.length === 0 && !cargando && !error && <p className="m-0 text-tinta-suave">{M.vacio}</p>}
          {filas.length > 0 && (
            <div className="rounded-tarjeta border border-linea bg-hoja shadow-tarjeta">
              <Table aria-label={M.tabla} className="min-w-[44rem]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className="px-2">{M.columnas.fecha}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.actor}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.accion}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.cliente}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.detalle}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody ref={cuerpo}>
                  {filas.map((f) => (
                    <TableRow
                      key={f.id}
                      tabIndex={-1}
                      className="align-top focus:outline-2 focus:-outline-offset-2 focus:outline-primario"
                    >
                      <TableCell className="whitespace-nowrap px-2 align-top">{fechaHoraLima(f.ocurridaEn)}</TableCell>
                      <TableCell className="px-2 align-top">
                        {f.actor.tipo === "usuario" ? (
                          <Autor autor={f.actor.autor} />
                        ) : (
                          textoActor(f.actor)
                        )}
                      </TableCell>
                      <TableCell className="px-2 align-top">{textoAccion(f.accion, f.datos)}</TableCell>
                      <TableCell className="px-2 align-top">
                        {f.cliente ? f.cliente.razonSocial : M.sinCliente}
                      </TableCell>
                      <TableCell className="px-2 align-top">
                        <Detalle fila={f} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div aria-live="polite">
            {cargando && (
              <p role="status" className="m-0 text-tinta-suave">
                {M.cargando}
              </p>
            )}
            {error && (
              <Alert tono="error" role="alert">
                <CircleAlert aria-hidden="true" />
                <p className="m-0">{error}</p>
              </Alert>
            )}
          </div>
          {error && (
            <Button
              ref={botonReintentar}
              variant="secundario"
              size="sm"
              onClick={() => {
                if (filas.length > 0) primeraNueva.current = filas.length;
                void cargar(filas.length > 0 ? siguiente : null);
              }}
              className="w-fit max-lg:h-11"
            >
              {M.reintentar}
            </Button>
          )}
          {siguiente !== null && !error && (
            <Button
              ref={botonMas}
              variant="secundario"
              size="sm"
              aria-disabled={cargando}
              onClick={cargarMas}
              className="w-fit max-lg:h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
            >
              {M.cargarMas}
            </Button>
          )}
        </>
      )}
    </main>
  );
}
