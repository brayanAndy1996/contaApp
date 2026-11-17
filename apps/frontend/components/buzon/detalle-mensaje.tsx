"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  enlace,
} from "../ui";
import { MENSAJES, mensajeDeError, usePuede } from "../../lib/acceso";
import {
  MENSAJES_BUZON as M,
  PERMISO_BUZON_MARCAR_LEIDO,
  abrirMensaje,
  descargarAdjuntoBuzon,
  etiquetaCategoria,
  hrefAdjunto,
  obtenerMensaje,
  textoConflictoBuzon,
  type DetalleMensaje as DetalleDto,
} from "../../lib/buzon";
import { fechaHoraLima } from "../../lib/fechas";
import { cn } from "../../lib/utils";

// Vista mínima de un mensaje del buzón (spec 023, CA-4, CA-8, P-1, P-9, D-4). El contenido llega como texto plano
// ya convertido por el servidor y se muestra como texto de React (`whitespace-pre-wrap`): nunca se interpreta como
// HTML. Los adjuntos se descargan por id. «Abrir en SUNAT» pide confirmación porque SUNAT puede marcar el mensaje como
// leído; solo se ofrece con `buzon.marcar_leido` y mientras no haya contenido.

const enlaceTactil = cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center");

type Aviso = { tipo: "encolada" } | { tipo: "obtenido" } | { tipo: "error"; texto: string };

const formatoTamano = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

