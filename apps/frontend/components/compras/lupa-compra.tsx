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
import { ChevronLeft, ChevronRight, CircleAlert } from "lucide-react";
import { MENSAJES_COMPRAS as M, type ContextoCompras } from "../../lib/compras";
import { cn } from "../../lib/utils";
import {
  MENSAJES_LUPA as L,
  obtenerDetalleLupa,
} from "../../lib/lupa-compras";
import { destinoDe } from "../../lib/montos-compras";
import { MENSAJES_REGLAS as R, ofreceRecordar } from "../../lib/reglas";
import {
  RecordarTrasClasificar,
  destinoRecordable,
} from "../reglas/recordar-tras-clasificar";
import { comprobanteDe, type AlAvisar } from "./accion-compras";
import { AccionesFilaCompras } from "./acciones-fila-compras";
import { AceptarSugerencias } from "./aceptar-sugerencia";
import { CabeceraLupaCompra } from "./cabecera-lupa";
import { ComparacionXml } from "./comparacion-xml";
import { EstadoXmlLupa, bloqueoDeXml } from "./estado-xml";
import { SubirXml } from "./subir-xml";
import { HistorialCompra } from "./historial-compra";
import { ItemsXml } from "./items-xml";
import {
  Alert,
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  panelDialogo,
  velo,
} from "../ui";

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
    <div className={cn(velo, "flex items-center justify-center p-4")}>
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
  alEditar,
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
  /**
   * «Editar» (P-3): la lupa se cierra y la grilla abre esta compra en edición, con la edición de 015. Sin esta función
   * no se ofrece el botón.
   */
  alEditar?: (id: string) => void;
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
  // «Recordar para este proveedor» (spec 021, 016 P-8): el aviso se pide con el botón; clasificar desde el menú lo
  // ofrece por su cuenta (lo monta `AccionesFilaCompras`).
  const [recordando, setRecordando] = useState(false);

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
    setRecordando(false);
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
  const destinoVigente = fila !== null ? destinoRecordable(fila) : null;
  const reglasCliente = contexto.reglas;
  const ofrecerRecordar =
    fila !== null && contexto.permisos.gestionarReglas === true && reglasCliente !== undefined;
  const yaRecordado =
    fila !== null &&
    destinoVigente !== null &&
    reglasCliente !== undefined &&
    !ofreceRecordar(reglasCliente.lista, fila.proveedor, destinoVigente, true);

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

  /** El foco se quedó en `body` o en un botón deshabilitado (el que se pulsó ya no actúa): vuelve a la raíz (RF-096). */
  function recuperarFoco(): void {
    const el = raiz.current;
    if (!el) return;
    const activo = document.activeElement;
    const perdido =
      activo === null ||
      activo === document.body ||
      (activo instanceof HTMLButtonElement && activo.disabled);
    // Un foco dentro de otra ventana (aceptar, excluir) o de un campo de la lupa no se toca.
    if (perdido) el.focus();
  }

  /** Misma regla que la grilla: sin solo lectura y fuera de las excluidas. */
  const puedeEditar = fila !== null && alEditar !== undefined && contexto.permisos.clasificar;
  const motivoSinEditar = bloqueo ?? (fila?.excluida ? M.errores.fila_excluida : null);

  function editar(): void {
    if (!puedeEditar || motivoSinEditar !== null) return;
    // Primero se recarga la fila (su versión es la base del `editar`) y luego se cede la edición a la grilla.
    void (async () => {
      try {
        await contexto.recargarFila(compraId);
      } catch {
        // La grilla se refresca en la próxima carga.
      }
      alEditar?.(compraId);
    })();
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
      className={velo}
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
        className={cn(panelDialogo, "max-w-5xl gap-5 p-4 outline-none sm:p-6")}
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="titulo-lupa-compra" className="font-titulo text-xl font-semibold text-tinta">
            {L.tituloModal(comprobante)}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {indice >= 0 && (
              <>
                <Button
                  variant="secundario"
                  size="sm"
                  onClick={() => anterior !== undefined && alCambiar(anterior)}
                  disabled={anterior === undefined}
                  className="max-lg:h-11"
                >
                  <ChevronLeft aria-hidden />
                  {L.anterior}
                </Button>
                <span className="cifras text-sm text-tinta-media">{L.posicion(indice + 1, orden.length)}</span>
                <Button
                  variant="secundario"
                  size="sm"
                  onClick={() => siguiente !== undefined && alCambiar(siguiente)}
                  disabled={siguiente === undefined}
                  className="max-lg:h-11"
                >
                  {L.siguiente}
                  <ChevronRight aria-hidden />
                </Button>
              </>
            )}
            <Button variant="secundario" size="sm" onClick={cerrar} className="max-lg:h-11">
              {L.cerrar}
            </Button>
          </div>
        </header>
        <p className="text-xs text-tinta-suave">{L.ayudaTeclado}</p>

        {actual.error !== null && (
          <div className="flex flex-wrap items-center gap-3">
            <Alert tono="error" className="flex-1">
              <CircleAlert aria-hidden />
              {actual.error}
            </Alert>
            <Button variant="secundario" size="sm" onClick={recargar} className="max-lg:h-11">
              {L.reintentar}
            </Button>
          </div>
        )}
        {datos === null && actual.error === null && (
          <p role="status" className="text-sm text-tinta-suave">
            {L.cargando}
          </p>
        )}

        {datos !== null && (
          <>
            <CabeceraLupaCompra
              cabecera={datos.cabecera}
              segunHistorial={fila?.segunHistorial != null}
            />
            <EstadoXmlLupa
              contexto={contexto}
              compraId={compraId}
              xml={datos.xml}
              alRecargar={recargar}
              recuperarFoco={recuperarFoco}
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
              <h3 className="text-sm font-semibold text-tinta">{L.secciones.hallazgos}</h3>
              {datos.hallazgos.length === 0 ? (
                <p className="text-sm text-tinta-media">{L.hallazgos.sinHallazgos}</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {datos.hallazgos.map((h) => (
                    <li key={h.regla} className="rounded-control border border-linea p-3 text-tinta-media">
                      <Badge tono="aviso" className="mr-2 h-auto min-h-6 whitespace-normal py-0.5">
                        {`${h.regla} · ${M.hallazgos[h.regla]}`}
                      </Badge>
                      {h.explicacion}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label={L.secciones.historialProveedor} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-tinta">{L.secciones.historialProveedor}</h3>
              {datos.historialProveedor.length === 0 ? (
                <p className="text-sm text-tinta-media">{L.proveedor.sinHistorial}</p>
              ) : (
                <Table aria-label={L.proveedor.tabla}>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col">{L.proveedor.periodo}</TableHead>
                      <TableHead scope="col">{L.proveedor.comprobante}</TableHead>
                      <TableHead scope="col">{L.proveedor.destino}</TableHead>
                      <TableHead scope="col">{L.proveedor.excluida}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {datos.historialProveedor.map((p) => (
                      <TableRow key={`${p.periodo}|${p.serie}|${p.numero}`}>
                        <TableCell className="py-2">{p.periodo}</TableCell>
                        <TableCell className="py-2 font-mono text-[13px]">{`${p.serie}-${p.numero}`}</TableCell>
                        <TableCell className="py-2">{M.destinos[destinoDe(p)]}</TableCell>
                        <TableCell className="py-2">{p.excluida ? L.proveedor.si : L.proveedor.no}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}

        <section aria-label={L.secciones.acciones} className="flex flex-col gap-2 border-t border-linea pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {fila !== null && (
              <AccionesFilaCompras contexto={contexto} fila={fila} alAvisar={avisar} />
            )}
            {puedeEditar && (
              <Button
                variant="secundario"
                size="sm"
                onClick={editar}
                disabled={motivoSinEditar !== null}
                title={motivoSinEditar ?? L.editarAyuda}
                className="max-lg:h-11"
              >
                {L.editar}
              </Button>
            )}
            {puedeAceptar && (
              <Button
                variant="secundario"
                size="sm"
                onClick={abrirAceptacion}
                disabled={bloqueo !== null}
                title={bloqueo ?? undefined}
                className="max-lg:h-11"
              >
                {L.hallazgos.aceptar}
              </Button>
            )}
            {ofrecerRecordar && (
              <Button
                variant="secundario"
                size="sm"
                onClick={() => setRecordando(true)}
                disabled={destinoVigente === null || yaRecordado || bloqueo !== null}
                title={
                  bloqueo ?? (yaRecordado ? R.yaRecordado : undefined)
                }
                className="max-lg:h-11"
              >
                {R.recordarProveedor}
              </Button>
            )}
            <Button
              variant="secundario"
              size="sm"
              aria-expanded={verHistorial}
              onClick={() => setVerHistorial((v) => !v)}
              className="max-lg:h-11"
            >
              {verHistorial ? L.ocultarHistorial : L.historial}
            </Button>
          </div>
          {fila === null && <p className="text-sm text-tinta-media">{L.sinFila}</p>}
          {recordando && fila !== null && destinoVigente !== null && (
            <RecordarTrasClasificar
              key={`${compraId}|${destinoVigente}`}
              contexto={contexto}
              compraIds={[fila.id]}
              proveedor={fila.proveedor}
              destino={destinoVigente}
              alAvisar={avisar}
              alTerminar={() => setRecordando(false)}
            />
          )}
          {/* Con la pantalla de la grilla, ella anuncia el aviso (role="status"); aquí solo se muestra (018, P-2). */}
          <div aria-live={alAvisarDe ? undefined : "polite"}>{aviso && <p className="text-sm text-tinta-media">{aviso}</p>}</div>
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
