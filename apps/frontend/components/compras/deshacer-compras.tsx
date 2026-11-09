"use client";

import type { FilaCompraVista } from "@contapp/shared";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  deshacerCompras,
  rehacerCompras,
  type ContextoCompras,
} from "../../lib/compras";
import { ConfirmarAccion } from "../ventas/confirmar-accion";
import type { AlAvisar } from "./accion-compras";
import { comprobanteDeId } from "./informe-masivo";

// Deshacer y rehacer (spec 015, D-9, P-4, RF-065, CA-8). El servidor deshace la ÚLTIMA operación del periodo; esta
// pantalla recuerda en memoria cuántas operaciones hizo ella (`pila`) y cuántas deshizo (`rehechas`):
//  - Los botones «Deshacer» y «Rehacer» siempre están. Sin operación propia piden confirmar (texto de P-4).
//  - El atajo Ctrl+Z / Ctrl+Y vale solo con operación propia; si no, no llama al servidor.
//  - Al responder se recargan solo las filas de `filas` y se resaltan (`alResaltar`).
//  - 409 `fila_cambiada` lista los comprobantes que otra persona cambió, con «Ver filas»; no se reintenta.
//  - 409 `nada_que_deshacer` / `nada_que_rehacer` es un aviso, no un error.
// La pantalla (T10) llama a `useDeshacerCompras`, pasa el control a `<DeshacerCompras>` y llama a
// `control.registrarOperacion()` tras cada escritura hecha aquí (editar, clasificar, excluir, masiva…).

export interface Operaciones {
  /** Operaciones de esta pantalla que aún se pueden deshacer. */
  pila: number;
  /** Operaciones de esta pantalla que se deshicieron y se pueden rehacer. */
  rehechas: number;
}

interface Aviso {
  texto: string;
  tipo: "info" | "error";
}

interface Conflicto {
  ids: string[];
  comprobantes: string[];
}

export interface ControlDeshacer {
  operaciones: Operaciones;
  ocupado: boolean;
  /** Confirmación pendiente por no haber operación propia (P-4). */
  confirmar: "deshacer" | "rehacer" | null;
  conflicto: Conflicto | null;
  aviso: Aviso | null;
  /** Anota una operación hecha en esta pantalla; invalida lo que había por rehacer. */
  registrarOperacion: () => void;
  /** Botón: con operación propia deshace; si no, pide confirmar. */
  deshacer: () => void;
  rehacer: () => void;
  /** Tras la confirmación del diálogo. */
  confirmarPendiente: () => void;
  cancelarConfirmacion: () => void;
  verFilas: () => void;
  cerrarConflicto: () => void;
  /**
   * Atajo: Ctrl+Z deshace, Ctrl+Y o Ctrl+Mayús+Z rehace, solo con operación propia y nunca dentro de un campo
   * de texto (allí es del campo). Devuelve `true` si lo atendió.
   */
  alTeclear: (e: KeyboardEvent<HTMLElement>) => boolean;
}

const ES_CAMPO = "INPUT,TEXTAREA,SELECT,[contenteditable='true'],[contenteditable='']";

