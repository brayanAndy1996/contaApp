"use client";

import { DESTINOS_COMPRA, type DestinoCompra } from "@contapp/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, cargarYo, tiene, type Yo } from "../../lib/acceso";
import { fechaHoraLima } from "../../lib/fechas";
import {
  MENSAJES_REGLAS as M,
  PERMISO_REGLAS_GESTIONAR,
  editarRegla,
  eliminarRegla,
  listarReglas,
  type ReglaVista,
} from "../../lib/reglas";
import { ConfirmarAccion } from "../ventas/confirmar-accion";

// Reglas aprendidas de un cliente (spec 021, CA-7, HU-31; D-5). Lista proveedor, destino, estado, cuántas veces se
// aplicó y se aceptó, y cuándo cambió por última vez (hora de Lima). Con `reglas.gestionar` se edita el destino, se
// activa o desactiva y se elimina (con confirmación). Cada cambio manda la `versionBase` que se vio: si otra persona la
// cambió antes, el servidor responde 409 y aquí se avisa y se vuelve a leer la lista. La razón social viene del SIRE
// y se muestra siempre como texto.

type Edicion = { reglaId: string; destino: DestinoCompra };

export function TablaReglasCliente({ clienteId }: { clienteId: string }) {
  const [yo, setYo] = useState<Yo | null>(null);
  const [reglas, setReglas] = useState<ReglaVista[]>([]);
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edicion, setEdicion] = useState<Edicion | null>(null);
  const [aEliminar, setAEliminar] = useState<ReglaVista | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);

  const puedeGestionar = tiene(yo, PERMISO_REGLAS_GESTIONAR);

  const leer = useCallback(async (): Promise<void> => {
    const r = await listarReglas(clienteId);
    if (r.ok) setReglas(r.datos);
    else if (r.status !== 401) setError(r.mensaje);
  }, [clienteId]);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const [{ yo: actual }] = await Promise.all([cargarYo(), leer()]);
      if (!vigente) return;
      setYo(actual);
      setCargado(true);
    })().catch(() => {
      if (!vigente) return;
      setError(MENSAJES.errorGeneral);
      setCargado(true);
    });
    return () => {
      vigente = false;
    };
  }, [leer]);

  /** Ejecuta un cambio sobre una regla; un 409 (u otro rechazo) avisa y vuelve a leer la lista. */
  async function ejecutar(accion: () => Promise<{ ok: true } | { ok: false; status: number; mensaje: string }>) {
    if (enCurso.current) return false;
    enCurso.current = true;
    setOcupado(true);
    setError(null);
    try {
      const r = await accion();
      if (r.ok) return true;
      if (r.status !== 401) {
        setError(r.mensaje);
        if (r.status === 409 || r.status === 404) await leer();
      }
      return false;
    } catch {
      setError(MENSAJES.errorGeneral);
      return false;
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  const reemplazar = (nueva: ReglaVista) =>
    setReglas((previas) => previas.map((r) => (r.id === nueva.id ? nueva : r)));

  async function cambiar(regla: ReglaVista, cambios: { destino?: DestinoCompra; activa?: boolean }) {
    const bien = await ejecutar(async () => {
      const r = await editarRegla(clienteId, regla.id, { versionBase: regla.version, ...cambios });
      if (r.ok) reemplazar(r.datos);
      return r;
    });
    if (bien) setEdicion(null);
  }

  async function eliminar(regla: ReglaVista) {
    await ejecutar(async () => {
      const r = await eliminarRegla(clienteId, regla.id, regla.version);
      if (r.ok) setReglas((previas) => previas.filter((x) => x.id !== regla.id));
      return r;
    });
    // Con 409 la lista ya se volvió a leer: el diálogo se cierra igual para que se vea el aviso y la fila.
    setAEliminar(null);
  }

  if (!cargado) return <p role="status">{M.cargando}</p>;

  return (
    <section aria-label={M.tituloReglasCliente} className="flex min-w-0 flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {reglas.length === 0 && !error && <p>{M.sinReglas}</p>}
      {reglas.length > 0 && (
        <div className="overflow-x-auto">
          <table aria-label={M.tablaReglas} className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1">{M.columnas.proveedor}</th>
                <th scope="col" className="px-2 py-1">{M.columnas.destino}</th>
                <th scope="col" className="px-2 py-1">{M.columnas.estado}</th>
                <th scope="col" className="px-2 py-1">{M.columnas.aplicada}</th>
                <th scope="col" className="px-2 py-1">{M.columnas.aceptada}</th>
                <th scope="col" className="px-2 py-1">{M.columnas.actualizada}</th>
                {puedeGestionar && (
                  <th scope="col" className="px-2 py-1">{M.columnaAcciones}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {reglas.map((r) => {
                const numero = r.proveedor.numero;
                const editando = edicion?.reglaId === r.id ? edicion : null;
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-2 py-1">
                      <span className="block">{numero}</span>
                      {r.proveedor.razonSocial !== null && (
                        <span className="block">{r.proveedor.razonSocial}</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {editando ? (
                        <select
                          aria-label={M.campoDestino}
                          value={editando.destino}
                          disabled={ocupado}
                          onChange={(e) =>
                            setEdicion({ reglaId: r.id, destino: e.target.value as DestinoCompra })
                          }
                          className="rounded border px-2 py-1"
                        >
                          {DESTINOS_COMPRA.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                      ) : (
                        r.destino
                      )}
                    </td>
                    <td className="px-2 py-1">{r.activa ? M.activa : M.inactiva}</td>
                    <td className="px-2 py-1">{r.aplicada}</td>
                    <td className="px-2 py-1">{r.aceptada}</td>
                    <td className="px-2 py-1">{fechaHoraLima(r.actualizadaEn)}</td>
                    {puedeGestionar && (
                      <td className="px-2 py-1">
                        <div className="flex flex-wrap gap-2">
                          {editando ? (
                            <>
                              <button
                                type="button"
                                disabled={ocupado}
                                onClick={() => void cambiar(r, { destino: editando.destino })}
                                className="rounded bg-black px-2 py-1 text-white disabled:opacity-50"
                              >
                                {M.guardar}
                              </button>
                              <button
                                type="button"
                                disabled={ocupado}
                                onClick={() => setEdicion(null)}
                                className="rounded border px-2 py-1"
                              >
                                {M.cancelarEdicion}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={ocupado}
                                aria-label={M.editar(numero)}
                                onClick={() => setEdicion({ reglaId: r.id, destino: r.destino })}
                                className="rounded border px-2 py-1"
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                disabled={ocupado}
                                aria-label={r.activa ? M.desactivar(numero) : M.activar(numero)}
                                onClick={() => void cambiar(r, { activa: !r.activa })}
                                className="rounded border px-2 py-1"
                              >
                                {r.activa ? "Desactivar" : "Activar"}
                              </button>
                              <button
                                type="button"
                                disabled={ocupado}
                                aria-label={M.eliminar(numero)}
                                onClick={() => setAEliminar(r)}
                                className="rounded border px-2 py-1"
                              >
                                Eliminar
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {aEliminar && (
        <ConfirmarAccion
          mensaje={M.confirmarEliminar(aEliminar.proveedor.numero)}
          ocupado={ocupado}
          alConfirmar={() => void eliminar(aEliminar)}
          alCancelar={() => setAEliminar(null)}
        />
      )}
    </section>
  );
}
