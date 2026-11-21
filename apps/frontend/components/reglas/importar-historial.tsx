"use client";

import { PERIODOS_IMPORTACION_MAX, type TrabajoVista } from "@contapp/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePuede } from "../../lib/acceso";
import {
  MENSAJES_APRENDIZAJE as M,
  PERMISO_APRENDIZAJE_GESTIONAR,
  solicitarImportacion,
  ultimaImportacion,
  type ImportacionVista,
} from "../../lib/aprendizaje";
import { MENSAJES } from "../../lib/acceso";
import { seguirTrabajos } from "../../lib/trabajos";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
} from "../ui";

// Importar el historial del cliente (spec 025, T13; CA-1, CA-5, CA-8; D-4, D-10, U-5). Botón «Importar historial» (solo con
// `reglas.gestionar`) que abre un diálogo con cuántos periodos leer (1 a 12, 6 por omisión) y el aviso de que nada se aplica
// hasta activar las reglas. La importación en curso se sigue con el trabajo de 008 (`seguirTrabajos`); al completar se vuelve a
// leer la última importación y se avisa con `alCompletar`. Aquí no se calcula nada: los conteos los da el servidor.

const TERMINAL = new Set(["completado", "error", "cancelado"]);
const OPCIONES = Array.from({ length: PERIODOS_IMPORTACION_MAX }, (_, i) => String(i + 1));

export function ImportarHistorial({
  clienteId,
  alCompletar,
  alNoEncontrado,
}: {
  clienteId: string;
  /** Se llama una vez que el trabajo de la importación terminó bien y la última importación se volvió a leer. */
  alCompletar?: () => void;
  /** Se llama si el servidor responde 404 al leer (cliente no visible): la página decide cómo avisarlo, una sola vez. */
  alNoEncontrado?: () => void;
}) {
  const puedeGestionar = usePuede(PERMISO_APRENDIZAJE_GESTIONAR) === true;
  const [importacion, setImportacion] = useState<ImportacionVista | null>(null);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  // El trabajo que devolvió el 202 (la fila leída después trae el suyo, el mismo).
  const [trabajoPropio, setTrabajoPropio] = useState<string | null>(null);
  // El trabajo terminó mal antes de que se vuelva a leer la importación.
  const [fallo, setFallo] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [periodos, setPeriodos] = useState<string>(M.periodosPorOmision);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botonRef = useRef<HTMLButtonElement>(null);
  const alCompletarRef = useRef(alCompletar);
  const alNoEncontradoRef = useRef(alNoEncontrado);
  useEffect(() => {
    alCompletarRef.current = alCompletar;
    alNoEncontradoRef.current = alNoEncontrado;
  });

  const leer = useCallback(async (): Promise<ImportacionVista | null> => {
    try {
      const r = await ultimaImportacion(clienteId);
      if (!r.ok) {
        setErrorLectura(r.mensaje);
        if (r.status === 404) alNoEncontradoRef.current?.();
        return null;
      }
      setErrorLectura(null);
      setImportacion(r.datos.importacion);
      return r.datos.importacion;
    } catch {
      setErrorLectura(MENSAJES.errorGeneral);
      return null;
    }
  }, [clienteId]);

  useEffect(() => {
    void leer();
  }, [leer]);

  const enCurso = importacion?.estado === "en_curso" && !fallo;
  const trabajoId = enCurso ? (trabajoPropio ?? importacion?.trabajoId ?? null) : null;

  useEffect(() => {
    if (trabajoId === null) return;
    const control = new AbortController();
    let terminado = false;
    let relecturaAlListar = false;
    const terminar = (t: Pick<TrabajoVista, "estado">) => {
      if (terminado) return;
      terminado = true;
      if (t.estado === "completado") {
        void leer().then(() => alCompletarRef.current?.());
      } else {
        setFallo(true);
      }
    };
    void seguirTrabajos({
      senal: control.signal,
      // Al abrir (y tras cada reconexión): si el trabajo ya terminó, o ya no está, se resuelve sin esperar un evento.
      alListar: (trabajos) => {
        const propio = trabajos.find((t) => t.id === trabajoId);
        if (propio !== undefined) {
          if (TERMINAL.has(propio.estado)) terminar(propio);
        } else if (!relecturaAlListar) {
          relecturaAlListar = true;
          void leer();
        }
      },
      alEvento: (t) => {
        if (t.id === trabajoId && TERMINAL.has(t.estado)) terminar(t);
      },
      alError: () => undefined,
    });
    return () => control.abort();
  }, [trabajoId, leer]);

  async function importar(): Promise<void> {
    if (ocupado) return;
    setError(null);
    setOcupado(true);
    try {
      const r = await solicitarImportacion(clienteId, { periodos: Number(periodos) });
      if (!r.ok) {
        setError(r.mensaje);
      } else {
        setFallo(false);
        setErrorLectura(null);
        setTrabajoPropio(r.datos.trabajoId);
        setImportacion(r.datos.importacion);
        setAbierto(false);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  const fallida = importacion?.estado === "fallida" || fallo;
  const resumen = importacion?.estado === "completada" && !fallo ? importacion.resumen : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {errorLectura !== null && <Alert tono="error">{errorLectura}</Alert>}
      {enCurso && (
        <p role="status" className="m-0 text-sm text-tinta-media">
          {M.enCurso}
        </p>
      )}
      {fallida && <Alert tono="error">{M.fallida}</Alert>}
      {resumen !== null && resumen !== undefined && (
        <div className="flex flex-col gap-1 text-sm text-tinta-media">
          <p className="m-0">{M.resumen(resumen)}</p>
          {resumen.periodosSinDatos.length > 0 && <p className="m-0">{M.sinDatos(resumen.periodosSinDatos)}</p>}
        </div>
      )}
      {puedeGestionar && (
        <Dialog
          open={abierto}
          onOpenChange={(valor) => {
            if (ocupado) return;
            setAbierto(valor);
            if (valor) setError(null);
          }}
        >
          <Button
            ref={botonRef}
            variant="secundario"
            disabled={enCurso || ocupado}
            onClick={() => setAbierto(true)}
            className="self-start max-lg:h-11"
          >
            {M.importar}
          </Button>
          <DialogContent
            mostrarCerrar={false}
            // El botón no es un `DialogTrigger`: al cerrar, el foco vuelve a él.
            onCloseAutoFocus={(e) => {
              if (botonRef.current) {
                e.preventDefault();
                botonRef.current.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{M.tituloImportar}</DialogTitle>
              <DialogDescription>{M.avisoSinAplicar}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="periodos-importacion">{M.campoPeriodos}</Label>
              <Select
                id="periodos-importacion"
                value={periodos}
                disabled={ocupado}
                onChange={(e) => setPeriodos(e.target.value)}
                className="max-lg:h-11"
              >
                {OPCIONES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
            {error !== null && <Alert tono="error">{error}</Alert>}
            <DialogFooter>
              <Button variant="secundario" disabled={ocupado} onClick={() => setAbierto(false)} className="max-lg:h-11">
                {M.cancelar}
              </Button>
              <Button disabled={ocupado} onClick={() => void importar()} className="max-lg:h-11">
                {M.confirmarImportar}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
