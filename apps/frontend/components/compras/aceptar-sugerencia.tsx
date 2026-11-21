"use client";

import {
  DESTINOS_COMPRA,
  aceptarSugerenciaSchema,
  type DestinoCompra,
  type FilaCompraVista,
  type HallazgoVista,
} from "@contapp/shared";
import { useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  aceptarSugerenciaCompra,
  type ContextoCompras,
} from "../../lib/compras";
import { validarMonto } from "../../lib/montos-compras";
import { cn } from "../../lib/utils";
import { ConfirmarAccion } from "../ventas/confirmar-accion";
import {
  comprobanteDe,
  recargarTrasError,
  recargarTrasExito,
  type AlAvisar,
} from "./accion-compras";
import { useErrorAnunciado } from "./aviso-unico";
import { Badge, Button, Input, Label, Select, cifra, panelDialogo } from "../ui";

// Aceptar sugerencias de una compra (spec 015, D-7, RNF-073). Los hallazgos de la fila se ven como chips con su
// explicación y un botón «Aceptar» cada uno. Flujo:
//  - Si el hallazgo pide confirmación y no pide dato (R-ISC, R-GP), se confirma antes de enviar.
//  - 422 `requiere_dato` abre el campo del gravado (R-MIX) o del destino (R-NEW) y reenvía con `dato`.
//  - 422 `requiere_confirmacion` abre la confirmación y reenvía con `confirmar`.
//  - 409 `revisar_de_nuevo` / `version_obsoleta`: recarga la fila y avisa; el usuario revisa y repite.
// Los montos del dato pasan por `validarMonto`; nunca se calcula nada aquí: el servidor mueve los montos.

type Paso =
  | { tipo: "lista" }
  | { tipo: "confirmar"; hallazgo: HallazgoVista }
  | { tipo: "dato"; hallazgo: HallazgoVista; dato: "gravado" | "destino" };

