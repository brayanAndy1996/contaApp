"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, EncabezadoPagina, buttonVariants } from "../../../../../components/ui";
import { ProrrataCliente } from "../../../../../components/prorrata/prorrata-cliente";
import { MENSAJES, mensajeDeError } from "../../../../../lib/acceso";
import { obtenerCliente } from "../../../../../lib/clientes";
import { MENSAJES_PRORRATA as M } from "../../../../../lib/prorrata";
import { cn } from "../../../../../lib/utils";

// Prorrata e IGV estimado de un cliente (spec 026, T13; CA-1, CA-9, D-8). Lee el cliente solo para saber si está archivado
// (solo lectura); el resto lo hace <ProrrataCliente>. Los permisos (`prorrata.ver`, `prorrata.gestionar`) los valida el
// backend; aquí solo se oculta lo que no corresponde.

function ProrrataDelCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const [archivado, setArchivado] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    setArchivado(null);
    setError(null);
    obtenerCliente(clienteId)
      .then((r) => {
        if (!vigente) return;
        if (r.ok && r.datos) setArchivado(r.datos.archivado === true);
        else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
      })
      .catch(() => {
        if (vigente) setError(MENSAJES.errorGeneral);
      });
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  const volver = (
    <nav aria-label="Ruta de navegación">
      <Link href={`/clientes/${encodeURIComponent(clienteId)}`} className={cn(buttonVariants({ variant: "secundario" }), "max-lg:h-11")}>
        {M.volverCliente}
      </Link>
    </nav>
  );

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <EncabezadoPagina titulo={M.titulo} acciones={volver} />
      {error && <Alert tono="error">{error}</Alert>}
      {archivado === null && !error && <p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>}
      {archivado !== null && <ProrrataCliente clienteId={clienteId} archivado={archivado} />}
    </main>
  );
}

// `useParams()` es dato de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">{M.cargando}</main>}>
      <ProrrataDelCliente />
    </Suspense>
  );
}
