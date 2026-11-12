"use client";

import {
  DESTINOS_COMPRA,
  type DestinoCompra,
  type FilaCompraVista,
} from "@contapp/shared";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  clasificarCompra,
  descartarCompra,
  restaurarCompra,
  type ContextoCompras,
  type ResultadoCompras,
  type AccionCompraRespuesta,
} from "../../lib/compras";
import { destinoDe } from "../../lib/montos-compras";
import { ConfirmarAccion } from "../ventas/confirmar-accion";
import {
  comprobanteDe,
  recargarTrasError,
  recargarTrasExito,
  type AlAvisar,
} from "./accion-compras";
import { useErrorAnunciado } from "./aviso-unico";
import { AceptarSugerencias } from "./aceptar-sugerencia";
import { ExcluirCompra } from "./excluir-compra";

// Menú de acciones de una fila de compras (spec 015, D-7, D-10, D-11; HU-15, HU-17). Se enchufa en la grilla por
// `renderAcciones(fila)` (T10). Clasificar DG/DGNG/DNG, aceptar sugerencias, excluir, restaurar y descartar (solo en
// filas agregadas a mano). Sin `sire.clasificar` no se muestra nada; con `soloLectura` el botón queda deshabilitado
// con el motivo. Cada acción espera la respuesta del servidor y recarga la fila y el resumen: el navegador no calcula
// ni mueve montos.

type Panel = "aceptar" | "excluir" | "descartar" | null;

// La celda de la grilla recorta su contenido (`overflow-hidden`) y su fila usa `transform`, que además es el bloque
// contenedor de todo lo `fixed`: el menú y las ventanas salen por un portal a `document.body` (T10), si no se verían
// cortados dentro de la fila. Los eventos de React siguen subiendo por el árbol de componentes.
function Ventana({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      {children}
    </div>,
    document.body,
  );
}

/** Alto aproximado del menú: si no cabe debajo del botón, se abre hacia arriba. */
const ALTO_MENU = 280;
const ANCHO_MENU = 224;

interface PosicionMenu {
  top?: number;
  bottom?: number;
  left: number;
}

