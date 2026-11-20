"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Label, Textarea } from "../ui";
import { LARGO_MAX_COMENTARIO_ATENCION, comentarioRequerido } from "@contapp/shared";
import { usePuede } from "../../lib/acceso";
import {
  MENSAJES_BANDEJA as B,
  MENSAJES_BUZON as M,
  PERMISO_BUZON_ATENDER,
  atenderMensaje,
  textoErrorAtencion,
  type AtencionDetalle,
  type EventoAtencion,
} from "../../lib/buzon";
import { fechaHoraLima } from "../../lib/fechas";

// Bloque de atención del detalle de un mensaje (spec 024, D-5 a D-8, U-1, U-2, CA-4 a CA-6, CA-11). Dice el estado con
// texto, muestra el historial y, con `buzon.atender` y un cliente no archivado, deja marcar o deshacer con un
// comentario (obligatorio solo al marcar un crítico). Los comentarios y nombres se pintan como texto de React
// (`whitespace-pre-wrap`): nunca como HTML. La regla del comentario la decide `shared`; el servidor valida de todos modos.

const ESPERA_ESTADO_MS = 1500;

export function AtencionMensaje({
  clienteId,
  mensajeId,
  critico,
  atencion,
  historial,
  archivado = false,
  alCambiar,
}: {
  clienteId: string;
  mensajeId: string;
  critico: boolean;
  atencion: AtencionDetalle;
  historial: EventoAtencion[];
  archivado?: boolean;
  /** El estado cambió (o hubo un 409): la pantalla vuelve a leer el detalle. */
  alCambiar: () => void;
}) {
  const puedeAtender = usePuede(PERMISO_BUZON_ATENDER) === true;
  const [comentario, setComentario] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tras un envío correcto el botón sigue inactivo hasta que llegue el estado nuevo (o pase un momento): un doble clic
  // no vuelve a enviar mientras el detalle se vuelve a leer.
  const [esperandoEstado, setEsperandoEstado] = useState(false);
  const enCurso = useRef(false);
  // El botón se inactiva mientras se envía y el navegador suelta su foco (cae a `body`): si lo tenía, se le devuelve al
  // terminar; el botón es el mismo elemento y ya dice la acción nueva («Deshacer» / «Marcar como atendido»).
  const botonRef = useRef<HTMLButtonElement>(null);
  const comentarioRef = useRef<HTMLTextAreaElement>(null);
  const devolverFoco = useRef(false);
  const huellaEstado = `${atencion.estado}|${atencion.en ?? ""}|${historial.length}`;

  useEffect(() => setEsperandoEstado(false), [huellaEstado]);
  useEffect(() => {
    if (!esperandoEstado) return;
    const t = setTimeout(() => setEsperandoEstado(false), ESPERA_ESTADO_MS);
    return () => clearTimeout(t);
  }, [esperandoEstado]);

  useEffect(() => {
    if (!devolverFoco.current || enviando || esperandoEstado) return;
    devolverFoco.current = false;
    const boton = botonRef.current;
    // Si el botón sigue inactivo (p. ej. un crítico que vuelve a pedir comentario), el foco va al cuadro del comentario.
    (boton && !boton.disabled ? boton : comentarioRef.current)?.focus();
  });

  const atendido = atencion.estado === "atendido";
  const accion = atendido ? "deshacer" : "marcar";
  const exigeComentario = comentarioRequerido({ critico, accion });
  const falta = exigeComentario && comentario.trim() === "";
  const ofrecer = puedeAtender && !archivado;

  async function enviar() {
    if (enCurso.current || esperandoEstado || falta) return;
    enCurso.current = true;
    devolverFoco.current = document.activeElement !== null && document.activeElement === botonRef.current;
    setEnviando(true);
    setError(null);
    try {
      const r = await atenderMensaje(clienteId, mensajeId, accion, comentario);
      if (r.status === 401) return;
      if (r.ok) {
        setComentario("");
        setEsperandoEstado(true);
        alCambiar();
      } else {
        setError(textoErrorAtencion(r.status, r.datos));
        // 409 `atencion_cambiada`: otra persona ya cambió el estado; se vuelve a leer para mostrar el vigente. Lo escrito
        // era para el estado anterior: no pasa al bloque nuevo.
        if (r.status === 409 && (r.datos as { codigo?: string } | null)?.codigo === "atencion_cambiada") {
          setComentario("");
          alCambiar();
        }
      }
    } catch {
      setError(textoErrorAtencion(0, null));
    } finally {
      enCurso.current = false;
      setEnviando(false);
    }
  }

  return (
    <section aria-label={B.tituloAtencion} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        {atencion.estado === "atendido" ? (
          <p className="m-0 break-words">
            {B.atendidoPor(atencion.por?.nombre ?? "—")}
            {atencion.en ? ` · ${fechaHoraLima(atencion.en)}` : ""}
          </p>
        ) : (
          <div>
            <Badge tono={atencion.estado === "historico" ? "neutro" : "aviso"}>{B.estado[atencion.estado]}</Badge>
          </div>
        )}
        {atendido && atencion.comentario && (
          <p className="m-0 whitespace-pre-wrap break-words text-tinta-media">{atencion.comentario}</p>
        )}
      </div>

      {archivado && <p className="m-0 text-sm text-tinta-suave">{M.archivado}</p>}

      {ofrecer && (
        <div className="flex max-w-xl flex-col gap-2">
          <Label>
            {B.comentario}
            <Textarea
              ref={comentarioRef}
              value={comentario}
              maxLength={LARGO_MAX_COMENTARIO_ATENCION}
              onChange={(e) => setComentario(e.target.value)}
              aria-invalid={falta || undefined}
            />
          </Label>
          <p className="m-0 text-xs text-tinta-suave">{B.contador(comentario.length)}</p>
          {falta && <p className="m-0 text-sm text-error">{B.comentarioObligatorio}</p>}
          <Button
            ref={botonRef}
            type="button"
            variant={atendido ? "secundario" : "primario"}
            disabled={enviando || esperandoEstado || falta}
            onClick={() => void enviar()}
            className="self-start max-lg:h-11"
          >
            {atendido ? B.deshacer : B.marcar}
          </Button>
          {error && <Alert tono="error">{error}</Alert>}
        </div>
      )}

      {historial.length > 0 && (
        <ol aria-label={B.historial} className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {historial.map((e, i) => (
            <li key={`${e.en}-${i}`} className="flex min-w-0 flex-col gap-0.5 border-l-2 border-linea pl-3">
              <span className="break-words">
                <span className="font-semibold">{e.usuario.nombre}</span>{" "}
                <span>{e.accion === "atendido" ? B.accionAtendido : B.accionDeshecho}</span>
              </span>
              <span className="text-xs text-tinta-suave">{fechaHoraLima(e.en)}</span>
              {e.comentario && <span className="whitespace-pre-wrap break-words text-tinta-media">{e.comentario}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
