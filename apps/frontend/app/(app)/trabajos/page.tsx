"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, cargarYo, mensajeDeError } from "../../../lib/acceso";
import { listarClientes } from "../../../lib/clientes";
import { obtenerSesion } from "../../../lib/sesion";
import {
  cancelarTrabajo,
  obtenerResumenTrabajos,
  puedeCancelar,
  seguirTrabajos,
  type ResumenTrabajos,
  type TrabajoVista,
} from "../../../lib/trabajos";

// Panel de trabajos (spec 007b, D10; CA-5, CA-7, CA-9). Lista del estudio con estado y motivo, resumen en una
// línea cuando un tipo tiene muchos trabajos, y seguimiento por SSE con reconexión y sondeo de respaldo
// (`lib/trabajos`). Los eventos se aplican por lotes: como mucho 4 repintados por segundo. La descarga de la
// propuesta del SIRE (D24) se lee con un nombre legible, su cliente (razón social de `GET /clientes`; si no se
// puede resolver, la fila sigue sin él) y su periodo.

const MENSAJES_PANEL = {
  titulo: "Trabajos",
  vacio: "No hay trabajos.",
  verDetalle: "Ver detalle",
  ocultarDetalle: "Ocultar detalle",
  cancelar: "Cancelar",
  periodo: (p: string) => `Periodo ${p}`,
} as const;

/** Tipos cuya fila muestra el cliente y el periodo (D24). */
const TIPOS_CON_CLIENTE: ReadonlySet<string> = new Set([
  "sire.propuesta.descargar",
]);

