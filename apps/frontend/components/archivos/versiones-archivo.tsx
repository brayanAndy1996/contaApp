"use client";

import { useState } from "react";
import type { VersionArchivoDto } from "@contapp/shared";
import { fechaHoraLima } from "../../lib/fechas";
import { Autor } from "../autor";
import { Alert, Badge, Button } from "../ui";
import {
  MENSAJES_ARCHIVO as M,
  descargarVersionArchivo,
  nombreZipVersion,
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
  const ultima = Math.max(0, ...versiones.map((x) => x.version));

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
      // La versión más reciente conserva el nombre del servidor; las anteriores llevan `_vN` (P-6).
      enlace.download = v.version === ultima ? r.nombre : nombreZipVersion(r.nombre, v.version);
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
      <h4 className="m-0 font-titulo text-[15px] font-bold">{M.tituloVersiones}</h4>
      {reabiertoTrasUltima && versiones.length > 0 && (
        <Alert tono="aviso" role="note">
          {M.reabiertoTrasUltima}
        </Alert>
      )}
      {versiones.length === 0 ? (
        <p className="m-0 text-sm text-tinta-suave">{M.sinVersiones}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {versiones.map((v) => (
            <li key={v.id} className="flex flex-col gap-1.5 rounded-control border border-linea bg-hoja-alterna p-3">
              <p className="m-0">
                <strong>{M.version(v.version)}</strong> · {M.generadoEn(fechaHoraLima(v.generadoEn))}{" "}
                {M.generadoPor} <Autor autor={v.autor} />
              </p>
              <p className="m-0">
                {v.nombreZip} · {M.lineas(v.lineas)}
              </p>
              <p className="m-0 text-tinta-media">
                {M.sha256Zip}: <code className="break-all font-mono text-xs">{v.sha256Zip}</code>
              </p>
              {v.provisional && (
                <p className="m-0">
                  <Badge tono="aviso">{M.provisional}</Badge>
                </p>
              )}
              <Button
                variant="secundario"
                size="sm"
                aria-label={M.descargarVersion(v.version)}
                disabled={descargando !== null}
                onClick={() => void descargar(v)}
                className="min-h-11 w-fit lg:min-h-8"
              >
                {descargando === v.id ? M.descargando : M.descargar}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div aria-live="polite">
        {error && <Alert tono="error">{error}</Alert>}
      </div>
    </section>
  );
}
