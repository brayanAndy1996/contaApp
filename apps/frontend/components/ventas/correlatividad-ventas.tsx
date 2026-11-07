"use client";

import type {
  CorrelatividadVentasDto,
  FaltanteVentasDto,
  SerieCorrelatividadDto,
} from "@contapp/shared";
import { MENSAJES_VENTAS as M } from "../../lib/ventas";

// Región «Correlatividad» (spec 013, D7; RF-053, HU-12). Muestra por serie lo que calcula el servidor: los
// saltos como rangos (jamás se expanden número por número), su estado de justificación y, con permiso, las
// acciones «Justificar», «Agregar venta» y, en lo justificado, «Revertir». Los formularios los abre la pantalla (T16) mediante los `al…`.

export interface SaltoElegido {
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
}

/** Justificación que se quiere revertir y el salto que cubre, tal como se lee en la confirmación (D23). */
export interface RevertirElegido {
  justificacionId: string;
  clave: string;
}

/** «B001-291» o «B001-291 a B001-293», para la confirmación. */
const claveFaltante = (serie: string, f: FaltanteVentasDto): string =>
  f.desde === f.hasta
    ? `${serie}-${f.desde}`
    : `${serie}-${f.desde} a ${serie}-${f.hasta}`;

const requiereRevision = (f: FaltanteVentasDto): boolean =>
  f.estado === "pendiente" || f.estado === "parcial";

function textoFaltante(serie: string, f: FaltanteVentasDto): string {
  return f.desde === f.hasta
    ? M.faltaUno(`${serie}-${f.desde}`)
    : M.faltaRango(`${serie}-${f.desde}`, `${serie}-${f.hasta}`);
}

function Faltante({
  s,
  f,
  puedeClasificar,
  alJustificar,
  alAgregar,
  alRevertir,
}: {
  s: SerieCorrelatividadDto;
  f: FaltanteVentasDto;
  puedeClasificar: boolean;
  alJustificar?: (salto: SaltoElegido) => void;
  alAgregar?: (salto: SaltoElegido) => void;
  alRevertir?: (r: RevertirElegido) => void;
}) {
  const salto: SaltoElegido = {
    tipo: s.tipo,
    serie: s.serie,
    desde: f.desde,
    hasta: f.hasta,
  };
  return (
    <li className="flex flex-col gap-1 rounded border p-2">
      <span className="font-medium">{textoFaltante(s.serie, f)}</span>
      {f.estado === "justificado" && (
        <span className="text-sm">{M.justificado}</span>
      )}
      {f.estado === "parcial" && (
        <span className="text-sm">{M.justificadoEnParte}</span>
      )}
      {f.comentario && <span className="text-sm">{f.comentario}</span>}
      {puedeClasificar &&
        f.estado === "justificado" &&
        f.justificacionId !== undefined && (
          <span className="flex gap-2">
            <button
              type="button"
              disabled={!alRevertir}
              onClick={() =>
                alRevertir?.({
                  justificacionId: f.justificacionId as string,
                  clave: claveFaltante(s.serie, f),
                })
              }
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              {M.revertir}
            </button>
          </span>
        )}
      {puedeClasificar && f.estado !== "justificado" && (
        <span className="flex gap-2">
          <button
            type="button"
            disabled={!alJustificar}
            onClick={() => alJustificar?.(salto)}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {M.justificar}
          </button>
          <button
            type="button"
            disabled={!alAgregar}
            onClick={() => alAgregar?.(salto)}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {M.agregarVenta}
          </button>
        </span>
      )}
    </li>
  );
}

export function CorrelatividadVentas({
  correlatividad,
  puedeClasificar,
  alJustificar,
  alAgregar,
  alRevertir,
}: {
  correlatividad: CorrelatividadVentasDto | null;
  /** `sire.clasificar` y cliente activo: sin él no se muestran las acciones (la alerta sí). */
  puedeClasificar: boolean;
  alJustificar?: (salto: SaltoElegido) => void;
  alAgregar?: (salto: SaltoElegido) => void;
  /** «Revertir» en el salto justificado por una única justificación vigente (D23); la pantalla pide la confirmación. */
  alRevertir?: (r: RevertirElegido) => void;
}) {
  const series = correlatividad?.series ?? [];
  const porRevisar = series.reduce(
    (n, s) => n + s.faltantes.filter(requiereRevision).length,
    0,
  );

  return (
    <section aria-label="Correlatividad" className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Correlatividad</h2>
      {correlatividad && <p className="text-sm">{M.porRevisar(porRevisar)}</p>}
      {series.map((s) => (
        <fieldset
          key={`${s.tipo}|${s.serie}`}
          className="flex flex-col gap-2 rounded border p-3"
        >
          <legend className="px-1 text-sm font-medium">
            {M.nombreSerie(s.tipo, s.serie)}
          </legend>
          {s.estado === "completa" && (
            <p className="text-sm">{M.numeracionCompleta}</p>
          )}
          {s.estado === "no_evaluable" && (
            <p className="text-sm">{M.noEvaluable}</p>
          )}
          {s.estado === "con_faltantes" && (
            <ul className="flex flex-col gap-2 text-sm">
              {s.faltantes.map((f) => (
                <Faltante
                  key={`${f.desde}-${f.hasta}`}
                  s={s}
                  f={f}
                  puedeClasificar={puedeClasificar}
                  alJustificar={alJustificar}
                  alAgregar={alAgregar}
                  alRevertir={alRevertir}
                />
              ))}
            </ul>
          )}
          {s.noEvaluables > 0 && (
            <p className="text-xs">
              Comprobantes con número no evaluable: {s.noEvaluables}
            </p>
          )}
        </fieldset>
      ))}
    </section>
  );
}
