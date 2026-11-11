"use client";

import { excluirVentaSchema } from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import { useRestaurarFoco } from "../../lib/restaurar-foco";
import { MENSAJES_VENTAS as M, excluirVenta } from "../../lib/ventas";

// Excluir una venta del SIRE cuyo error bloquea la generación (spec 012b, T15; D12, P-8; CA-15). `alertdialog`
// con motivo obligatorio de 1 a 200 caracteres en una línea, el aviso de que la venta no irá en el archivo y
// «Confirmar»/«Cancelar». Espera la respuesta del servidor (sin actualización optimista); el motivo es texto del
// usuario y nunca se interpreta como HTML. La regla «solo lo que bloquea» la valida el backend (409 `no_excluible`).

export function ExcluirVenta({
  clienteId,
  periodo,
  ventaId,
  clave,
  alTerminar,
  alCancelar,
  alFallar,
}: {
  clienteId: string;
  periodo: string;
  ventaId: string;
  /** `serie-número` si la pantalla lo conoce (la grilla); el error del previo solo trae el id. */
  clave: string | null;
  /** Excluida bien: la pantalla recarga previo, grilla y resumen y cierra el diálogo. */
  alTerminar: () => void;
  alCancelar: () => void;
  /** El servidor rechazó (409/403/404): la pantalla vuelve a pedir el estado. */
  alFallar?: (status: number, codigo: string) => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const titulo = clave === null ? M.excluirVenta : M.excluirComprobante(clave);

  useRestaurarFoco();
  useEffect(() => {
    campo.current?.focus();
  }, []);

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado) return;
    const analisis = excluirVentaSchema.safeParse({ motivo });
    if (!analisis.success) {
      setError(M.motivoExclusionInvalido);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await excluirVenta(clienteId, periodo, ventaId, analisis.data);
      if (r.ok) {
        alTerminar();
        return;
      }
      if (r.status === 401) return;
      setError(r.mensaje);
      alFallar?.(r.status, r.codigo);
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  return (
    <form
      role="alertdialog"
      aria-modal="true"
      aria-label={titulo}
      aria-describedby="excluir-venta-aviso"
      onSubmit={(e) => void enviar(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      noValidate
      className="flex w-96 max-w-full flex-col gap-3 rounded border bg-white p-4 shadow-lg"
    >
      <h3 className="text-base font-medium">{titulo}</h3>
      <p
        id="excluir-venta-aviso"
        className="rounded border border-amber-300 bg-amber-50 p-2 text-sm"
      >
        {M.avisoExcluir}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        {M.motivoExclusion}
        <input
          ref={campo}
          type="text"
          autoComplete="off"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          aria-invalid={error !== null}
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
          {M.confirmar}
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
