"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, cargarYo, tiene, type Yo } from "../../lib/acceso";
import {
  CATEGORIAS_GND,
  ETIQUETA_CATEGORIA,
  MENSAJES_GASTOS as M,
  PERMISO_GASTOS_GESTIONAR,
  fijarCategoriasCliente,
  leerCategoriasCliente,
  type CategoriaGnd,
  type CategoriasClienteVista,
} from "../../lib/gastos";
import { Alert, Button, Card } from "../ui";

// «Categorías permitidas» del cliente (spec 027, R-13, D-6, CA-1, CA-8): una casilla por categoría, marcada si es efectiva (la
// base de su sección CIIU más lo que se permitió, menos lo que se quitó). Marcar una que la base no trae la agrega a
// `permitidas`; desmarcar una de la base la agrega a `quitadas`; volver al valor de la base deshace el ajuste. El servidor
// calcula las efectivas: aquí solo se ordenan las casillas. Con `reglas.gestionar` (alcance del cliente: también el Contador
// asignado) se edita; sin él, o con el cliente archivado, es de solo lectura. El servidor valida.

type Marcas = ReadonlySet<CategoriaGnd>;

/** Los dos arreglos del cuerpo en el orden canónico de las seis categorías, a partir de lo marcado y de la base. */
function ajustesDe(base: readonly CategoriaGnd[], marcadas: Marcas): { permitidas: CategoriaGnd[]; quitadas: CategoriaGnd[] } {
  const permitidas: CategoriaGnd[] = [];
  const quitadas: CategoriaGnd[] = [];
  for (const c of CATEGORIAS_GND) {
    const enBase = base.includes(c);
    const marcada = marcadas.has(c);
    if (marcada && !enBase) permitidas.push(c);
    if (!marcada && enBase) quitadas.push(c);
  }
  return { permitidas, quitadas };
}

const enOrden = (lista: readonly CategoriaGnd[]): CategoriaGnd[] => CATEGORIAS_GND.filter((c) => lista.includes(c));
const iguales = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function CategoriasCliente({
  clienteId,
  archivado = false,
  alNoEncontrado,
}: {
  clienteId: string;
  archivado?: boolean;
  /** 404: el cliente no es visible; la pantalla que lo monta decide cómo avisarlo una sola vez. */
  alNoEncontrado?: () => void;
}) {
  const [yo, setYo] = useState<Yo | null>(null);
  const [vista, setVista] = useState<CategoriasClienteVista | null>(null);
  const [marcadas, setMarcadas] = useState<Marcas>(new Set());
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);
  const aviso404 = useRef(alNoEncontrado);
  aviso404.current = alNoEncontrado;

  useEffect(() => {
    let vigente = true;
    (async () => {
      const [{ yo: actual }, lectura] = await Promise.all([cargarYo(), leerCategoriasCliente(clienteId)]);
      if (!vigente) return;
      setYo(actual);
      if (lectura.ok) {
        setVista(lectura.datos);
        setMarcadas(new Set(lectura.datos.efectivas));
      } else if (lectura.status !== 401) {
        setError(lectura.mensaje);
        if (lectura.status === 404) aviso404.current?.();
      }
      setCargado(true);
    })().catch(() => {
      if (!vigente) return;
      setError(MENSAJES.errorGeneral);
      setCargado(true);
    });
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  /** Vuelve a leer la vista; `conservar` deja lo que la persona había marcado (un conflicto de versión no le borra su elección). */
  const releer = useCallback(
    async (conservar: boolean) => {
      try {
        const r = await leerCategoriasCliente(clienteId);
        if (!r.ok) return;
        setVista(r.datos);
        if (!conservar) setMarcadas(new Set(r.datos.efectivas));
      } catch {
        // Se conserva la vista que ya se muestra.
      }
    },
    [clienteId],
  );

  const puedeEditar = tiene(yo, PERMISO_GASTOS_GESTIONAR) && !archivado;

  if (!cargado) return <p className="text-sm text-tinta-suave">{M.cargandoCategorias}</p>;

  const titulo = (
    <h2 className="m-0 font-titulo text-lg font-bold text-tinta">{M.tituloCategorias}</h2>
  );
  if (vista === null) {
    return (
      <Card aria-label={M.tituloCategorias} className="gap-3 p-4 sm:p-5">
        {titulo}
        {error && <Alert tono="error">{error}</Alert>}
      </Card>
    );
  }

  const ajustes = ajustesDe(vista.base, marcadas);
  const hayCambios = !iguales(ajustes.permitidas, enOrden(vista.permitidas)) || !iguales(ajustes.quitadas, enOrden(vista.quitadas));

  function alternar(c: CategoriaGnd): void {
    setAnuncio("");
    setMarcadas((previas) => {
      const nuevas = new Set(previas);
      if (nuevas.has(c)) nuevas.delete(c);
      else nuevas.add(c);
      return nuevas;
    });
  }

  async function guardar(): Promise<void> {
    if (!vista || enCurso.current || !puedeEditar || !hayCambios) return;
    enCurso.current = true;
    setOcupado(true);
    setError(null);
    setAnuncio("");
    try {
      const r = await fijarCategoriasCliente(clienteId, { ...ajustes, version: vista.version });
      if (r.ok) {
        setAnuncio(M.categoriasGuardadas);
        await releer(false);
      } else if (r.status !== 401) {
        setError(r.mensaje);
        if (r.codigo === "version_cambiada") await releer(true);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  return (
    <Card aria-label={M.tituloCategorias} className="gap-3 p-4 sm:p-5">
      {titulo}
      {vista.ciiu !== null && vista.seccion !== null ? (
        <p className="m-0 text-sm text-tinta-media">{M.giroDe(vista.ciiu, vista.seccion)}</p>
      ) : (
        <p className="m-0 text-sm text-tinta-media">{M.sinCiiu}</p>
      )}
      {vista.ciiu !== null && vista.base.length === 0 && <p className="m-0 text-sm text-tinta-suave">{M.sinBase}</p>}
      {archivado ? (
        <p className="m-0 text-sm text-aviso">{M.errores.cliente_archivado}</p>
      ) : (
        !puedeEditar && <p className="m-0 text-sm text-aviso">{M.categoriasSoloLectura}</p>
      )}
      {error && <Alert tono="error">{error}</Alert>}
      {anuncio && <Alert tono="ok">{anuncio}</Alert>}
      <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0 sm:grid-cols-2">
        {CATEGORIAS_GND.map((c) => (
          <li key={c}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-1 text-sm text-tinta has-[:disabled]:cursor-not-allowed has-[:disabled]:text-tinta-suave lg:min-h-9">
              <input
                type="checkbox"
                checked={marcadas.has(c)}
                disabled={!puedeEditar || ocupado}
                onChange={() => alternar(c)}
                className="size-5 shrink-0 cursor-pointer accent-primario disabled:cursor-not-allowed"
              />
              {ETIQUETA_CATEGORIA[c]}
            </label>
          </li>
        ))}
      </ul>
      {puedeEditar && (
        <div>
          <Button disabled={ocupado || !hayCambios} onClick={() => void guardar()} className="max-lg:h-11">
            {M.guardarCategorias}
          </Button>
        </div>
      )}
    </Card>
  );
}
