"use client";

import {
  DESTINOS_COMPRA,
  masivaAceptarSchema,
  masivaClasificarSchema,
  masivaExcluirSchema,
  masivaRestaurarSchema,
  type DestinoCompra,
  type FilaCompraVista,
  type InformeMasiva,
} from "@contapp/shared";
import { useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import {
  MENSAJES_COMPRAS as M,
  TOPE_SELECCION,
  masivaAceptarCompras,
  masivaClasificarCompras,
  masivaExcluirCompras,
  masivaRestaurarCompras,
  type ContextoCompras,
  type ResultadoCompras,
} from "../../lib/compras";
import type { AlAvisar } from "./accion-compras";
import { InformeMasivo } from "./informe-masivo";

// Barra de acciones masivas (spec 015, D-8, RF-063, CA-7). Con filas seleccionadas ofrece clasificar, excluir (motivo
// opcional), restaurar y «Aceptar R-RED» (en masa solo se acepta R-RED, 014 D-15). Hace UNA petición con el
// `versionBase` de cada fila cargada. Las masivas son parciales: el informe muestra las aplicadas y las rechazadas con
// su motivo; se recargan las aplicadas y las `version_obsoleta` (lo demás no cambió). Sin actualización optimista.

type Modo = "barra" | "excluir";

export function BarraMasiva({
  contexto,
  filas,
  seleccion,
  alAvisar,
  alOperacion,
  alLimpiarSeleccion,
}: {
  contexto: ContextoCompras;
  /** Las filas cargadas: de ahí salen el `versionBase` de cada seleccionada y los comprobantes del informe. */
  filas: readonly FilaCompraVista[];
  seleccion: ReadonlySet<string>;
  alAvisar?: AlAvisar;
  /** Se llama si la masiva aplicó al menos una fila (T10 la cuenta para el atajo de deshacer, P-4). */
  alOperacion?: () => void;
  /** Se llama cuando no quedó ninguna rechazada. */
  alLimpiarSeleccion?: () => void;
}) {
  const [modo, setModo] = useState<Modo>("barra");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [informe, setInforme] = useState<InformeMasiva | null>(null);

  if (!contexto.permisos.clasificar) return null;
  if (seleccion.size === 0 && informe === null) return null;

  const items = filas
    .filter((f) => seleccion.has(f.id))
    .map((f) => ({ compraId: f.id, versionBase: f.version }));
  const hayRed = filas.some(
    (f) => seleccion.has(f.id) && f.hallazgos.some((h) => h.regla === "R-RED"),
  );
  const demasiadas = items.length > TOPE_SELECCION;
  const bloqueo = contexto.soloLectura;
  const deshabilitado = ocupado || bloqueo !== null || demasiadas;

  async function aplicar(
    pedir: () => Promise<ResultadoCompras<InformeMasiva>>,
  ): Promise<void> {
    if (ocupado) return;
    setError(null);
    setOcupado(true);
    try {
      const r = await pedir();
      if (!r.ok) {
        setError(r.mensaje);
        alAvisar?.(r.mensaje, "error");
        setOcupado(false);
        return;
      }
      const rechazadas = new Set(r.datos.rechazadas.map((x) => x.compraId));
      const obsoletas = r.datos.rechazadas
        .filter((x) => x.codigo === "version_obsoleta")
        .map((x) => x.compraId);
      const aplicadas = items
        .map((i) => i.compraId)
        .filter((id) => !rechazadas.has(id));
      const recargar = [...aplicadas, ...obsoletas];
      await Promise.all([
        recargar.length > 0 ? contexto.recargarFilas(recargar) : undefined,
        contexto.recargarResumen(),
      ]);
      if (r.datos.aplicadas > 0) alOperacion?.();
      setInforme(r.datos);
      setModo("barra");
      setMotivo("");
      alAvisar?.(
        `${M.aplicadas(r.datos.aplicadas)} · ${M.rechazadas(r.datos.rechazadas.length)}`,
        r.datos.aplicadas > 0 ? "ok" : "error",
      );
      if (r.datos.rechazadas.length === 0) alLimpiarSeleccion?.();
    } catch {
      setError(MENSAJES.errorGeneral);
      alAvisar?.(MENSAJES.errorGeneral, "error");
    }
    setOcupado(false);
  }

  const invalida = () => {
    setError(M.datosInvalidos);
  };

  const clasificar = (destino: DestinoCompra) => {
    const cuerpo = masivaClasificarSchema.safeParse({ items, destino });
    if (!cuerpo.success) return invalida();
    void aplicar(() =>
      masivaClasificarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  };

  const restaurar = () => {
    const cuerpo = masivaRestaurarSchema.safeParse({ items });
    if (!cuerpo.success) return invalida();
    void aplicar(() =>
      masivaRestaurarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  };

  const aceptarRed = () => {
    const cuerpo = masivaAceptarSchema.safeParse({ items, regla: "R-RED" });
    if (!cuerpo.success) return invalida();
    void aplicar(() =>
      masivaAceptarCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  };

  function excluir(evento: FormEvent<HTMLFormElement>): void {
    evento.preventDefault();
    const limpio = motivo.trim();
    const cuerpo = masivaExcluirSchema.safeParse({
      items,
      ...(limpio === "" ? {} : { motivo: limpio }),
    });
    if (!cuerpo.success) {
      setError(M.motivoMaximo);
      return;
    }
    void aplicar(() =>
      masivaExcluirCompras(contexto.clienteId, contexto.periodo, cuerpo.data),
    );
  }

  const boton = (
    texto: string,
    alPulsar: () => void,
    extra: { deshabilitado?: boolean; ayuda?: string } = {},
  ) => (
    <button
      key={texto}
      type="button"
      disabled={deshabilitado || extra.deshabilitado === true}
      title={bloqueo ?? extra.ayuda}
      onClick={alPulsar}
      className="rounded border px-3 py-1 text-sm disabled:opacity-50"
    >
      {texto}
    </button>
  );

  return (
    <>
      {seleccion.size > 0 && (
        <div
          role="toolbar"
          aria-label={M.barraMasiva}
          className="flex flex-col gap-2 rounded border bg-gray-50 p-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {M.seleccionadas(seleccion.size)}
            </span>
            {DESTINOS_COMPRA.map((d) =>
              boton(M.clasificarComo(M.destinos[d]), () => clasificar(d)),
            )}
            {boton(M.excluir, () => {
              setError(null);
              setModo("excluir");
            })}
            {boton(M.restaurar, restaurar)}
            {boton(M.aceptarRed, aceptarRed, {
              deshabilitado: !hayRed,
              ayuda: hayRed ? undefined : M.aceptarRedSinSugerencia,
            })}
            {alLimpiarSeleccion && (
              <button
                type="button"
                disabled={ocupado}
                onClick={alLimpiarSeleccion}
                className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              >
                {M.limpiarSeleccion}
              </button>
            )}
          </div>
          {modo === "excluir" && (
            <form
              aria-label={`${M.excluir} · ${M.seleccionadas(seleccion.size)}`}
              onSubmit={excluir}
              noValidate
              className="flex flex-wrap items-end gap-2"
            >
              <label className="flex flex-col gap-1 text-sm">
                {M.motivoExclusion}
                <input
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  className="w-72 rounded border px-3 py-1"
                />
              </label>
              <button
                type="submit"
                disabled={deshabilitado}
                className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
              >
                {M.excluir}
              </button>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => setModo("barra")}
                className="rounded border px-3 py-1 text-sm"
              >
                {M.cancelar}
              </button>
            </form>
          )}
          {demasiadas && (
            <p className="text-sm text-amber-700">
              {M.seleccionarDemasiadas(TOPE_SELECCION)}
            </p>
          )}
          {bloqueo !== null && <p className="text-sm">{bloqueo}</p>}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      )}
      {informe && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <InformeMasivo
            informe={informe}
            filas={filas}
            alCerrar={() => setInforme(null)}
          />
        </div>
      )}
    </>
  );
}
