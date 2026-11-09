"use client";

import { useState } from "react";
import { MENSAJES_COMPRAS as M, exportarCompras } from "../../lib/compras";

// «Exportar a Excel» (spec 015, D-15; CA-15): descarga el Excel del periodo (no del filtro) con `fetch` y lo
// guarda con un enlace temporal; el archivo nunca se interpreta aquí. Un error del servidor sale como aviso.

export function ExportarCompras({
  clienteId,
  periodo,
  periodoValido,
}: {
  clienteId: string;
  periodo: string;
  periodoValido: boolean;
}) {
  const [exportando, setExportando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportar() {
    setExportando(true);
    setError(null);
    try {
      const r = await exportarCompras(clienteId, periodo);
      if (!r.ok) {
        if (r.status === 401) return;
        // Con código conocido, 403 o 404 el servidor explica; si no, el aviso general de exportar.
        const conocido =
          r.status === 403 ||
          r.status === 404 ||
          (r.codigo !== "respuesta_invalida" && Object.hasOwn(M.errores, r.codigo));
        setError(conocido ? r.mensaje : M.errorExportar);
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
      setError(M.errorExportar);
    } finally {
      setExportando(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void exportar()}
        disabled={!periodoValido || exportando}
        className="rounded border px-4 py-2 text-sm disabled:opacity-50"
      >
        {exportando ? M.exportando : M.exportar}
      </button>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
