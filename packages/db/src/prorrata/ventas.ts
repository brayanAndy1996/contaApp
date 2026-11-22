// Totales de ventas por periodo para la prorrata (spec 026, R-2, R-5, R-7; CA-3, CA-5, CA-11). Una sola consulta agregada sobre los
// periodos pedidos: las filas que cuentan son las de `leerFilasVentas` (013) sin exclusión vigente, de cualquier origen. Las PEN se
// suman exactas en SQL (NUMERIC); las USD salen una por una con su tipo de cambio (el dominio las convierte como `resumirVentas`).
import type { TxConsulta } from "../compras/errores";
import { consultarProrrata, esUuidProrrata, exigirPeriodos } from "./errores";

export interface FilaUsdProrrata {
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  /** «3.750» o `null` si la fila USD no trae tipo de cambio. */
  tipoCambio: string | null;
}

export interface TotalesVentasPeriodo {
  periodo: string;
  cargado: boolean;
  pen: {
    baseGravada: string;
    igv: string;
    exonerada: string;
    inafecta: string;
  };
  usd: FilaUsdProrrata[];
}

// Una fila por periodo pedido (en su orden). «cargado»: hay propuesta de ventas del periodo o alguna venta (también excluida). Las
// sumas y las USD solo de las filas sin exclusión vigente (la única parcial (tenant, venta) con restaurada_en nulo: a lo sumo una por
// venta, la unión no duplica). Las sumas parten de 0.00 (escala 2: «0.00» sin filas).
const SQL_TOTALES = `with pedidos as (
    select distinct on (t.p) t.p::bpchar as periodo from unnest($2::text[]) as t(p) order by t.p
  )
  select pe.periodo::text as periodo,
    (s.filas > 0 or exists (select 1 from propuesta pr
                             where pr.cliente_id = $1 and pr.periodo = pe.periodo and pr.libro = 'ventas')) as cargado,
    s.base_gravada, s.igv, s.exonerada, s.inafecta, s.usd
  from pedidos pe
  cross join lateral (
    select count(*) as filas,
      coalesce(sum(v.base_gravada) filter (where v.moneda = 'PEN' and x.venta_id is null), 0.00)::text as base_gravada,
      coalesce(sum(v.igv) filter (where v.moneda = 'PEN' and x.venta_id is null), 0.00)::text as igv,
      coalesce(sum(v.exonerada) filter (where v.moneda = 'PEN' and x.venta_id is null), 0.00)::text as exonerada,
      coalesce(sum(v.inafecta) filter (where v.moneda = 'PEN' and x.venta_id is null), 0.00)::text as inafecta,
      coalesce(json_agg(json_build_object('baseGravada', v.base_gravada::text, 'igv', v.igv::text, 'exonerada', v.exonerada::text,
        'inafecta', v.inafecta::text, 'tipoCambio', v.tipo_cambio::text)) filter (where v.moneda = 'USD' and x.venta_id is null),
        '[]'::json) as usd
    from venta v
    left join venta_exclusion x on x.tenant_id = v.tenant_id and x.venta_id = v.id and x.restaurada_en is null
    where v.cliente_id = $1 and v.periodo = pe.periodo
  ) s`;

/** Una entrada por periodo pedido, en el mismo orden (los no cargados también, en cero). */
export async function leerTotalesVentasProrrata(
  tx: TxConsulta,
  clienteId: string,
  periodos: string[],
): Promise<TotalesVentasPeriodo[]> {
  const lista = exigirPeriodos(periodos);
  if (lista.length === 0) return [];
  const filas = esUuidProrrata(clienteId)
    ? await consultarProrrata(tx, SQL_TOTALES, [clienteId, lista])
    : [];
  const porPeriodo = new Map(filas.map((f) => [f.periodo as string, f]));
  return lista.map((periodo) => {
    const f = porPeriodo.get(periodo);
    return {
      periodo,
      cargado: f?.cargado === true,
      pen: {
        baseGravada: f?.base_gravada ?? "0.00",
        igv: f?.igv ?? "0.00",
        exonerada: f?.exonerada ?? "0.00",
        inafecta: f?.inafecta ?? "0.00",
      },
      usd: f?.usd ?? [],
    };
  });
}
