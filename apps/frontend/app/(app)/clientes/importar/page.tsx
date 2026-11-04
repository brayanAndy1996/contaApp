"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent } from "react";
import { MENSAJES, usePuede } from "../../../../lib/acceso";
import {
  MASCARA_CLAVE,
  MENSAJES_IMPORTACION as M,
  URL_PLANTILLA,
  confirmarImportacion,
  revisarArchivo,
  textoMotivo,
  type InformeImportacion,
  type VistaPrevia,
} from "../../../../lib/importacion";

// Asistente de importación de clientes (spec 007b, D7–D9; CA-1, CA-8): subir → vista previa → informe.
// El archivo se conserva solo en memoria (referencia en un `ref`, nunca en estado ni almacenamiento) y se
// descarta al confirmar, al cambiarlo o al desmontar. Las claves del archivo nunca se muestran: el backend
// solo dice si la fila trae SOL/SIRE y aquí se pinta como «••••». Sin cálculos: solo se muestra lo recibido.

const ACEPTA =
  ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export default function ImportarClientes() {
  const puede = usePuede("clientes.crear");
  const archivo = useRef<File | null>(null);
  const [haySeleccion, setHaySeleccion] = useState(false);
  const [vista, setVista] = useState<VistaPrevia | null>(null);
  const [informe, setInforme] = useState<InformeImportacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  if (puede === undefined) return <main className="p-6">Cargando…</main>;
  if (puede === false) {
    return (
      <main className="p-6">
        <p role="alert" className="text-sm text-red-600">
          {MENSAJES.sinPermiso}
        </p>
      </main>
    );
  }

  function alElegir(e: ChangeEvent<HTMLInputElement>): void {
    archivo.current = e.target.files?.[0] ?? null;
    setHaySeleccion(archivo.current !== null);
    setVista(null);
    setInforme(null);
    setError(null);
  }

  async function revisar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || ocupado) return;
    setOcupado(true);
    setError(null);
    setVista(null);
    setInforme(null);
    try {
      const r = await revisarArchivo(elegido);
      if (archivo.current !== elegido) return; // cambió el archivo mientras tanto
      if (r.ok) setVista(r.datos);
      else setError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await confirmarImportacion(elegido);
      if (r.ok) {
        archivo.current = null; // el archivo se descarta al confirmar
        setHaySeleccion(false);
        setVista(null);
        setInforme(r.datos);
      } else {
        setError(r.mensaje);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  function cancelar(): void {
    archivo.current = null;
    setHaySeleccion(false);
    setVista(null);
    setError(null);
  }

  return (
    <main className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{M.titulo}</h1>
        <Link href="/clientes" className="text-sm underline">
          Volver a clientes
        </Link>
      </div>

      <section className="space-y-3">
        <a href={URL_PLANTILLA} download className="text-sm underline">
          {M.plantilla}
        </a>
        <div className="flex flex-col gap-1">
          <label htmlFor="archivo-importacion" className="text-sm">
            Archivo (.xlsx o .csv)
          </label>
          <input
            id="archivo-importacion"
            type="file"
            accept={ACEPTA}
            onChange={alElegir}
            className="text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void revisar()}
          disabled={!haySeleccion || ocupado}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Revisar archivo
        </button>
      </section>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {vista && (
        <section aria-label="Vista previa" className="space-y-3">
          <ul className="text-sm">
            <li>{M.validas(vista.validas)}</li>
            <li>{M.conError(vista.conError)}</li>
            <li>{M.cupoLibre(vista.cupoLibre)}</li>
            <li>{M.excedentes(vista.excedentes)}</li>
          </ul>
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Fila</th>
                <th>RUC</th>
                <th>Estado</th>
                <th>Claves</th>
                <th>Motivos</th>
              </tr>
            </thead>
            <tbody>
              {vista.filas.map((f) => (
                <tr key={f.n}>
                  <td>{f.n}</td>
                  <td>{f.ruc}</td>
                  <td>
                    {f.estado === "valida"
                      ? M.estadoFila.valida
                      : M.estadoFila.conError}
                  </td>
                  <td>
                    {[
                      f.tieneSol ? `SOL ${MASCARA_CLAVE}` : null,
                      f.tieneSire ? `SIRE ${MASCARA_CLAVE}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td>
                    {f.motivos.map((m) => (
                      <p key={m}>{textoMotivo(m, f.archivado)}</p>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void confirmar()}
              disabled={vista.validas === 0 || ocupado}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Confirmar importación
            </button>
            <button
              type="button"
              onClick={cancelar}
              disabled={ocupado}
              className="rounded border px-4 py-2 text-sm"
            >
              Cancelar
            </button>
          </div>
        </section>
      )}

      {informe && (
        <section aria-label="Resultado" className="space-y-3">
          <ul className="text-sm">
            <li>{M.creadas(informe.creadas)}</li>
            <li>{M.consultasEncoladas(informe.consultasEncoladas)}</li>
            <li>{M.consultasOmitidas(informe.consultasOmitidas)}</li>
          </ul>
          {informe.noImportadas.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>RUC</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {informe.noImportadas.map((f) => (
                  <tr key={`${f.n}-${f.ruc}`}>
                    <td>{f.n}</td>
                    <td>{f.ruc}</td>
                    <td>{textoMotivo(f.motivo, f.archivado)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Link href="/clientes" className="text-sm underline">
            Ir a clientes
          </Link>
        </section>
      )}
    </main>
  );
}
