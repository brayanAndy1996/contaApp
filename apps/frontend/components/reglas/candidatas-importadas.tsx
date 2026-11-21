"use client";

import { DESTINOS_COMPRA, GRUPOS_CANDIDATAS, MOTIVOS_OMISION_CANDIDATA, type DestinoCompra } from "@contapp/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, usePuede } from "../../lib/acceso";
import {
  MENSAJES_APRENDIZAJE as M,
  PERMISO_APRENDIZAJE_GESTIONAR,
  activarCandidatas,
  conteosSinCriterio,
  descartarCandidatas,
  frecuencia,
  listarCandidatas,
  periodoDespuesDe,
  reemplazarCandidata,
  rutaGrilla,
  ultimaImportacion,
  type CandidataVista,
  type GrupoCandidatas,
  type ImportacionVista,
  type RespuestaActivar,
} from "../../lib/aprendizaje";
import { Alert, Badge, Button, Select, Tabs, TabsContent, TabsList, TabsTrigger, enlace } from "../ui";
import { ActivarCandidatas } from "./activar-candidatas";

// Candidatas deducidas del historial (spec 025, T13; CA-3, CA-4, CA-8, CA-12; D-5, D-6, U-6, U-8). Cuatro pestañas leídas del
// servidor, que es la fuente de verdad: después de cada acción la lista se vuelve a leer. Propuestas: casillas, destino
// editable, «Activar seleccionadas», «Descartar seleccionadas» y «Activar todas». Sin criterio claro: de una en una eligiendo
// el destino. Con conflicto: «Reemplazar» solo si la regla vigente es distinta. Resueltas: solo texto. Sin `reglas.gestionar`
// se ve todo, sin controles. Todo texto del servidor (razón social) se pinta como texto.

const LIMITE = 100;

interface Anuncio {
  texto: string;
  /** Proveedores (RUC) de lo activado, para los enlaces de U-6; `null` = sin aviso de U-6. */
  activados: string[] | null;
  omitidas: string[];
}

const SIN_ANUNCIO: Anuncio = { texto: "", activados: null, omitidas: [] };
/** Más de estos enlaces por proveedor se resumen en uno solo al periodo. */
const MAX_ENLACES = 5;

/** Una línea por motivo con lo que el servidor omitió al activar (en el orden de `MOTIVOS_OMISION_CANDIDATA`). */
function lineasDeOmitidas(omitidas: RespuestaActivar["omitidas"]): string[] {
  return MOTIVOS_OMISION_CANDIDATA.map((motivo) => [motivo, omitidas.filter((o) => o.motivo === motivo).length] as const)
    .filter(([, n]) => n > 0)
    .map(([motivo, n]) => M.omitidas(n, motivo));
}