export function useDeshacerCompras({
  contexto,
  filas,
  alResaltar,
  alAvisar,
}: {
  contexto: ContextoCompras;
  /** Las filas cargadas: de ahí salen los comprobantes del conflicto. */
  filas: readonly FilaCompraVista[];
  alResaltar: (ids: string[]) => void;
  alAvisar?: AlAvisar;
}): ControlDeshacer {
  const [operaciones, setOperaciones] = useState<Operaciones>({
    pila: 0,
    rehechas: 0,
  });
  const actual = useRef(operaciones);
  const filasActuales = useRef(filas);
  filasActuales.current = filas;
  const enCurso = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  const [confirmar, setConfirmar] = useState<"deshacer" | "rehacer" | null>(null);
  const [conflicto, setConflicto] = useState<Conflicto | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);

  const poner = useCallback((o: Operaciones) => {
    actual.current = o;
    setOperaciones(o);
  }, []);

  const avisar = useCallback(
    (texto: string, tipo: "info" | "error") => {
      setAviso({ texto, tipo });
      alAvisar?.(texto, tipo);
    },
    [alAvisar],
  );

  const ejecutar = useCallback(
    async (cual: "deshacer" | "rehacer"): Promise<void> => {
      if (enCurso.current) return;
      enCurso.current = true;
      setOcupado(true);
      setConfirmar(null);
      setConflicto(null);
      setAviso(null);
      try {
        const r = await (cual === "deshacer" ? deshacerCompras : rehacerCompras)(
          contexto.clienteId,
          contexto.periodo,
        );
        if (r.ok) {
          const ids = r.datos.filas;
          await Promise.all([
            ids.length > 0 ? contexto.recargarFilas(ids) : undefined,
            contexto.recargarResumen(),
          ]);
          alResaltar(ids);
          const o = actual.current;
          poner(
            cual === "deshacer"
              ? { pila: Math.max(0, o.pila - 1), rehechas: o.rehechas + 1 }
              : { pila: o.pila + 1, rehechas: Math.max(0, o.rehechas - 1) },
          );
          avisar(
            cual === "deshacer" ? M.deshecho(ids.length) : M.rehecho(ids.length),
            "info",
          );
        } else if (r.codigo === "fila_cambiada") {
          const ids = r.ids ?? [];
          setConflicto({
            ids,
            comprobantes: ids.map((id) =>
              comprobanteDeId(filasActuales.current, id),
            ),
          });
          alAvisar?.(M.filaCambiada, "error");
        } else if (
          r.codigo === "nada_que_deshacer" ||
          r.codigo === "nada_que_rehacer"
        ) {
          // No hay nada más que revertir: lo que esta pantalla creía tener ya no existe.
          const o = actual.current;
          poner(
            cual === "deshacer" ? { ...o, pila: 0 } : { ...o, rehechas: 0 },
          );
          avisar(
            cual === "deshacer" ? M.nadaQueDeshacer : M.nadaQueRehacer,
            "info",
          );
        } else {
          avisar(r.mensaje, "error");
        }
      } catch {
        avisar(MENSAJES.errorGeneral, "error");
      }
      enCurso.current = false;
      setOcupado(false);
    },
    [alAvisar, alResaltar, avisar, contexto, poner],
  );

  const pedir = (cual: "deshacer" | "rehacer"): void => {
    if (enCurso.current) return;
    const propias =
      cual === "deshacer" ? actual.current.pila : actual.current.rehechas;
    if (propias > 0) void ejecutar(cual);
    else setConfirmar(cual);
  };

  return {
    operaciones,
    ocupado,
    confirmar,
    conflicto,
    aviso,
    registrarOperacion: () => poner({ pila: actual.current.pila + 1, rehechas: 0 }),
    deshacer: () => pedir("deshacer"),
    rehacer: () => pedir("rehacer"),
    confirmarPendiente: () => {
      if (confirmar !== null) void ejecutar(confirmar);
    },
    cancelarConfirmacion: () => setConfirmar(null),
    verFilas: () => {
      if (conflicto) alResaltar(conflicto.ids);
      setConflicto(null);
    },
    cerrarConflicto: () => setConflicto(null),
    alTeclear: (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
      const tecla = e.key.toLowerCase();
      const cual =
        tecla === "z" && !e.shiftKey
          ? "deshacer"
          : tecla === "y" || (tecla === "z" && e.shiftKey)
            ? "rehacer"
            : null;
      if (cual === null) return false;
      // Dentro de un campo de texto Ctrl+Z es del campo (plan, riesgos).
      if (e.target instanceof Element && e.target.closest(ES_CAMPO)) return false;
      const propias =
        cual === "deshacer" ? actual.current.pila : actual.current.rehechas;
      if (propias === 0) return false;
      e.preventDefault();
      void ejecutar(cual);
      return true;
    },
  };
}

export function DeshacerCompras({ control }: { control: ControlDeshacer }) {
  const { conflicto, aviso, confirmar, ocupado } = control;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2" role="group" aria-label={`${M.deshacer} / ${M.rehacer}`}>
        <button
          type="button"
          disabled={ocupado}
          onClick={control.deshacer}
          title="Ctrl+Z"
          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          {M.deshacer}
        </button>
        <button
          type="button"
          disabled={ocupado}
          onClick={control.rehacer}
          title="Ctrl+Y"
          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          {M.rehacer}
        </button>
      </div>

      {confirmar !== null && (
        <ConfirmarAccion
          mensaje={
            confirmar === "deshacer"
              ? M.confirmarDeshacerAjeno
              : M.confirmarRehacerAjeno
          }
          ocupado={ocupado}
          alConfirmar={control.confirmarPendiente}
          alCancelar={control.cancelarConfirmacion}
        />
      )}

      {conflicto && (
        <div
          role="alert"
          className="flex max-w-xl flex-col gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm"
        >
          <p className="font-medium">{M.filaCambiada}</p>
          <ul className="list-disc pl-5">
            {conflicto.comprobantes.map((c, i) => (
              <li key={`${c}-${conflicto.ids[i]}`}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={control.verFilas}
              className="rounded border px-3 py-1"
            >
              {M.verFilas}
            </button>
            <button
              type="button"
              onClick={control.cerrarConflicto}
              className="rounded border px-3 py-1"
            >
              {M.cerrar}
            </button>
          </div>
        </div>
      )}

      {aviso &&
        (aviso.tipo === "error" ? (
          <p role="alert" className="text-sm text-red-600">
            {aviso.texto}
          </p>
        ) : (
          <p role="status" className="text-sm">
            {aviso.texto}
          </p>
        ))}
    </div>
  );
}
