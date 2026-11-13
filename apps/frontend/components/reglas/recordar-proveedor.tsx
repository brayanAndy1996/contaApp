"use client";

import {
  recordarReglaSchema,
  type DestinoCompra,
  type ReglaVista,
} from "@contapp/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_REGLAS as M,
  ofreceRecordar,
  recordarRegla,
  reglaDelProveedor,
} from "../../lib/reglas";
import { useErrorAnunciado } from "../compras/aviso-unico";
import type { AlAvisar } from "../compras/accion-compras";

// Aviso «Recordar para este proveedor en este cliente» (spec 021, CA-1, P-2, P-3). No es modal: se anuncia con
// `role="status"` y `aria-live="polite"`, NO toma el foco y se acepta con el botón o con Alt+R (la grilla ignora Alt,
// así que no choca con `foco-grilla.ts`). Se oculta solo a los 10 s. No se ofrece sin `reglas.gestionar` ni si ya hay
// una regla activa del proveedor con ese destino. El servidor decide: aquí solo se arma la petición con la
// `versionBase` de la regla viva del proveedor (o `null` si no hay).

export const SEGUNDOS_AVISO_RECORDAR = 10;

export interface PropsRecordarProveedor {
  clienteId: string;
  /** Las compras recién clasificadas: de un solo proveedor y un solo periodo. */
  compraIds: readonly string[];
  proveedor: { tipo: string; numero: string; razonSocial?: string | null };
  destino: DestinoCompra;
  /** Las reglas del cliente, ya leídas por la pantalla. */
  reglas: readonly ReglaVista[];
  puedeGestionar: boolean;
  /** `recordada` tras guardar; `expirada` a los 10 s. En ambos casos quien lo muestra lo quita. */
  alTerminar: (motivo: "recordada" | "expirada") => void;
  /** Con él, el resultado se entrega a la pantalla (un solo anunciador); sin él, el error se pinta aquí. */
  alAvisar?: AlAvisar;
}

export function RecordarProveedor({
  clienteId,
  compraIds,
  proveedor,
  destino,
  reglas,
  puedeGestionar,
  alTerminar,
  alAvisar,
}: PropsRecordarProveedor) {
  const ofrecido = ofreceRecordar(reglas, proveedor, destino, puedeGestionar);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState(false);
  const { avisarError, rolDe } = useErrorAnunciado(alAvisar);

  // Referencias para que el temporizador y el atajo vean siempre los valores vigentes sin reiniciarse.
  const enCurso = useRef(false);
  const alTerminarRef = useRef(alTerminar);
  alTerminarRef.current = alTerminar;

  const versionBase = reglaDelProveedor(reglas, proveedor)?.version ?? null;

  const aceptar = useCallback(async (): Promise<void> => {
    if (enCurso.current) return;
    const analisis = recordarReglaSchema.safeParse({
      compraIds: [...compraIds],
      destino,
      versionBase,
    });
    if (!analisis.success) {
      setError(M.datosInvalidos);
      return;
    }
    enCurso.current = true;
    setOcupado(true);
    setError(null);
    try {
      const r = await recordarRegla(clienteId, analisis.data);
      if (r.ok) {
        if (alAvisar) alAvisar(M.recordada, "ok");
        else setHecho(true);
        alTerminarRef.current("recordada");
        return;
      }
      if (r.status === 401) return;
      setError(r.mensaje);
      avisarError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
      avisarError(MENSAJES.errorGeneral);
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }, [alAvisar, avisarError, clienteId, compraIds, destino, versionBase]);

  // Se oculta a los 10 s; mientras se guarda no corre, y tras un error vuelve a contar para que se alcance a leer.
  useEffect(() => {
    if (!ofrecido || ocupado || hecho) return;
    const id = setTimeout(
      () => alTerminarRef.current("expirada"),
      SEGUNDOS_AVISO_RECORDAR * 1000,
    );
    return () => clearTimeout(id);
  }, [ofrecido, ocupado, hecho, error]);

  // Alt+R acepta sin mover el foco. Se compara también `code` porque en macOS Alt+R produce «®».
  useEffect(() => {
    if (!ofrecido || hecho) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "r" && e.code !== "KeyR") return;
      e.preventDefault();
      void aceptar();
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [ofrecido, hecho, aceptar]);

  if (!ofrecido) return null;

  const nombre = proveedor.razonSocial ?? proveedor.numero;

  return (
    <div className="flex max-w-xl flex-col gap-1">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-2 rounded border bg-neutral-50 p-2 text-sm text-neutral-900"
      >
        {hecho ? (
          <span>{M.recordada}</span>
        ) : (
          <>
            <span>{M.pregunta}</span>
            <span>{`${nombre} · ${destino}`}</span>{" "}
            <button
              type="button"
              disabled={ocupado}
              aria-keyshortcuts={M.atajo}
              onClick={() => void aceptar()}
              className="rounded bg-black px-3 py-1 text-white disabled:opacity-50"
            >
              {M.recordar}
            </button>
          </>
        )}
      </div>
      {error !== null && (
        <p role={rolDe(error)} className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
