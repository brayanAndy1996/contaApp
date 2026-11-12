"use client";

import type { ExcluidaPrevioDto, PrevioArchivoDto } from "@contapp/shared";
import { MENSAJES_ARCHIVO as M, nombreCodigoPrevio, type LibroArchivo } from "../../lib/archivos";
import { conMiles } from "../../lib/montos-compras";

// Previo del archivo (spec 012b, T14; D1, D5; CA-1, CA-9): errores con enlace que ubica la fila en la grilla,
// avisos, resumen de cambios e impacto en el IGV, y la marca «Provisional». Solo muestra lo que calculó el
// servidor: los montos son cadenas y se formatean con `conMiles`, nunca se calculan aquí. Toda cadena del SIRE
// (explicaciones, campos) se pinta como texto, que React escapa.

const DESTINOS = ["DG", "DGNG", "DNG"] as const;

export function PrevioArchivo({
  previo,
  libro = "compras",
  alUbicarFila,
  alExcluir,
  alRestaurar,
  bloqueo = null,
}: {
  previo: PrevioArchivoDto;
  libro?: LibroArchivo;
  /** Ubica y resalta la fila en la grilla; sin esta función los errores no llevan enlace. */
  alUbicarFila?: (filaId: string) => void;
  /** Ventas (T15, D12): abre «Excluir» para un error `excluible`; sin esta función no hay botón (sin `sire.clasificar`). */
  alExcluir?: (filaId: string) => void;
  /** Ventas (T15, D12): pide restaurar una venta excluida; sin esta función no hay botón. */
  alRestaurar?: (excluida: ExcluidaPrevioDto) => void;
  /** Motivo por el que las escrituras de ventas están bloqueadas (periodo `generado` o `revisado` sin permiso). */
  bloqueo?: string | null;
}) {
  const { resumen } = previo;
  const impacto = resumen.impactoIgv;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-sm">
        <p>{M.formato(previo.formato.id, previo.formato.version)}</p>
        {!previo.formato.oficial && (
          <p role="note" className="rounded bg-amber-50 p-2 font-medium text-amber-900">
            {M.provisional}
            <span className="block font-normal">{M.provisionalAyuda}</span>
          </p>
        )}
        <p role="status" data-generable={previo.generable}>
          {previo.generable
            ? M.generable
            : `${M.noGenerable}${previo.motivo ? ` ${M.motivos[previo.motivo]}` : ""}`}
        </p>
      </div>

      <section aria-label={M.tituloErrores} className="flex flex-col gap-2">
        <h4 className="font-medium">{M.tituloErrores}</h4>
        {libro === "ventas" && previo.errores.length > 0 && (
          <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
            {M.erroresVentasAyuda}
          </p>
        )}
        {bloqueo !== null && (alExcluir || alRestaurar) && (
          <p role="note" className="text-sm">
            {bloqueo}
          </p>
        )}
        {previo.errores.length === 0 ? (
          <p className="text-sm">{M.sinErrores}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {previo.errores.map((e, i) => (
              <li key={`${e.filaId ?? "periodo"}|${e.codigo}|${i}`} className="rounded border p-2">
                <p>
                  {e.comprobante != null && <strong>{e.comprobante} · </strong>}
                  <strong>{nombreCodigoPrevio(e.codigo)}</strong>
                  {e.campo ? ` · ${e.campo}` : ""}
                  {e.destino ? ` · ${e.destino}` : ""}
                </p>
                <p>{e.explicacion}</p>
                {e.diferencia !== null && <p>{M.diferencia(conMiles(e.diferencia))}</p>}
                <div className="flex flex-wrap gap-3">
                  {e.filaId !== null && alUbicarFila && (
                    <button
                      type="button"
                      aria-label={e.comprobante == null ? undefined : M.ubicarComprobante(e.comprobante)}
                      onClick={() => alUbicarFila(e.filaId!)}
                      className="underline"
                    >
                      {M.ubicarFila}
                    </button>
                  )}
                  {libro === "ventas" && e.excluible && e.filaId !== null && alExcluir && (
                    <button
                      type="button"
                      aria-label={e.comprobante == null ? undefined : M.excluirComprobante(e.comprobante)}
                      disabled={bloqueo !== null}
                      title={bloqueo ?? undefined}
                      onClick={() => alExcluir(e.filaId!)}
                      className="rounded border px-3 py-1 disabled:opacity-50"
                    >
                      {M.excluir}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {previo.erroresOmitidos > 0 && (
          <p className="text-sm">{M.erroresOmitidos(previo.erroresOmitidos)}</p>
        )}
      </section>

      {previo.avisos.length > 0 && (
        <section aria-label={M.tituloAvisos} className="flex flex-col gap-2">
          <h4 className="font-medium">{M.tituloAvisos}</h4>
          <ul className="flex flex-col gap-1 text-sm">
            {previo.avisos.map((a, i) => (
              <li key={`${a.filaId ?? "periodo"}|${a.codigo}|${i}`}>
                {a.comprobante != null && <strong>{a.comprobante} · </strong>}
                <strong>{nombreCodigoPrevio(a.codigo)}</strong> · {a.explicacion}
                {a.filaId !== null && alUbicarFila && (
                  <>
                    {" "}
                    <button
                      type="button"
                      aria-label={a.comprobante == null ? undefined : M.ubicarComprobante(a.comprobante)}
                      onClick={() => alUbicarFila(a.filaId!)}
                      className="underline"
                    >
                      {M.ubicarFila}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs">{M.avisosOmitidos}</p>
        </section>
      )}

      {libro === "ventas" && (previo.excluidas.length > 0 || previo.excluidasOmitidas > 0) && (
        <section aria-label={M.tituloExcluidas} className="flex flex-col gap-2">
          <h4 className="font-medium">{M.tituloExcluidas}</h4>
          <p className="text-xs">{M.excluidasAyuda}</p>
          <ul className="flex flex-col gap-2 text-sm">
            {previo.excluidas.map((x) => (
              <li key={x.filaId} className="flex flex-col gap-1 rounded border p-2">
                <strong>{x.comprobante}</strong>
                <span>{M.excluidaMotivo(x.motivo)}</span>
                <span className="flex flex-wrap gap-3">
                  {alUbicarFila && (
                    <button
                      type="button"
                      onClick={() => alUbicarFila(x.filaId)}
                      className="underline"
                    >
                      {M.ubicarFila}
                    </button>
                  )}
                  {alRestaurar && (
                    <button
                      type="button"
                      aria-label={M.restaurarVenta(x.comprobante)}
                      disabled={bloqueo !== null}
                      title={bloqueo ?? undefined}
                      onClick={() => alRestaurar(x)}
                      className="rounded border px-3 py-1 disabled:opacity-50"
                    >
                      {M.restaurar}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {previo.excluidasOmitidas > 0 && (
            <p className="text-sm">{M.excluidasOmitidas(previo.excluidasOmitidas)}</p>
          )}
        </section>
      )}

      <section aria-label={M.tituloResumen} className="flex flex-col gap-2">
        <h4 className="font-medium">{M.tituloResumen}</h4>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt>{M.modificadas}</dt>
          <dd className="text-right tabular-nums">{resumen.modificadas}</dd>
          <dt>{M.excluidas}</dt>
          <dd className="text-right tabular-nums">{resumen.excluidas}</dd>
          <dt>{M.agregadas}</dt>
          <dd className="text-right tabular-nums">{resumen.agregadas}</dd>
        </dl>
        <h5 className="text-sm font-medium">{M.impactoIgv}</h5>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          {DESTINOS.map((d) =>
            impacto[d] === null ? null : (
              <div key={d} className="contents">
                <dt>{M.impactoDestino[d]}</dt>
                <dd className="text-right tabular-nums">{conMiles(impacto[d])}</dd>
              </div>
            ),
          )}
          <dt className="font-medium">{M.impactoDestino.total}</dt>
          <dd className="text-right font-medium tabular-nums">{conMiles(impacto.total)}</dd>
        </dl>
        {resumen.filasSinConvertir.length > 0 && (
          <p className="text-sm">{M.sinConvertir(resumen.filasSinConvertir.length)}</p>
        )}
      </section>
    </div>
  );
}
