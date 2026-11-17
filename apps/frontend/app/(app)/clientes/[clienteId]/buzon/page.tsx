"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, EncabezadoPagina, buttonVariants } from "../../../../../components/ui";
import { DetalleMensaje } from "../../../../../components/buzon/detalle-mensaje";
import { ListaMensajes } from "../../../../../components/buzon/lista-mensajes";
import { RevisarBuzon } from "../../../../../components/buzon/revisar-buzon";
import { MENSAJES, mensajeDeError } from "../../../../../lib/acceso";
import { obtenerCliente } from "../../../../../lib/clientes";
import {
  MENSAJES_BUZON as M,
  listarMensajes,
  type EstadoBuzonVista,
  type MensajeBuzonFila,
} from "../../../../../lib/buzon";
import { fechaHoraLima } from "../../../../../lib/fechas";
import { cn } from "../../../../../lib/utils";

// Buzón SOL de un cliente (spec 023, CA-2, CA-6, D-4): lista mínima de mensajes y, con `?mensaje=<id>`, el detalle.
// Los permisos (`buzon.ver`, `buzon.marcar_leido`) los valida el backend; aquí solo se oculta lo que no corresponde.

function BuzonDelCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const mensajeId = useSearchParams().get("mensaje");
  const [archivado, setArchivado] = useState(false);
  const [estado, setEstado] = useState<EstadoBuzonVista | null>(null);
  const [mensajes, setMensajes] = useState<MensajeBuzonFila[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargado, setCargado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargarPagina = useCallback(
    async (cursor: string | null): Promise<void> => {
      setOcupado(true);
      try {
        const r = await listarMensajes(clienteId, { cursor });
        if (r.status === 401) return;
        if (r.ok && r.datos) {
          const datos = r.datos;
          setEstado(datos.estado);
          setMensajes((previos) => (cursor ? [...previos, ...datos.mensajes] : datos.mensajes));
          setSiguiente(datos.siguiente);
          setError(null);
        } else {
          setError(r.status === 200 || r.status === 500 ? M.errorCarga : mensajeDeError(r.status, r.datos));
        }
      } catch {
        setError(MENSAJES.errorGeneral);
      } finally {
        setOcupado(false);
        setCargado(true);
      }
    },
    [clienteId],
  );

  useEffect(() => {
    let vigente = true;
    obtenerCliente(clienteId)
      .then((r) => {
        if (vigente && r.ok && r.datos) setArchivado(r.datos.archivado === true);
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  useEffect(() => {
    if (!mensajeId) void cargarPagina(null);
  }, [mensajeId, cargarPagina]);

  const volver = (
    <nav aria-label="Ruta de navegación">
      <Link
        href={mensajeId ? `/clientes/${encodeURIComponent(clienteId)}/buzon` : `/clientes/${encodeURIComponent(clienteId)}`}
        className={cn(buttonVariants({ variant: "secundario" }), "max-lg:h-11")}
      >
        {mensajeId ? M.volverLista : M.volverCliente}
      </Link>
    </nav>
  );

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <EncabezadoPagina titulo={M.titulo} acciones={volver} />
      {mensajeId ? (
        <DetalleMensaje clienteId={clienteId} mensajeId={mensajeId} />
      ) : (
        <>
          <RevisarBuzon clienteId={clienteId} archivado={archivado} />
          {error && <Alert tono="error">{error}</Alert>}
          {!cargado && !error && <p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>}
          {cargado && !error && (
            <Card>
              <p className="m-0 text-sm text-tinta-suave">
                {estado?.ultimaCaptura ? M.ultimaCaptura(fechaHoraLima(estado.ultimaCaptura)) : M.nuncaRevisado}
              </p>
              <ListaMensajes clienteId={clienteId} mensajes={mensajes} />
              {siguiente && (
                <Button
                  type="button"
                  variant="secundario"
                  disabled={ocupado}
                  onClick={() => void cargarPagina(siguiente)}
                  className="self-start max-lg:h-11"
                >
                  {M.cargarMas}
                </Button>
              )}
            </Card>
          )}
        </>
      )}
    </main>
  );
}

// `useParams()` y `useSearchParams()` son datos de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">{M.cargando}</main>}>
      <BuzonDelCliente />
    </Suspense>
  );
}
