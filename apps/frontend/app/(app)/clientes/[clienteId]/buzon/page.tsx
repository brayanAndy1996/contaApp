"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, EncabezadoPagina, buttonVariants } from "../../../../../components/ui";
import { Bandeja } from "../../../../../components/buzon/bandeja";
import { MENSAJES, mensajeDeError } from "../../../../../lib/acceso";
import { obtenerCliente } from "../../../../../lib/clientes";
import { MENSAJES_BUZON as M } from "../../../../../lib/buzon";
import { cn } from "../../../../../lib/utils";

// Buzón SOL de un cliente (spec 023, CA-2, CA-6, D-4; spec 024, D-10): es la bandeja fijada en ese cliente, con «Revisar
// buzón ahora» arriba y, con `?mensaje=<id>`, el detalle al costado. Los permisos (`buzon.ver`, `buzon.marcar_leido`,
// `buzon.atender`) los valida el backend; aquí solo se oculta lo que no corresponde.

function BuzonDelCliente() {
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
      <Link
        href={`/clientes/${encodeURIComponent(clienteId)}`}
        className={cn(buttonVariants({ variant: "secundario" }), "max-lg:h-11")}
      >
        {M.volverCliente}
      </Link>
    </nav>
  );

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <EncabezadoPagina titulo={M.titulo} acciones={volver} />
      {error && <Alert tono="error">{error}</Alert>}
      {archivado === null && !error && <p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>}
      {archivado !== null && <Bandeja clienteFijo={{ id: clienteId, archivado }} />}
    </main>
  );
}

// `useParams()` es dato de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">{M.cargando}</main>}>
      <BuzonDelCliente />
    </Suspense>
  );
}
