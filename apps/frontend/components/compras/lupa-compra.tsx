"use client";

import type { DetalleLupa, FilaCompraVista } from "@contapp/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MENSAJES_COMPRAS as M, type ContextoCompras } from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  obtenerDetalleLupa,
} from "../../lib/lupa-compras";
import { destinoDe } from "../../lib/montos-compras";
import { comprobanteDe, type AlAvisar } from "./accion-compras";
import { AccionesFilaCompras } from "./acciones-fila-compras";
import { AceptarSugerencias } from "./aceptar-sugerencia";
import { CabeceraLupaCompra } from "./cabecera-lupa";
import { ComparacionXml } from "./comparacion-xml";
import { EstadoXmlLupa, bloqueoDeXml } from "./estado-xml";
import { SubirXml } from "./subir-xml";
import { HistorialCompra } from "./historial-compra";
import { ItemsXml } from "./items-xml";

// Lupa del comprobante (spec 016, T15; HU-20, CA-14 a CA-17; RF-091 a RF-097). Modal accesible (`aria-modal`, foco
// atrapado, Esc cierra) con cabecera, estado del XML, ítems, comparación SIRE y XML, hallazgos y sugerencia, las
// acciones de 015 y el historial de la compra y del proveedor. Todo sale de `GET …/:compraId/detalle`, validado con
// `detalleLupaSchema`; los textos del XML y del SIRE se pintan como texto. Teclado: ← → recorren el orden que tenía
// la grilla (`orden`, lo entrega ella al abrir), Enter abre la aceptación de la sugerencia visible (y Enter de nuevo
// la acepta), Esc cierra. Al cerrar se recarga la fila. Las acciones usan las mismas rutas y mensajes (409/422) que
// la grilla y quedan deshabilitadas según `soloLectura`.

const FOCALIZABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Ventana encima de la lupa (sale por un portal: las acciones de 015 también lo hacen). */
function Ventana({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      {children}
    </div>,
    document.body,
  );
}

interface EstadoDetalle {
  id: string;
  datos: DetalleLupa | null;
  error: string | null;
}

