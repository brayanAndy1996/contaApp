"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TrabajoVista } from "@contapp/shared";
import { Alert, Button, Label, Select } from "../ui";
import { MENSAJES, usePuede } from "../../lib/acceso";
import {
  MENSAJES_PRORRATA as M,
  PERMISO_PRORRATA_GESTIONAR,
  etiquetaPeriodo,
  leerProrrata,
  mesEnCursoLima,
  mesesOfrecidos,
  obtenerDeclaraciones,
  periodoPorOmision,
  type MesVista,
  type ProrrataVista,
} from "../../lib/prorrata";
import { seguirTrabajos } from "../../lib/trabajos";
import { Coeficiente } from "./coeficiente";
import { GraficoProrrata } from "./grafico-prorrata";
import { HistorialMes } from "./historial-mes";
import { IgvEstimado } from "./igv-estimado";
import { MesManual } from "./mes-manual";
import { ProrrataUsada } from "./prorrata-usada";
import { TablaMeses } from "./tabla-meses";

// Pantalla de prorrata e IGV estimado de un cliente (spec 026, T13; CA-1, CA-3 a CA-6, CA-9, D-5, D-8). Integra el selector
// del mes de cálculo (por omisión el mes anterior al en curso, hora de Lima), «Obtener declaraciones» (un trabajo de 008 que se
// sigue hasta terminar), la tabla de 12 meses, el gráfico, el coeficiente, el IGV estimado y la prorrata usada. Aquí no se
// calcula nada: la vista viene del servidor y se vuelve a leer tras cada cambio. Los permisos solo ocultan (el servidor valida).

const TERMINAL = new Set(["completado", "error", "cancelado"]);

type Estado =
  | { tipo: "cargando" }
  | { tipo: "error"; status: number; texto: string }
  | { tipo: "listo"; vista: ProrrataVista };

