"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES } from "../../lib/acceso";
import type { ContextoCompras } from "../../lib/compras";
import { MENSAJES_GASTOS as M, reevaluarPeriodo } from "../../lib/gastos";
import { seguirTrabajos, type TrabajoVista } from "../../lib/trabajos";
import { Alert, Button } from "../ui";

// «Volver a evaluar» el periodo de compras (spec 027, R-8, R-12, D-3, CA-12). Tras cambiar el diccionario, el umbral o las
// categorías del cliente, encola un trabajo que vuelve a evaluar las compras del periodo (no crea versiones: solo anota los
// hallazgos nuevos). Solo se ofrece con el periodo abierto y `sire.clasificar`. El trabajo se sigue con `seguirTrabajos` de 008
// hasta que termina; el motivo técnico de un error nunca se muestra. Los permisos solo ocultan: el servidor valida.

const TERMINAL = new Set(["completado", "error", "cancelado"]);

export function VolverAEvaluar({ contexto, alTerminar }: { contexto: ContextoCompras; alTerminar?: () => void }) {
  const { clienteId, periodo } = contexto;
  const [trabajoId, setTrabajoId] = useState<string | null>(null);
  const [solicitando, setSolicitando] = useState(false);
  const [terminado, setTerminado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enCurso = useRef(false);
  // El contexto y el aviso cambian de identidad en cada lectura de la página: el seguimiento usa siempre los vigentes.
  const recargar = useRef(contexto.recargarResumen);
  recargar.current = contexto.recargarResumen;
  const avisar = useRef(alTerminar);
  avisar.current = alTerminar;

  const alFinalizar = useCallback(async (t: Pick<TrabajoVista, "estado">) => {
    setTrabajoId(null);
    if (t.estado !== "completado") {
      setError(M.reevaluarFallida);
      return;
    }
    setTerminado(true);
    try {
      await recargar.current();
    } catch {
      // La página vuelve a leer el resumen en su próxima carga.
    }
    avisar.current?.();
  }, []);

  // Sigue ESE trabajo hasta que termina (como la obtención de declaraciones de 026).
  useEffect(() => {
    if (trabajoId === null) return;
    const control = new AbortController();
    let finalizado = false;
    const finalizar = (t: Pick<TrabajoVista, "estado">) => {
      if (finalizado) return;
      finalizado = true;
      void alFinalizar(t);
    };
    void seguirTrabajos({
      senal: control.signal,
      alListar: (trabajos) => {
        const propio = trabajos.find((t) => t.id === trabajoId);
        if (propio && TERMINAL.has(propio.estado)) finalizar(propio);
      },
      alEvento: (t) => {
        if (t.id === trabajoId && TERMINAL.has(t.estado)) finalizar(t);
      },
      alError: () => undefined,
    });
    return () => control.abort();
  }, [trabajoId, alFinalizar]);

  async function pedir(): Promise<void> {
    if (enCurso.current || trabajoId !== null) return;
    enCurso.current = true;
    setError(null);
    setTerminado(false);
    setSolicitando(true);
    try {
      const r = await reevaluarPeriodo(clienteId, periodo);
      if (r.ok) setTrabajoId(r.datos.trabajoId);
      else if (r.status !== 401) setError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      enCurso.current = false;
      setSolicitando(false);
    }
  }

  if (contexto.estado !== "abierto" || !contexto.permisos.clasificar) return null;
  const evaluando = solicitando || trabajoId !== null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Button variant="secundario" disabled={evaluando} onClick={() => void pedir()} className="max-lg:h-11">
        {M.volverAEvaluar}
      </Button>
      {evaluando && <Alert tono="info">{M.reevaluando}</Alert>}
      {terminado && !evaluando && <Alert tono="ok">{M.reevaluada}</Alert>}
      {error && <Alert tono="error">{error}</Alert>}
    </div>
  );
}