export function AceptarSugerencias({
  contexto,
  fila,
  alTerminar,
  alCancelar,
  alAvisar,
  alAceptar,
}: {
  contexto: ContextoCompras;
  fila: FilaCompraVista;
  /** Tras aceptar bien, para que quien lo abrió lo cierre. */
  alTerminar: () => void;
  alCancelar: () => void;
  alAvisar?: AlAvisar;
  /** Spec 025 (CA-10): se llama con el hallazgo aceptado, antes de `alTerminar`; la grilla ofrece «Recordar» tras R-STD. */
  alAceptar?: (hallazgo: HallazgoVista) => void;
}) {
  const [paso, setPaso] = useState<Paso>({ tipo: "lista" });
  const [gravado, setGravado] = useState("");
  const [destino, setDestino] = useState<DestinoCompra>("DG");
  const [error, setError] = useState<string | null>(null);
  const { avisarError, rolDe } = useErrorAnunciado(alAvisar);
  const [ocupado, setOcupado] = useState(false);
  const comprobante = comprobanteDe(fila);

  const volver = () => {
    setPaso({ tipo: "lista" });
    setError(null);
  };

  async function enviar(
    hallazgo: HallazgoVista,
    extra: {
      confirmar?: boolean;
      dato?: { gravado: string } | { destino: DestinoCompra };
    },
  ): Promise<void> {
    if (ocupado) return;
    const analisis = aceptarSugerenciaSchema.safeParse({
      versionBase: fila.version,
      regla: hallazgo.regla,
      ...(extra.confirmar ? { confirmar: true } : {}),
      ...(extra.dato ? { dato: extra.dato } : {}),
    });
    if (!analisis.success) {
      setError(M.datosInvalidos);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await aceptarSugerenciaCompra(
        contexto.clienteId,
        contexto.periodo,
        fila.id,
        analisis.data,
      );
      if (r.ok) {
        await recargarTrasExito(contexto, fila.id);
        alAvisar?.(M.sugerenciaAceptada, "ok");
        alAceptar?.(hallazgo);
        alTerminar();
        return;
      }
      if (r.codigo === "requiere_dato" && r.dato !== undefined) {
        setPaso({ tipo: "dato", hallazgo, dato: r.dato });
      } else if (r.codigo === "requiere_confirmacion") {
        setPaso({ tipo: "confirmar", hallazgo });
      } else {
        await recargarTrasError(contexto, fila.id, r);
        setPaso({ tipo: "lista" });
        setError(r.mensaje);
        avisarError(r.mensaje);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
      avisarError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  function aceptar(h: HallazgoVista): void {
    // Con dato pendiente se pide primero al servidor (D-7): él dice qué dato falta. Sin dato, la confirmación va antes.
    if (h.requiereConfirmacion && h.dato === null) {
      setError(null);
      setPaso({ tipo: "confirmar", hallazgo: h });
      return;
    }
    void enviar(h, {});
  }

  function enviarDato(evento: FormEvent<HTMLFormElement>): void {
    evento.preventDefault();
    if (paso.tipo !== "dato") return;
    if (paso.dato === "gravado") {
      const v = validarMonto(gravado);
      if (!v.ok) {
        setError(v.motivo);
        return;
      }
      void enviar(paso.hallazgo, { confirmar: true, dato: { gravado: v.valor } });
    } else {
      void enviar(paso.hallazgo, { confirmar: true, dato: { destino } });
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${M.aceptarSugerencias} ${comprobante}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      className={cn(panelDialogo, "max-w-xl")}
    >
      <h3 className="font-titulo text-lg font-semibold text-tinta">{`${M.aceptarSugerencias} · ${comprobante}`}</h3>

      {paso.tipo === "lista" &&
        (fila.hallazgos.length === 0 ? (
          <p className="text-sm text-tinta-media">{M.sinHallazgos}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {fila.hallazgos.map((h, i) => (
              <li
                key={h.regla}
                className="flex flex-col items-start gap-2 rounded-control border border-linea p-3 text-sm text-tinta-media"
              >
                <Badge tono="aviso" className="h-auto min-h-6 whitespace-normal py-0.5">
                  {`${h.regla} · ${M.hallazgos[h.regla]}`}
                </Badge>
                <p>{h.explicacion}</p>
                <Button
                  size="sm"
                  aria-label={`${M.aceptar} ${h.regla}`}
                  autoFocus={i === 0}
                  disabled={ocupado}
                  onClick={() => aceptar(h)}
                  className="max-lg:h-11"
                >
                  {M.aceptar}
                </Button>
              </li>
            ))}
          </ul>
        ))}

      {paso.tipo === "confirmar" && (
        <ConfirmarAccion
          mensaje={`${M.confirmarSugerencia} ${paso.hallazgo.explicacion}`}
          ocupado={ocupado}
          alConfirmar={() => void enviar(paso.hallazgo, { confirmar: true })}
          alCancelar={volver}
        />
      )}

      {paso.tipo === "dato" && (
        <form
          aria-label={`${paso.hallazgo.regla} · ${paso.dato === "gravado" ? M.pedirGravado : M.pedirDestino}`}
          onSubmit={enviarDato}
          noValidate
          className="flex flex-col gap-2"
        >
          {paso.dato === "gravado" ? (
            <Label>
              {M.pedirGravado}
              <Input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                value={gravado}
                onChange={(e) => setGravado(e.target.value)}
                aria-invalid={error !== null}
                className={cn("w-40 max-w-full max-lg:h-11", cifra)}
              />
            </Label>
          ) : (
            <Label>
              {M.pedirDestino}
              <Select
                value={destino}
                onChange={(e) => setDestino(e.target.value as DestinoCompra)}
                className="w-40 max-w-full max-lg:h-11"
              >
                {DESTINOS_COMPRA.map((d) => (
                  <option key={d} value={d}>
                    {M.destinos[d]}
                  </option>
                ))}
              </Select>
            </Label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={ocupado} className="max-lg:h-11">
              {M.aceptarSugerencia}
            </Button>
            <Button variant="secundario" size="sm" disabled={ocupado} onClick={volver} className="max-lg:h-11">
              {M.cancelar}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <p role={rolDe(error)} className="text-sm font-medium text-error">
          {error}
        </p>
      )}
      {paso.tipo === "lista" && (
        <Button
          variant="secundario"
          size="sm"
          disabled={ocupado}
          onClick={alCancelar}
          className="w-fit max-lg:h-11"
        >
          {M.cerrar}
        </Button>
      )}
    </div>
  );
}
