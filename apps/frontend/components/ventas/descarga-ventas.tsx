"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PropuestaVentasDto, TrabajoVista } from "@contapp/shared";
import { MENSAJES, fechaCorta, mensajeDeError } from "../../lib/acceso";
import { MENSAJES_CREDENCIALES } from "../../lib/credenciales";
import { seguirTrabajos } from "../../lib/trabajos";
import { MENSAJES_VENTAS as M, descargarPropuesta } from "../../lib/ventas";

// Región «Descarga» (spec 013, D14; RF-050, HU-11). «Descargar» encola `sire.propuesta.descargar` y la
// región sigue el trabajo (posición en cola, «Ejecutando») con el mismo lector del panel de 007b. Al
// completar avisa a la pantalla para que refresque; el resumen «N nuevos, M difieren» sale de la propuesta
// más reciente que entrega el servidor. Un error del trabajo ofrece «Reintentar».

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

const ACTIVO: ReadonlySet<TrabajoVista["estado"]> = new Set([
  "en_cola",
  "ejecutando",
]);

export function DescargaVentas({
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
  /** La descarga o importación más reciente del periodo (o `undefined` si no hay). */
  ultimaPropuesta: PropuestaVentasDto | undefined;
  /** `true` cuando ya llegó la lista de propuestas (distingue «sin descargas» de «cargando»). */
  cargadas: boolean;
  /** El trabajo terminó bien: la pantalla recarga grilla, resumen, correlatividad y propuestas. */
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
      const r = await descargarPropuesta(clienteId, periodo);
      if (r.ok && r.datos?.trabajoId) {
        setTrabajoId(r.datos.trabajoId);
      } else if (r.status !== 401) {
        setTrabajoId(null);
        setError(
          r.status === 409 && codigoDe(r.datos) === "credencial_no_configurada"
            ? MENSAJES_CREDENCIALES.noConfigurada
            : r.status === 409 && codigoDe(r.datos) === "cliente_archivado"
              ? M.clienteArchivado
              : mensajeDeError(r.status, r.datos),
        );
      }
    } catch {
      setTrabajoId(null);
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  const activo = trabajo !== null && ACTIVO.has(trabajo.estado);
  const espera = trabajoId !== null && trabajo === null;

  return (
    <section aria-label="Descarga" className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Descarga</h2>

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

      {!activo && !espera && ultimaPropuesta && (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            {M.resumenDescarga(
              ultimaPropuesta.filasNuevas,
              ultimaPropuesta.filasDistintas,
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
