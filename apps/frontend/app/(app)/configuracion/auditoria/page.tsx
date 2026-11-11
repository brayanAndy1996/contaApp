"use client";

import { useCallback, useEffect, useState } from "react";
import { Autor } from "../../../../components/autor";
import {
  listarAuditoria,
  MENSAJES_AUDITORIA as M,
  textoAccion,
  textoActor,
  textoDetalle,
  type FilaAuditoria,
} from "../../../../lib/auditoria";

// Consulta de auditoría (spec 017, P-2; CA-12, CA-14): tabla paginada por fecha, sin filtros. Solo con
// `auditoria.ver` (el enlace de la barra se oculta sin el permiso; el backend responde 403). Todo es texto de React:
// una razón social con `<script>` se ve literal.

const FORMATO_FECHA = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Lima",
});

export default function PaginaAuditoria() {
  const [filas, setFilas] = useState<FilaAuditoria[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);

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

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{M.titulo}</h1>
      {sinPermiso ? (
        <p role="alert">{M.sinPermiso}</p>
      ) : (
        <>
          {filas.length === 0 && !cargando && !error && <p>{M.vacio}</p>}
          {filas.length > 0 && (
            <table aria-label={M.tabla} className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th scope="col">{M.columnas.fecha}</th>
                  <th scope="col">{M.columnas.actor}</th>
                  <th scope="col">{M.columnas.accion}</th>
                  <th scope="col">{M.columnas.cliente}</th>
                  <th scope="col">{M.columnas.detalle}</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.id} className="border-t">
                    <td>{FORMATO_FECHA.format(new Date(f.ocurridaEn))}</td>
                    <td>
                      {f.actor.tipo === "usuario" ? (
                        <Autor autor={f.actor.autor} />
                      ) : (
                        textoActor(f.actor)
                      )}
                    </td>
                    <td>{textoAccion(f.accion)}</td>
                    <td>{f.cliente ? f.cliente.razonSocial : M.sinCliente}</td>
                    <td>{textoDetalle(f.datos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
              type="button"
              onClick={() => void cargar(filas.length > 0 ? siguiente : null)}
              className="w-fit rounded border px-3 py-1 text-sm"
            >
              {M.reintentar}
            </button>
          )}
          {siguiente !== null && !cargando && !error && (
            <button
              type="button"
              onClick={() => void cargar(siguiente)}
              className="w-fit rounded border px-3 py-1 text-sm"
            >
              {M.cargarMas}
            </button>
          )}
        </>
      )}
    </main>
  );
}
