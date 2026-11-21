"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, EncabezadoPagina, buttonVariants } from "../../../../../components/ui";
import { cn } from "../../../../../lib/utils";
import { CandidatasImportadas } from "../../../../../components/reglas/candidatas-importadas";
import { ImportarHistorial } from "../../../../../components/reglas/importar-historial";
import { TablaReglasCliente } from "../../../../../components/reglas/tabla-reglas-cliente";
import { MENSAJES } from "../../../../../lib/acceso";
import { MENSAJES_APRENDIZAJE as A } from "../../../../../lib/aprendizaje";
import { MENSAJES_REGLAS as M } from "../../../../../lib/reglas";

// Reglas aprendidas del cliente (spec 021, CA-7, HU-31). La pantalla lee y cambia las reglas con
// `TablaReglasCliente`; los permisos los valida el backend (`reglas.ver`, `reglas.gestionar`).

function ReglasDelCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  // Al completar una importación, las candidatas y la tabla de reglas se vuelven a leer (se montan de nuevo).
  const [lectura, setLectura] = useState(0);
  const [lecturaReglas, setLecturaReglas] = useState(0);
  // Cliente no visible (404): un solo aviso y ninguna acción; cada lectura que da 404 avisa y aquí se junta en uno.
  const [noVisible, setNoVisible] = useState(false);
  const alNoEncontrado = () => setNoVisible(true);
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
      {noVisible ? (
        <Alert tono="error">{MENSAJES.noEncontrado}</Alert>
      ) : (
        <>
          <section aria-label={A.tituloImportar} className="flex min-w-0 flex-col gap-3">
            <h2 className="m-0 font-titulo text-lg font-semibold text-tinta">{A.tablaCandidatas}</h2>
            <ImportarHistorial
              clienteId={clienteId}
              alCompletar={() => setLectura((n) => n + 1)}
              alNoEncontrado={alNoEncontrado}
            />
            <CandidatasImportadas
              key={lectura}
              clienteId={clienteId}
              alCrearReglas={() => setLecturaReglas((n) => n + 1)}
              alNoEncontrado={alNoEncontrado}
            />
          </section>
          <TablaReglasCliente
            key={`${lectura}-${lecturaReglas}`}
            clienteId={clienteId}
            alNoEncontrado={alNoEncontrado}
          />
        </>
      )}
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
