"use client";

import {
  DESTINOS_COMPRA,
  destinoDesdeXmlSchema,
  type DestinoCompra,
  type FilaCompraVista,
  type VistaPreviaDesdeXml,
} from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import { MENSAJES_COMPRAS as M, type ContextoCompras } from "../../lib/compras";
import {
  MENSAJES_LUPA as L,
  agregarDesdeXml,
  etiquetaTipo,
  mensajeDeErrorXml,
} from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";
import type { AlAvisar } from "./accion-compras";
import { ItemsXml } from "./items-xml";

// «Agregar desde XML» (spec 016, T16; HU-18, CA-13, D-8, P-9). Con la vista previa ya leída por el servidor
// (`vistaPreviaDesdeXmlSchema`) se muestran los campos prellenados (solo lectura: salen del XML) y se pide SOLO el
// destino de la base imponible y el IGV; en USD, además el tipo de cambio (el XML no lo trae). El envío manda el
// mismo archivo como cuerpo crudo con el destino en la query; el servidor lo vuelve a leer y valida. Nada se calcula
// aquí: los montos se muestran con formato. 409 `duplicado` (o `existente` en la vista previa) ofrece ubicar la compra.

const COLUMNAS = [
  ["biDg", L.desdeXml.base],
  ["igvDg", "IGV"],
  ["noGravado", M.casilleros.noGravado],
  ["isc", M.casilleros.isc],
  ["icbper", M.casilleros.icbper],
  ["otrosTributos", M.casilleros.otrosTributos],
] as const;

export function AgregarDesdeXml({
  contexto,
  archivo,
  vista,
  alAgregar,
  alQuitar,
  alCancelar,
  alUbicarExistente,
  alAvisar,
}: {
  contexto: ContextoCompras;
  archivo: File;
  vista: VistaPreviaDesdeXml;
  alAgregar: (fila: FilaCompraVista) => void;
  /** Descarta el XML y vuelve al formulario manual. */
  alQuitar: () => void;
  alCancelar: () => void;
  alUbicarExistente: (compraId: string) => void;
  alAvisar?: AlAvisar;
}) {
  const [destino, setDestino] = useState<DestinoCompra | "">("");
  const [tipoCambio, setTipoCambio] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicada, setDuplicada] = useState<string | null>(vista.existente?.id ?? null);
  const [ocupado, setOcupado] = useState(false);
  const primero = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    primero.current?.focus();
  }, []);

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault();
    if (ocupado || duplicada !== null) return;
    if (destino === "") {
      setError(L.desdeXml.destinoObligatorio);
      return;
    }
    const cambio = tipoCambio.trim();
    if (vista.requiereTipoCambio && cambio === "") {
      setError(M.tipoCambioObligatorio);
      return;
    }
    const analisis = destinoDesdeXmlSchema.safeParse({
      destino,
      ...(vista.requiereTipoCambio ? { tipoCambio: cambio } : {}),
    });
    if (!analisis.success || (vista.requiereTipoCambio && !/[1-9]/.test(cambio))) {
      setError(L.desdeXml.tipoCambioInvalido);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await agregarDesdeXml(
        contexto.clienteId,
        contexto.periodo,
        archivo,
        analisis.data.destino,
        analisis.data.tipoCambio,
      );
      if (r.ok) {
        await Promise.all([contexto.recargarFila(r.datos.id), contexto.recargarResumen()]);
        alAvisar?.(L.desdeXml.agregada, "ok");
        alAgregar(r.datos);
        return;
      }
      if (r.codigo === "duplicado" && r.id !== undefined) {
        setDuplicada(r.id);
        setError(M.yaExisteEnPropuesta);
      } else {
        setError(mensajeDeErrorXml(r, "cliente"));
      }
      alAvisar?.(r.codigo === "duplicado" ? M.yaExisteEnPropuesta : mensajeDeErrorXml(r, "cliente"), "error");
    } catch {
      setError(MENSAJES.errorGeneral);
      alAvisar?.(MENSAJES.errorGeneral, "error");
    }
    setOcupado(false);
  }

  const dato = (nombre: string, valor: string) => (
    <div className="flex flex-col">
      <dt className="text-xs text-gray-700">{nombre}</dt>
      <dd className="text-sm break-words">{valor}</dd>
    </div>
  );

  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-label={L.desdeXml.titulo}
      onSubmit={(e) => void enviar(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !ocupado) alCancelar();
      }}
      noValidate
      className="flex max-h-[90vh] w-[56rem] max-w-full flex-col gap-3 overflow-auto rounded border bg-white p-4 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">{L.desdeXml.titulo}</h3>
        <button
          type="button"
          onClick={alQuitar}
          disabled={ocupado}
          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          {L.desdeXml.volver}
        </button>
      </div>

      <section aria-label={L.desdeXml.resumen} className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{L.desdeXml.resumen}</h4>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {dato(M.campos.tipo, etiquetaTipo(vista.tipo))}
          {dato(L.secciones.cabecera, `${vista.serie}-${vista.numero}`)}
          {dato(M.campos.fecha, vista.fecha)}
          {dato(M.campos.moneda, vista.moneda)}
          {dato(L.desdeXml.proveedor, `${vista.proveedor.numero} · ${vista.proveedor.razonSocial}`)}
        </dl>
        <table aria-label={L.desdeXml.montos} className="w-full text-sm">
          <thead>
            <tr className="text-left">
              {COLUMNAS.map(([clave, nombre]) => (
                <th key={clave} scope="col" className="py-1 pr-2 text-right">
                  {nombre}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              {COLUMNAS.map(([clave]) => (
                <td key={clave} className="py-1 pr-2 text-right tabular-nums">
                  {conMiles(vista.montos[clave] ?? "0.00")}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>

      <ItemsXml items={vista.items} hayXml />

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {L.desdeXml.destino}
          <select
            ref={primero}
            value={destino}
            onChange={(e) => {
              setDestino(e.target.value as DestinoCompra | "");
              setError(null);
            }}
            className="rounded border px-3 py-2"
          >
            <option value="">{L.desdeXml.elegirDestino}</option>
            {DESTINOS_COMPRA.map((d) => (
              <option key={d} value={d}>
                {M.destinos[d]}
              </option>
            ))}
          </select>
        </label>
        {vista.requiereTipoCambio && (
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex flex-col gap-1">
              {L.desdeXml.tipoCambio}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={tipoCambio}
                onChange={(e) => {
                  setTipoCambio(e.target.value);
                  setError(null);
                }}
                aria-describedby="desde-xml-tipo-cambio"
                className="w-32 rounded border px-3 py-2"
              />
            </label>
            <span id="desde-xml-tipo-cambio" className="text-xs text-gray-700">
              {L.desdeXml.tipoCambioAyuda}
            </span>
          </div>
        )}
      </div>
      <p className="text-xs text-gray-700">{M.destinoAyuda}</p>

      {duplicada !== null && (
        <p role="note" className="text-sm">
          {L.desdeXml.yaExiste}{" "}
          <button type="button" onClick={() => alUbicarExistente(duplicada)} className="underline">
            {M.ubicarExistente}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={ocupado || duplicada !== null}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {ocupado ? L.desdeXml.agregando : L.desdeXml.agregar}
        </button>
        <button
          type="button"
          onClick={alCancelar}
          disabled={ocupado}
          className="rounded border px-4 py-2 text-sm"
        >
          {M.cancelar}
        </button>
      </div>
    </form>
  );
}
