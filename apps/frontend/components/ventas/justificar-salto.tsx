"use client";

import {
  saltoJustificarSchema,
  type SaltoJustificarInput,
} from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MENSAJES_VENTAS as M,
  justificarSalto,
  mensajeDeErrorVentas,
} from "../../lib/ventas";
import { MENSAJES } from "../../lib/acceso";
import type { SaltoElegido } from "./correlatividad-ventas";

// Formulario «Justificar salto» (spec 013, D8; HU-12, CA-7). Pide el comentario (1 a 500 caracteres) del
// salto elegido y lo envía tal cual al servidor, que decide si el rango sigue siendo un faltante vigente.

export function JustificarSalto({
  clienteId,
  periodo,
  salto,
  alGuardar,
  alCancelar,
}: {
  clienteId: string;
  periodo: string;
  salto: SaltoElegido;
  /** Se llama tras el 201, para que la pantalla recargue la correlatividad. */
  alGuardar: () => void;
  alCancelar: () => void;
}) {
  const [comentario, setComentario] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const campo = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    campo.current?.focus();
  }, []);

  async function guardar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado) return;
    const texto = comentario.trim();
    if (texto === "" || texto.length > 500) {
      setError(M.comentarioRequerido);
      return;
    }
    const datos: SaltoJustificarInput = {
      tipo: salto.tipo,
      serie: salto.serie,
      desde: salto.desde,
      hasta: salto.hasta,
      comentario: texto,
    };
    if (!saltoJustificarSchema.safeParse(datos).success) {
      setError(M.justificarInvalido);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await justificarSalto(clienteId, periodo, datos);
      if (r.ok) {
        alGuardar();
        return;
      }
      setError(mensajeDeErrorVentas(r.status, r.datos, M.justificarInvalido));
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  const rango =
    salto.desde === salto.hasta
      ? `${salto.serie}-${salto.desde}`
      : `${salto.serie}-${salto.desde} a ${salto.serie}-${salto.hasta}`;

  return (
    <form
      aria-label={M.formularioJustificar}
      onSubmit={(e) => void guardar(e)}
      noValidate
      className="flex max-w-xl flex-col gap-3 rounded border p-3"
    >
      <h3 className="text-base font-medium">
        {M.nombreSerie(salto.tipo, salto.serie)} · {rango}
      </h3>
      <label className="flex flex-col gap-1 text-sm">
        {M.etiquetaComentario}
        <textarea
          ref={campo}
          value={comentario}
          onChange={(e) => setComentario(e.target.value)}
          rows={3}
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
          {M.guardar}
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
