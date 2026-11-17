"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, cargarYo, tiene, type Yo } from "../../lib/acceso";
import { Alert, Badge, Card, anilloFoco } from "../ui";
import {
  MENSAJES_REGLAS as M,
  PERMISO_REGLAS_GESTIONAR,
  fijarAporteCatalogo,
  fijarReglaMotor,
  leerReglasMotor,
  type CodigoReglaMotor,
  type ReglasMotor as ReglasMotorDto,
} from "../../lib/reglas";

// Reglas del motor del estudio (spec 021, CA-8, P-8, P-10; RF-089). Seis interruptores (R-ISC … R-HIS), ninguno para
// la prevalidación de 012, y uno más para aportar los proveedores con RUC 20 al catálogo compartido. Sin
// actualización optimista: el interruptor cambia cuando el servidor responde 200. Solo quien tiene `reglas.gestionar`
// y alcance global (Dueño o Administrador) puede cambiarlos; el servidor lo valida, aquí solo se deshabilita.

export function ReglasMotor() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [motor, setMotor] = useState<ReglasMotorDto | null>(null);
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");
  const enCurso = useRef(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const [{ yo: actual }, lectura] = await Promise.all([cargarYo(), leerReglasMotor()]);
      if (!vigente) return;
      setYo(actual);
      if (lectura.ok) setMotor(lectura.datos);
      else if (lectura.status !== 401) setError(lectura.mensaje);
      setCargado(true);
    })().catch(() => {
      if (!vigente) return;
      setError(MENSAJES.errorGeneral);
      setCargado(true);
    });
    return () => {
      vigente = false;
    };
  }, []);

  const puedeCambiar = tiene(yo, PERMISO_REGLAS_GESTIONAR) && yo?.alcance === "global";

  const cambiar = useCallback(
    async (
      llamada: () => ReturnType<typeof fijarAporteCatalogo>,
      aplicar: (m: ReglasMotorDto) => ReglasMotorDto,
      mensaje: string,
    ) => {
      if (enCurso.current) return;
      enCurso.current = true;
      setError(null);
      setAnuncio("");
      try {
        const r = await llamada();
        if (r.ok) {
          setMotor((previo) => (previo ? aplicar(previo) : previo));
          setAnuncio(mensaje);
        } else if (r.status !== 401) setError(r.mensaje);
      } catch {
        setError(MENSAJES.errorGeneral);
      } finally {
        enCurso.current = false;
      }
    },
    [],
  );

  const fijarRegla = (codigo: CodigoReglaMotor, activa: boolean) =>
    cambiar(
      () => fijarReglaMotor(codigo, activa),
      (m) => ({ ...m, reglas: m.reglas.map((r) => (r.codigo === codigo ? { ...r, activa } : r)) }),
      M.motorCambiada(codigo, activa),
    );

  const fijarAporte = (aportar: boolean) =>
    cambiar(
      () => fijarAporteCatalogo(aportar),
      (m) => ({ ...m, aportarCatalogo: aportar }),
      M.aporteCambiado(aportar),
    );

  if (!cargado) return <p role="status" className="text-sm text-tinta-suave">{M.cargandoMotor}</p>;

  return (
    <section aria-label={M.tituloReglasMotor} className="flex max-w-2xl flex-col gap-4">
      {error && <Alert tono="error">{error}</Alert>}
      <p role="status" className="sr-only">
        {anuncio}
      </p>
      {motor && (
        <>
          <p className="m-0 text-sm text-tinta-media">{M.introMotor}</p>
          {!puedeCambiar && (
            <p className="m-0 rounded-control border border-aviso-borde bg-aviso-fondo px-3.5 py-3 text-sm text-aviso">
              {M.soloAlcanceGlobal}
            </p>
          )}
          <Card className="gap-0 p-0">
            <ul className="m-0 flex list-none flex-col divide-y divide-linea p-0">
              {motor.reglas.map((r) => (
                <li key={r.codigo} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                  {/* Bajo 1024 px la etiqueta envolvente da 44 × 44 px de área táctil al interruptor. */}
                  <label className="mt-1 flex shrink-0 items-center justify-center max-lg:-ml-2 max-lg:mt-0 max-lg:size-11">
                    <input
                      id={`regla-motor-${r.codigo}`}
                      type="checkbox"
                      role="switch"
                      checked={r.activa}
                      aria-checked={r.activa}
                      aria-labelledby={`regla-motor-${r.codigo}-nombre`}
                      aria-describedby={`regla-motor-${r.codigo}-descripcion`}
                      disabled={!puedeCambiar}
                      onChange={(e) => void fijarRegla(r.codigo, e.target.checked)}
                      className={`h-5 w-5 shrink-0 cursor-pointer accent-primario disabled:cursor-not-allowed disabled:opacity-60 ${anilloFoco}`}
                    />
                  </label>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <label
                      id={`regla-motor-${r.codigo}-nombre`}
                      htmlFor={`regla-motor-${r.codigo}`}
                      className="flex min-h-11 items-center font-mono text-sm font-semibold text-tinta lg:min-h-0"
                    >
                      {r.codigo}
                    </label>
                    <span id={`regla-motor-${r.codigo}-descripcion`} className="text-sm text-tinta-suave">
                      {r.descripcion}
                    </span>
                  </div>
                  <Badge tono={r.activa ? "ok" : "neutro"}>{r.activa ? M.activa : M.inactiva}</Badge>
                </li>
              ))}
            </ul>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 border-t border-linea px-4 py-3 text-sm text-tinta sm:px-5">
              <input
                type="checkbox"
                role="switch"
                checked={motor.aportarCatalogo}
                aria-checked={motor.aportarCatalogo}
                disabled={!puedeCambiar}
                onChange={(e) => void fijarAporte(e.target.checked)}
                className={`h-5 w-5 shrink-0 cursor-pointer accent-primario disabled:cursor-not-allowed disabled:opacity-60 ${anilloFoco}`}
              />
              {M.aporte}
            </label>
          </Card>
        </>
      )}
    </section>
  );
}
