"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PropuestaComprasDto, TrabajoVista } from "@contapp/shared";
import { fechaCorta } from "../../lib/acceso";
import { MENSAJES_COMPRAS as M, descargarCompras } from "../../lib/compras";
import { MENSAJES_CREDENCIALES } from "../../lib/credenciales";
import { seguirTrabajos } from "../../lib/trabajos";

// Región «Descarga» de compras (spec 015, D-14; RF-060, CA-3). «Descargar» encola `sire.propuesta.descargar`
// y la región sigue el trabajo (posición en cola, «Ejecutando») con el mismo lector del panel de 007b. Al
// completar avisa a la página para que refresque; el resumen «N nuevas, M distintas» sale de la propuesta más
// reciente que entrega el servidor y «distintas» lleva a la lista de diferencias (avisan, no cambian nada).
// Un error del trabajo ofrece «Reintentar»; 409 y 403 del servidor se muestran con su mensaje propio.

export const TITULO_DESCARGA = "Descarga";
/** Ancla de la región de diferencias: el enlace de «M distintas» apunta aquí. */
export const ANCLA_DIFERENCIAS = "diferencias-compras";

const ACTIVO: ReadonlySet<TrabajoVista["estado"]> = new Set([
  "en_cola",
  "ejecutando",
]);

export function DescargaCompras({
  clienteId,
  periodo,
  puedeDescargar,
  periodoValido,
  ultimaPropuesta,
  cargadas,
  alCompletar,
}: {
  clienteId: string;
  periodo: string;
  /** `sire.descargar` y cliente activo: sin él, «Descargar» y «Reintentar» no se muestran. */
  puedeDescargar: boolean;
  periodoValido: boolean;
  /** La descarga más reciente del periodo (o `undefined` si no hay). */
  ultimaPropuesta: PropuestaComprasDto | undefined;
  /** `true` cuando ya llegó la lista de propuestas (distingue «sin descargas» de «cargando»). */
  cargadas: boolean;
  /** El trabajo terminó bien: la página recarga grilla, resumen, propuestas y diferencias. */
  alCompletar: () => void;
}) {
  const [trabajoId, setTrabajoId] = useState<string | null>(null);
  const [trabajo, setTrabajo] = useState<TrabajoVista | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completar = useRef(alCompletar);
  useEffect(() => {
    completar.current = alCompletar;
  });

  useEffect(() => {
    if (!trabajoId) return;
    const control = new AbortController();
    let cerrado = false;
    const aplicar = (t: TrabajoVista) => {
      if (cerrado || t.id !== trabajoId) return;
      setTrabajo(t);
      if (!ACTIVO.has(t.estado)) {
        cerrado = true;
        control.abort();
        if (t.estado === "completado") completar.current();
      }
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

  async function descargar() {
    setEnviando(true);
    setError(null);
    setTrabajo(null);
    setTrabajoId(null);
    try {
      const r = await descargarCompras(clienteId, periodo);
      if (r.ok) {
        setTrabajoId(r.datos.trabajoId);
      } else if (r.status !== 401) {
        // 409 `credencial_no_configurada` / `periodo_generado` / `cliente_archivado` y 403 `periodo_revisado`
        // traen su texto propio en `mensaje`.
        setError(r.mensaje);
      }
    } finally {
      setEnviando(false);
    }
  }

  const activo = trabajo !== null && ACTIVO.has(trabajo.estado);
  const espera = trabajoId !== null && trabajo === null;
  const resumen =
    ultimaPropuesta === undefined
      ? null
      : M.resumenDescarga(
          ultimaPropuesta.filasNuevas,
          ultimaPropuesta.filasDistintas,
        );

  return (
    <section aria-label={TITULO_DESCARGA} className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{TITULO_DESCARGA}</h2>

      <div className="flex flex-wrap items-center gap-3">
        {puedeDescargar && (
          <button
            type="button"
            onClick={() => void descargar()}
            disabled={!periodoValido || enviando || activo || espera}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {M.descargar}
          </button>
        )}
        {trabajoId && (
          <Link href="/trabajos" className="text-sm underline">
            {MENSAJES_CREDENCIALES.enlacePanel}
          </Link>
        )}
      </div>

      <div aria-live="polite" className="flex flex-col gap-2">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {trabajo?.estado === "en_cola" && (
          <p role="status" className="text-sm">
            {trabajo.posicion === null
              ? M.enColaSinPosicion
              : M.enCola(trabajo.posicion)}
          </p>
        )}
        {trabajo?.estado === "ejecutando" && (
          <p role="status" className="text-sm">
            {M.ejecutando}
          </p>
        )}
        {trabajo?.estado === "cancelado" && (
          <p role="status" className="text-sm">
            {M.descargaCancelada}
          </p>
        )}
        {trabajo?.estado === "error" && (
          <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
            <p>
              {M.descargaFallida}
              {trabajo.motivo ? `: ${M.motivosTrabajo[trabajo.motivo]}` : "."}
            </p>
            {puedeDescargar && (
              <button
                type="button"
                onClick={() => void descargar()}
                disabled={!periodoValido || enviando}
                className="rounded border px-3 py-1"
              >
                {M.reintentar}
              </button>
            )}
          </div>
        )}
      </div>

      {!activo && !espera && ultimaPropuesta && resumen !== null && (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            {ultimaPropuesta.filasDistintas > 0 ? (
              <a href={`#${ANCLA_DIFERENCIAS}`} className="underline">
                {resumen}
              </a>
            ) : (
              resumen
            )}
          </p>
          <p>{M.ultimaDescarga(fechaCorta(ultimaPropuesta.creadaEn))}</p>
        </div>
      )}
      {cargadas && !ultimaPropuesta && periodoValido && (
        <p className="text-sm">{M.sinDescargas}</p>
      )}
    </section>
  );
}