export function ProrrataCliente({ clienteId, archivado = false }: { clienteId: string; archivado?: boolean }) {
  const puedeGestionar = usePuede(PERMISO_PRORRATA_GESTIONAR) === true;
  const idPeriodo = useId();
  const enCurso = useMemo(() => mesEnCursoLima(), []);
  const opciones = useMemo(() => mesesOfrecidos(enCurso), [enCurso]);
  const [periodo, setPeriodo] = useState(() => periodoPorOmision(enCurso));
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  // Sube cuando hay que volver a leer el mismo periodo (tras guardar o al terminar la obtención).
  const [lectura, setLectura] = useState(0);
  const [trabajoId, setTrabajoId] = useState<string | null>(null);
  const [solicitando, setSolicitando] = useState(false);
  const [errorObtener, setErrorObtener] = useState<string | null>(null);
  const [mesAbierto, setMesAbierto] = useState<MesVista | null>(null);
  const [historialAbierto, setHistorialAbierto] = useState<string | null>(null);
  const solicitud = useRef(0);
  const peticionEnCurso = useRef(false);

  // Cambiar de mes borra la vista (es otra ventana); volver a leer el mismo mes la deja a la vista hasta que llegue la nueva.
  useEffect(() => {
    setEstado({ tipo: "cargando" });
  }, [clienteId, periodo]);

  useEffect(() => {
    const numero = ++solicitud.current;
    leerProrrata(clienteId, periodo)
      .then((r) => {
        if (numero !== solicitud.current) return;
        if (r.ok) setEstado({ tipo: "listo", vista: r.datos });
        else if (r.status !== 401) setEstado({ tipo: "error", status: r.status, texto: r.mensaje });
      })
      .catch(() => {
        if (numero === solicitud.current) setEstado({ tipo: "error", status: 0, texto: M.errorCarga });
      });
  }, [clienteId, periodo, lectura]);

  const relee = useCallback(() => setLectura((n) => n + 1), []);

  // Seguimiento del trabajo de obtención hasta que termina (como la importación del historial, 025).
  useEffect(() => {
    if (trabajoId === null) return;
    const control = new AbortController();
    let terminado = false;
    const terminar = (t: Pick<TrabajoVista, "estado">) => {
      if (terminado) return;
      terminado = true;
      setTrabajoId(null);
      if (t.estado === "completado") relee();
      else setErrorObtener(M.obtencionFallida);
    };
    void seguirTrabajos({
      senal: control.signal,
      alListar: (trabajos) => {
        const propio = trabajos.find((t) => t.id === trabajoId);
        if (propio && TERMINAL.has(propio.estado)) terminar(propio);
      },
      alEvento: (t) => {
        if (t.id === trabajoId && TERMINAL.has(t.estado)) terminar(t);
      },
      alError: () => undefined,
    });
    return () => control.abort();
  }, [trabajoId, relee]);

  async function obtener(): Promise<void> {
    if (peticionEnCurso.current || trabajoId !== null || archivado) return;
    peticionEnCurso.current = true;
    setErrorObtener(null);
    setSolicitando(true);
    try {
      const r = await obtenerDeclaraciones(clienteId, periodo);
      if (r.ok) setTrabajoId(r.datos.trabajoId);
      else if (r.status !== 401) setErrorObtener(r.mensaje);
    } catch {
      setErrorObtener(MENSAJES.errorGeneral);
    } finally {
      peticionEnCurso.current = false;
      setSolicitando(false);
    }
  }

  const obteniendo = solicitando || trabajoId !== null;
  const vista = estado.tipo === "listo" ? estado.vista : null;
  // La vista bloqueada por error no deja botones ni tabla (404, 403) y ofrece reintentar en los errores transitorios.
  const sinAcceso = estado.tipo === "error" && (estado.status === 404 || estado.status === 403);

  function cerrarYReleer(): void {
    setMesAbierto(null);
    relee();
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {estado.tipo === "error" ? (
        <div className="flex min-w-0 flex-col gap-3">
          <Alert tono="error">{estado.texto}</Alert>
          {!sinAcceso && (
            <Button type="button" variant="secundario" onClick={relee} className="self-start max-lg:h-11">
              {M.reintentar}
            </Button>
          )}
        </div>
      ) : null}
      {!sinAcceso && (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-col gap-1.5 max-sm:w-full">
              <Label htmlFor={`${idPeriodo}-periodo`}>{M.campoPeriodo}</Label>
              <Select
                id={`${idPeriodo}-periodo`}
                value={periodo}
                onChange={(e) => setPeriodo(e.target.value)}
                className="max-lg:h-11 sm:w-44"
              >
                {opciones.map((p) => (
                  <option key={p} value={p}>
                    {etiquetaPeriodo(p)}
                  </option>
                ))}
              </Select>
            </div>
            {puedeGestionar && (
              <Button
                type="button"
                variant="secundario"
                disabled={archivado || obteniendo}
                onClick={() => void obtener()}
                className="max-lg:h-11 max-sm:w-full"
              >
                {M.obtener}
              </Button>
            )}
          </div>
          {archivado && <p className="m-0 text-sm text-tinta-suave">{M.errores.cliente_archivado}</p>}
          {obteniendo && (
            <Alert tono="info" role="status">
              {M.obteniendo}
            </Alert>
          )}
          {errorObtener && <Alert tono="error">{errorObtener}</Alert>}
          {vista && (
            <div className="flex min-w-0 flex-col gap-1 text-sm text-tinta-suave">
              <p className="m-0">{vista.ultimaObtencion ? M.ultimaObtencion(vista.ultimaObtencion.obtenidaEn) : M.sinObtencion}</p>
              {vista.ultimaObtencion && vista.ultimaObtencion.periodosSinDeclaracion.length > 0 && (
                <p className="m-0">{M.sinDeclaracion(vista.ultimaObtencion.periodosSinDeclaracion)}</p>
              )}
            </div>
          )}
        </div>
      )}
      {estado.tipo === "cargando" && <p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>}
      {vista && (
        <>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <Coeficiente coeficiente={vista.coeficiente} puedeGestionar={puedeGestionar && !archivado} />
            <IgvEstimado igv={vista.igvEstimado} />
          </div>
          <ProrrataUsada
            clienteId={clienteId}
            periodo={vista.periodo}
            usada={vista.prorrataUsada}
            versionUsada={vista.versionUsada}
            diferencia={vista.diferencia}
            coeficiente={vista.coeficiente}
            puedeGestionar={puedeGestionar}
            archivado={archivado}
            alGuardar={relee}
          />
          <TablaMeses
            meses={vista.ventana}
            puedeGestionar={puedeGestionar && !archivado}
            alIngresar={(p) => setMesAbierto(vista.ventana.find((m) => m.periodo === p) ?? null)}
            alHistorial={setHistorialAbierto}
          />
          <GraficoProrrata meses={vista.ventana} />
        </>
      )}
      {mesAbierto && <MesManual key={mesAbierto.periodo} clienteId={clienteId} mes={mesAbierto} alGuardar={cerrarYReleer} alCerrar={() => setMesAbierto(null)} />}
      {historialAbierto && <HistorialMes key={historialAbierto} clienteId={clienteId} periodo={historialAbierto} alCerrar={() => setHistorialAbierto(null)} />}
    </div>
  );
}
