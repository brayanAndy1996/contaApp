"use client";

import type { ExcluidaPrevioDto, PrevioArchivoDto } from "@contapp/shared";
import { MENSAJES_ARCHIVO as M, nombreCodigoPrevio, type LibroArchivo } from "../../lib/archivos";
import { conMiles } from "../../lib/montos-compras";
import { Alert, Button, cifra, enlace } from "../ui";

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
      <div className="flex flex-col gap-2 text-sm">
        <p className="m-0 font-mono text-xs text-tinta-suave">{M.formato(previo.formato.id, previo.formato.version)}</p>
        {!previo.formato.oficial && (
          <Alert tono="aviso" role="note" className="flex-col gap-0.5 font-semibold">
            {M.provisional}
            <span className="block font-normal">{M.provisionalAyuda}</span>
          </Alert>
        )}
        <p
          role="status"
          data-generable={previo.generable}
          className={`m-0 rounded-control border px-3 py-2 font-semibold ${
            previo.generable ? "border-ok-borde bg-ok-fondo text-ok" : "border-aviso-borde bg-aviso-fondo text-aviso"
          }`}
        >
          {previo.generable
            ? M.generable
            : `${M.noGenerable}${previo.motivo ? ` ${M.motivos[previo.motivo]}` : ""}`}
        </p>
      </div>

      <section aria-label={M.tituloErrores} className="flex flex-col gap-2">
        <h4 className="m-0 font-titulo text-[15px] font-bold">{M.tituloErrores}</h4>
        {libro === "ventas" && previo.errores.length > 0 && (
          <Alert tono="aviso" role="note">
            {M.erroresVentasAyuda}
          </Alert>
        )}
        {bloqueo !== null && (alExcluir || alRestaurar) && (
          <p role="note" className="m-0 text-sm text-tinta-media">
            {bloqueo}
          </p>
        )}
        {previo.errores.length === 0 ? (
          <p className="m-0 text-sm text-tinta-suave">{M.sinErrores}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {previo.errores.map((e, i) => (
              <li
                key={`${e.filaId ?? "periodo"}|${e.codigo}|${i}`}
                className="flex flex-col gap-1 rounded-control border border-error-borde bg-hoja-alterna p-3"
              >
                <p className="m-0">
                  {e.comprobante != null && <strong>{e.comprobante} · </strong>}
                  <strong>{nombreCodigoPrevio(e.codigo)}</strong>
                  {e.campo ? ` · ${e.campo}` : ""}
                  {e.destino ? ` · ${e.destino}` : ""}
                </p>
                <p className="m-0 text-tinta-media">{e.explicacion}</p>
                {e.diferencia !== null && <p className={`m-0 ${cifra}`}>{M.diferencia(conMiles(e.diferencia))}</p>}
                <div className="flex flex-wrap items-center gap-3">
                  {e.filaId !== null && alUbicarFila && (
                    <button
                      type="button"
                      aria-label={e.comprobante == null ? undefined : M.ubicarComprobante(e.comprobante)}
                      onClick={() => alUbicarFila(e.filaId!)}
                      className={`min-h-11 lg:min-h-0 ${enlace}`}
                    >
                      {M.ubicarFila}
                    </button>
                  )}
                  {libro === "ventas" && e.excluible && e.filaId !== null && alExcluir && (
                    <Button
                      variant="secundario"
                      size="sm"
                      aria-label={e.comprobante == null ? undefined : M.excluirComprobante(e.comprobante)}
                      disabled={bloqueo !== null}
                      title={bloqueo ?? undefined}
                      onClick={() => alExcluir(e.filaId!)}
                      className="min-h-11 lg:min-h-8"
                    >
                      {M.excluir}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {previo.erroresOmitidos > 0 && (
          <p className="m-0 text-sm text-tinta-suave">{M.erroresOmitidos(previo.erroresOmitidos)}</p>
        )}
      </section>

      {(previo.avisos.length > 0 || previo.avisosOmitidos > 0) && (
        <section aria-label={M.tituloAvisos} className="flex flex-col gap-2">
          <h4 className="m-0 font-titulo text-[15px] font-bold">{M.tituloAvisos}</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {previo.avisos.map((a, i) => (
              <li
                key={`${a.filaId ?? "periodo"}|${a.codigo}|${i}`}
                className="rounded-control border border-aviso-borde bg-aviso-fondo px-3 py-2 text-aviso"
              >
                {a.comprobante != null && <strong>{a.comprobante} · </strong>}
                <strong>{nombreCodigoPrevio(a.codigo)}</strong> · {a.explicacion}
                {a.filaId !== null && alUbicarFila && (
                  <>
                    {" "}
                    <button
                      type="button"
                      aria-label={a.comprobante == null ? undefined : M.ubicarComprobante(a.comprobante)}
                      onClick={() => alUbicarFila(a.filaId!)}
                      className={`min-h-11 lg:min-h-0 ${enlace}`}
                    >
                      {M.ubicarFila}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {previo.avisosOmitidos > 0 && (
            <p className="m-0 text-sm font-semibold text-tinta-media">{M.avisosOmitidos(previo.avisosOmitidos)}</p>
          )}
          <p className="m-0 text-xs text-tinta-suave">{M.avisosNoImpiden}</p>
        </section>
      )}

      {libro === "ventas" && (previo.excluidas.length > 0 || previo.excluidasOmitidas > 0) && (
        <section aria-label={M.tituloExcluidas} className="flex flex-col gap-2">
          <h4 className="m-0 font-titulo text-[15px] font-bold">{M.tituloExcluidas}</h4>
          <p className="m-0 text-xs text-tinta-suave">{M.excluidasAyuda}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {previo.excluidas.map((x) => (
              <li key={x.filaId} className="flex flex-col gap-1 rounded-control border border-linea bg-hoja-alterna p-3">
                <strong>{x.comprobante}</strong>
                <span>{M.excluidaMotivo(x.motivo)}</span>
                <span className="flex flex-wrap items-center gap-3">
                  {alUbicarFila && (
                    <button
                      type="button"
                      onClick={() => alUbicarFila(x.filaId)}
                      className={`min-h-11 lg:min-h-0 ${enlace}`}
                    >
                      {M.ubicarFila}
                    </button>
                  )}
                  {alRestaurar && (
                    <Button
                      variant="secundario"
                      size="sm"
                      aria-label={M.restaurarVenta(x.comprobante)}
                      disabled={bloqueo !== null}
                      title={bloqueo ?? undefined}
                      onClick={() => alRestaurar(x)}
                      className="min-h-11 lg:min-h-8"
                    >
                      {M.restaurar}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {previo.excluidasOmitidas > 0 && (
            <p className="m-0 text-sm text-tinta-suave">{M.excluidasOmitidas(previo.excluidasOmitidas)}</p>
          )}
        </section>
      )}

      <section aria-label={M.tituloResumen} className="flex flex-col gap-2">
        <h4 className="m-0 font-titulo text-[15px] font-bold">{M.tituloResumen}</h4>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt>{M.modificadas}</dt>
          <dd className={`m-0 ${cifra}`}>{resumen.modificadas}</dd>
          <dt>{M.excluidas}</dt>
          <dd className={`m-0 ${cifra}`}>{resumen.excluidas}</dd>
          <dt>{M.agregadas}</dt>
          <dd className={`m-0 ${cifra}`}>{resumen.agregadas}</dd>
        </dl>
        <h5 className="m-0 text-sm font-bold text-tinta-media">{M.impactoIgv}</h5>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          {DESTINOS.map((d) =>
            impacto[d] === null ? null : (
              <div key={d} className="contents">
                <dt>{M.impactoDestino[d]}</dt>
                <dd className={`m-0 ${cifra}`}>{conMiles(impacto[d])}</dd>
              </div>
            ),
          )}
          <dt className="font-bold">{M.impactoDestino.total}</dt>
          <dd className={`m-0 font-bold ${cifra}`}>{conMiles(impacto.total)}</dd>
        </dl>
        {resumen.filasSinConvertir.length > 0 && (
          <p className="m-0 text-sm text-tinta-suave">{M.sinConvertir(resumen.filasSinConvertir.length)}</p>
        )}
      </section>
    </div>
  );
}
