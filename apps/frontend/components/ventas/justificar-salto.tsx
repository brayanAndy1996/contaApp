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
import { Alert, Button, Label } from "../ui";
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
      className="flex w-full max-w-xl flex-col gap-4 rounded-tarjeta border border-linea bg-hoja p-5 shadow-tarjeta"
    >
      <h3 className="m-0 font-titulo text-base font-bold text-tinta">
        {M.nombreSerie(salto.tipo, salto.serie)} · {rango}
      </h3>
      <Label>
        {M.etiquetaComentario}
        <textarea
          ref={campo}
          value={comentario}
          onChange={(e) => setComentario(e.target.value)}
          rows={3}
          className="w-full min-w-0 rounded-control border border-linea-control bg-hoja px-3 py-2 text-sm font-normal text-tinta placeholder:text-tinta-suave focus-visible:border-primario focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primario/20"
        />
      </Label>
      {error && <Alert tono="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={ocupado} className="max-lg:h-11">
          {M.guardar}
        </Button>
        <Button
          type="button"
          variant="secundario"
          onClick={alCancelar}
          disabled={ocupado}
          className="max-lg:h-11"
        >
          {M.cancelar}
        </Button>
      </div>
    </form>
  );
}
