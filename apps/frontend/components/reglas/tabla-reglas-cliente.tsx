"use client";

import { DESTINOS_COMPRA, type DestinoCompra } from "@contapp/shared";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
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
import { cn } from "../../lib/utils";
import { ConfirmarAccion } from "../ventas/confirmar-accion";
import {
  Alert,
  Badge,
  Button,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui";

// Reglas aprendidas de un cliente (spec 021, CA-7, HU-31; D-5). Lista proveedor, destino, estado, cuántas veces se
// aplicó y se aceptó, y cuándo cambió por última vez (hora de Lima). Con `reglas.gestionar` se edita el destino, se
// activa o desactiva y se elimina (con confirmación). Cada cambio manda la `versionBase` que se vio: si otra persona la
// cambió antes, el servidor responde 409 y aquí se avisa y se vuelve a leer la lista. La razón social viene del SIRE
// y se muestra siempre como texto.
//
// Foco y anuncios (T23a-3): cada acción deja el foco en un destino explícito (el combobox «Destino» al editar; el botón
// de la fila al terminar; el encabezado de la tabla si la fila ya no está) y anuncia el resultado en un `role="status"`.
// Esc cancela la edición. A menos de 768 px la tabla se apila por fila (T23a-5): cada celda lleva su etiqueta de columna
// en `data-etiqueta`, sin scroll interior que esconda las acciones.

/** Celda: en escritorio, tabla; a menos de 768 px, bloque con la etiqueta de su columna delante (T23a-5). */
const CELDA =
  "px-2 py-2 align-top max-md:flex max-md:gap-2 max-md:px-0 max-md:py-1 max-md:before:w-28 max-md:before:shrink-0 max-md:before:font-semibold max-md:before:text-tinta-suave max-md:before:content-[attr(data-etiqueta)]";
const CABECERA = "px-2 py-2";

type Edicion = { reglaId: string; destino: DestinoCompra };

/** Clave de un elemento que puede recibir el foco: `<reglaId>:<boton>`; la del encabezado es `encabezado`. */
type Boton = "editar" | "alternar" | "eliminar" | "destino" | "guardar";
const clave = (reglaId: string, boton: Boton) => `${reglaId}:${boton}`;
const ENCABEZADO = "encabezado";

export function TablaReglasCliente({ clienteId }: { clienteId: string }) {
  const [yo, setYo] = useState<Yo | null>(null);
  const [reglas, setReglas] = useState<ReglaVista[]>([]);
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edicion, setEdicion] = useState<Edicion | null>(null);
  const [aEliminar, setAEliminar] = useState<ReglaVista | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [anuncio, setAnuncio] = useState("");
  const [foco, setFoco] = useState<string | null>(null);
  const enCurso = useRef(false);
  const elementos = useRef(new Map<string, HTMLElement>());

  /** Ref de callback que registra el elemento bajo su clave. */
  const registrar = (k: string) => (el: HTMLElement | null) => {
    if (el) elementos.current.set(k, el);
    else elementos.current.delete(k);
  };

  // Mueve el foco cuando ya no hay una acción en curso (los botones deshabilitados no lo reciben). Si el elemento
  // pedido ya no existe (la fila se eliminó), el foco va al encabezado de la tabla.
  useEffect(() => {
    if (foco === null || ocupado || aEliminar !== null) return;
    const destino = elementos.current.get(foco) ?? elementos.current.get(ENCABEZADO);
    destino?.focus();
    setFoco(null);
  }, [foco, ocupado, aEliminar, reglas, edicion]);

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
    const numero = regla.proveedor.numero;
    if (bien) {
      setEdicion(null);
      if (cambios.activa === undefined) setAnuncio(M.reglaActualizada(numero));
      else setAnuncio(cambios.activa ? M.reglaActivada(numero) : M.reglaDesactivada(numero));
    }
    // Editar: de vuelta en «Editar»; si falló, «Guardar» sigue en pantalla. Activar/desactivar: el mismo botón.
    setFoco(clave(regla.id, cambios.destino !== undefined ? (bien ? "editar" : "guardar") : "alternar"));
  }

  function empezarEdicion(r: ReglaVista) {
    setEdicion({ reglaId: r.id, destino: r.destino });
    setFoco(clave(r.id, "destino"));
  }

  function cancelarEdicion(reglaId: string) {
    setEdicion(null);
    setFoco(clave(reglaId, "editar"));
  }

  function alTeclear(e: KeyboardEvent, reglaId: string) {
    if (e.key !== "Escape" || ocupado || edicion?.reglaId !== reglaId) return;
    e.preventDefault();
    cancelarEdicion(reglaId);
  }

  async function eliminar(regla: ReglaVista) {
    const bien = await ejecutar(async () => {
      const r = await eliminarRegla(clienteId, regla.id, regla.version);
      if (r.ok) setReglas((previas) => previas.filter((x) => x.id !== regla.id));
      return r;
    });
    if (bien) setAnuncio(M.reglaEliminada(regla.proveedor.numero));
    // Con 409 la lista ya se volvió a leer: el diálogo se cierra igual para que se vea el aviso y la fila.
    setAEliminar(null);
    // Sin fila (eliminada, o ya no existe tras recargar) el foco cae al encabezado.
    setFoco(clave(regla.id, "eliminar"));
  }

  if (!cargado) return <p role="status" className="m-0 text-tinta-suave">{M.cargando}</p>;

  return (
    <section aria-label={M.tituloReglasCliente} className="flex min-w-0 flex-col gap-3">
      {error && (
        <Alert tono="error" role="alert">
          {error}
        </Alert>
      )}
      <p role="status" className="sr-only">
        {anuncio}
      </p>
      {reglas.length === 0 && !error && <p className="m-0 text-tinta-media">{M.sinReglas}</p>}
      {reglas.length > 0 && (
        <div className="md:overflow-x-clip md:rounded-tarjeta md:border md:border-linea md:bg-hoja md:shadow-tarjeta">
          <Table
            desplazable={false}
            role="table"
            aria-label={M.tablaReglas}
            className="max-md:block"
          >
            <TableHeader role="rowgroup" className="max-md:sr-only">
              <TableRow role="row" className="hover:bg-transparent">
                <TableHead
                  ref={registrar(ENCABEZADO)}
                  tabIndex={-1}
                  role="columnheader"
                  scope="col"
                  className={CABECERA}
                >
                  {M.columnas.proveedor}
                </TableHead>
                <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.destino}</TableHead>
                <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.estado}</TableHead>
                <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.aplicada}</TableHead>
                <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.aceptada}</TableHead>
                <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.actualizada}</TableHead>
                {puedeGestionar && (
                  <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnaAcciones}</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody role="rowgroup" className="max-md:block">
              {reglas.map((r) => {
                const numero = r.proveedor.numero;
                const editando = edicion?.reglaId === r.id ? edicion : null;
                return (
                  <TableRow
                    key={r.id}
                    role="row"
                    onKeyDown={(e) => alTeclear(e, r.id)}
                    className="align-top max-md:mb-3 max-md:flex max-md:flex-col max-md:rounded-control max-md:border max-md:border-linea max-md:bg-hoja max-md:p-3 max-md:shadow-tarjeta"
                  >
                    <TableCell role="cell" data-etiqueta={M.columnas.proveedor} className={CELDA}>
                      <div>
                        <span className="block font-mono">{numero}</span>
                        {r.proveedor.razonSocial !== null && (
                          <span className="block text-tinta-media">{r.proveedor.razonSocial}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell role="cell" data-etiqueta={M.columnas.destino} className={CELDA}>
                      {editando ? (
                        <Select
                          ref={registrar(clave(r.id, "destino"))}
                          aria-label={M.campoDestino}
                          value={editando.destino}
                          disabled={ocupado}
                          onChange={(e) =>
                            setEdicion({ reglaId: r.id, destino: e.target.value as DestinoCompra })
                          }
                          className="h-9 w-auto max-lg:h-11"
                        >
                          {DESTINOS_COMPRA.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        r.destino
                      )}
                    </TableCell>
                    <TableCell role="cell" data-etiqueta={M.columnas.estado} className={CELDA}>
                      <Badge tono={r.activa ? "ok" : "neutro"}>{r.activa ? M.activa : M.inactiva}</Badge>
                    </TableCell>
                    <TableCell role="cell" data-etiqueta={M.columnas.aplicada} className={cn(CELDA, "cifras")}>{r.aplicada}</TableCell>
                    <TableCell role="cell" data-etiqueta={M.columnas.aceptada} className={cn(CELDA, "cifras")}>{r.aceptada}</TableCell>
                    <TableCell role="cell" data-etiqueta={M.columnas.actualizada} className={CELDA}>
                      {fechaHoraLima(r.actualizadaEn)}
                    </TableCell>
                    {puedeGestionar && (
                      <TableCell role="cell" data-etiqueta={M.columnaAcciones} className={CELDA}>
                        <div className="flex flex-wrap gap-2">
                          {editando ? (
                            <>
                              <Button
                                key="guardar"
                                ref={registrar(clave(r.id, "guardar"))}
                                type="button"
                                size="sm"
                                disabled={ocupado}
                                onClick={() => void cambiar(r, { destino: editando.destino })}
                                className="max-lg:h-11"
                              >
                                {M.guardar}
                              </Button>
                              <Button
                                key="cancelar"
                                type="button"
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                onClick={() => cancelarEdicion(r.id)}
                                className="max-lg:h-11"
                              >
                                {M.cancelarEdicion}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                key="editar"
                                ref={registrar(clave(r.id, "editar"))}
                                type="button"
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                aria-label={M.editar(numero)}
                                onClick={() => empezarEdicion(r)}
                                className="max-lg:h-11"
                              >
                                Editar
                              </Button>
                              <Button
                                key="alternar"
                                ref={registrar(clave(r.id, "alternar"))}
                                type="button"
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                aria-label={r.activa ? M.desactivar(numero) : M.activar(numero)}
                                onClick={() => void cambiar(r, { activa: !r.activa })}
                                className="max-lg:h-11"
                              >
                                {r.activa ? "Desactivar" : "Activar"}
                              </Button>
                              <Button
                                key="eliminar"
                                ref={registrar(clave(r.id, "eliminar"))}
                                type="button"
                                variant="secundario"
                                size="sm"
                                disabled={ocupado}
                                aria-label={M.eliminar(numero)}
                                onClick={() => setAEliminar(r)}
                                className="max-lg:h-11"
                              >
                                Eliminar
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
