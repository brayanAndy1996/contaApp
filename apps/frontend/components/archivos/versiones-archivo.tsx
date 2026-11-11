"use client";

import { useState } from "react";
import type { VersionArchivoDto } from "@contapp/shared";
import { fechaCorta } from "../../lib/acceso";
import { Autor } from "../autor";
import {
  MENSAJES_ARCHIVO as M,
  descargarVersionArchivo,
  type LibroArchivo,
} from "../../lib/archivos";

// Versiones generadas del archivo (spec 012b, T14; D9, P-4; CA-9, CA-12): la mayor primero, con «Descargar»
// (`clientes.ver`) y el aviso «Reabierto después de la última versión». La descarga guarda el ZIP con un enlace
// temporal; el contenido nunca se interpreta aquí.

export function VersionesArchivo({
  clienteId,
  periodo,
  libro,
  versiones,
  reabiertoTrasUltima,
}: {
  clienteId: string;
  periodo: string;
  libro: LibroArchivo;
  versiones: VersionArchivoDto[];
  reabiertoTrasUltima: boolean;
}) {
  const [descargando, setDescargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function descargar(v: VersionArchivoDto) {
    if (descargando !== null) return;
    setDescargando(v.id);
    setError(null);
    try {
      const r = await descargarVersionArchivo(clienteId, periodo, libro, v.id, v.nombreZip);
      if (!r.ok) {
        if (r.status === 401) return;
        // Un 500 `archivo_alterado` explica; el resto cae en el aviso general de descarga.
        setError(r.codigo === "archivo_alterado" ? r.mensaje : M.errorDescarga);
        return;
      }
      const url = URL.createObjectURL(r.archivo);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = r.nombre;
      enlace.rel = "noopener";
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(M.errorDescarga);
    } finally {
      setDescargando(null);
    }
  }

  return (
    <section aria-label={M.tituloVersiones} className="flex flex-col gap-2">
      <h4 className="font-medium">{M.tituloVersiones}</h4>
      {reabiertoTrasUltima && versiones.length > 0 && (
        <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
          {M.reabiertoTrasUltima}
        </p>
      )}
      {versiones.length === 0 ? (
        <p className="text-sm">{M.sinVersiones}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {versiones.map((v) => (
            <li key={v.id} className="flex flex-col gap-1 rounded border p-2">
              <p>
                <strong>{M.version(v.version)}</strong> · {M.generadoEn(fechaCorta(v.generadoEn))}{" "}
                {M.generadoPor} <Autor autor={v.autor} />
              </p>
              <p>
                {v.nombreZip} · {M.lineas(v.lineas)}
              </p>
              {v.provisional && <p className="font-medium text-amber-900">{M.provisional}</p>}
              <button
                type="button"
                aria-label={M.descargarVersion(v.version)}
                disabled={descargando !== null}
                onClick={() => void descargar(v)}
                className="w-fit rounded border px-3 py-1 disabled:opacity-50"
              >
                {descargando === v.id ? M.descargando : M.descargar}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