export function CandidatasImportadas({
  clienteId,
  alCrearReglas,
  alNoEncontrado,
}: {
  clienteId: string;
  /** Se llama tras activar (aunque sean 0) o reemplazar: la página vuelve a leer la tabla de reglas. */
  alCrearReglas?: () => void;
  /** Se llama si el servidor responde 404 al leer (cliente no visible): la página decide cómo avisarlo, una sola vez. */
  alNoEncontrado?: () => void;
}) {
  const puedeGestionar = usePuede(PERMISO_APRENDIZAJE_GESTIONAR) === true;
  const [importacion, setImportacion] = useState<ImportacionVista | null | undefined>(undefined);
  const [grupo, setGrupo] = useState<GrupoCandidatas>("propuestas");
  const [candidatas, setCandidatas] = useState<CandidataVista[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState<Anuncio>(SIN_ANUNCIO);
  const [seleccion, setSeleccion] = useState<ReadonlySet<string>>(new Set());
  // Destino elegido a mano por candidata (solo si se cambió o, en «sin criterio», se eligió).
  const [destinos, setDestinos] = useState<Readonly<Record<string, DestinoCompra | "">>>({});
  const [ocupado, setOcupado] = useState(false);
  // Descarta lecturas que llegan tarde (cambio de pestaña o relectura en medio).
  const secuencia = useRef(0);
  const alNoEncontradoRef = useRef(alNoEncontrado);
  useEffect(() => {
    alNoEncontradoRef.current = alNoEncontrado;
  });

  const importacionId = importacion?.id ?? null;

  useEffect(() => {
    let vigente = true;
    void ultimaImportacion(clienteId)
      .then((r) => {
        if (!vigente) return;
        if (r.ok) setImportacion(r.datos.importacion);
        else {
          setImportacion(null);
          setError(r.mensaje);
          if (r.status === 404) alNoEncontradoRef.current?.();
        }
      })
      .catch(() => {
        if (!vigente) return;
        setImportacion(null);
        setError(MENSAJES.errorGeneral);
      });
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  const leer = useCallback(
    async (deGrupo: GrupoCandidatas, cursor?: string): Promise<void> => {
      const mia = ++secuencia.current;
      setCargando(true);
      try {
        const r = await listarCandidatas(clienteId, { grupo: deGrupo, limite: LIMITE, ...(cursor === undefined ? {} : { cursor }) });
        if (mia !== secuencia.current) return;
        if (!r.ok) {
          setError(r.mensaje);
          if (r.status === 404) alNoEncontradoRef.current?.();
        } else {
          setError(null);
          setSiguiente(r.datos.siguiente);
          setCandidatas((previas) => {
            if (cursor === undefined) return r.datos.candidatas;
            const vistas = new Set(previas.map((c) => c.id));
            return [...previas, ...r.datos.candidatas.filter((c) => !vistas.has(c.id))];
          });
        }
      } catch {
        if (mia === secuencia.current) setError(MENSAJES.errorGeneral);
      }
      if (mia === secuencia.current) setCargando(false);
    },
    [clienteId],
  );

  // Con una importación, se lee el grupo de la pestaña; al cambiar de pestaña se parte de cero.
  useEffect(() => {
    if (importacionId === null) return;
    setSeleccion(new Set());
    setDestinos({});
    setCandidatas([]);
    setSiguiente(null);
    void leer(grupo);
  }, [importacionId, grupo, leer]);

  const recargar = () => leer(grupo);

  /** Una acción de escritura: sin doble envío, con el error del servidor en español y la lista vuelta a leer. */
  async function ejecutar(
    pedir: () => Promise<{ ok: true; exito: Anuncio } | { ok: false; mensaje: string }>,
    releerSiempre = false,
  ): Promise<void> {
    if (ocupado) return;
    setError(null);
    setAnuncio(SIN_ANUNCIO);
    setOcupado(true);
    try {
      const r = await pedir();
      if (r.ok) {
        setAnuncio(r.exito);
        setSeleccion(new Set());
        setDestinos({});
        await recargar();
      } else {
        // La lectura limpia el error de la lista: se relee primero y el mensaje de la acción queda después.
        if (releerSiempre) await recargar();
        setError(r.mensaje);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  const proveedoresDe = (ids: readonly string[]): string[] => {
    const numeros = ids
      .map((id) => candidatas.find((c) => c.id === id)?.proveedor.numero)
      .filter((n): n is string => n !== undefined);
    return [...new Set(numeros)];
  };

  const destinoDe = (c: CandidataVista): DestinoCompra | "" => destinos[c.id] ?? c.destinoPropuesto ?? "";
  const elegir = (id: string, destino: DestinoCompra | "") => setDestinos((previos) => ({ ...previos, [id]: destino }));

  const activar = (items: Array<{ id: string; destino?: DestinoCompra }>) =>
    ejecutar(async () => {
      const r = await activarCandidatas(clienteId, { items });
      if (!r.ok) return { ok: false, mensaje: r.mensaje };
      // Otra pestaña pudo crear la regla aunque aquí se activen 0: la tabla de reglas se relee siempre.
      alCrearReglas?.();
      return {
        ok: true,
        exito: {
          texto: M.reglasActivadas(r.datos.activadas.length),
          // Sin reglas nuevas no hay aviso de U-6 (rige desde la próxima descarga).
          activados: r.datos.activadas.length > 0 ? proveedoresDe(r.datos.activadas) : null,
          omitidas: lineasDeOmitidas(r.datos.omitidas),
        },
      };
    });

  const activarSeleccionadas = () => {
    const items = candidatas
      .filter((c) => seleccion.has(c.id))
      .map((c) => {
        const elegido = destinos[c.id];
        return elegido !== undefined && elegido !== "" && elegido !== c.destinoPropuesto
          ? { id: c.id, destino: elegido }
          : { id: c.id };
      });
    if (items.length > 0) void activar(items);
  };

  const descartarSeleccionadas = () => {
    const ids = candidatas.filter((c) => seleccion.has(c.id)).map((c) => c.id);
    if (ids.length === 0) return;
    void ejecutar(async () => {
      const r = await descartarCandidatas(clienteId, { ids });
      if (!r.ok) return { ok: false, mensaje: r.mensaje };
      return { ok: true, exito: { texto: M.candidatasDescartadas(r.datos.descartadas.length), activados: null, omitidas: [] } };
    });
  };

  const reemplazar = (c: CandidataVista) => {
    if (c.regla === null) return;
    const elegido = destinos[c.id];
    const regla = c.regla;
    void ejecutar(async () => {
      const r = await reemplazarCandidata(clienteId, c.id, {
        versionRegla: regla.version,
        ...(elegido !== undefined && elegido !== "" && elegido !== c.destinoPropuesto ? { destino: elegido } : {}),
      });
      if (!r.ok) return { ok: false, mensaje: r.mensaje };
      alCrearReglas?.();
      return { ok: true, exito: { texto: M.reglaReemplazada, activados: [c.proveedor.numero], omitidas: [] } };
    }, true);
  };

  const periodoAbierto = periodoDespuesDe(importacion?.periodos ?? []);
  const alActivarTodas = () => {
    alCrearReglas?.();
    setAnuncio(SIN_ANUNCIO);
    setSeleccion(new Set());
    void recargar();
  };

  if (importacion === undefined) return <p className="m-0 text-tinta-media">{M.cargandoCandidatas}</p>;
  if (importacion === null) {
    return (
      <div className="flex flex-col gap-3">
        {error !== null && <Alert tono="error">{error}</Alert>}
        <p className="m-0 text-tinta-media">{M.sinImportacion}</p>
      </div>
    );
  }

  const resumen = importacion.resumen;
  const aActivarTodas =
    siguiente !== null && resumen !== null
      ? Math.max(candidatas.length, resumen.candidatas - resumen.sinCriterio)
      : candidatas.length;

  return (
    <section aria-label={M.tablaCandidatas} className="flex min-w-0 flex-col gap-3">
      {error !== null && <Alert tono="error">{error}</Alert>}
      <div role="status" className="flex flex-col gap-1 text-sm text-tinta-media empty:hidden">
        {anuncio.texto !== "" && <p className="m-0 font-semibold text-tinta">{anuncio.texto}</p>}
        {anuncio.omitidas.map((linea) => (
          <p key={linea} className="m-0">
            {linea}
          </p>
        ))}
      </div>
      {anuncio.activados !== null && periodoAbierto !== null && (
        <div className="flex flex-col gap-1 text-sm text-tinta-media">
          <p className="m-0">{M.avisoPeriodoCargado}</p>
          {anuncio.activados.length > 0 && anuncio.activados.length <= MAX_ENLACES ? (
            anuncio.activados.map((numero) => (
              <p key={numero} className="m-0 flex flex-wrap items-center gap-2">
                <span className="font-mono">{numero}</span>
                <Link href={rutaGrilla(clienteId, periodoAbierto, numero)} className={`${enlace} max-lg:py-3`}>
                  {M.irAGrilla}
                </Link>
              </p>
            ))
          ) : (
            <Link href={rutaGrilla(clienteId, periodoAbierto)} className={`${enlace} self-start max-lg:py-3`}>
              {M.irAGrilla}
            </Link>
          )}
        </div>
      )}

      <Tabs
        value={grupo}
        onValueChange={(valor) => {
          setGrupo(valor as GrupoCandidatas);
          setAnuncio(SIN_ANUNCIO);
        }}
      >
        <TabsList>
          {GRUPOS_CANDIDATAS.map((g) => (
            <TabsTrigger key={g} value={g} className="max-lg:h-11">
              {M.pestanas[g]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={grupo} className="flex flex-col gap-3">
          {grupo === "propuestas" && puedeGestionar && (
            <div className="flex flex-wrap items-start gap-2">
              <Button disabled={seleccion.size === 0 || ocupado} onClick={activarSeleccionadas} className="max-lg:h-11">
                {M.activarSeleccionadas}
              </Button>
              <Button
                variant="secundario"
                disabled={seleccion.size === 0 || ocupado}
                onClick={descartarSeleccionadas}
                className="max-lg:h-11"
              >
                {M.descartarSeleccionadas}
              </Button>
              {importacion.estado === "completada" && periodoAbierto !== null && (
                <ActivarCandidatas
                  clienteId={clienteId}
                  importacionId={importacion.id}
                  aActivar={aActivarTodas}
                  omitidas={resumen?.sinCriterio ?? 0}
                  periodoAbierto={periodoAbierto}
                  alTerminar={alActivarTodas}
                />
              )}
            </div>
          )}
          {cargando && candidatas.length === 0 && <p className="m-0 text-tinta-media">{M.cargandoCandidatas}</p>}
          {!cargando && candidatas.length === 0 && error === null && (
            <p className="m-0 text-tinta-media">{M.sinCandidatas}</p>
          )}
          {candidatas.length > 0 && (
            <ul aria-label={M.tablaCandidatas} className="m-0 flex list-none flex-col gap-2 p-0">
              {candidatas.map((c) => (
                <FilaCandidata
                  key={c.id}
                  c={c}
                  grupo={grupo}
                  puedeGestionar={puedeGestionar}
                  ocupado={ocupado}
                  marcada={seleccion.has(c.id)}
                  destino={destinoDe(c)}
                  alMarcar={(marcada) =>
                    setSeleccion((previa) => {
                      const nueva = new Set(previa);
                      if (marcada) nueva.add(c.id);
                      else nueva.delete(c.id);
                      return nueva;
                    })
                  }
                  alElegir={(d) => elegir(c.id, d)}
                  alActivarUna={(d) => void activar([{ id: c.id, destino: d }])}
                  alReemplazar={() => reemplazar(c)}
                />
              ))}
            </ul>
          )}
          {siguiente !== null && (
            <Button
              variant="secundario"
              disabled={cargando || ocupado}
              onClick={() => void leer(grupo, siguiente)}
              className="self-start max-lg:h-11"
            >
              {M.cargarMas}
            </Button>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function FilaCandidata({
  c,
  grupo,
  puedeGestionar,
  ocupado,
  marcada,
  destino,
  alMarcar,
  alElegir,
  alActivarUna,
  alReemplazar,
}: {
  c: CandidataVista;
  grupo: GrupoCandidatas;
  puedeGestionar: boolean;
  ocupado: boolean;
  marcada: boolean;
  destino: DestinoCompra | "";
  alMarcar: (marcada: boolean) => void;
  alElegir: (destino: DestinoCompra | "") => void;
  alActivarUna: (destino: DestinoCompra) => void;
  alReemplazar: () => void;
}) {
  const numero = c.proveedor.numero;
  const selector = (conVacio: boolean) => (
    <Select
      aria-label={M.campoDestino(numero)}
      value={destino}
      disabled={ocupado}
      onChange={(e) => alElegir(e.target.value as DestinoCompra | "")}
      className="h-10 w-auto max-lg:h-11"
    >
      {conVacio && <option value="">{M.elegirDestino}</option>}
      {DESTINOS_COMPRA.map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </Select>
  );

  return (
    <li
      data-candidata={c.id}
      className="flex min-w-0 flex-col gap-2 rounded-control border border-linea bg-hoja p-3 text-sm text-tinta md:flex-row md:items-start md:gap-4"
    >
      {grupo === "propuestas" && puedeGestionar && (
        <input
          type="checkbox"
          aria-label={M.seleccionar(numero)}
          checked={marcada}
          disabled={ocupado}
          onChange={(e) => alMarcar(e.target.checked)}
          className="size-5 shrink-0 cursor-pointer accent-primario"
        />
      )}
      <div className="min-w-0 flex-1">
        <span className="block font-mono">{numero}</span>
        {c.proveedor.razonSocial !== null && (
          <span className="block break-words text-tinta-media">{c.proveedor.razonSocial}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-[2] flex-col gap-2">
        {grupo === "sin_criterio" && <p className="m-0 text-tinta-media">{conteosSinCriterio(c)}</p>}
        {grupo !== "sin_criterio" && c.destinoPropuesto !== null && (
          <p className="m-0 text-tinta-media">{frecuencia(c)}</p>
        )}
        {grupo === "conflicto" && c.regla !== null && <p className="m-0">{M.reglaVigente(c.regla.destino)}</p>}
        {grupo === "conflicto" && c.conflicto === "ya_aprendida" && <p className="m-0">{M.yaAprendida}</p>}
        {grupo === "conflicto" && c.regla?.activa === false && (
          <p className="m-0 text-tinta-media">{M.reglaInactiva}</p>
        )}
        {grupo === "resueltas" && (
          <p className="m-0 flex flex-wrap items-center gap-2">
            {c.estado !== "pendiente" && <Badge tono="neutro">{M.estados[c.estado]}</Badge>}
            {c.destinoElegido !== null && <span className="text-tinta-media">{M.destinoElegido(c.destinoElegido)}</span>}
          </p>
        )}
      </div>
      {puedeGestionar && grupo === "propuestas" && <div>{selector(false)}</div>}
      {!puedeGestionar && grupo === "propuestas" && c.destinoPropuesto !== null && (
        <p className="m-0">{M.destinoPropuesto(c.destinoPropuesto)}</p>
      )}
      {puedeGestionar && grupo === "sin_criterio" && (
        <div className="flex flex-wrap items-center gap-2">
          {selector(true)}
          <Button
            size="sm"
            disabled={destino === "" || ocupado}
            aria-label={M.activarUna(numero)}
            onClick={() => destino !== "" && alActivarUna(destino)}
            className="max-lg:h-11"
          >
            Activar
          </Button>
        </div>
      )}
      {puedeGestionar && grupo === "conflicto" && c.conflicto === "distinto" && (
        <div className="flex flex-wrap items-center gap-2">
          {selector(false)}
          <Button
            size="sm"
            variant="secundario"
            disabled={ocupado}
            aria-label={M.reemplazar(numero)}
            onClick={alReemplazar}
            className="max-lg:h-11"
          >
            Reemplazar
          </Button>
        </div>
      )}
    </li>
  );
}