export function DetalleMensaje({ clienteId, mensajeId }: { clienteId: string; mensajeId: string }) {
  const puedeAbrir = usePuede(PERMISO_BUZON_MARCAR_LEIDO) === true;
  const [detalle, setDetalle] = useState<DetalleDto | null>(null);
  const [cargado, setCargado] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [descargando, setDescargando] = useState<string | null>(null);
  const [errorDescarga, setErrorDescarga] = useState<string | null>(null);

  const cargar = useCallback(async (): Promise<void> => {
    try {
      const r = await obtenerMensaje(clienteId, mensajeId);
      if (r.status === 401) return;
      if (r.ok && r.datos) {
        setDetalle(r.datos);
        setErrorCarga(null);
      } else {
        setErrorCarga(mensajeDeError(r.status === 200 ? 500 : r.status, r.datos));
      }
    } catch {
      setErrorCarga(MENSAJES.errorGeneral);
    } finally {
      setCargado(true);
    }
  }, [clienteId, mensajeId]);

  useEffect(() => {
    setDetalle(null);
    setCargado(false);
    setAviso(null);
    void cargar();
  }, [cargar]);

  async function confirmarApertura() {
    setConfirmando(false);
    setOcupado(true);
    setAviso(null);
    try {
      const r = await abrirMensaje(clienteId, mensajeId);
      if (r.status === 401) return;
      if (r.ok && r.datos) {
        if (r.datos.trabajo === null) {
          setAviso({ tipo: "obtenido" });
          await cargar();
        } else {
          setAviso({ tipo: "encolada" });
        }
      } else {
        const texto =
          r.status === 409 ? textoConflictoBuzon((r.datos as { codigo?: string } | null)?.codigo) : null;
        setAviso({ tipo: "error", texto: texto ?? mensajeDeError(r.status, r.datos) });
      }
    } catch {
      setAviso({ tipo: "error", texto: MENSAJES.errorGeneral });
    } finally {
      setOcupado(false);
    }
  }

  if (!cargado) return <p className="m-0 text-sm text-tinta-suave">{M.cargandoMensaje}</p>;
  if (errorCarga || !detalle) {
    return <Alert tono="error">{errorCarga ?? MENSAJES.errorGeneral}</Alert>;
  }

  const { mensaje, contenido, adjuntos } = detalle;
  const sinContenido = contenido === null;
  const ofrecerAbrir = puedeAbrir && sinContenido && aviso?.tipo !== "encolada";


  // El enlace conserva su `href` (ruta de descarga por id), pero el clic baja el archivo con `fetch` + `X-Estudio`:
  // una navegación directa no manda esa cabecera y el servidor respondería 409 (CA-8).
  async function descargar(adjuntoId: string, nombre: string): Promise<void> {
    if (descargando !== null) return;
    setDescargando(adjuntoId);
    setErrorDescarga(null);
    try {
      const r = await descargarAdjuntoBuzon(clienteId, mensajeId, adjuntoId);
      if (!r.ok) {
        if (r.status !== 401) setErrorDescarga(r.mensaje);
        return;
      }
      const url = URL.createObjectURL(r.archivo);
      const enlaceDescarga = document.createElement("a");
      enlaceDescarga.href = url;
      enlaceDescarga.download = nombre;
      enlaceDescarga.rel = "noopener";
      document.body.appendChild(enlaceDescarga);
      enlaceDescarga.click();
      enlaceDescarga.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDescargando(null);
    }
  }
  return (
    <article className="flex min-w-0 flex-col gap-4">
      <Card>
        <header className="flex flex-col gap-2">
          <h2 className="m-0 break-words font-titulo text-lg font-bold">{mensaje.asunto}</h2>
          <p className="m-0 break-words text-sm text-tinta-media">{mensaje.remitente}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-tinta-suave">
            {mensaje.critico && <Badge tono="error">{M.critico(etiquetaCategoria(mensaje.categoria))}</Badge>}
            <span>{fechaHoraLima(mensaje.fecha)}</span>
          </div>
        </header>

        {sinContenido ? (
          <p className="m-0 text-sm text-tinta-suave">{M.sinContenido}</p>
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm">{contenido}</div>
        )}

        {ofrecerAbrir && (
          <Button
            type="button"
            variant="secundario"
            disabled={ocupado}
            onClick={() => setConfirmando(true)}
            className="self-start max-lg:h-11"
          >
            {M.abrirEnSunat}
          </Button>
        )}

        {aviso?.tipo === "error" && <Alert tono="error">{aviso.texto}</Alert>}
        {aviso?.tipo === "obtenido" && <Alert tono="ok">{M.yaObtenido}</Alert>}
        {aviso?.tipo === "encolada" && (
          <Alert tono="ok" className="flex-wrap">
            <span>{M.aperturaEncolada}</span>
            <Link href="/trabajos" className={enlaceTactil}>
              {M.enlacePanel}
            </Link>
          </Alert>
        )}
      </Card>

      {adjuntos.length > 0 && (
        <Card aria-label={M.adjuntos}>
          <CardTitle>{M.adjuntos}</CardTitle>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {adjuntos.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {a.omitido === null ? (
                  <a
                    href={hrefAdjunto(clienteId, mensajeId, a.id)}
                    className={cn(enlaceTactil, "break-all")}
                    aria-busy={descargando === a.id || undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      void descargar(a.id, a.nombre);
                    }}
                    onAuxClick={(e) => e.preventDefault()}
                  >
                    {a.nombre}
                  </a>
                ) : (
                  <span className="break-all">{a.nombre}</span>
                )}
                {a.omitido === null ? (
                  <span className="text-tinta-suave">{formatoTamano(a.tamano)}</span>
                ) : (
                  <span className="text-tinta-suave">{M.omitido[a.omitido]}</span>
                )}
              </li>
            ))}
          </ul>
          {errorDescarga !== null && <Alert tono="error">{errorDescarga}</Alert>}
        </Card>
      )}

      <Dialog open={confirmando} onOpenChange={setConfirmando}>
        <DialogContent mostrarCerrar={false}>
          <DialogHeader>
            <DialogTitle>{M.tituloAbrir}</DialogTitle>
            <DialogDescription>{M.avisoAbrir}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secundario" onClick={() => setConfirmando(false)} className="max-lg:h-11">
              {M.cancelar}
            </Button>
            <Button type="button" onClick={() => void confirmarApertura()} className="max-lg:h-11">
              {M.confirmar}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
