"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { EncabezadoPagina, buttonVariants } from "../../../../../components/ui";
import { cn } from "../../../../../lib/utils";
import { TablaReglasCliente } from "../../../../../components/reglas/tabla-reglas-cliente";
import { MENSAJES_REGLAS as M } from "../../../../../lib/reglas";

// Reglas aprendidas del cliente (spec 021, CA-7, HU-31). La pantalla lee y cambia las reglas con
// `TablaReglasCliente`; los permisos los valida el backend (`reglas.ver`, `reglas.gestionar`).

function ReglasDelCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <EncabezadoPagina
        titulo={M.tituloReglasCliente}
        acciones={
          <nav aria-label="Ruta de navegación">
            <Link
              href={`/clientes/${encodeURIComponent(clienteId)}`}
              className={cn(buttonVariants({ variant: "secundario" }), "max-lg:h-11")}
            >
              Volver al cliente
            </Link>
          </nav>
        }
      />
      <TablaReglasCliente clienteId={clienteId} />
    </main>
  );
}

// `useParams()` es un dato de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">{M.cargando}</main>}>
      <ReglasDelCliente />
    </Suspense>
  );
}
