"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, mensajeDeError } from "../../../lib/acceso";
import {
  cancelarTrabajo,
  seguirTrabajos,
  type TrabajoVista,
} from "../../../lib/trabajos";

// Panel de trabajos (spec 007b, D10; CA-5, CA-7, CA-9). Lista del estudio con estado y motivo, resumen en una
// línea cuando un tipo tiene muchos trabajos, y seguimiento por SSE con reconexión y sondeo de respaldo
// (`lib/trabajos`). Los eventos se aplican por lotes: como mucho 4 repintados por segundo.

const MENSAJES_PANEL = {
  titulo: "Trabajos",
  vacio: "No hay trabajos.",
  verDetalle: "Ver detalle",
  ocultarDetalle: "Ocultar detalle",
  cancelar: "Cancelar",
} as const;

const TIPOS: Record<string, string> = {
  "cliente.consultar_ruc": "Consultando datos de RUC",
  "credencial.verificar_sol": "Verificando clave SOL",
  "credencial.verificar_sire": "Verificando credencial SIRE",
};

const ESTADOS: Record<TrabajoVista["estado"], string> = {
  en_cola: "En cola",
  ejecutando: "Ejecutando",
  completado: "Completado",
  error: "Con error",
  cancelado: "Cancelado",
};

const MOTIVOS: Record<NonNullable<TrabajoVista["motivo"]>, string> = {
  sunat_no_responde: "SUNAT no responde",
  credencial_invalida: "Credencial inválida",
  datos_invalidos: "Datos inválidos",
  portal_cambio: "El portal de SUNAT cambió",
  interrumpido: "Interrumpido",
  acceso_retirado: "Acceso retirado",
  cancelado_usuario: "Cancelado por el usuario",
  error_interno: "Error interno",
};

/** Más de esta cantidad de trabajos de un tipo se resume en una línea. */
const MAX_FILAS_POR_TIPO = 10;
/** 250 ms entre repintados = como mucho 4 por segundo. */
const LOTE_MS = 250;

const TERMINALES: ReadonlySet<TrabajoVista["estado"]> = new Set([
  "completado",
  "error",
  "cancelado",
]);

const conMiles = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const nombreDeTipo = (tipo: string): string => TIPOS[tipo] ?? tipo;

function agrupar(trabajos: Map<string, TrabajoVista>) {
  const porTipo = new Map<string, TrabajoVista[]>();
  for (const t of trabajos.values()) {
    const grupo = porTipo.get(t.tipo);
    if (grupo) grupo.push(t);
    else porTipo.set(t.tipo, [t]);
  }
  for (const grupo of porTipo.values()) {
    grupo.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
  }
  return [...porTipo.entries()];
}

export default function Trabajos() {
  const [trabajos, setTrabajos] = useState<Map<string, TrabajoVista>>(
    new Map(),
  );
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCancelar, setErrorCancelar] = useState<string | null>(null);
  const [desplegados, setDesplegados] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const pendientes = useRef<TrabajoVista[]>([]);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  const aplicarLote = useCallback(() => {
    temporizador.current = null;
    const lote = pendientes.current;
    pendientes.current = [];
    if (lote.length === 0) return;
    setTrabajos((previos) => {
      const siguientes = new Map(previos);
      for (const t of lote) siguientes.set(t.id, t);
      return siguientes;
    });
  }, []);

  useEffect(() => {
    const control = new AbortController();
    void seguirTrabajos({
      senal: control.signal,
      alListar: (lista) => {
        // El listado es más nuevo que lo que esté esperando el lote.
        pendientes.current = [];
        setTrabajos(new Map(lista.map((t) => [t.id, t])));
        setCargado(true);
      },
      alEvento: (t) => {
        pendientes.current.push(t);
        temporizador.current ??= setTimeout(aplicarLote, LOTE_MS);
      },
      alError: (status) => {
        setError(status === null ? null : mensajeDeError(status, null));
        if (status !== null) setCargado(true);
      },
    }).catch(() => {
      if (!control.signal.aborted) setError(MENSAJES.errorGeneral);
    });
    return () => {
      control.abort();
      if (temporizador.current) clearTimeout(temporizador.current);
      temporizador.current = null;
      pendientes.current = [];
    };
  }, [aplicarLote]);

  async function cancelar(id: string) {
    setErrorCancelar(null);
    const r = await cancelarTrabajo(id);
    if (r.ok && r.datos) {
      const vista = r.datos;
      setTrabajos((previos) => new Map(previos).set(vista.id, vista));
    } else if (r.status !== 401) {
      setErrorCancelar(mensajeDeError(r.status, r.datos));
    }
  }

  const alternar = (tipo: string) =>
    setDesplegados((previos) => {
      const siguientes = new Set(previos);
      if (!siguientes.delete(tipo)) siguientes.add(tipo);
      return siguientes;
    });

  // Cancelar no se oculta por permiso: lo decide el servidor (creador o rol, D9) y su 403/409 se muestra.
  const grupos = agrupar(trabajos);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">{MENSAJES_PANEL.titulo}</h1>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {errorCancelar && (
        <p role="alert" className="text-red-600">
          {errorCancelar}
        </p>
      )}
      {cargado && !error && grupos.length === 0 && (
        <p>{MENSAJES_PANEL.vacio}</p>
      )}
      {grupos.map(([tipo, lista]) => {
        const resumido = lista.length > MAX_FILAS_POR_TIPO;
        const abierto = !resumido || desplegados.has(tipo);
        const terminados = lista.filter((t) => TERMINALES.has(t.estado)).length;
        const conError = lista.filter((t) => t.estado === "error").length;
        return (
          <section key={tipo} className="space-y-2">
            {resumido && (
              <div className="flex flex-wrap items-center gap-3">
                <p>
                  {`${nombreDeTipo(tipo)}: ${conMiles(terminados)} de ${conMiles(lista.length)}`}
                </p>
                {conError > 0 && (
                  <span className="text-red-600">{`${conMiles(conError)} con error`}</span>
                )}
                <button
                  type="button"
                  className="rounded border px-2 py-1"
                  aria-expanded={abierto}
                  onClick={() => alternar(tipo)}
                >
                  {abierto
                    ? MENSAJES_PANEL.ocultarDetalle
                    : MENSAJES_PANEL.verDetalle}
                </button>
              </div>
            )}
            {abierto && (
              <table className="w-full text-left text-sm">
                <tbody>
                  {lista.map((t) => (
                    <tr key={t.id} className="border-b">
                      <td className="py-1 pr-3">{nombreDeTipo(t.tipo)}</td>
                      <td className="py-1 pr-3">{ESTADOS[t.estado]}</td>
                      <td className="py-1 pr-3">
                        {t.motivo ? MOTIVOS[t.motivo] : ""}
                      </td>
                      <td className="py-1">
                        {t.estado === "en_cola" && (
                          <button
                            type="button"
                            className="rounded border px-2 py-0.5"
                            onClick={() => void cancelar(t.id)}
                          >
                            {MENSAJES_PANEL.cancelar}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </main>
  );
}
