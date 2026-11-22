"use client";

import type { FilaCompraVista } from "@contapp/shared";
import { useEffect, useRef, useState } from "react";
import { MENSAJES } from "../../lib/acceso";
import type { ContextoCompras } from "../../lib/compras";
import {
  CATEGORIAS_GND,
  ETIQUETA_CATEGORIA,
  MENSAJES_GASTOS as M,
  aprenderPalabras,
  esTerminoValido,
  leerPropuestaAprender,
  type AprenderRespuesta,
  type CategoriaGnd,
} from "../../lib/gastos";
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select } from "../ui";

// «Aprender estas palabras» tras excluir una compra con XML (spec 027, R-7, CA-8, CA-9). Al montar pide los términos que el
// sistema propone (el servidor los saca del XML); con 1 a 10 abre un Dialog con cada término editable, una casilla para
// incluirlo y su categoría (obligatoria). Con 0 términos, un 409 (compra sin XML o ya no excluida) o cualquier error NO
// muestra nada y llama a `alCerrar()`: ofrecerlo nunca bloquea ni deshace la exclusión. Los términos salen del XML (texto no
// confiable): se pintan como valor de un campo, nunca como HTML.

interface Fila {
  incluir: boolean;
  termino: string;
  categoria: string;
}

export function AprenderPalabras({
  contexto,
  fila,
  alCerrar,
}: {
  contexto: ContextoCompras;
  fila: Pick<FilaCompraVista, "id">;
  alCerrar: () => void;
}) {
  const { clienteId, periodo } = contexto;
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [abierto, setAbierto] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<AprenderRespuesta | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const cerrar = useRef(alCerrar);
  cerrar.current = alCerrar;
  const cerrado = useRef(false);

  const terminar = (): void => {
    if (cerrado.current) return;
    cerrado.current = true;
    setAbierto(false);
    cerrar.current();
  };

  useEffect(() => {
    let vigente = true;
    void leerPropuestaAprender(clienteId, periodo, fila.id)
      .then((r) => {
        if (!vigente) return;
        if (r.ok && r.datos.terminos.length > 0) {
          setFilas(r.datos.terminos.map((termino) => ({ incluir: false, termino, categoria: "" })));
        } else {
          terminar();
        }
      })
      .catch(() => {
        if (vigente) terminar();
      });
    return () => {
      vigente = false;
    };
    // `terminar` solo usa refs y el estado propio: no cambia lo que hay que volver a pedir.
  }, [clienteId, periodo, fila.id]);

  if (filas === null) return null;

  const cambiar = (i: number, parcial: Partial<Fila>): void =>
    setFilas((previas) => (previas ?? []).map((f, j) => (j === i ? { ...f, ...parcial } : f)));

  async function guardar(): Promise<void> {
    if (ocupado || resultado !== null || filas === null) return;
    const marcadas = filas.filter((f) => f.incluir);
    if (marcadas.length === 0) return setError(M.ningunaMarcada);
    if (marcadas.some((f) => f.categoria === "")) return setError(M.categoriaObligatoria);
    if (marcadas.some((f) => !esTerminoValido(f.termino))) return setError(M.terminoInvalido);
    setError(null);
    setOcupado(true);
    try {
      const r = await aprenderPalabras(clienteId, periodo, fila.id, {
        terminos: marcadas.map((f) => ({ termino: f.termino.trim(), categoria: f.categoria as CategoriaGnd })),
      });
      if (r.ok) setResultado(r.datos);
      else if (r.status !== 401) setError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  return (
    <Dialog open={abierto} onOpenChange={(a) => !a && terminar()}>
      <DialogContent mostrarCerrar={false} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{M.tituloAprender}</DialogTitle>
          <DialogDescription>{M.introAprender}</DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {filas.map((f, i) => (
            <li
              key={i}
              className="flex min-w-0 flex-col gap-2 rounded-control border border-linea p-3 sm:flex-row sm:items-center"
            >
              <input
                type="checkbox"
                aria-label={M.incluirTermino(i + 1)}
                checked={f.incluir}
                disabled={ocupado || resultado !== null}
                onChange={(e) => cambiar(i, { incluir: e.target.checked })}
                className="size-5 shrink-0 cursor-pointer accent-primario disabled:cursor-not-allowed"
              />
              <Input
                type="text"
                autoComplete="off"
                aria-label={M.campoTermino(i + 1)}
                value={f.termino}
                disabled={ocupado || resultado !== null}
                onChange={(e) => cambiar(i, { termino: e.target.value })}
                className="min-w-0 font-mono max-lg:h-11 sm:flex-1"
              />
              <Select
                aria-label={M.campoCategoriaTermino(i + 1)}
                value={f.categoria}
                disabled={ocupado || resultado !== null}
                onChange={(e) => cambiar(i, { categoria: e.target.value })}
                className="max-lg:h-11 sm:w-56"
              >
                <option value="">{M.elegirCategoria}</option>
                {CATEGORIAS_GND.map((c) => (
                  <option key={c} value={c}>
                    {ETIQUETA_CATEGORIA[c]}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
        {error && <Alert tono="error">{error}</Alert>}
        {resultado !== null && (
          <Alert tono="ok" className="flex-col">
            <p className="m-0">{M.aprendidas(resultado.guardadas)}</p>
            {resultado.omitidas.length > 0 && <p className="m-0">{M.omitidas(resultado.omitidas)}</p>}
          </Alert>
        )}
        <DialogFooter>
          {resultado === null ? (
            <>
              <Button variant="secundario" onClick={terminar} disabled={ocupado} className="max-lg:h-11">
                {M.ahoraNo}
              </Button>
              <Button onClick={() => void guardar()} disabled={ocupado} className="max-lg:h-11">
                {M.aprender}
              </Button>
            </>
          ) : (
            <Button onClick={terminar} className="max-lg:h-11">
              {M.cerrar}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
