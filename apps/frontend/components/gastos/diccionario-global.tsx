"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { HistorialGlobalVista } from "@contapp/shared";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_GASTOS as M,
  agregarPalabraGlobal,
  editarPalabraGlobal,
  etiquetaCategoria,
  leerDiccionarioGlobal,
  leerHistorialGlobal,
  validarEdicionGlobal,
  validarPalabra,
  type DiccionarioGlobalVista,
} from "../../lib/gastos";
import { Alert, Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui";
import { CamposPalabra, PALABRA_VACIA, type ValoresPalabra } from "./campos-palabra";
import { CABECERA, CELDA, FILA, MARCO_TABLA } from "./estilos";
import { HistorialGlobal } from "./historial-global";

// Diccionario global del super-admin (spec 027, R-6, D-2, D-3): lista, alta, edición de la categoría y las excepciones,
// activar o desactivar, e historial paginado. Sin estudio activo (la sesión no trae `X-Estudio`). Cada cambio manda el
// reemplazo completo con la versión de la fila (compare-and-set): un 409 `version_cambiada` vuelve a leer. El servidor
// valida; aquí solo se comprueba el formulario con las mismas reglas de shared.

type Palabra = DiccionarioGlobalVista["palabras"][number];

export function DiccionarioGlobal() {
  const [palabras, setPalabras] = useState<Palabra[] | null>(null);
  const [historial, setHistorial] = useState<HistorialGlobalVista | null>(null);
  const [valores, setValores] = useState<ValoresPalabra>(PALABRA_VACIA);
  const [editando, setEditando] = useState<Palabra | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const enCurso = useRef(false);

  /** Lista e historial (primera página). Los fallos de lectura se avisan; lo ya mostrado se conserva. */
  const cargar = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([leerDiccionarioGlobal(), leerHistorialGlobal()]);
      if (d.ok) setPalabras(d.datos.palabras);
      else if (d.status !== 401) setError(d.mensaje);
      if (h.ok) setHistorial(h.datos);
      else if (h.status !== 401) setError(h.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function verMas(): Promise<void> {
    if (historial?.siguiente == null || cargandoMas) return;
    setCargandoMas(true);
    try {
      const r = await leerHistorialGlobal(historial.siguiente);
      if (r.ok) setHistorial((previo) => ({ items: [...(previo?.items ?? []), ...r.datos.items], siguiente: r.datos.siguiente }));
      else if (r.status !== 401) setError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setCargandoMas(false);
    }
  }

  /** Una escritura: espera al servidor, avisa y vuelve a leer lista e historial. */
  async function escribir(
    llamada: () => Promise<{ ok: boolean; status: number; codigo?: string; mensaje?: string }>,
    exito: string,
    alExito: () => void,
    alConflicto?: () => void,
  ): Promise<void> {
    if (enCurso.current) return;
    enCurso.current = true;
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      const r = await llamada();
      if (r.ok) {
        setAviso(exito);
        alExito();
        await cargar();
      } else if (r.status !== 401) {
        setError(r.mensaje ?? MENSAJES.errorGeneral);
        if (r.codigo === "version_cambiada") {
          alConflicto?.();
          await cargar();
        }
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  function salirDeEdicion(): void {
    setEditando(null);
    setValores(PALABRA_VACIA);
  }

  function editar(p: Palabra): void {
    setError(null);
    setAviso(null);
    setEditando(p);
    setValores({ palabra: p.palabra, categoria: p.categoria, excepciones: p.excepciones.join(", ") });
  }

  function enviar(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (editando !== null) {
      const v = validarEdicionGlobal(valores);
      if (!v.ok) {
        setAviso(null);
        setError(v.error);
        return;
      }
      void escribir(
        () =>
          editarPalabraGlobal(editando.id, {
            categoria: v.categoria,
            excepciones: v.excepciones,
            activa: editando.activa,
            version: editando.version,
          }),
        M.globalGuardada,
        salirDeEdicion,
        salirDeEdicion,
      );
      return;
    }
    const v = validarPalabra(valores);
    if (!v.ok) {
      setAviso(null);
      setError(v.error);
      return;
    }
    void escribir(() => agregarPalabraGlobal(v.cuerpo), M.globalAgregada, () => setValores(PALABRA_VACIA));
  }

  function alternar(p: Palabra): void {
    void escribir(
      () =>
        editarPalabraGlobal(p.id, {
          categoria: p.categoria,
          excepciones: p.excepciones,
          activa: !p.activa,
          version: p.version,
        }),
      M.globalGuardada,
      () => {
        if (editando?.id === p.id) salirDeEdicion();
      },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {error && <Alert tono="error">{error}</Alert>}
      {aviso && <Alert tono="ok">{aviso}</Alert>}

      <Card className="gap-3 p-4 sm:p-6">
        <h2 className="m-0 font-titulo text-lg font-bold text-tinta">{M.tituloDiccionarioGlobal}</h2>
        {palabras !== null && palabras.length === 0 ? (
          <p className="m-0 text-tinta-media">{M.sinGlobales}</p>
        ) : (
          palabras !== null && (
            <div className={MARCO_TABLA}>
              <Table desplazable={false} role="table" aria-label={M.tituloDiccionarioGlobal} className="max-md:block">
                <TableHeader role="rowgroup" className="max-md:sr-only">
                  <TableRow role="row" className="hover:bg-transparent">
                    <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.palabra}</TableHead>
                    <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.categoria}</TableHead>
                    <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.excepciones}</TableHead>
                    <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.estado}</TableHead>
                    <TableHead role="columnheader" scope="col" className={CABECERA}>{M.columnas.acciones}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody role="rowgroup" className="max-md:block">
                  {palabras.map((p) => (
                    <TableRow key={p.id} role="row" className={FILA}>
                      <TableCell role="cell" data-etiqueta={M.columnas.palabra} className={`${CELDA} font-mono font-semibold`}>
                        {p.palabra}
                      </TableCell>
                      <TableCell role="cell" data-etiqueta={M.columnas.categoria} className={CELDA}>
                        {etiquetaCategoria(p.categoria)}
                      </TableCell>
                      <TableCell role="cell" data-etiqueta={M.columnas.excepciones} className={CELDA}>
                        {p.excepciones.length === 0 ? M.sinExcepciones : p.excepciones.join(", ")}
                      </TableCell>
                      <TableCell role="cell" data-etiqueta={M.columnas.estado} className={CELDA}>
                        <Badge tono={p.activa ? "ok" : "neutro"}>{p.activa ? M.activa : M.inactiva}</Badge>
                      </TableCell>
                      <TableCell role="cell" data-etiqueta={M.columnas.acciones} className={CELDA}>
                        <div className="flex min-w-0 flex-wrap gap-2">
                          <Button
                            variant="secundario"
                            size="sm"
                            disabled={ocupado}
                            aria-label={M.editarGlobal(p.palabra)}
                            onClick={() => editar(p)}
                            className="max-lg:h-11"
                          >
                            {M.editar}
                          </Button>
                          <Button
                            variant="secundario"
                            size="sm"
                            disabled={ocupado}
                            aria-label={p.activa ? M.desactivarDiccionario(p.palabra) : M.activarDiccionario(p.palabra)}
                            onClick={() => alternar(p)}
                            className="max-lg:h-11"
                          >
                            {p.activa ? M.desactivar : M.activar}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        )}
      </Card>

      <Card className="max-w-xl gap-4 p-4 sm:p-6">
        <form onSubmit={enviar} noValidate className="flex min-w-0 flex-col gap-4">
          <h2 className="m-0 font-titulo text-lg font-bold text-tinta">
            {editando ? M.editarGlobal(editando.palabra) : M.agregarGlobal}
          </h2>
          <CamposPalabra valores={valores} alCambiar={setValores} deshabilitado={ocupado} palabraFija={editando !== null} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={ocupado} className="max-lg:h-11">
              {editando ? M.guardarCambios : M.agregarGlobal}
            </Button>
            {editando && (
              <Button variant="secundario" disabled={ocupado} onClick={salirDeEdicion} className="max-lg:h-11">
                {M.cancelar}
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Card className="gap-3 p-4 sm:p-6">
        <h2 className="m-0 font-titulo text-lg font-bold text-tinta">{M.tituloHistorial}</h2>
        {historial !== null && (
          <HistorialGlobal
            items={historial.items}
            hayMas={historial.siguiente !== null}
            cargandoMas={cargandoMas}
            alVerMas={() => void verMas()}
          />
        )}
      </Card>
    </div>
  );
}