export function AccionesFilaCompras({
  contexto,
  fila,
  alAvisar,
}: {
  contexto: ContextoCompras;
  fila: FilaCompraVista;
  alAvisar?: AlAvisar;
}) {
  const [abierto, setAbierto] = useState(false);
  const [posicion, setPosicion] = useState<PosicionMenu>({ left: 0 });
  const [panel, setPanel] = useState<Panel>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { avisarError, rolDe } = useErrorAnunciado(alAvisar);
  const menu = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const comprobante = comprobanteDe(fila);

  useEffect(() => {
    if (abierto) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [abierto]);

  // El botón se deshabilita mientras guarda y el navegador deja el foco en `body` (RF-096, spec 018 T7a): al terminar
  // vuelve al botón, que está en la grilla o dentro de la lupa, para que Esc y las flechas sigan funcionando.
  const estabaOcupado = useRef(false);
  useEffect(() => {
    if (ocupado) {
      estabaOcupado.current = true;
      return;
    }
    if (!estabaOcupado.current) return;
    estabaOcupado.current = false;
    const activo = document.activeElement;
    if (activo === null || activo === document.body) boton.current?.focus();
  }, [ocupado]);

  // El menú es `fixed`: si la grilla se desplaza, deja de apuntar a su botón y se cierra.
  useEffect(() => {
    if (!abierto) return;
    const cerrar = () => setAbierto(false);
    window.addEventListener("scroll", cerrar, true);
    window.addEventListener("resize", cerrar);
    return () => {
      window.removeEventListener("scroll", cerrar, true);
      window.removeEventListener("resize", cerrar);
    };
  }, [abierto]);

  if (!contexto.permisos.clasificar) return null;

  const bloqueo = contexto.soloLectura;
  const destinoActual = fila.clasificada ? destinoDe(fila.montos) : null;

  const cerrarMenu = () => {
    setAbierto(false);
    boton.current?.focus();
  };

  async function ejecutar(
    pedir: () => Promise<ResultadoCompras<AccionCompraRespuesta>>,
    mensajeOk: string,
  ): Promise<void> {
    if (ocupado) return;
    setError(null);
    setOcupado(true);
    try {
      const r = await pedir();
      if (r.ok) {
        await recargarTrasExito(contexto, fila.id);
        alAvisar?.(mensajeOk, "ok");
      } else {
        await recargarTrasError(contexto, fila.id, r);
        setError(r.mensaje);
        avisarError(r.mensaje);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
      avisarError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  const clasificar = (destino: DestinoCompra) => {
    cerrarMenu();
    void ejecutar(
      () =>
        clasificarCompra(contexto.clienteId, contexto.periodo, fila.id, {
          versionBase: fila.version,
          destino,
        }),
      M.compraClasificada,
    );
  };

  const restaurar = () => {
    cerrarMenu();
    void ejecutar(
      () =>
        restaurarCompra(contexto.clienteId, contexto.periodo, fila.id, {
          versionBase: fila.version,
        }),
      M.compraRestaurada,
    );
  };

  const abrirPanel = (p: Exclude<Panel, null>) => {
    setAbierto(false);
    setPanel(p);
  };

  const cerrarPanel = () => {
    setPanel(null);
    boton.current?.focus();
  };

  const alTeclear = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cerrarMenu();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const i = items.findIndex((el) => el === document.activeElement);
    const paso = e.key === "ArrowDown" ? 1 : -1;
    items[(i + paso + items.length) % items.length]?.focus();
  };

  const item = (texto: string, alElegir: () => void) => (
    <button
      key={texto}
      type="button"
      role="menuitem"
      onClick={alElegir}
      className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-gray-100 focus:bg-gray-100"
    >
      {texto}
    </button>
  );

  return (
    <div className="relative inline-block text-left">
      <button
        ref={boton}
        type="button"
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={`${M.columnas.acciones} ${comprobante}`}
        disabled={bloqueo !== null || ocupado}
        title={bloqueo ?? undefined}
        onClick={() => {
          const caja = boton.current?.getBoundingClientRect();
          if (caja) {
            const left = Math.max(8, Math.min(caja.right - ANCHO_MENU, window.innerWidth - ANCHO_MENU - 8));
            setPosicion(
              caja.bottom + ALTO_MENU > window.innerHeight && caja.top > ALTO_MENU
                ? { bottom: window.innerHeight - caja.top + 4, left }
                : { top: caja.bottom + 4, left },
            );
          }
          setAbierto((a) => !a);
        }}
        className="rounded border px-2 py-1 text-sm disabled:opacity-50"
      >
        {ocupado ? M.guardando : M.columnas.acciones}
      </button>

      {abierto && bloqueo === null && createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label={`${M.columnas.acciones} ${comprobante}`}
          onKeyDown={alTeclear}
          style={{ position: "fixed", ...posicion }}
          className="z-50 flex w-56 flex-col rounded border bg-white p-1 text-black shadow-lg"
        >
          {fila.excluida ? (
            item(M.restaurar, restaurar)
          ) : (
            <>
              {DESTINOS_COMPRA.filter((d) => d !== destinoActual).map((d) =>
                item(M.clasificarComo(M.destinos[d]), () => clasificar(d)),
              )}
              {fila.hallazgos.length > 0 &&
                item(M.aceptarSugerencias, () => abrirPanel("aceptar"))}
              {item(M.excluir, () => abrirPanel("excluir"))}
            </>
          )}
          {fila.origen === "agregada" &&
            item(M.descartar, () => abrirPanel("descartar"))}
        </div>,
        document.body,
      )}

      {error && (
        <p role={rolDe(error)} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}

      {panel === "aceptar" && (
        <Ventana>
          <AceptarSugerencias
            contexto={contexto}
            fila={fila}
            alAvisar={alAvisar}
            alTerminar={cerrarPanel}
            alCancelar={cerrarPanel}
          />
        </Ventana>
      )}
      {panel === "excluir" && (
        <Ventana>
          <ExcluirCompra
            contexto={contexto}
            fila={fila}
            alAvisar={alAvisar}
            alTerminar={cerrarPanel}
            alCancelar={cerrarPanel}
          />
        </Ventana>
      )}
      {panel === "descartar" && (
        <Ventana>
          <ConfirmarAccion
            mensaje={M.confirmarDescartar(comprobante)}
            ocupado={ocupado}
            alConfirmar={() => {
              setPanel(null);
              void ejecutar(
                () =>
                  descartarCompra(contexto.clienteId, contexto.periodo, fila.id, {
                    versionBase: fila.version,
                  }),
                M.compraDescartada,
              );
            }}
            alCancelar={cerrarPanel}
          />
        </Ventana>
      )}
    </div>
  );
}
