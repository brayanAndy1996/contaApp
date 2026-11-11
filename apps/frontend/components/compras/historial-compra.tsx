"use client";

import type { DetalleCompra, MontosCompra } from "@contapp/shared";
import { useEffect, useState } from "react";
import {
  MENSAJES_COMPRAS as M,
  obtenerDetalleCompra,
  type ContextoCompras,
} from "../../lib/compras";
import { etiquetaAutor } from "../../lib/autor";
import { conMiles, iguales } from "../../lib/montos-compras";
import { comprobanteDe } from "./accion-compras";

// Panel lateral «Historial» de una compra (spec 015, P-6, D-2). Solo lectura, desde `GET …/:compraId`: el valor
// original del SIRE frente al vigente, las versiones (autor, fecha y acción) y los hallazgos. Todo es texto: la
// razón social, el motivo y las explicaciones del SIRE los escapa React. Los montos son cadenas del servidor y
// solo se les da formato de miles; la comparación original/vigente usa `iguales`.

const COLUMNAS_MOSTRADAS = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
  "total",
] as const satisfies readonly (keyof MontosCompra)[];

/** «2026-10-20T15:00:00.000Z» → «2026-10-20 15:00 UTC» (texto, sin objetos de fecha). */
const fechaLegible = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function HistorialCompra({
  contexto,
  compraId,
  alCerrar,
}: {
  contexto: ContextoCompras;
  compraId: string;
  alCerrar: () => void;
}) {
  const [detalle, setDetalle] = useState<DetalleCompra | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { clienteId, periodo } = contexto;

  useEffect(() => {
    // Si cambia la compra o se cierra el panel, la respuesta que llegue tarde se descarta.
    let vigente = true;
    setDetalle(null);
    setError(null);
    void obtenerDetalleCompra(clienteId, periodo, compraId).then((r) => {
      if (!vigente) return;
      if (r.ok) setDetalle(r.datos);
      else setError(r.mensaje);
    });
    return () => {
      vigente = false;
    };
  }, [clienteId, periodo, compraId]);

  return (
    <aside
      aria-label={M.tituloHistorial}
      className="flex max-h-screen w-[28rem] max-w-full flex-col gap-3 overflow-auto border-l bg-white p-4 shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-medium">{M.tituloHistorial}</h3>
        <button
          type="button"
          onClick={alCerrar}
          className="rounded border px-3 py-1 text-sm"
        >
          {M.cerrar}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {!error && detalle === null && (
        <p role="status" className="text-sm">
          {M.cargando}
        </p>
      )}

      {detalle && (
        <>
          <section className="flex flex-col gap-1 text-sm">
            <p className="font-medium">{comprobanteDe(detalle.vigente)}</p>
            <p>{detalle.vigente.proveedor.numero}</p>
            <p>{detalle.vigente.proveedor.razonSocial ?? ""}</p>
            {detalle.vigente.motivo && <p>{detalle.vigente.motivo}</p>}
          </section>

          <table
            aria-label={`${M.valorOriginal} / ${M.valorVigente}`}
            className="w-full text-sm"
          >
            <thead>
              <tr className="text-right">
                <th scope="col" className="py-1 text-left" />
                <th scope="col" className="py-1">
                  {M.valorOriginal}
                </th>
                <th scope="col" className="py-1">
                  {M.valorVigente}
                </th>
              </tr>
            </thead>
            <tbody>
              {COLUMNAS_MOSTRADAS.map((c) => {
                const original = detalle.original.montos[c];
                const vigente = detalle.vigente.montos[c];
                const cambio = !iguales(original, vigente);
                return (
                  <tr key={c} className="border-t text-right">
                    <th scope="row" className="py-1 text-left font-normal">
                      {M.casilleros[c]}
                    </th>
                    <td className="py-1">{conMiles(original)}</td>
                    <td className={`py-1 ${cambio ? "font-medium" : ""}`}>
                      {conMiles(vigente)}
                      {cambio && <span className="ml-1 text-xs">(cambió)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <section aria-label={M.versiones} className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">{M.versiones}</h4>
            <ol className="flex flex-col gap-1 text-sm">
              {detalle.versiones.map((ver) => (
                <li key={ver.n} className="rounded border p-2">
                  <p>
                    {M.versionPor(
                      ver.n,
                      ver.usuarioId ? etiquetaAutor(ver.autor) : M.autorSire,
                      fechaLegible(ver.creadaEn),
                    )}
                  </p>
                  <p>
                    {M.accionesVersion[ver.accion]} · {M.casilleros.total}{" "}
                    {conMiles(ver.montos.total)}
                    {ver.excluida ? ` · ${M.excluida}` : ""}
                  </p>
                  {ver.motivo && <p>{ver.motivo}</p>}
                </li>
              ))}
            </ol>
          </section>

          <section aria-label={M.tituloHallazgos} className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">{M.tituloHallazgos}</h4>
            {detalle.hallazgos.length === 0 ? (
              <p className="text-sm">{M.sinHallazgos}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {detalle.hallazgos.map((h) => (
                  <li key={h.regla} className="rounded border p-2">
                    <span className="mr-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium">
                      {`${h.regla} · ${M.hallazgos[h.regla]}`}
                    </span>
                    {h.explicacion}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