export function LupaCompra({
  contexto,
  filas,
  orden,
  compraId,
  alCambiar,
  alCerrar,
  alAvisarDe,
  subir,
}: {
  contexto: ContextoCompras;
  /** Las compras cargadas: de aquí salen la versión y los hallazgos vigentes que usan las acciones. */
  filas: readonly FilaCompraVista[];
  /** Ids en el orden en que la grilla los mostraba al abrir la lupa. */
  orden: readonly string[];
  compraId: string;
  alCambiar: (id: string) => void;
  alCerrar: () => void;
  /** Aviso de una acción de la fila (la página lo anota para «Deshacer»). */
  alAvisarDe?: (fila: FilaCompraVista) => AlAvisar;
  /** «Subir XML» (T16): se ofrece cuando el XML no está disponible. */
  subir?: (alSubido: () => void) => ReactNode;
}) {
  const { clienteId, periodo } = contexto;
  const fila = filas.find((f) => f.id === compraId) ?? null;
  const version = fila?.version;
  const raiz = useRef<HTMLDivElement>(null);

  const [detalle, setDetalle] = useState<EstadoDetalle>({ id: compraId, datos: null, error: null });
  const [recarga, setRecarga] = useState(0);
  const recargar = useCallback(() => setRecarga((n) => n + 1), []);
  const [panel, setPanel] = useState(false);
  const [verHistorial, setVerHistorial] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  // Foco: entra en el modal y vuelve a quien lo abrió. Cambiar de compra no mueve el foco.
  useEffect(() => {
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    raiz.current?.focus();
    return () => previo?.focus();
  }, []);

  // Cambia la compra, su versión (una acción la cambió) o se pide recargar: se vuelve a pedir el detalle. La
  // respuesta que llega tarde (de otra compra o de una carga vieja) se descarta.
  useEffect(() => {
    let vigente = true;
    void obtenerDetalleLupa(clienteId, periodo, compraId).then((r) => {
      if (!vigente) return;
      setDetalle((previo) =>
        r.ok
          ? { id: compraId, datos: r.datos, error: null }
          : {
              id: compraId,
              datos: previo.id === compraId ? previo.datos : null,
              error: r.status === 401 ? null : r.mensaje,
            },
      );
    });
    return () => {
      vigente = false;
    };
  }, [clienteId, periodo, compraId, version, recarga]);

  useEffect(() => {
    setPanel(false);
    setVerHistorial(false);
    setAviso(null);
  }, [compraId]);

  const actual = detalle.id === compraId ? detalle : { id: compraId, datos: null, error: null };
  const datos = actual.datos;
  const indice = orden.indexOf(compraId);
  const anterior = indice > 0 ? orden[indice - 1] : undefined;
  const siguiente = indice >= 0 ? orden[indice + 1] : undefined;
  const comprobante = fila
    ? comprobanteDe(fila)
    : datos
      ? `${datos.cabecera.serie}-${datos.cabecera.numero}`
      : "";

  const puedeAceptar =
    fila !== null &&
    contexto.permisos.clasificar &&
    !fila.excluida &&
    fila.hallazgos.length > 0;
  const bloqueo = contexto.soloLectura;

  function cerrar(): void {
    void (async () => {
      try {
        await contexto.recargarFila(compraId);
      } catch {
        // La grilla se refresca en la próxima carga.
      }
    })();
    alCerrar();
  }

  function abrirAceptacion(): void {
    if (puedeAceptar && bloqueo === null) setPanel(true);
  }

  const avisar: AlAvisar = (texto, tipo) => {
    setAviso(tipo === "error" ? null : texto);
    if (fila) alAvisarDe?.(fila)(texto, tipo);
  };

  function alTeclear(e: KeyboardEvent<HTMLDivElement>): void {
    const objetivo = e.target instanceof HTMLElement ? e.target : null;
    // Las acciones de 015 salen por portales: sus teclas son suyas, aunque React las suba hasta aquí.
    if (!objetivo || !raiz.current?.contains(objetivo)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return;
    }
    if (e.key === "Tab") {
      const lista = Array.from(raiz.current.querySelectorAll<HTMLElement>(FOCALIZABLES));
      const primero = lista[0];
      const ultimo = lista[lista.length - 1];
      if (!primero || !ultimo) return;
      if (e.shiftKey && (objetivo === raiz.current || objetivo === primero)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && objetivo === ultimo) {
        e.preventDefault();
        primero.focus();
      }
      return;
    }
    // En un campo, las flechas y Enter son del campo.
    if (objetivo.closest("input, select, textarea") !== null) return;
    if (e.key === "ArrowLeft" && anterior !== undefined) {
      e.preventDefault();
      alCambiar(anterior);
    } else if (e.key === "ArrowRight" && siguiente !== undefined) {
      e.preventDefault();
      alCambiar(siguiente);
    } else if (e.key === "Enter" && objetivo.closest("button, a, summary") === null) {
      e.preventDefault();
      abrirAceptacion();
    }
  }

  const hayXml = datos?.xml.estado === "disponible";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <div
        ref={raiz}
        role="dialog"
        aria-modal="true"
        aria-labelledby="titulo-lupa-compra"
        tabIndex={-1}
        onKeyDown={alTeclear}
        className="flex max-h-full w-full max-w-5xl flex-col gap-4 overflow-auto rounded bg-white p-4 shadow-lg outline-none"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="titulo-lupa-compra" className="text-lg font-semibold">
            {L.tituloModal(comprobante)}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {indice >= 0 && (
              <>
                <button
                  type="button"
                  onClick={() => anterior !== undefined && alCambiar(anterior)}
                  disabled={anterior === undefined}
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                >
                  {L.anterior}
                </button>
                <span className="text-sm">{L.posicion(indice + 1, orden.length)}</span>
                <button
                  type="button"
                  onClick={() => siguiente !== undefined && alCambiar(siguiente)}
                  disabled={siguiente === undefined}
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                >
                  {L.siguiente}
                </button>
              </>
            )}
            <button type="button" onClick={cerrar} className="rounded border px-3 py-1 text-sm">
              {L.cerrar}
            </button>
          </div>
        </header>
        <p className="text-xs text-gray-700">{L.ayudaTeclado}</p>

        {actual.error !== null && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm text-red-600">
              {actual.error}
            </p>
            <button type="button" onClick={recargar} className="rounded border px-3 py-1 text-sm">
              {L.reintentar}
            </button>
          </div>
        )}
        {datos === null && actual.error === null && (
          <p role="status" className="text-sm">
            {L.cargando}
          </p>
        )}

        {datos !== null && (
          <>
            <CabeceraLupaCompra cabecera={datos.cabecera} />
            <EstadoXmlLupa
              contexto={contexto}
              compraId={compraId}
              xml={datos.xml}
              alRecargar={recargar}
              subir={
                subir?.(recargar) ?? (
                  <SubirXml
                    contexto={contexto}
                    compraId={compraId}
                    bloqueo={bloqueoDeXml(contexto)}
                    alSubido={recargar}
                  />
                )
              }
            />
            <ItemsXml items={datos.items} hayXml={hayXml} />
            <ComparacionXml filas={datos.comparacion} hayXml={hayXml} />

            <section aria-label={L.secciones.hallazgos} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{L.secciones.hallazgos}</h3>
              {datos.hallazgos.length === 0 ? (
                <p className="text-sm">{L.hallazgos.sinHallazgos}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {datos.hallazgos.map((h) => (
                    <li key={h.regla} className="rounded border p-2">
                      <span className="mr-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium">
                        {`${h.regla} · ${M.hallazgos[h.regla]}`}
                      </span>
                      {h.explicacion}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label={L.secciones.historialProveedor} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{L.secciones.historialProveedor}</h3>
              {datos.historialProveedor.length === 0 ? (
                <p className="text-sm">{L.proveedor.sinHistorial}</p>
              ) : (
                <table aria-label={L.proveedor.tabla} className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th scope="col" className="py-1 pr-2">{L.proveedor.periodo}</th>
                      <th scope="col" className="py-1 pr-2">{L.proveedor.comprobante}</th>
                      <th scope="col" className="py-1 pr-2">{L.proveedor.destino}</th>
                      <th scope="col" className="py-1">{L.proveedor.excluida}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datos.historialProveedor.map((p) => (
                      <tr key={`${p.periodo}|${p.serie}|${p.numero}`} className="border-t">
                        <td className="py-1 pr-2">{p.periodo}</td>
                        <td className="py-1 pr-2">{`${p.serie}-${p.numero}`}</td>
                        <td className="py-1 pr-2">{M.destinos[destinoDe(p)]}</td>
                        <td className="py-1">{p.excluida ? L.proveedor.si : L.proveedor.no}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}

        <section aria-label={L.secciones.acciones} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {fila !== null && (
              <AccionesFilaCompras contexto={contexto} fila={fila} alAvisar={avisar} />
            )}
            {puedeAceptar && (
              <button
                type="button"
                onClick={abrirAceptacion}
                disabled={bloqueo !== null}
                title={bloqueo ?? undefined}
                className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              >
                {L.hallazgos.aceptar}
              </button>
            )}
            <button
              type="button"
              aria-expanded={verHistorial}
              onClick={() => setVerHistorial((v) => !v)}
              className="rounded border px-3 py-1 text-sm"
            >
              {verHistorial ? L.ocultarHistorial : L.historial}
            </button>
          </div>
          {fila === null && <p className="text-sm">{L.sinFila}</p>}
          <div aria-live="polite">{aviso && <p className="text-sm">{aviso}</p>}</div>
          {verHistorial && (
            <div className="overflow-x-auto">
              <HistorialCompra
                key={`${compraId}|${version ?? 0}`}
                contexto={contexto}
                compraId={compraId}
                alCerrar={() => setVerHistorial(false)}
              />
            </div>
          )}
        </section>
      </div>

      {panel && fila !== null && (
        <Ventana>
          <AceptarSugerencias
            contexto={contexto}
            fila={fila}
            alAvisar={avisar}
            alTerminar={() => {
              setPanel(false);
              raiz.current?.focus();
            }}
            alCancelar={() => {
              setPanel(false);
              raiz.current?.focus();
            }}
          />
        </Ventana>
      )}
    </div>
  );
}
