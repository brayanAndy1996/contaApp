"use client";

import { MOTIVOS_OMISION_CANDIDATA } from "@contapp/shared";
import Link from "next/link";
import { useState } from "react";
import { MENSAJES, usePuede } from "../../lib/acceso";
import {
  MENSAJES_APRENDIZAJE as M,
  PERMISO_APRENDIZAJE_GESTIONAR,
  activarCandidatas,
  rutaGrilla,
  type RespuestaActivar,
} from "../../lib/aprendizaje";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  enlace,
} from "../ui";

// «Activar todas» las propuestas de una importación (spec 025, T13; CA-3, CA-4; D-6, U-6). Pide confirmar con el total y lo
// que se omite, manda `{todas: true, importacionId}` y muestra lo activado, lo omitido por motivo, el aviso de que las reglas
// rigen desde la próxima descarga y el enlace a la grilla del periodo. El servidor decide qué se activa: aquí solo se cuenta.

export function ActivarCandidatas({
  clienteId,
  importacionId,
  aActivar,
  omitidas,
  periodoAbierto,
  alTerminar,
}: {
  clienteId: string;
  importacionId: string;
  /** Las propuestas pendientes sin conflicto: las que «Activar todas» crearía. */
  aActivar: number;
  /** Las que se saltaría (con conflicto o sin criterio claro). */
  omitidas: number;
  /** AAAAMM de la grilla de compras a la que enlaza el aviso de U-6. */
  periodoAbierto: string;
  /** Avisa a la lista con la respuesta del servidor, para que se vuelva a leer. */
  alTerminar?: (respuesta: RespuestaActivar) => void;
}) {
  const puedeGestionar = usePuede(PERMISO_APRENDIZAJE_GESTIONAR) === true;
  const [abierto, setAbierto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<RespuestaActivar | null>(null);

  if (!puedeGestionar) return null;

  async function confirmar(): Promise<void> {
    if (ocupado) return;
    setError(null);
    setOcupado(true);
    try {
      const r = await activarCandidatas(clienteId, { todas: true, importacionId });
      setAbierto(false);
      if (r.ok) {
        setResultado(r.datos);
        alTerminar?.(r.datos);
      } else {
        setResultado(null);
        setError(r.mensaje);
      }
    } catch {
      setAbierto(false);
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  const porMotivo = MOTIVOS_OMISION_CANDIDATA.map(
    (motivo) => [motivo, resultado?.omitidas.filter((o) => o.motivo === motivo).length ?? 0] as const,
  ).filter(([, n]) => n > 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Dialog open={abierto} onOpenChange={(valor) => !ocupado && setAbierto(valor)}>
        <Button
          variant="secundario"
          disabled={aActivar === 0 || ocupado}
          onClick={() => {
            setError(null);
            setAbierto(true);
          }}
          className="self-start max-lg:h-11"
        >
          {M.activarTodas}
        </Button>
        <DialogContent mostrarCerrar={false}>
          <DialogHeader>
            <DialogTitle>{M.activarTodas}</DialogTitle>
            <DialogDescription>{M.confirmarTodas(aActivar, omitidas)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secundario" disabled={ocupado} onClick={() => setAbierto(false)} className="max-lg:h-11">
              {M.cancelar}
            </Button>
            <Button disabled={ocupado} onClick={() => void confirmar()} className="max-lg:h-11">
              {M.confirmar}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error !== null && <Alert tono="error">{error}</Alert>}
      {resultado !== null && (
        <div role="status" className="flex flex-col gap-1 text-sm text-tinta-media">
          <p className="m-0 font-semibold text-tinta">{M.reglasActivadas(resultado.activadas.length)}</p>
          {porMotivo.map(([motivo, n]) => (
            <p key={motivo} className="m-0">
              {M.omitidas(n, motivo)}
            </p>
          ))}
          <p className="m-0">{M.avisoPeriodoCargado}</p>
          <Link href={rutaGrilla(clienteId, periodoAbierto)} className={`${enlace} max-lg:py-3 self-start`}>
            {M.irAGrilla}
          </Link>
        </div>
      )}
    </div>
  );
}
