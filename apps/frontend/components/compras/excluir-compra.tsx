"use client";

import { excluirCompraSchema, type FilaCompraVista } from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import { cn } from "../../lib/utils";
import { Button, Input, Label, panelDialogo } from "../ui";
import {
  MENSAJES_COMPRAS as M,
  excluirCompra,
  type ContextoCompras,
} from "../../lib/compras";
import {
  comprobanteDe,
  recargarTrasError,
  recargarTrasExito,
  type AlAvisar,
} from "./accion-compras";
import { useErrorAnunciado } from "./aviso-unico";
import { AprenderPalabras } from "../gastos/aprender-palabras";

// Excluir una compra (spec 015, D-10, HU-17): motivo opcional de hasta 200 caracteres en una línea. Excluir una
// agregada a mano equivale a descartarla (014 DU-16): se avisa antes de enviar. Espera la respuesta del servidor
// (no hay actualización optimista) y recarga la fila y el resumen. El motivo es texto del usuario: nunca HTML.
// Spec 027 (R-7): con `reglas.gestionar`, tras excluir bien se ofrece «Aprender estas palabras» (la propuesta sale del XML de la
// compra); `alTerminar` se llama al cerrar ese diálogo, o de inmediato si no hay nada que ofrecer o no hay permiso.

export function ExcluirCompra({
  contexto,
  fila,
  alTerminar,
  alCancelar,
  alAvisar,
}: {
  contexto: ContextoCompras;
  fila: FilaCompraVista;
  /** Tras excluir bien, para que quien lo abrió lo cierre. */
  alTerminar: () => void;
  alCancelar: () => void;
  alAvisar?: AlAvisar;
}) {
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { avisarError, rolDe } = useErrorAnunciado(alAvisar);
  const [ocupado, setOcupado] = useState(false);
  const [aprender, setAprender] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const comprobante = comprobanteDe(fila);

  useEffect(() => {
    campo.current?.focus();
  }, []);

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado) return;
    const limpio = motivo.trim();
    const analisis = excluirCompraSchema.safeParse({
      versionBase: fila.version,
      ...(limpio === "" ? {} : { motivo: limpio }),
    });
    if (!analisis.success) {
      setError(M.motivoMaximo);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await excluirCompra(
        contexto.clienteId,
        contexto.periodo,
        fila.id,
        analisis.data,
      );
      if (r.ok) {
        await recargarTrasExito(contexto, fila.id);
        alAvisar?.(M.compraExcluida, "ok");
        if (contexto.permisos.gestionarReglas === true) setAprender(true);
        else alTerminar();
        return;
      }
      await recargarTrasError(contexto, fila.id, r);
      setError(r.mensaje);
      avisarError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
      avisarError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  if (aprender) return <AprenderPalabras contexto={contexto} fila={fila} alCerrar={alTerminar} />;

  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-label={`${M.excluir} ${comprobante}`}
      onSubmit={(e) => void enviar(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      noValidate
      className={cn(panelDialogo, "max-w-md")}
    >
      <h3 className="font-titulo text-lg font-semibold text-tinta">{`${M.excluir} ${comprobante}`}</h3>
      {fila.origen === "agregada" && (
        <p className="rounded-control border border-aviso-borde bg-aviso-fondo p-3 text-sm text-aviso">
          {M.confirmarExcluirAgregada}
        </p>
      )}
      <Label>
        {M.motivoExclusion}
        <Input
          ref={campo}
          type="text"
          autoComplete="off"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          aria-invalid={error !== null && motivo.trim().length > 200}
          className="max-lg:h-11"
        />
      </Label>
      {error && (
        <p role={rolDe(error)} className="text-sm font-medium text-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="peligro" disabled={ocupado} className="max-lg:h-11">
          {M.excluir}
        </Button>
        <Button variant="secundario" onClick={alCancelar} disabled={ocupado} className="max-lg:h-11">
          {M.cancelar}
        </Button>
      </div>
    </form>
  );
}
