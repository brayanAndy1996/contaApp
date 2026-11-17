"use client";

import type {
  CorrelatividadVentasDto,
  FaltanteVentasDto,
  SerieCorrelatividadDto,
} from "@contapp/shared";
import { MENSAJES_VENTAS as M } from "../../lib/ventas";
import { Badge, Button, Card, CardTitle } from "../ui";

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
    <li className="flex flex-col items-start gap-2 rounded-control border border-linea bg-hoja-alterna p-3">
      <span className="font-semibold text-tinta">{textoFaltante(s.serie, f)}</span>
      {f.estado === "justificado" && <Badge tono="ok">{M.justificado}</Badge>}
      {f.estado === "parcial" && <Badge tono="aviso">{M.justificadoEnParte}</Badge>}
      {f.comentario && <span className="text-sm text-tinta-media">{f.comentario}</span>}
      {puedeClasificar &&
        f.estado === "justificado" &&
        f.justificacionId !== undefined && (
          <span className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secundario"
              size="sm"
              disabled={!alRevertir}
              onClick={() =>
                alRevertir?.({
                  justificacionId: f.justificacionId as string,
                  clave: claveFaltante(s.serie, f),
                })
              }
              className="max-lg:h-11"
            >
              {M.revertir}
            </Button>
          </span>
        )}
      {puedeClasificar && f.estado !== "justificado" && (
        <span className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secundario"
            size="sm"
            disabled={!alJustificar}
            onClick={() => alJustificar?.(salto)}
            className="max-lg:h-11"
          >
            {M.justificar}
          </Button>
          <Button
            type="button"
            variant="secundario"
            size="sm"
            disabled={!alAgregar}
            onClick={() => alAgregar?.(salto)}
            className="max-lg:h-11"
          >
            {M.agregarVenta}
          </Button>
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
    <Card aria-label="Correlatividad">
      <CardTitle>Correlatividad</CardTitle>
      {correlatividad && <p className="m-0 text-sm text-tinta-media">{M.porRevisar(porRevisar)}</p>}
      {series.map((s) => (
        <fieldset
          key={`${s.tipo}|${s.serie}`}
          className="m-0 flex min-w-0 flex-col gap-3 rounded-control border border-linea p-4"
        >
          <legend className="px-1 text-sm font-semibold text-tinta">
            {M.nombreSerie(s.tipo, s.serie)}
          </legend>
          {s.estado === "completa" && (
            <p className="m-0 text-sm text-tinta-media">{M.numeracionCompleta}</p>
          )}
          {s.estado === "no_evaluable" && (
            <p className="m-0 text-sm text-tinta-media">{M.noEvaluable}</p>
          )}
          {s.estado === "con_faltantes" && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
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
            <p className="m-0 text-xs text-tinta-suave">
              Comprobantes con número no evaluable: {s.noEvaluables}
            </p>
          )}
        </fieldset>
      ))}
    </Card>
  );
}
