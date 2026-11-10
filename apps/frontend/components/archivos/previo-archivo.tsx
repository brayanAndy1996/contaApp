"use client";

import type { PrevioArchivoDto } from "@contapp/shared";
import { MENSAJES_ARCHIVO as M } from "../../lib/archivos";
import { conMiles } from "../../lib/montos-compras";

// Previo del archivo (spec 012b, T14; D1, D5; CA-1, CA-9): errores con enlace que ubica la fila en la grilla,
// avisos, resumen de cambios e impacto en el IGV, y la marca «Provisional». Solo muestra lo que calculó el
// servidor: los montos son cadenas y se formatean con `conMiles`, nunca se calculan aquí. Toda cadena del SIRE
// (explicaciones, campos) se pinta como texto, que React escapa.

const DESTINOS = ["DG", "DGNG", "DNG"] as const;

export function PrevioArchivo({
  previo,
  alUbicarFila,
}: {
  previo: PrevioArchivoDto;
  /** Ubica y resalta la fila en la grilla; sin esta función los errores no llevan enlace. */
  alUbicarFila?: (filaId: string) => void;
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
        {previo.errores.length === 0 ? (
          <p className="text-sm">{M.sinErrores}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {previo.errores.map((e, i) => (
              <li key={`${e.filaId ?? "periodo"}|${e.codigo}|${i}`} className="rounded border p-2">
                <p>
                  <strong>{e.codigo}</strong>
                  {e.campo ? ` · ${e.campo}` : ""}
                  {e.destino ? ` · ${e.destino}` : ""}
                </p>
                <p>{e.explicacion}</p>
                {e.diferencia !== null && <p>{M.diferencia(conMiles(e.diferencia))}</p>}
                {e.filaId !== null && alUbicarFila && (
                  <button
                    type="button"
                    onClick={() => alUbicarFila(e.filaId!)}
                    className="underline"
                  >
                    {M.ubicarFila}
                  </button>
                )}
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
                <strong>{a.codigo}</strong> · {a.explicacion}
                {a.filaId !== null && alUbicarFila && (
                  <>
                    {" "}
                    <button
                      type="button"
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
