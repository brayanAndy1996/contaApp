"use client";

import type { MesVista } from "@contapp/shared";
import { sumar } from "../../lib/montos-compras";
import { MENSAJES_PRORRATA as M, centimos, etiquetaPeriodo } from "../../lib/prorrata";

// Gráfico de la ventana de prorrata (spec 026, T13; D-8, RNF-070). SVG propio (sin dependencias nuevas) con dos barras por mes:
// «gravadas más exportaciones» y «no gravadas». Solo tokens de color. La geometría se mide en céntimos exactos (`BigInt`,
// por lectura del texto) y solo al final pasa a píxeles; los montos que se muestran (tabla accesible) son cadenas. Los meses con total
// negativo se dibujan hacia abajo del eje con altura positiva y quedan marcados (`data-negativo`) y con borde.

const ANCHO = 360;
const ALTO = 220;
const MARGEN_X = 8;
const TOPE = 12;
const BASE_ROTULOS = 28;
const ALTO_PLANO = ALTO - TOPE - BASE_ROTULOS;
const ANCHO_BARRA = 10;
const SEPARACION_BARRAS = 2;

interface Barra {
  periodo: string;
  serie: "gravadas_exportaciones" | "no_gravadas";
  valor: bigint;
}

const CERO = BigInt(0);
const sumaGravadas = (m: MesVista): bigint => centimos(m.gravadas) + centimos(m.exportaciones);
const abs = (v: bigint): bigint => (v < CERO ? -v : v);

export function GraficoProrrata({ meses }: { meses: readonly MesVista[] }) {
  const barras: Barra[] = meses.flatMap((m) => [
    { periodo: m.periodo, serie: "gravadas_exportaciones" as const, valor: sumaGravadas(m) },
    { periodo: m.periodo, serie: "no_gravadas" as const, valor: centimos(m.noGravadas) },
  ]);
  const maxPositivo = barras.reduce((a, b) => (b.valor > a ? b.valor : a), CERO);
  const maxNegativo = barras.reduce((a, b) => (-b.valor > a ? -b.valor : a), CERO);
  const recorrido = maxPositivo + maxNegativo;
  // Proporción en milésimas de punto de la altura del plano: la división es entera sobre céntimos exactos.
  const px = (v: bigint): number => (recorrido === CERO ? 0 : Number((abs(v) * BigInt(1_000_000)) / recorrido) * (ALTO_PLANO / 1_000_000));
  const linea = TOPE + px(maxPositivo);
  const paso = (ANCHO - 2 * MARGEN_X) / Math.max(meses.length, 1);
  const anchoGrupo = 2 * ANCHO_BARRA + SEPARACION_BARRAS;

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-tarjeta border border-linea bg-hoja p-4 shadow-tarjeta sm:p-6" aria-label={M.tituloGrafico}>
      <h2 className="m-0 font-titulo text-lg font-bold">{M.tituloGrafico}</h2>
      <svg role="img" aria-label={M.tituloGrafico} viewBox={`0 0 ${ANCHO} ${ALTO}`} className="h-auto w-full max-w-full">
        <title>{M.tituloGrafico}</title>
        <line x1={MARGEN_X} x2={ANCHO - MARGEN_X} y1={linea} y2={linea} className="stroke-linea-control" strokeWidth={1} />
        {meses.map((m, i) => {
          const x0 = MARGEN_X + i * paso + (paso - anchoGrupo) / 2;
          const enero = m.periodo.endsWith("01");
          return (
            <g key={m.periodo}>
              {(["gravadas_exportaciones", "no_gravadas"] as const).map((serie, k) => {
                const b = barras[i * 2 + k]!;
                const negativo = b.valor < CERO;
                const alto = px(b.valor);
                return (
                  <rect
                    key={serie}
                    data-periodo={m.periodo}
                    data-serie={serie}
                    data-negativo={negativo ? "true" : undefined}
                    x={x0 + k * (ANCHO_BARRA + SEPARACION_BARRAS)}
                    y={negativo ? linea : linea - alto}
                    width={ANCHO_BARRA}
                    height={alto}
                    className={[
                      serie === "gravadas_exportaciones" ? "fill-primario" : "fill-tinta-suave",
                      negativo ? "stroke-error" : "",
                    ].join(" ")}
                    strokeWidth={negativo ? 2 : 0}
                  />
                );
              })}
              <text x={x0 + anchoGrupo / 2} y={ALTO - 14} textAnchor="middle" className="fill-tinta-suave" fontSize={10}>
                {m.periodo.slice(4)}
              </text>
              {(enero || i === 0) && (
                <text x={x0 + anchoGrupo / 2} y={ALTO - 2} textAnchor="middle" className="fill-tinta-suave" fontSize={10}>
                  {m.periodo.slice(0, 4)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px] text-tinta-media">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-primario" />
          {M.columnasGrafico.gravadasMasExportaciones}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-tinta-suave" />
          {M.columnasGrafico.noGravadas}
        </li>
      </ul>
      <details className="text-sm">
        <summary className="cursor-pointer text-primario max-lg:min-h-11 max-lg:leading-[44px]">{M.tablaGrafico}</summary>
        <table aria-label={M.tablaGrafico} className="mt-2 w-full border-collapse text-sm">
          <thead className="bg-hoja-alterna">
            <tr>
              <th scope="col" className="border-b border-linea px-2 py-2 text-left text-xs font-semibold text-tinta-suave">
                {M.columnasGrafico.mes}
              </th>
              <th scope="col" className="border-b border-linea px-2 py-2 text-right text-xs font-semibold text-tinta-suave">
                {M.columnasGrafico.gravadasMasExportaciones}
              </th>
              <th scope="col" className="border-b border-linea px-2 py-2 text-right text-xs font-semibold text-tinta-suave">
                {M.columnasGrafico.noGravadas}
              </th>
            </tr>
          </thead>
          <tbody>
            {meses.map((m) => (
              <tr key={m.periodo} className="border-b border-neutro-fondo">
                <td className="px-2 py-2">{etiquetaPeriodo(m.periodo)}</td>
                <td className="cifras px-2 py-2 text-right">{sumar([m.gravadas, m.exportaciones])}</td>
                <td className="cifras px-2 py-2 text-right">{m.noGravadas}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {meses.some((m) => sumaGravadas(m) < CERO || centimos(m.noGravadas) < CERO) && (
        <p className="m-0 text-[13px] text-tinta-suave">{M.leyendaNegativo}</p>
      )}
    </section>
  );
}
