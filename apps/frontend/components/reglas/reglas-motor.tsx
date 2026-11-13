"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES, cargarYo, tiene, type Yo } from "../../lib/acceso";
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
    async (llamada: () => ReturnType<typeof fijarAporteCatalogo>, aplicar: (m: ReglasMotorDto) => ReglasMotorDto) => {
      if (enCurso.current) return;
      enCurso.current = true;
      setError(null);
      try {
        const r = await llamada();
        if (r.ok) setMotor((previo) => (previo ? aplicar(previo) : previo));
        else if (r.status !== 401) setError(r.mensaje);
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
    );

  const fijarAporte = (aportar: boolean) =>
    cambiar(
      () => fijarAporteCatalogo(aportar),
      (m) => ({ ...m, aportarCatalogo: aportar }),
    );

  if (!cargado) return <p role="status">{M.cargandoMotor}</p>;

  return (
    <section aria-label={M.tituloReglasMotor} className="flex max-w-2xl flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {motor && (
        <>
          <p className="text-sm">{M.introMotor}</p>
          {!puedeCambiar && <p className="text-sm">{M.soloAlcanceGlobal}</p>}
          <ul className="flex list-none flex-col gap-3">
            {motor.reglas.map((r) => (
              <li key={r.codigo} className="flex items-start gap-3">
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
                  className="mt-1 h-4 w-4"
                />
                <div className="flex flex-col">
                  <label
                    id={`regla-motor-${r.codigo}-nombre`}
                    htmlFor={`regla-motor-${r.codigo}`}
                    className="font-medium"
                  >
                    {r.codigo}
                  </label>
                  <span id={`regla-motor-${r.codigo}-descripcion`} className="text-sm">
                    {r.descripcion}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              checked={motor.aportarCatalogo}
              aria-checked={motor.aportarCatalogo}
              disabled={!puedeCambiar}
              onChange={(e) => void fijarAporte(e.target.checked)}
              className="h-4 w-4"
            />
            {M.aporte}
          </label>
        </>
      )}
    </section>
  );
}
