"use client";

import { excluirCompraSchema, type FilaCompraVista } from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  excluirCompra,
  type ContextoCompras,
} from "../../lib/compras";
import {
  comprobanteDe,
  recargarTrasError,
  recargarTrasExito,
  type AlAvisar,
} from "./accion-compras";

// Excluir una compra (spec 015, D-10, HU-17): motivo opcional de hasta 200 caracteres en una línea. Excluir una
// agregada a mano equivale a descartarla (014 DU-16): se avisa antes de enviar. Espera la respuesta del servidor
// (no hay actualización optimista) y recarga la fila y el resumen. El motivo es texto del usuario: nunca HTML.

export function ExcluirCompra({
  contexto,
  fila,
  alTerminar,
  alCancelar,
  alAvisar,
}: {
  contexto: ContextoCompras;
  fila: FilaCompraVista;
  /** Tras excluir bien, para que quien lo abrió lo cierre. */
  alTerminar: () => void;
  alCancelar: () => void;
  alAvisar?: AlAvisar;
}) {
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const comprobante = comprobanteDe(fila);

  useEffect(() => {
    campo.current?.focus();
  }, []);

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado) return;
    const limpio = motivo.trim();
    const analisis = excluirCompraSchema.safeParse({
      versionBase: fila.version,
      ...(limpio === "" ? {} : { motivo: limpio }),
    });
    if (!analisis.success) {
      setError(M.motivoMaximo);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await excluirCompra(
        contexto.clienteId,
        contexto.periodo,
        fila.id,
        analisis.data,
      );
      if (r.ok) {
        await recargarTrasExito(contexto, fila.id);
        alAvisar?.(M.compraExcluida, "ok");
        alTerminar();
        return;
      }
      await recargarTrasError(contexto, fila.id, r);
      setError(r.mensaje);
      alAvisar?.(r.mensaje, "error");
    } catch {
      setError(MENSAJES.errorGeneral);
      alAvisar?.(MENSAJES.errorGeneral, "error");
    }
    setOcupado(false);
  }

  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-label={`${M.excluir} ${comprobante}`}
      onSubmit={(e) => void enviar(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      noValidate
      className="flex w-96 max-w-full flex-col gap-3 rounded border bg-white p-4 shadow-lg"
    >
      <h3 className="text-base font-medium">{`${M.excluir} ${comprobante}`}</h3>
      {fila.origen === "agregada" && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">
          {M.confirmarExcluirAgregada}
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {M.motivoExclusion}
        <input
          ref={campo}
          type="text"
          autoComplete="off"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          aria-invalid={error !== null && motivo.trim().length > 200}
          className="rounded border px-3 py-2"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={ocupado}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {M.excluir}
        </button>
        <button
          type="button"
          onClick={alCancelar}
          disabled={ocupado}
          className="rounded border px-4 py-2 text-sm"
        >
          {M.cancelar}
        </button>
      </div>
    </form>
  );
}
