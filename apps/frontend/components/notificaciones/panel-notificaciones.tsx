"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  destinoDe,
  EVENTO_NOTIFICACIONES_CAMBIO,
  listarNotificaciones,
  marcarLeida,
  marcarTodasLeidas,
  MAX_EN_PANEL,
  MENSAJES_NOTIFICACIONES as M,
  type NotificacionVista,
} from "../../lib/notificaciones";
import { TextoNotificacion } from "./texto-notificacion";

// Lista de notificaciones (spec 017, D-11; CA-16). `PanelNotificaciones` es el desplegable de la campana (las 10
// últimas); `ListaNotificaciones` es la página completa con «cargar más». Ambos comparten la fila y las acciones:
// marcar como leída al abrir y navegar al cliente o al trabajo, y «marcar todas» hasta la más nueva que se ve.

const FORMATO_FECHA = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Lima",
});

export function avisarCambio(): void {
  window.dispatchEvent(new Event(EVENTO_NOTIFICACIONES_CAMBIO));
}

function FilaNotificacion({
  notificacion,
  alAbrir,
}: {
  notificacion: NotificacionVista;
  alAbrir: (n: NotificacionVista) => void;
}) {
  const sinLeer = notificacion.leidaEn === null;
  return (
    <li>
      <button
        type="button"
        onClick={() => alAbrir(notificacion)}
        className={`flex w-full flex-col gap-1 border-b px-3 py-2 text-left text-sm ${sinLeer ? "font-semibold" : ""}`}
      >
        <TextoNotificacion notificacion={notificacion} />
        <span className="text-xs font-normal text-gray-500">
          {FORMATO_FECHA.format(new Date(notificacion.creadaEn))}
          {sinLeer && ` · ${M.sinLeer}`}
        </span>
      </button>
    </li>
  );
}

/** Estado y acciones comunes del panel y la página. */
function useLista(limite: number | null) {
  const router = useRouter();
  const [items, setItems] = useState<NotificacionVista[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(
    async (cursor: string | null) => {
      setCargando(true);
      setError(null);
      try {
        const r = await listarNotificaciones(cursor);
        if (!r.ok || !r.datos) {
          setError(M.errorCarga);
          return;
        }
        const nuevos = r.datos.items;
        setItems((previos) => (cursor ? [...previos, ...nuevos] : nuevos));
        setSiguiente(r.datos.siguiente);
      } catch {
        setError(M.errorCarga);
      } finally {
        setCargando(false);
      }
    },
    [],
  );

  useEffect(() => {
    void cargar(null);
  }, [cargar]);

  const abrir = useCallback(
    async (n: NotificacionVista) => {
      if (n.leidaEn === null) {
        try {
          const r = await marcarLeida(n.id);
          if (!r.ok && r.status !== 404) {
            setError(M.errorMarcar);
            return;
          }
          setItems((previos) =>
            previos.map((p) =>
              p.id === n.id ? { ...p, leidaEn: new Date().toISOString() } : p,
            ),
          );
          avisarCambio();
        } catch {
          setError(M.errorMarcar);
          return;
        }
      }
      const destino = destinoDe(n);
      if (destino) router.push(destino);
    },
    [router],
  );

  const marcarTodas = useCallback(async () => {
    // Hasta la más nueva que se ve: lo que llegó después queda sin leer.
    const hasta = items.reduce<string | null>(
      (max, n) => (max === null || n.creadaEn > max ? n.creadaEn : max),
      null,
    );
    if (!hasta) return;
    try {
      const r = await marcarTodasLeidas(hasta);
      if (!r.ok) {
        setError(M.errorMarcar);
        return;
      }
      const ahora = new Date().toISOString();
      setItems((previos) =>
        previos.map((p) =>
          p.leidaEn === null && p.creadaEn <= hasta ? { ...p, leidaEn: ahora } : p,
        ),
      );
      avisarCambio();
    } catch {
      setError(M.errorMarcar);
    }
  }, [items]);

  const visibles = limite === null ? items : items.slice(0, limite);
  return { visibles, siguiente, cargando, error, cargar, abrir, marcarTodas };
}

function Estado({
  cargando,
  error,
  vacio,
  alReintentar,
}: {
  cargando: boolean;
  error: string | null;
  vacio: boolean;
  alReintentar: () => void;
}) {
  if (error) {
    return (
      <div role="alert" className="px-3 py-2 text-sm text-red-600">
        <p>{error}</p>
        <button type="button" className="underline" onClick={alReintentar}>
          {M.reintentar}
        </button>
      </div>
    );
  }
  if (cargando && vacio) return <p role="status" className="px-3 py-2 text-sm">{M.cargando}</p>;
  if (!cargando && vacio) return <p className="px-3 py-2 text-sm">{M.vacio}</p>;
  return null;
}

/** Desplegable de la campana: las 10 últimas, «marcar todas» y enlace a la página completa. */
export function PanelNotificaciones({ alCerrar }: { alCerrar: () => void }) {
  const { visibles, cargando, error, cargar, abrir, marcarTodas } =
    useLista(MAX_EN_PANEL);
  return (
    <div
      role="dialog"
      aria-label={M.panel}
      className="absolute right-0 z-10 mt-2 w-96 max-w-[90vw] rounded border bg-white shadow"
    >
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
        <h2 className="font-semibold">{M.titulo}</h2>
        <button
          type="button"
          className="underline"
          onClick={() => void marcarTodas()}
          disabled={visibles.length === 0}
        >
          {M.marcarTodas}
        </button>
      </div>
      <Estado
        cargando={cargando}
        error={error}
        vacio={visibles.length === 0}
        alReintentar={() => void cargar(null)}
      />
      <ul>
        {visibles.map((n) => (
          <FilaNotificacion
            key={n.id}
            notificacion={n}
            alAbrir={(x) => {
              void abrir(x).then(alCerrar);
            }}
          />
        ))}
      </ul>
      <div className="px-3 py-2 text-sm">
        <Link href="/notificaciones" onClick={alCerrar} className="underline">
          {M.verTodas}
        </Link>
      </div>
    </div>
  );
}

/** Página completa de notificaciones, con «cargar más». */
export function ListaNotificaciones() {
  const { visibles, siguiente, cargando, error, cargar, abrir, marcarTodas } =
    useLista(null);
  return (
    <section className="mx-auto max-w-2xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{M.titulo}</h1>
        <button
          type="button"
          className="text-sm underline"
          onClick={() => void marcarTodas()}
          disabled={visibles.length === 0}
        >
          {M.marcarTodas}
        </button>
      </div>
      <Estado
        cargando={cargando}
        error={error}
        vacio={visibles.length === 0}
        alReintentar={() => void cargar(null)}
      />
      <ul className="mt-4">
        {visibles.map((n) => (
          <FilaNotificacion
            key={n.id}
            notificacion={n}
            alAbrir={(x) => void abrir(x)}
          />
        ))}
      </ul>
      {siguiente && (
        <button
          type="button"
          className="mt-4 rounded border px-3 py-1 text-sm"
          disabled={cargando}
          onClick={() => void cargar(siguiente)}
        >
          {M.cargarMas}
        </button>
      )}
    </section>
  );
}
