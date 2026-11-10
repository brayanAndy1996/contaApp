"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import type { ContextoCompras } from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  mensajeDeErrorXml,
  subirXmlCompra,
  validarArchivoXml,
} from "../../lib/lupa-compras";

// «Subir XML» (spec 016, T16; CA-12, CA-13, D-3). Dos piezas:
//  - `SelectorXml`: elegir o arrastrar un archivo. Comprueba que no esté vacío y que no pase de 1 MiB ANTES de enviar
//    nada; el servidor vuelve a validar (413). No lee ni interpreta el contenido: lo entrega como `File` a quien lo use.
//  - `SubirXml`: el de la lupa. Envía el XML como cuerpo crudo a la compra y, si el servidor lo acepta (200), avisa
//    para que la lupa recargue su detalle sin recargar la página. Los errores salen por código (`xml_invalido`,
//    `xml_incompleto`, `xml_ajeno` con el campo que difiere, `xml_existente` P-6, 413). Nunca se muestra el cuerpo crudo.

const ACEPTA = ".xml,text/xml,application/xml";

export function SelectorXml({
  etiqueta = L.subir.boton,
  ocupado = false,
  deshabilitado = false,
  titulo,
  alElegir,
}: {
  etiqueta?: string;
  /** Mientras se envía no se acepta otro archivo. */
  ocupado?: boolean;
  deshabilitado?: boolean;
  /** Motivo de la deshabilitación (tooltip). */
  titulo?: string;
  /** Recibe el archivo ya comprobado (no vacío, ≤ 1 MiB). */
  alElegir: (archivo: File) => void;
}) {
  const entrada = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [encima, setEncima] = useState(false);
  const idError = useId();
  const inactivo = ocupado || deshabilitado;

  function recibir(archivo: File | undefined): void {
    if (!archivo || inactivo) return;
    const motivo = validarArchivoXml(archivo);
    if (motivo !== null) {
      setError(motivo);
      return;
    }
    setError(null);
    alElegir(archivo);
  }

  function alSoltar(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setEncima(false);
    recibir(e.dataTransfer.files[0]);
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        role="group"
        aria-label={L.subir.zona}
        onDragOver={(e) => {
          e.preventDefault();
          if (!inactivo) setEncima(true);
        }}
        onDragLeave={() => setEncima(false)}
        onDrop={alSoltar}
        className={`flex flex-wrap items-center gap-2 rounded border border-dashed p-2 ${encima ? "bg-gray-100" : ""}`}
      >
        <label
          title={titulo}
          className={`rounded border px-3 py-1 text-sm focus-within:ring-2 ${inactivo ? "opacity-50" : "cursor-pointer"}`}
        >
          {etiqueta}
          <input
            ref={entrada}
            type="file"
            accept={ACEPTA}
            disabled={inactivo}
            aria-describedby={error ? idError : undefined}
            onChange={(e) => {
              recibir(e.target.files?.[0]);
              // Permite elegir de nuevo el mismo archivo tras un error.
              e.target.value = "";
            }}
            className="sr-only"
          />
        </label>
        <span className="text-xs text-gray-700">{L.subir.arrastrar}</span>
      </div>
      {error && (
        <p id={idError} role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/** «Subir XML» de la lupa: completa el modal sin recargar la página (`alSubido` vuelve a pedir el detalle). */
export function SubirXml({
  contexto,
  compraId,
  bloqueo,
  alSubido,
}: {
  contexto: ContextoCompras;
  compraId: string;
  /** Motivo por el que no se puede subir (cliente archivado); `null` si se puede. */
  bloqueo: string | null;
  alSubido: () => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function subir(archivo: File): Promise<void> {
    if (ocupado) return;
    setError(null);
    setAviso(null);
    setOcupado(true);
    try {
      const r = await subirXmlCompra(contexto.clienteId, contexto.periodo, compraId, archivo);
      if (r.ok) {
        setAviso(L.subir.subido);
        alSubido();
      } else if (r.status !== 401) {
        // 409 `xml_existente` (P-6): se muestra su mensaje y el modal queda como estaba.
        setError(mensajeDeErrorXml(r, "compra"));
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  return (
    <div className="flex flex-col gap-1">
      <SelectorXml
        ocupado={ocupado}
        deshabilitado={bloqueo !== null}
        titulo={bloqueo ?? undefined}
        alElegir={(archivo) => void subir(archivo)}
      />
      <div aria-live="polite">
        {ocupado && <p className="text-sm">{L.subir.subiendo}</p>}
        {aviso && <p className="text-sm">{aviso}</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
