"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PrevioArchivoDto,
  TrabajoVista,
  VersionArchivoDto,
} from "@contapp/shared";
import {
  MENSAJES_ARCHIVO as M,
  generarArchivo,
  listarVersionesArchivo,
  obtenerPrevioArchivo,
  type LibroArchivo,
} from "../../lib/archivos";
import { MENSAJES } from "../../lib/acceso";
import { useSecuencia } from "../../lib/secuencia";
import { seguirTrabajos } from "../../lib/trabajos";
import { PrevioArchivo } from "./previo-archivo";
import { VersionesArchivo } from "./versiones-archivo";

// Panel lateral «Generar archivo» (spec 012b, T14; D1, D2, D5, D9, P-2, P-4, P-7, P-10; CA-1, CA-9, CA-12).
// Muestra el previo del servidor (errores con enlace a la fila, avisos, resumen, «Provisional») y las versiones.
// «Generar» (solo con `sire.aprobar_generar`) envía el estado y la huella del previo VISTO (P-2) y sigue el
// trabajo; ante 409, 422 o un trabajo en error se vuelve a pedir el previo (P-10). Ver el previo y descargar
// piden `clientes.ver` (P-4). Ocultar el botón es comodidad: el backend vuelve a validar (RNF-007).

const ACTIVO: ReadonlySet<TrabajoVista["estado"]> = new Set(["en_cola", "ejecutando"]);

type Carga = "inactiva" | "cargando" | "lista" | "error";

