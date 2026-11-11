"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fechaHoraLima } from "../../lib/fechas";
import {
  destinoDe,
  EVENTO_NOTIFICACIONES_CAMBIO,
  listarNotificaciones,
  marcarLeida,
  marcarTodasLeidas,
  MAX_EN_PANEL,
  MENSAJES_NOTIFICACIONES as M,
  suscribirAvisos,
  type NotificacionVista,
} from "../../lib/notificaciones";
import { TextoNotificacion } from "./texto-notificacion";

// Lista de notificaciones (spec 017, D-11; CA-16). `PanelNotificaciones` es el desplegable de la campana (las 10
// últimas); `ListaNotificaciones` es la página completa con «cargar más». Ambos comparten la fila y las acciones:
// marcar como leída al abrir y navegar al cliente o al trabajo, y «marcar todas» hasta la más nueva que se ve.
// Ambos se refrescan solos cuando llega un aviso en vivo (T18a, P-8).

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
          {fechaHoraLima(notificacion.creadaEn)}
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
  // Cuántas páginas hay cargadas: al refrescar, con una sola se reemplaza todo y con más se antepone lo nuevo.
  const paginas = useRef(0);

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
        paginas.current = cursor ? paginas.current + 1 : 1;
        setItems((previos) => {
          if (!cursor) return nuevos;
          const ids = new Set(previos.map((p) => p.id));
          return [...previos, ...nuevos.filter((n) => !ids.has(n.id))];
        });
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

  // P-8: llegó un aviso (o se reconectó el stream): se vuelve a leer la primera página sin parpadeo ni perder el
  // foco. Un fallo aquí no molesta: la lista queda como estaba.
  const refrescar = useCallback(async () => {
    try {
      const r = await listarNotificaciones(null);
      if (!r.ok || !r.datos) return;
      const nuevos = r.datos.items;
      if (paginas.current <= 1) {
        paginas.current = 1;
        setItems(nuevos);
        setSiguiente(r.datos.siguiente);
        return;
      }
      const ids = new Set(nuevos.map((n) => n.id));
      setItems((previos) => [...nuevos, ...previos.filter((p) => !ids.has(p.id))]);
    } catch {
      // Sin cambios.
    }
  }, []);

  useEffect(() => suscribirAvisos(() => void refrescar()), [refrescar]);

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

/**
 * Desplegable de la campana: las 10 últimas, «marcar todas» y enlace a la página completa. Al abrirse el foco entra
 * al panel (P-5); cerrarlo con Esc o con un clic fuera y devolver el foco a la campana lo hace `Campana`.
 */
export function PanelNotificaciones({ alCerrar }: { alCerrar: () => void }) {
  const { visibles, cargando, error, cargar, abrir, marcarTodas } =
    useLista(MAX_EN_PANEL);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={M.panel}
      tabIndex={-1}
      className="absolute right-0 z-10 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded border bg-white shadow focus:outline-none max-sm:fixed max-sm:inset-x-4 max-sm:w-auto"
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

  // P-6: tras «Cargar más» el foco pasa a la primera fila nueva (el botón puede desaparecer en la última página y
  // deshabilitarlo con `disabled` también lo suelta). Si la carga falla, se queda en el botón.
  const lista = useRef<HTMLUListElement>(null);
  const botonMas = useRef<HTMLButtonElement>(null);
  const primeraNueva = useRef<number | null>(null);
  useEffect(() => {
    if (cargando || primeraNueva.current === null) return;
    const indice = primeraNueva.current;
    primeraNueva.current = null;
    const filas = lista.current?.querySelectorAll<HTMLButtonElement>(
      ":scope > li > button",
    );
    const destino = visibles.length > indice ? filas?.[indice] : undefined;
    (destino ?? botonMas.current)?.focus();
  }, [cargando, visibles]);
  function cargarMas() {
    if (cargando || siguiente === null) return;
    primeraNueva.current = visibles.length;
    void cargar(siguiente);
  }

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
      <ul ref={lista} className="mt-4">
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
          ref={botonMas}
          type="button"
          className="mt-4 rounded border px-3 py-1 text-sm aria-disabled:opacity-50"
          aria-disabled={cargando}
          onClick={cargarMas}
        >
          {M.cargarMas}
        </button>
      )}
    </section>
  );
}
