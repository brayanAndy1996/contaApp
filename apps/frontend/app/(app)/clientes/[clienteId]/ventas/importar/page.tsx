"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { MENSAJES, cargarYo, tiene } from "../../../../../../lib/acceso";
import { obtenerCliente } from "../../../../../../lib/clientes";
import {
  MENSAJES_VENTAS as M,
  PERIODO_VALIDO,
  confirmarImportacion,
  mensajeDeErrorImportacionVentas,
  vistaPreviaImportacion,
  type PropuestaVentasDto,
  type VistaPreviaVentas,
} from "../../../../../../lib/ventas";

// Asistente de importación de la propuesta de ventas (spec 013, D6, D3, D16; RF-051, CA-10): archivo → vista
// previa → confirmar. Es el asistente de 007b adaptado a ventas. El archivo vive solo en memoria (un `ref`),
// viaja como cuerpo crudo y nunca se lee ni se muestra aquí: la vista previa trae únicamente números de fila,
// estado y códigos de motivo. Todo o nada: con una fila con error no se puede confirmar. Sin cálculos.

const ACEPTA = ".xlsx,.csv,.txt,text/csv,text/plain";
/** Filas válidas que se listan; las filas con error se muestran siempre todas. */
const MAX_VALIDAS_LISTADAS = 200;

type Permiso = "cargando" | "si" | "no";

function Importar() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const busqueda = useSearchParams();
  const [permiso, setPermiso] = useState<Permiso>("cargando");
  const [archivado, setArchivado] = useState(false);
  const [periodo, setPeriodo] = useState(busqueda.get("periodo") ?? "");
  const periodoValido = PERIODO_VALIDO.test(periodo);

  const archivo = useRef<File | null>(null);
  const [haySeleccion, setHaySeleccion] = useState(false);
  const [vista, setVista] = useState<VistaPreviaVentas | null>(null);
  const [propuesta, setPropuesta] = useState<PropuestaVentasDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo } = await cargarYo();
      if (!vigente) return;
      const puede = tiene(yo, "sire.descargar");
      setPermiso(puede ? "si" : "no");
      if (!puede) return;
      const c = await obtenerCliente(clienteId);
      if (vigente && c.ok && c.datos) setArchivado(c.datos.archivado === true);
    })().catch(() => {
      if (vigente) setPermiso("no");
    });
    return () => {
      vigente = false;
      archivo.current = null; // el archivo se descarta al salir
    };
  }, [clienteId]);

  if (permiso === "cargando") return <main className="p-6">Cargando…</main>;
  if (permiso === "no") {
    return (
      <main className="p-6">
        <p role="alert" className="text-sm text-red-600">
          {MENSAJES.sinPermiso}
        </p>
      </main>
    );
  }

  function descartarResultados(): void {
    setVista(null);
    setPropuesta(null);
    setError(null);
  }

  function alElegir(e: ChangeEvent<HTMLInputElement>): void {
    archivo.current = e.target.files?.[0] ?? null;
    setHaySeleccion(archivo.current !== null);
    descartarResultados();
  }

  function cambiarPeriodo(valor: string): void {
    setPeriodo(valor.trim());
    descartarResultados();
  }

  async function revisar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || !periodoValido || ocupado) return;
    setOcupado(true);
    descartarResultados();
    try {
      const r = await vistaPreviaImportacion(clienteId, periodo, elegido);
      if (archivo.current !== elegido) return; // cambió el archivo mientras tanto
      if (r.ok && r.datos) setVista(r.datos);
      else setError(mensajeDeErrorImportacionVentas(r.status, r.datos));
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || !vista || !periodoValido || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await confirmarImportacion(clienteId, periodo, elegido);
      if (r.ok && r.datos) {
        archivo.current = null; // el archivo se descarta al confirmar
        setHaySeleccion(false);
        setVista(null);
        setPropuesta(r.datos.propuesta);
      } else {
        setError(mensajeDeErrorImportacionVentas(r.status, r.datos));
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
    descartarResultados();
  }

  const hrefVentas = `/clientes/${encodeURIComponent(clienteId)}/ventas${
    periodoValido ? `?periodo=${periodo}` : ""
  }`;

  let filasListadas = vista?.filas ?? [];
  let omitidas = 0;
  if (vista) {
    let validas = 0;
    filasListadas = vista.filas.filter((f) => {
      if (f.estado !== "valida") return true;
      validas += 1;
      return validas <= MAX_VALIDAS_LISTADAS;
    });
    omitidas = vista.filas.length - filasListadas.length;
  }

  return (
    <main className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{M.tituloImportar}</h1>
        <Link href={hrefVentas} className="text-sm underline">
          Volver a ventas
        </Link>
      </div>

      {archivado ? (
        <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          {M.clienteArchivado}
        </p>
      ) : (
        <section className="space-y-3">
          <label className="flex max-w-xs flex-col gap-1 text-sm">
            {M.etiquetaPeriodo}
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              value={periodo}
              onChange={(e) => cambiarPeriodo(e.target.value)}
              aria-describedby={
                periodo !== "" && !periodoValido ? "periodo-ayuda" : undefined
              }
              className="rounded border px-3 py-2"
            />
          </label>
          {periodo !== "" && !periodoValido && (
            <p id="periodo-ayuda" className="text-sm text-red-600">
              {M.periodoInvalido}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor="archivo-ventas" className="text-sm">
              {M.archivo}
            </label>
            <input
              id="archivo-ventas"
              type="file"
              accept={ACEPTA}
              onChange={alElegir}
              className="text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => void revisar()}
            disabled={!haySeleccion || !periodoValido || ocupado}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {M.revisarArchivo}
          </button>
        </section>
      )}

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
          </ul>
          {vista.conError > 0 && (
            <p className="text-sm">{M.corregirFilas}</p>
          )}
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Fila</th>
                <th>Estado</th>
                <th>Motivos</th>
              </tr>
            </thead>
            <tbody>
              {filasListadas.map((f) => (
                <tr key={f.n}>
                  <td>{f.n}</td>
                  <td>
                    {f.estado === "valida"
                      ? M.estadoFila.valida
                      : M.estadoFila.conError}
                  </td>
                  <td>
                    {f.motivos.map((m) => (
                      <p key={m}>{M.motivos[m] ?? M.archivoInvalido}</p>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {omitidas > 0 && <p className="text-sm">{M.filasOcultas(omitidas)}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void confirmar()}
              disabled={vista.conError > 0 || vista.validas === 0 || ocupado}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {M.confirmarImportacion}
            </button>
            <button
              type="button"
              onClick={cancelar}
              disabled={ocupado}
              className="rounded border px-4 py-2 text-sm"
            >
              {M.cancelar}
            </button>
          </div>
        </section>
      )}

      {propuesta && (
        <section aria-label="Resultado" className="space-y-3">
          <p className="text-sm">
            {M.resumenDescarga(propuesta.filasNuevas, propuesta.filasDistintas)}
          </p>
          <Link href={hrefVentas} className="text-sm underline">
            {M.verVentas}
          </Link>
        </section>
      )}
    </main>
  );
}

// `useParams()` y `useSearchParams()` son datos de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6">Cargando…</main>}>
      <Importar />
    </Suspense>
  );
}
