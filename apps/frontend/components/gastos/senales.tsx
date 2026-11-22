import type { SenalGasto } from "@contapp/shared";
import { MENSAJES_GASTOS as M } from "../../lib/gastos";

// Señales del puntaje de R-GP (spec 027, D-1, R-3, R-5). Una fila por señal, en el orden recibido, con su texto fijo y sus
// puntos, y el total fuera de la lista. Solo texto fijo: nunca glosas, montos, RUC ni razón social; lo único que viene del
// servidor es la palabra del diccionario, el código de la categoría y los conteos de ítems. Siempre como texto de React.

function textoDe(senal: SenalGasto): string {
  switch (senal.codigo) {
    case "S1":
      return M.senales.S1(senal.palabra ?? "", senal.items?.coinciden ?? 0, senal.items?.total ?? 0);
    case "S3":
      return M.senales.S3(senal.categoria ?? "");
    default:
      return M.senales[senal.codigo];
  }
}

export function Senales({ puntaje, senales }: { puntaje: number; senales: readonly SenalGasto[] }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1.5">
      {senales.length > 0 && (
        <ul aria-label={M.listaSenales} className="m-0 flex list-none flex-col gap-1 p-0">
          {senales.map((s, i) => (
            <li key={`${s.codigo}|${i}`} className="flex min-w-0 items-start justify-between gap-3 text-[13px] text-tinta-media">
              <span className="min-w-0 break-words">{textoDe(s)}</span>
              <span className="cifras shrink-0 font-semibold text-tinta">{M.puntos(s.puntos)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-[13px] font-semibold text-tinta">{M.puntajeTotal(puntaje)}</p>
    </div>
  );
}
