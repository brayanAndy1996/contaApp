"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// Consulta de auditoría (spec 017, P-2; CA-12, CA-14): tabla paginada por fecha, sin filtros. Solo con
// `auditoria.ver` (el enlace de la barra se oculta sin el permiso; el backend responde 403). Todo es texto de React:
// una razón social con `<script>` se ve literal. Fechas en hora de Lima. La tabla se desplaza dentro de su propio
// contenedor en pantallas angostas (T18a, P-7) y «Cargar más» no pierde el foco (P-6).

/** Detalle de una fila en líneas cortas (usuario afectado, antes → después, rol, estado…). */
function Detalle({ fila }: { fila: FilaAuditoria }) {
  const lineas = lineasDetalle(fila);
  if (lineas.length === 0) return null;
  return (
    <ul className="list-none">
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
      <h1 className="text-xl font-semibold">{M.titulo}</h1>
      {sinPermiso ? (
        <p role="alert">{M.sinPermiso}</p>
      ) : (
        <>
          {filas.length === 0 && !cargando && !error && <p>{M.vacio}</p>}
          {filas.length > 0 && (
            <div className="overflow-x-auto">
              <table
                aria-label={M.tabla}
                className="w-full min-w-[44rem] text-left text-sm"
              >
                <thead>
                  <tr>
                    <th scope="col" className="px-2 py-1">{M.columnas.fecha}</th>
                    <th scope="col" className="px-2 py-1">{M.columnas.actor}</th>
                    <th scope="col" className="px-2 py-1">{M.columnas.accion}</th>
                    <th scope="col" className="px-2 py-1">{M.columnas.cliente}</th>
                    <th scope="col" className="px-2 py-1">{M.columnas.detalle}</th>
                  </tr>
                </thead>
                <tbody ref={cuerpo}>
                  {filas.map((f) => (
                    <tr
                      key={f.id}
                      tabIndex={-1}
                      className="border-t align-top focus:outline focus:outline-2"
                    >
                      <td className="px-2 py-1">{fechaHoraLima(f.ocurridaEn)}</td>
                      <td className="px-2 py-1">
                        {f.actor.tipo === "usuario" ? (
                          <Autor autor={f.actor.autor} />
                        ) : (
                          textoActor(f.actor)
                        )}
                      </td>
                      <td className="px-2 py-1">{textoAccion(f.accion, f.datos)}</td>
                      <td className="px-2 py-1">
                        {f.cliente ? f.cliente.razonSocial : M.sinCliente}
                      </td>
                      <td className="px-2 py-1">
                        <Detalle fila={f} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div aria-live="polite">
            {cargando && <p role="status">{M.cargando}</p>}
            {error && (
              <p role="alert" className="text-red-600">
                {error}
              </p>
            )}
          </div>
          {error && (
            <button
              ref={botonReintentar}
              type="button"
              onClick={() => {
                if (filas.length > 0) primeraNueva.current = filas.length;
                void cargar(filas.length > 0 ? siguiente : null);
              }}
              className="w-fit rounded border px-3 py-1 text-sm"
            >
              {M.reintentar}
            </button>
          )}
          {siguiente !== null && !error && (
            <button
              ref={botonMas}
              type="button"
              aria-disabled={cargando}
              onClick={cargarMas}
              className="w-fit rounded border px-3 py-1 text-sm aria-disabled:opacity-50"
            >
              {M.cargarMas}
            </button>
          )}
        </>
      )}
    </main>
  );
}
