"use client";

import { coeficienteVistaSchema } from "@contapp/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardTitle, Input, Label } from "../ui";
import { MENSAJES } from "../../lib/acceso";
import { MENSAJES_PRORRATA as M, guardarProrrataUsada, porcentajeUsadaValido } from "../../lib/prorrata";

// Prorrata usada en la declaración y alerta de diferencia (spec 026, T13; CA-6, CA-9, R-8, U-9, U-10, D-8). Muestra la prorrata
// usada con su origen. Si el PDT 621 no la trae (`usada` nula o «ingresada»), quien gestiona puede ingresarla, corregirla o
// quitarla; si el PDT la trae, no hay ingreso. La diferencia y la alerta las decide el servidor: aquí solo se pinta el
// texto con ambos valores. El porcentaje se manda como se tecleó, recortado.

type Usada = { valor: string; origen: "declarada" | "ingresada" };

export function ProrrataUsada({
  clienteId,
  periodo,
  usada,
  versionUsada,
  diferencia,
  coeficiente,
  puedeGestionar,
  archivado = false,
  alGuardar,
  alConflicto,
}: {
  clienteId: string;
  periodo: string;
  usada: Usada | null;
  versionUsada: number;
  diferencia: { diferencia: string; alerta: boolean } | null;
  coeficiente: unknown;
  puedeGestionar: boolean;
  archivado?: boolean | undefined;
  alGuardar: () => void;
  /** Otra persona cambió el valor mientras se editaba (409 de versión): la pantalla relee lo vigente. */
  alConflicto?: (() => void) | undefined;
}) {
  const id = useId();
  const [valor, setValor] = useState(usada?.origen === "ingresada" ? usada.valor : "");
  const [invalido, setInvalido] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);

  // Tras guardar, la pantalla relee la vista: el campo se vuelve a alinear con lo vigente.
  const valorVigente = usada?.origen === "ingresada" ? usada.valor : "";
  useEffect(() => {
    setValor(valorVigente);
    setInvalido(false);
  }, [valorVigente, periodo, versionUsada]);

  const calculado = (() => {
    const c = coeficienteVistaSchema.safeParse(coeficiente);
    return c.success && c.data.estado === "calculado" ? c.data.porcentaje : null;
  })();
  const hayAlerta = diferencia?.alerta === true && calculado !== null && usada !== null;
  const puedeIngresar = puedeGestionar && !archivado && usada?.origen !== "declarada";

  async function enviar(porcentaje: string | null): Promise<void> {
    if (enCurso.current) return;
    setError(null);
    enCurso.current = true;
    setOcupado(true);
    try {
      const r = await guardarProrrataUsada(clienteId, periodo, { porcentaje, version: versionUsada });
      if (r.ok) alGuardar();
      else if (r.status !== 401) {
        setError(r.mensaje);
        if (r.status === 409 && r.codigo === "mes_cambiado") alConflicto?.();
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  function guardar(evento: FormEvent<HTMLFormElement>): void {
    evento.preventDefault();
    const texto = valor.trim();
    if (!porcentajeUsadaValido(texto)) {
      setInvalido(true);
      return;
    }
    setInvalido(false);
    void enviar(texto);
  }

  return (
    <Card aria-labelledby={`${id}-titulo`}>
      <CardTitle id={`${id}-titulo`}>{M.tituloUsada}</CardTitle>
      {usada ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="cifras m-0 font-titulo text-2xl font-extrabold text-tinta">{M.porcentaje(usada.valor)}</p>
          <p className="m-0 text-sm text-tinta-suave">{M.origenUsada[usada.origen]}</p>
        </div>
      ) : (
        <p className="m-0 text-sm text-tinta-suave">{M.sinUsada}</p>
      )}
      {hayAlerta && diferencia && usada && calculado !== null && (
        <Alert tono="aviso">{M.alertaDiferencia(calculado, usada.valor, usada.origen, diferencia.diferencia)}</Alert>
      )}
      {error && <Alert tono="error">{error}</Alert>}
      {puedeIngresar && (
        <form onSubmit={guardar} noValidate className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`${id}-campo`}>{M.campoUsada}</Label>
            <Input
              id={`${id}-campo`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              aria-invalid={invalido ? true : undefined}
              aria-describedby={invalido ? `${id}-error` : undefined}
              className="max-lg:h-11 sm:max-w-48"
            />
            {invalido && (
              <p id={`${id}-error`} className="m-0 text-[13px] text-error">
                {M.porcentajeInvalido}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={ocupado} className="max-lg:h-11">
              {M.guardarUsada}
            </Button>
            {usada?.origen === "ingresada" && (
              <Button type="button" variant="secundario" disabled={ocupado} onClick={() => void enviar(null)} className="max-lg:h-11">
                {M.quitarUsada}
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}
