"use client";

import type { EstadoXml } from "@contapp/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MENSAJES } from "../../lib/acceso";
import { MENSAJES_COMPRAS as M, type ContextoCompras } from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  autorCorto,
  descargarXml,
  fechaLegibleUtc,
  mensajeDeErrorLupa,
  solicitarXml,
} from "../../lib/lupa-compras";
import { seguirTrabajos } from "../../lib/trabajos";

// Estado del XML en la lupa (spec 016, RF-097a, RF-097b, CA-9, CA-11, CA-16). Cuatro estados del servidor:
//  - disponible: «XML simulado» (origen del mock), «XML real» o «XML subido por X el …»; aviso de moneda si la del
//    XML no es la de la fila; «Descargar XML» (adjunto, nunca se interpreta).
//  - pendiente: se sigue con `seguirTrabajos` y, al terminar el trabajo `xml.obtener` del cliente, se recarga el detalle.
//  - sin_solicitar: «Obtener XML».
//  - no_disponible(codigo): texto fijo por código (nada de la causa interna) con «Reintentar» y, si hay, «Subir XML»
//    (lo entrega T16 por `subir`).
// Obtener se permite en cualquier estado del periodo (D-7); solo el cliente archivado lo bloquea. Sin `sire.clasificar`
// no se ofrece. Oculta o deshabilita por comodidad: el backend vuelve a validar.

const TIPO_TRABAJO_XML = "xml.obtener";
const TERMINAL = new Set(["completado", "error", "cancelado"]);

/** El XML se puede obtener aunque el periodo esté revisado o generado; solo el cliente archivado lo impide. */
export const bloqueoDeXml = (contexto: ContextoCompras): string | null =>
  contexto.soloLectura === M.soloLectura.clienteArchivado ? contexto.soloLectura : null;

export function EstadoXmlLupa({
  contexto,
  compraId,
  xml,
  alRecargar,
  subir,
}: {
  contexto: ContextoCompras;
  compraId: string;
  xml: EstadoXml;
  /** Vuelve a pedir el detalle (termina el trabajo, se solicitó el XML, etc.). */
  alRecargar: () => void;
  /** «Subir XML» (T16): se muestra junto a «Reintentar» cuando el XML no está disponible. */
  subir?: ReactNode;
}) {
  const [ocupado, setOcupado] = useState<"solicitar" | "descargar" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const { clienteId, periodo } = contexto;
  const recargarRef = useRef(alRecargar);
  useEffect(() => {
    recargarRef.current = alRecargar;
  });

  // Pendiente: se sigue el trabajo hasta que termine y entonces se recarga el detalle.
  const pendiente = xml.estado === "pendiente";
  useEffect(() => {
    if (!pendiente) return;
    const control = new AbortController();
    let recargadoAlListar = false;
    void seguirTrabajos({
      senal: control.signal,
      // Al abrir (y tras cada reconexión): si ya no hay un trabajo vivo de este cliente, el XML pudo llegar antes de
      // abrir el flujo; se recarga una sola vez.
      alListar: (trabajos) => {
        const vivo = trabajos.some(
          (t) => t.tipo === TIPO_TRABAJO_XML && t.clienteId === clienteId && !TERMINAL.has(t.estado),
        );
        if (!vivo && !recargadoAlListar) {
          recargadoAlListar = true;
          recargarRef.current();
        }
      },
      alEvento: (t) => {
        if (t.tipo === TIPO_TRABAJO_XML && t.clienteId === clienteId && TERMINAL.has(t.estado)) {
          recargarRef.current();
        }
      },
      alError: () => undefined,
    });
    return () => control.abort();
  }, [pendiente, clienteId, compraId]);

  const puedeEscribir = contexto.permisos.clasificar;
  const bloqueo = bloqueoDeXml(contexto);

  async function solicitar(): Promise<void> {
    if (ocupado) return;
    setError(null);
    setAviso(null);
    setOcupado("solicitar");
    try {
      const r = await solicitarXml(clienteId, periodo, compraId);
      if (r.ok) {
        setAviso(L.xml.solicitado);
      } else {
        setError(mensajeDeErrorLupa(r));
      }
      // También tras un 409 `xml_existente`: el detalle ya trae el XML.
      alRecargar();
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(null);
  }

  async function descargar(): Promise<void> {
    if (ocupado) return;
    setError(null);
    setOcupado("descargar");
    try {
      const r = await descargarXml(clienteId, periodo, compraId);
      if (!r.ok) {
        if (r.status !== 401) setError(r.status === 403 || r.status === 404 ? r.mensaje : L.xml.errorDescarga);
      } else {
        const url = URL.createObjectURL(r.archivo);
        const enlace = document.createElement("a");
        enlace.href = url;
        enlace.download = r.nombre;
        enlace.rel = "noopener";
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      setError(L.xml.errorDescarga);
    }
    setOcupado(null);
  }

  const botonObtener = (texto: string) =>
    puedeEscribir && (
      <button
        type="button"
        onClick={() => void solicitar()}
        disabled={ocupado !== null || bloqueo !== null}
        title={bloqueo ?? undefined}
        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
      >
        {ocupado === "solicitar" ? L.xml.solicitando : texto}
      </button>
    );

  let cuerpo: ReactNode;
  if (xml.estado === "disponible") {
    const etiqueta =
      xml.origen === "simulado"
        ? L.xml.simulado
        : xml.origen === "subido"
          ? xml.subidoPor !== undefined && xml.subidoEn !== undefined
            ? L.xml.subidoPor(autorCorto(xml.subidoPor), fechaLegibleUtc(xml.subidoEn))
            : L.xml.subido
          : L.xml.real;
    cuerpo = (
      <>
        <div className="flex flex-wrap items-center gap-3">
          <span
            data-origen={xml.origen}
            className="rounded bg-gray-100 px-2 py-0.5 text-sm font-medium"
          >
            {etiqueta}
          </span>
          <button
            type="button"
            onClick={() => void descargar()}
            disabled={ocupado !== null}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {ocupado === "descargar" ? L.xml.descargando : L.xml.descargar}
          </button>
        </div>
        {xml.avisoMoneda !== undefined && (
          <p role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">
            {L.xml.avisoMoneda(xml.avisoMoneda.monedaXml, xml.avisoMoneda.monedaFila)}
          </p>
        )}
      </>
    );
  } else if (xml.estado === "pendiente") {
    cuerpo = (
      <p role="status" className="text-sm">
        {L.xml.pendiente}
      </p>
    );
  } else if (xml.estado === "sin_solicitar") {
    cuerpo = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm">{L.xml.sinSolicitar}</p>
        {botonObtener(L.xml.obtener)}
      </div>
    );
  } else {
    cuerpo = (
      <>
        <p className="text-sm font-medium">{L.xml.noDisponible}</p>
        <p className="text-sm">{L.xml.causas[xml.codigo]}</p>
        <div className="flex flex-wrap items-center gap-3">
          {xml.codigo !== "no_aplica" && botonObtener(L.xml.reintentarObtener)}
          {puedeEscribir && subir}
        </div>
      </>
    );
  }

  return (
    <section aria-label={L.secciones.xml} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{L.secciones.xml}</h3>
      {cuerpo}
      <div aria-live="polite">
        {aviso && <p className="text-sm">{aviso}</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
