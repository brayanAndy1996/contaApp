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
import { AceptarSugerencias } from "./aceptar-sugerencia";
import { ExcluirCompra } from "./excluir-compra";

// Menú de acciones de una fila de compras (spec 015, D-7, D-10, D-11; HU-15, HU-17). Se enchufa en la grilla por
// `renderAcciones(fila)` (T10). Clasificar DG/DGNG/DNG, aceptar sugerencias, excluir, restaurar y descartar (solo en
// filas agregadas a mano). Sin `sire.clasificar` no se muestra nada; con `soloLectura` el botón queda deshabilitado
// con el motivo. Cada acción espera la respuesta del servidor y recarga la fila y el resumen: el navegador no calcula
// ni mueve montos.

type Panel = "aceptar" | "excluir" | "descartar" | null;

function Ventana({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      {children}
    </div>
  );
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
  const [panel, setPanel] = useState<Panel>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const comprobante = comprobanteDe(fila);

  useEffect(() => {
    if (abierto) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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
        alAvisar?.(r.mensaje, "error");
      }
    } catch {
      setError(MENSAJES.errorGeneral);
      alAvisar?.(MENSAJES.errorGeneral, "error");
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
        onClick={() => setAbierto((a) => !a)}
        className="rounded border px-2 py-1 text-sm disabled:opacity-50"
      >
        {ocupado ? M.guardando : M.columnas.acciones}
      </button>

      {abierto && bloqueo === null && (
        <div
          ref={menu}
          role="menu"
          aria-label={`${M.columnas.acciones} ${comprobante}`}
          onKeyDown={alTeclear}
          className="absolute right-0 z-40 mt-1 flex w-56 flex-col rounded border bg-white p-1 shadow-lg"
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
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
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
