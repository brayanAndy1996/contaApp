"use client";

import type { EstadoXml } from "@contapp/shared";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MENSAJES } from "../../lib/acceso";
import { etiquetaAutor } from "../../lib/autor";
import { fechaHoraLima } from "../../lib/fechas";
import { MENSAJES_COMPRAS as M, type ContextoCompras } from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  descargarXml,
  mensajeDeErrorLupa,
  solicitarXml,
} from "../../lib/lupa-compras";
import { seguirTrabajos } from "../../lib/trabajos";
import { Alert, Badge, Button } from "../ui";

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
  recuperarFoco,
}: {
  contexto: ContextoCompras;
  compraId: string;
  xml: EstadoXml;
  /** Vuelve a pedir el detalle (termina el trabajo, se solicitó el XML, etc.). */
  alRecargar: () => void;
  /** «Subir XML» (T16): se muestra junto a «Reintentar» cuando el XML no está disponible. */
  subir?: ReactNode;
  /**
   * RF-096: si el botón que tenía el foco se deshabilitó o desapareció (pidió el XML y el estado cambió), el foco
   * queda en `body` y Esc y ← → dejan de llegar a la lupa. Quien abre el modal lo devuelve a su raíz.
   */
  recuperarFoco?: () => void;
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

  // Tras pedir o descargar el XML, y cuando el estado cambia, el botón pulsado puede haberse ido: se recupera el foco.
  const recuperarRef = useRef(recuperarFoco);
  useEffect(() => {
    recuperarRef.current = recuperarFoco;
  });
  useEffect(() => {
    recuperarRef.current?.();
  }, [ocupado, xml.estado]);

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
      <Button
        variant="secundario"
        size="sm"
        onClick={() => void solicitar()}
        disabled={ocupado !== null || bloqueo !== null}
        title={bloqueo ?? undefined}
        className="max-lg:h-11"
      >
        {ocupado === "solicitar" ? L.xml.solicitando : texto}
      </Button>
    );

  let cuerpo: ReactNode;
  if (xml.estado === "disponible") {
    const etiqueta =
      xml.origen === "simulado"
        ? L.xml.simulado
        : xml.origen === "subido"
          ? xml.subidoPor !== undefined && xml.subidoEn !== undefined
            ? L.xml.subidoPor(etiquetaAutor(xml.autor), fechaHoraLima(xml.subidoEn))
            : L.xml.subido
          : L.xml.real;
    cuerpo = (
      <>
        <div className="flex flex-wrap items-center gap-3">
          <Badge
            data-origen={xml.origen}
            tono={xml.origen === "simulado" ? "aviso" : xml.origen === "subido" ? "info" : "ok"}
            className="h-auto min-h-6 whitespace-normal py-0.5"
          >
            {etiqueta}
          </Badge>
          <Button
            variant="secundario"
            size="sm"
            onClick={() => void descargar()}
            disabled={ocupado !== null}
            className="max-lg:h-11"
          >
            {ocupado === "descargar" ? L.xml.descargando : L.xml.descargar}
          </Button>
        </div>
        {/* P-6: un XML simulado se puede reemplazar subiendo el real; con uno real o subido el servidor da 409. */}
        {xml.origen === "simulado" && puedeEscribir && subir}
        {xml.avisoMoneda !== undefined && (
          <Alert tono="aviso" role="note">
            <TriangleAlert aria-hidden />
            {L.xml.avisoMoneda(xml.avisoMoneda.monedaXml, xml.avisoMoneda.monedaFila)}
          </Alert>
        )}
      </>
    );
  } else if (xml.estado === "pendiente") {
    cuerpo = (
      <p role="status" className="text-sm text-tinta-media">
        {L.xml.pendiente}
      </p>
    );
  } else if (xml.estado === "sin_solicitar") {
    cuerpo = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-tinta-media">{L.xml.sinSolicitar}</p>
        {botonObtener(L.xml.obtener)}
        {puedeEscribir && subir}
      </div>
    );
  } else {
    cuerpo = (
      <>
        <p className="text-sm font-semibold text-tinta">{L.xml.noDisponible}</p>
        <p className="text-sm text-tinta-media">{L.xml.causas[xml.codigo]}</p>
        <div className="flex flex-wrap items-center gap-3">
          {xml.codigo !== "no_aplica" && botonObtener(L.xml.reintentarObtener)}
          {puedeEscribir && subir}
        </div>
      </>
    );
  }

  return (
    <section aria-label={L.secciones.xml} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-tinta">{L.secciones.xml}</h3>
      {cuerpo}
      <div aria-live="polite">
        {aviso && <p className="text-sm text-tinta-media">{aviso}</p>}
        {error && (
          <Alert tono="error">
            <CircleAlert aria-hidden />
            {error}
          </Alert>
        )}
      </div>
    </section>
  );
}