export function PanelGenerar({
  clienteId,
  periodo,
  libro = "compras",
  puedeVer,
  puedeGenerar,
  recarga,
  alUbicarFila,
  alGenerado,
}: {
  clienteId: string;
  periodo: string;
  libro?: LibroArchivo;
  /** `clientes.ver`: sin él no se ofrece el panel. */
  puedeVer: boolean;
  /** `sire.aprobar_generar`: sin él no hay botón «Generar». */
  puedeGenerar: boolean;
  /** Cambia cuando la grilla, el resumen o el estado cambiaron: con el panel abierto se vuelve a pedir el previo. */
  recarga?: unknown;
  /** Ubica y resalta la fila en la grilla (enlace de cada error). */
  alUbicarFila?: (filaId: string) => void;
  /** El trabajo terminó bien: la página recarga el resumen y el estado. */
  alGenerado?: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [previo, setPrevio] = useState<PrevioArchivoDto | null>(null);
  const [versiones, setVersiones] = useState<VersionArchivoDto[]>([]);
  const [carga, setCarga] = useState<Carga>("inactiva");
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [trabajoId, setTrabajoId] = useState<string | null>(null);
  const [trabajo, setTrabajo] = useState<TrabajoVista | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secuencia = useSecuencia();

  const cargar = useCallback(async () => {
    const id = secuencia.nueva();
    setCarga("cargando");
    setErrorCarga(null);
    try {
      const [p, v] = await Promise.all([
        obtenerPrevioArchivo(clienteId, periodo, libro),
        listarVersionesArchivo(clienteId, periodo, libro),
      ]);
      if (!secuencia.vigente(id)) return;
      if (!p.ok) {
        if (p.status !== 401) setErrorCarga(p.mensaje);
        setCarga("error");
        return;
      }
      if (!v.ok) {
        if (v.status !== 401) setErrorCarga(v.mensaje);
        setCarga("error");
        return;
      }
      setPrevio(p.datos);
      setVersiones(v.datos);
      setCarga("lista");
    } catch {
      if (!secuencia.vigente(id)) return;
      setErrorCarga(MENSAJES.errorGeneral);
      setCarga("error");
    }
    // `secuencia` es estable (solo envuelve un ref).
  }, [clienteId, periodo, libro]);

  // Con el panel abierto, el previo se pide al abrir y cada vez que la página avisa de un cambio.
  useEffect(() => {
    if (!abierto || !puedeVer) return;
    void cargar();
    return () => secuencia.invalidar();
  }, [abierto, puedeVer, cargar, recarga]);

  const alTerminar = useRef({ cargar, alGenerado });
  useEffect(() => {
    alTerminar.current = { cargar, alGenerado };
  });

  // Sigue el trabajo de generación con el lector de 007b.
  useEffect(() => {
    if (!trabajoId) return;
    const control = new AbortController();
    let cerrado = false;
    const aplicar = (t: TrabajoVista) => {
      if (cerrado || t.id !== trabajoId) return;
      setTrabajo(t);
      if (ACTIVO.has(t.estado)) return;
      cerrado = true;
      control.abort();
      // Terminó (bien o mal): el previo vigente dice la causa y la última versión (P-10).
      if (t.estado === "completado") {
        setAviso(M.generacionCompletada);
        alTerminar.current.alGenerado?.();
      } else if (t.estado === "cancelado") {
        setAviso(M.generacionCancelada);
      } else {
        setError(M.generacionFallida);
      }
      void alTerminar.current.cargar();
    };
    void seguirTrabajos({
      alListar: (lista) => {
        const t = lista.find((x) => x.id === trabajoId);
        if (t) aplicar(t);
      },
      alEvento: aplicar,
      alError: () => undefined,
      senal: control.signal,
    });
    return () => {
      cerrado = true;
      control.abort();
    };
  }, [trabajoId]);

  async function generar() {
    if (!previo || enviando) return;
    const estadoVisto = previo.estado.estado;
    if (estadoVisto === "generado") return;
    setEnviando(true);
    setAviso(null);
    setError(null);
    setTrabajo(null);
    setTrabajoId(null);
    try {
      const r = await generarArchivo(clienteId, periodo, libro, {
        estadoVisto,
        huella: previo.huella,
      });
      if (r.ok) {
        setTrabajoId(r.datos.trabajoId);
      } else if (r.status !== 401) {
        setError(r.recargar ? `${r.mensaje} ${M.seRecargo}` : r.mensaje);
        if (r.recargar) void cargar();
      }
    } finally {
      setEnviando(false);
    }
  }

  if (!puedeVer) return null;

  const activo = trabajo !== null && ACTIVO.has(trabajo.estado);
  const esperando = trabajoId !== null && trabajo === null;
  const puedePulsar =
    previo !== null &&
    previo.generable &&
    previo.estado.estado !== "generado" &&
    carga !== "cargando" &&
    !enviando &&
    !activo &&
    !esperando;

  return (
    <>
      <button
        type="button"
        aria-expanded={abierto}
        onClick={() => setAbierto((a) => !a)}
        className="rounded border px-4 py-2 text-sm"
      >
        {M.abrir}
      </button>
      {abierto && (
        <aside
          aria-label={M.titulo}
          className="fixed inset-y-0 right-0 z-40 flex max-h-screen w-[30rem] max-w-full flex-col gap-4 overflow-auto border-l bg-white p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-medium">{M.titulo}</h3>
              <p className="text-xs">{M.subtitulo(libro)}</p>
            </div>
            <button
              type="button"
              onClick={() => setAbierto(false)}
              className="rounded border px-3 py-1 text-sm"
            >
              {M.cerrar}
            </button>
          </div>

          <div aria-live="polite" className="flex flex-col gap-2">
            {carga === "cargando" && (
              <p role="status" className="text-sm">
                {M.cargando}
              </p>
            )}
            {carga === "error" && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <p role="alert" className="text-red-600">
                  {errorCarga ?? M.errorCarga}
                </p>
                <button
                  type="button"
                  onClick={() => void cargar()}
                  className="rounded border px-3 py-1"
                >
                  {M.reintentar}
                </button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            {aviso && (
              <p role="status" className="text-sm">
                {aviso}
              </p>
            )}
            {trabajo?.estado === "en_cola" && (
              <p role="status" className="text-sm">
                {trabajo.posicion === null
                  ? M.generacionEnColaSinPosicion
                  : M.generacionEnCola(trabajo.posicion)}
              </p>
            )}
            {trabajo?.estado === "ejecutando" && (
              <p role="status" className="text-sm">
                {M.generacionEjecutando}
              </p>
            )}
          </div>

          {previo !== null && (
            <>
              <PrevioArchivo previo={previo} alUbicarFila={alUbicarFila} />

              <div className="flex flex-wrap items-center gap-3">
                {puedeGenerar ? (
                  <button
                    type="button"
                    disabled={!puedePulsar}
                    onClick={() => void generar()}
                    className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
                  >
                    {enviando || activo || esperando ? M.generando : M.generar}
                  </button>
                ) : (
                  <p className="text-sm">{M.sinPermisoGenerar}</p>
                )}
                {trabajoId && (
                  <Link href="/trabajos" className="text-sm underline">
                    {M.verTrabajos}
                  </Link>
                )}
              </div>

              <VersionesArchivo
                clienteId={clienteId}
                periodo={periodo}
                libro={libro}
                versiones={versiones}
                reabiertoTrasUltima={previo.reabiertoTrasUltima}
              />
            </>
          )}
        </aside>
      )}
    </>
  );
}