const TIPOS: Record<string, string> = {
  "cliente.consultar_ruc": "Consultando datos de RUC",
  "credencial.verificar_sol": "Verificando clave SOL",
  "credencial.verificar_sire": "Verificando credencial SIRE",
  "sire.propuesta.descargar": "Descargando propuesta del SIRE",
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

/** Un evento refresca el conteo total, como mucho una vez cada 500 ms. */
const REFRESCO_RESUMEN_MS = 500;

const TERMINALES: ReadonlySet<TrabajoVista["estado"]> = new Set([
  "completado",
  "error",
  "cancelado",
]);

const conMiles = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const nombreDeTipo = (tipo: string): string => TIPOS[tipo] ?? tipo;

/** «Razón social · Periodo 202610»; solo lo que se conoce, sin UUID ni «undefined». */
function detalleDe(
  t: TrabajoVista,
  clientes: ReadonlyMap<string, string>,
): string {
  if (!TIPOS_CON_CLIENTE.has(t.tipo)) return "";
  const partes: string[] = [];
  const cliente = clientes.get(t.clienteId);
  if (cliente) partes.push(cliente);
  if (t.periodo) partes.push(MENSAJES_PANEL.periodo(t.periodo));
  return partes.join(" · ");
}

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

interface Conteo {
  total: number;
  terminados: number;
  conError: number;
}

/** Conteo por tipo de TODOS los trabajos (el listado trae solo los 100 más recientes, D-1). */
function conteos(resumen: ResumenTrabajos): Map<string, Conteo> {
  const r = new Map<string, Conteo>();
  for (const f of resumen) {
    const c = r.get(f.tipo) ?? { total: 0, terminados: 0, conError: 0 };
    c.total += f.total;
    if (TERMINALES.has(f.estado)) c.terminados += f.total;
    if (f.estado === "error") c.conError += f.total;
    r.set(f.tipo, c);
  }
  return r;
}

function conteoDeLista(lista: TrabajoVista[]): Conteo {
  return {
    total: lista.length,
    terminados: lista.filter((t) => TERMINALES.has(t.estado)).length,
    conError: lista.filter((t) => t.estado === "error").length,
  };
}

export default function Trabajos() {
  const [trabajos, setTrabajos] = useState<Map<string, TrabajoVista>>(
    new Map(),
  );
  const [resumen, setResumen] = useState<ResumenTrabajos | null>(null);
  const [clientes, setClientes] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [quien, setQuien] = useState<{
    rol: string | null;
    usuarioId: string | null;
  }>({ rol: null, usuarioId: null });
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCancelar, setErrorCancelar] = useState<string | null>(null);
  const [desplegados, setDesplegados] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const pendientes = useRef<TrabajoVista[]>([]);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresco = useRef<ReturnType<typeof setTimeout> | null>(null);
  const montado = useRef(true);

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

  const refrescarResumen = useCallback(() => {
    refresco.current = null;
    void obtenerResumenTrabajos().then((r) => {
      if (r && montado.current) setResumen(r);
    });
  }, []);

  // Razón social por cliente (D24), también de los archivados (devuelve activos y archivados). Si la lista falla, el panel sigue igual: solo falta el nombre.
  useEffect(() => {
    let vigente = true;
    void listarClientes({ archivados: true })
      .then((r) => {
        if (!vigente || !r.ok || !Array.isArray(r.datos)) return;
        setClientes(
          new Map(
            r.datos
              .filter((c) => typeof c.razonSocial === "string")
              .map((c) => [c.id, c.razonSocial]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, []);

  // Rol y usuario para decidir si se muestra «Cancelar» (D-6). Mientras no se conocen, el botón no aparece.
  useEffect(() => {
    let vigente = true;
    void Promise.all([cargarYo(), obtenerSesion()])
      .then(([{ yo }, sesion]) => {
        if (vigente)
          setQuien({
            rol: yo?.rol ?? null,
            usuarioId: sesion?.usuario.id ?? null,
          });
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, []);

  useEffect(() => {
    montado.current = true;
    const control = new AbortController();
    void seguirTrabajos({
      senal: control.signal,
      alListar: (lista) => {
        // El listado es más nuevo que lo que esté esperando el lote.
        pendientes.current = [];
        setTrabajos(new Map(lista.map((t) => [t.id, t])));
        setCargado(true);
      },
      alResumen: setResumen,
      alEvento: (t) => {
        pendientes.current.push(t);
        temporizador.current ??= setTimeout(aplicarLote, LOTE_MS);
        refresco.current ??= setTimeout(refrescarResumen, REFRESCO_RESUMEN_MS);
      },
      alError: (status) => {
        setError(status === null ? null : mensajeDeError(status, null));
        if (status !== null) setCargado(true);
      },
    }).catch(() => {
      if (!control.signal.aborted) setError(MENSAJES.errorGeneral);
    });
    return () => {
      montado.current = false;
      control.abort();
      if (refresco.current) clearTimeout(refresco.current);
      refresco.current = null;
      if (temporizador.current) clearTimeout(temporizador.current);
      temporizador.current = null;
      pendientes.current = [];
    };
  }, [aplicarLote, refrescarResumen]);

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

  // «Cancelar» solo lo ve quien encoló el trabajo, el Dueño y el Administrador (D9); el servidor igual valida y su
  // 403/409 se muestra.
  const grupos = agrupar(trabajos);
  const totales = resumen ? conteos(resumen) : null;

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
        // Con el resumen del servidor el total cubre más de los 100 que trae el listado; si falló, cuenta la lista.
        const { total, terminados, conError } =
          totales?.get(tipo) ?? conteoDeLista(lista);
        const resumido = total > MAX_FILAS_POR_TIPO;
        const abierto = !resumido || desplegados.has(tipo);
        return (
          <section key={tipo} className="space-y-2">
            {resumido && (
              <div className="flex flex-wrap items-center gap-3">
                <p>
                  {`${nombreDeTipo(tipo)}: ${conMiles(terminados)} de ${conMiles(total)}`}
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
                      <td className="py-1 pr-3">
                        {nombreDeTipo(t.tipo)}
                        {detalleDe(t, clientes) && (
                          <span className="block text-xs text-gray-600">
                            {detalleDe(t, clientes)}
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3">{ESTADOS[t.estado]}</td>
                      <td className="py-1 pr-3">
                        {t.motivo ? MOTIVOS[t.motivo] : ""}
                      </td>
                      <td className="py-1">
                        {t.estado === "en_cola" &&
                          puedeCancelar(quien.rol, quien.usuarioId, t) && (
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
