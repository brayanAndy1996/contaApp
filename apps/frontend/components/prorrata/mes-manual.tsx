"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { MesVista } from "@contapp/shared";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "../ui";
import {
  MENSAJES_PRORRATA as M,
  eliminarMesManual,
  errorDeMotivo,
  guardarMesManual,
  montoValido,
  textoErrorMotivo,
  type ErrorMotivo,
} from "../../lib/prorrata";
import { MENSAJES } from "../../lib/acceso";
import { useRestaurarFoco } from "../../lib/restaurar-foco";

// Diálogo para ingresar o corregir un mes a mano (spec 026, T13; CA-4, CA-9, R-5, R-6, U-4, U-5, D-5, D-8). Un mes que ya es
// manual llega con sus tres montos y el motivo vacío (cada versión lleva el suyo); uno SIRE o en falta, con los campos vacíos
// (el contador escribe «0» para «sin operaciones»). Los montos se mandan tal como se teclearon, recortados: no se convierten a
// número. La validación local solo evita viajes inútiles; el servidor valida de todos modos y un 409 sale en español.

type Campo = "gravadas" | "exportaciones" | "noGravadas";
const CAMPOS: readonly Campo[] = ["gravadas", "exportaciones", "noGravadas"];

const montoInicial = (mes: MesVista, campo: Campo): string => (mes.origen === "manual" ? mes[campo] : "");

export function MesManual({
  clienteId,
  mes,
  alGuardar,
  alCerrar,
  alConflicto,
}: {
  clienteId: string;
  mes: MesVista;
  alGuardar: () => void;
  alCerrar: () => void;
  /** El servidor rechazó con 409 (el mes cambió, ya se declaró o el cliente se archivó): lo que muestra la pantalla quedó viejo. */
  alConflicto?: (() => void) | undefined;
}) {
  useRestaurarFoco();
  const id = useId();
  const [montos, setMontos] = useState<Record<Campo, string>>({
    gravadas: montoInicial(mes, "gravadas"),
    exportaciones: montoInicial(mes, "exportaciones"),
    noGravadas: montoInicial(mes, "noGravadas"),
  });
  const [motivo, setMotivo] = useState("");
  const [eliminando, setEliminando] = useState(false);
  const [erroresMonto, setErroresMonto] = useState<Partial<Record<Campo, true>>>({});
  const [errorMotivo, setErrorMotivo] = useState<ErrorMotivo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);
  const esManual = mes.origen === "manual";

  const etiquetas: Record<Campo, string> = {
    gravadas: M.campos.gravadas,
    exportaciones: M.campos.exportaciones,
    noGravadas: M.campos.noGravadas,
  };

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (enCurso.current) return;
    setError(null);

    const texto = motivo.trim();
    const fallaMotivo = errorDeMotivo(texto);
    setErrorMotivo(fallaMotivo);

    const recortados = {
      gravadas: montos.gravadas.trim(),
      exportaciones: montos.exportaciones.trim(),
      noGravadas: montos.noGravadas.trim(),
    };
    if (!eliminando) {
      const malos: Partial<Record<Campo, true>> = {};
      for (const campo of CAMPOS) if (!montoValido(recortados[campo])) malos[campo] = true;
      setErroresMonto(malos);
      if (Object.keys(malos).length > 0) return;
    }
    if (fallaMotivo) return;

    enCurso.current = true;
    setOcupado(true);
    try {
      const r = eliminando
        ? await eliminarMesManual(clienteId, mes.periodo, { motivo: texto, version: mes.versionManual })
        : await guardarMesManual(clienteId, mes.periodo, { ...recortados, motivo: texto, version: mes.versionManual });
      if (r.ok) alGuardar();
      else if (r.status !== 401) {
        setError(r.mensaje);
        if (r.status === 409) alConflicto?.();
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  const idMotivo = `${id}-motivo`;

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && alCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{M.tituloManual(mes.periodo)}</DialogTitle>
          <DialogDescription>{eliminando ? M.descripcionEliminar : M.descripcionManual}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void enviar(e)} noValidate className="flex min-w-0 flex-col gap-4">
          {!eliminando &&
            CAMPOS.map((campo) => (
              <div key={campo} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${id}-${campo}`}>{etiquetas[campo]}</Label>
                <Input
                  id={`${id}-${campo}`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={montos[campo]}
                  onChange={(e) => setMontos((m) => ({ ...m, [campo]: e.target.value }))}
                  aria-invalid={erroresMonto[campo] ? true : undefined}
                  aria-describedby={erroresMonto[campo] ? `${id}-${campo}-error` : undefined}
                  className="max-lg:h-11"
                />
                {erroresMonto[campo] && (
                  <p id={`${id}-${campo}-error`} className="m-0 text-[13px] text-error">
                    {M.montoInvalido}
                  </p>
                )}
              </div>
            ))}
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={idMotivo}>{M.campos.motivo}</Label>
            <Input
              id={idMotivo}
              type="text"
              autoComplete="off"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              aria-invalid={errorMotivo ? true : undefined}
              aria-describedby={errorMotivo ? `${idMotivo}-error` : undefined}
              className="max-lg:h-11"
            />
            {errorMotivo && (
              <p id={`${idMotivo}-error`} className="m-0 text-[13px] text-error">
                {textoErrorMotivo[errorMotivo]}
              </p>
            )}
          </div>
          {error && <Alert tono="error">{error}</Alert>}
          <DialogFooter>
            {esManual && !eliminando && (
              <Button
                type="button"
                variant="secundario"
                disabled={ocupado}
                onClick={() => {
                  setEliminando(true);
                  setError(null);
                  setErrorMotivo(null);
                }}
                className="max-lg:h-11 sm:mr-auto"
              >
                {M.eliminarManual}
              </Button>
            )}
            <Button type="button" variant="secundario" onClick={alCerrar} className="max-lg:h-11">
              {M.cancelar}
            </Button>
            {eliminando ? (
              <Button type="submit" variant="peligro" disabled={ocupado} className="max-lg:h-11">
                {M.confirmarEliminar}
              </Button>
            ) : (
              <Button type="submit" disabled={ocupado} className="max-lg:h-11">
                {M.guardar}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
