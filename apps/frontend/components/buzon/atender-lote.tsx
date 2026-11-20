"use client";

import { useEffect, useRef, useState } from "react";
import { LARGO_MAX_COMENTARIO_ATENCION, LOTE_MAX_ATENCION, comentarioRequerido } from "@contapp/shared";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from "../ui";
import {
  MENSAJES_BANDEJA as B,
  atenderLote,
  textoErrorAtencion,
  type FilaBandeja,
  type RespuestaLote,
} from "../../lib/buzon";

// Marcar como atendidos varios mensajes de la bandeja (spec 024, D-6, D-7, U-3, CA-7, CA-11). Barra con «N seleccionados»
// y un diálogo con el comentario (obligatorio si algún seleccionado es crítico). Solo marca: no hay «Deshacer» en lote.
// El resultado («N atendidos, M ya estaban atendidos») se queda a la vista aunque la bandeja limpie la selección.

export function AtenderLote({
  seleccionados,
  alTerminar,
}: {
  seleccionados: FilaBandeja[];
  alTerminar: (respuesta: RespuestaLote) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [comentario, setComentario] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<RespuestaLote | null>(null);
  const enCurso = useRef(false);
  const botonRef = useRef<HTMLButtonElement>(null);

  const n = seleccionados.length;
  const huella = seleccionados.map((f) => f.id).join(",");
  // Una selección nueva reemplaza el resultado anterior.
  useEffect(() => {
    if (huella) setResultado(null);
  }, [huella]);

  const hayCritico = seleccionados.some((f) => comentarioRequerido({ critico: f.critico, accion: "marcar" }));
  const falta = hayCritico && comentario.trim() === "";
  const demasiados = n > LOTE_MAX_ATENCION;

  function abrir() {
    setComentario("");
    setError(null);
    setAbierto(true);
  }

  async function confirmar() {
    if (enCurso.current || falta || demasiados || n === 0) return;
    enCurso.current = true;
    setEnviando(true);
    setError(null);
    try {
      const r = await atenderLote(
        seleccionados.map((f) => f.id),
        comentario,
      );
      if (r.status === 401) return;
      if (r.ok && r.datos) {
        setAbierto(false);
        setResultado(r.datos);
        alTerminar(r.datos);
      } else {
        setError(textoErrorAtencion(r.status, r.datos));
      }
    } catch {
      setError(textoErrorAtencion(0, null));
    } finally {
      enCurso.current = false;
      setEnviando(false);
    }
  }

  if (n === 0 && !resultado) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {n > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-control border border-linea bg-hoja px-3 py-2">
          <span className="text-sm font-semibold">{B.seleccionados(n)}</span>
          <Button
            ref={botonRef}
            type="button"
            disabled={demasiados}
            onClick={abrir}
            className="max-lg:h-11"
          >
            {B.marcarLote}
          </Button>
          {demasiados && <span className="text-sm text-error">{B.maximoLote}</span>}
        </div>
      )}
      {resultado && (
        <Alert tono="ok" role="status">
          {B.resultadoLote(resultado.atendidos.length, resultado.omitidos.length)}
        </Alert>
      )}

      <Dialog open={abierto} onOpenChange={(v) => !enviando && setAbierto(v)}>
        <DialogContent
          mostrarCerrar={false}
          // El diálogo no tiene disparador propio: al cerrar, el foco vuelve a «Marcar como atendidos».
          onCloseAutoFocus={(e) => {
            if (botonRef.current) {
              e.preventDefault();
              botonRef.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{B.tituloLote}</DialogTitle>
            <DialogDescription>{B.descripcionLote(n)}</DialogDescription>
          </DialogHeader>
          <Label>
            {B.comentario}
            <Textarea
              value={comentario}
              maxLength={LARGO_MAX_COMENTARIO_ATENCION}
              onChange={(e) => setComentario(e.target.value)}
              aria-invalid={falta || undefined}
            />
          </Label>
          <p className="m-0 text-xs text-tinta-suave">{B.contador(comentario.length)}</p>
          {falta && <p className="m-0 text-sm text-error">{B.comentarioObligatorio}</p>}
          {error && <Alert tono="error">{error}</Alert>}
          <DialogFooter>
            <Button type="button" variant="secundario" onClick={() => setAbierto(false)} className="max-lg:h-11">
              {B.cancelar}
            </Button>
            <Button type="button" disabled={enviando || falta} onClick={() => void confirmar()} className="max-lg:h-11">
              {B.confirmar}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
