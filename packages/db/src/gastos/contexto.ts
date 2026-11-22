// Lector único del contexto de R-GP (spec 027, D-5; R-3 S5-S7, R-12 a R-14) y glosas de la compra (R-7). Datos planos: `db` no depende
// de `domain`; el diccionario efectivo lo arma el dominio con `crearDiccionarioEfectivo`. Lo usan el backend y el worker dentro de su
// transacción, con la RLS del estudio. Dos consultas: (1) diccionario, umbral, cliente y caché de CIIU; (2) historial de los proveedores.
import type { TxConsulta } from "../compras/errores";
import {
  ARGUMENTO_INVALIDO,
  consultarGastos,
  esUuidGastos,
  exigirId,
  GastosRepoError,
  type FilaGastos,
} from "./errores";

/** Documento del proveedor tal como lo guarda `compra` (`doc_tipo`, `doc_numero`). */
export interface ProveedorDoc {
  tipo: string;
  numero: string;
}

export interface PalabraContexto {
  palabra: string;
  categoria: string;
  excepciones: string[];
}

/** Datos planos (sin `domain`): el diccionario efectivo lo arma el dominio con `crearDiccionarioEfectivo`. */
export interface ContextoGastosLeido {
  /** 1..20; 3 si el estudio no fijó uno. */
  umbral: number;
  /** Palabras globales activas, por palabra ascendente. */
  globales: PalabraContexto[];
  /** Palabras globales que el estudio desactivó, ascendentes. */
  desactivadas: string[];
  /** Propias activas del estudio, por palabra ascendente. */
  propias: PalabraContexto[];
  ciiuCliente: string | null;
  /** Una entrada por proveedor pedido (sin repetir, en su orden); `ciiu` null sin caché o «sin dato». */
  ciiuProveedores: { proveedor: ProveedorDoc; ciiu: string | null }[];
  categoriasCliente: { permitidas: string[]; quitadas: string[] };
  /** Una entrada por proveedor pedido (sin repetir, en su orden), con ceros si no tiene compras. */
  historial: {
    proveedor: ProveedorDoc;
    aceptadas6: number;
    excluidas6: number;
    excluidas12: number;
  }[];
}

const PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;
const RUC = /^[0-9]{11}$/;
/** Tipo de documento del RUC en el SIRE (catálogo 06). */
const TIPO_RUC = "6";

// (1) Todo lo que no depende de los proveedores más la caché de CIIU de los RUC pedidos (la RLS deja solo las filas del estudio).
const SQL_ESTUDIO = `select
    coalesce((select c.umbral::int from gnd_config c), 3) as umbral,
    coalesce((select jsonb_agg(jsonb_build_object('palabra', g.palabra, 'categoria', g.categoria,
                                                  'excepciones', to_jsonb(g.excepciones)) order by g.palabra)
                from gnd_palabra_global g where g.activa), '[]'::jsonb) as globales,
    coalesce((select array_agg(g.palabra order by g.palabra)
                from gnd_global_desactivada d join gnd_palabra_global g on g.id = d.palabra_global_id), '{}'::text[]) as desactivadas,
    coalesce((select jsonb_agg(jsonb_build_object('palabra', p.palabra, 'categoria', p.categoria,
                                                  'excepciones', to_jsonb(p.excepciones)) order by p.palabra)
                from gnd_palabra_estudio p where p.activa), '[]'::jsonb) as propias,
    (select g.ciiu::text from cliente k join gnd_ciiu g on g.ruc = k.ruc::bpchar where k.id = $1) as ciiu_cliente,
    (select jsonb_build_object('permitidas', to_jsonb(c.permitidas), 'quitadas', to_jsonb(c.quitadas))
       from gnd_cliente_categorias c where c.cliente_id = $1) as categorias,
    coalesce((select jsonb_object_agg(g.ruc::text, g.ciiu::text) from gnd_ciiu g where g.ruc = any($2::bpchar[])),
             '{}'::jsonb) as ciiu_proveedores`;

// (2) Historial (U-8) por proveedor: compras vivas del cliente con su versión VIGENTE (puntero), de M-12..M-1. Aceptadas: no excluida,
// de M-6..M-1, en un periodo `revisado` o `generado`; excluidas: vigente excluida (cualquier estado del periodo).
const SQL_HISTORIAL = `select c.doc_tipo, c.doc_numero,
    count(*) filter (where not v.excluida and c.periodo >= $5::bpchar and cp.estado in ('revisado', 'generado'))::int as aceptadas6,
    count(*) filter (where v.excluida and c.periodo >= $5::bpchar)::int as excluidas6,
    count(*) filter (where v.excluida)::int as excluidas12
  from compra c
  join compra_version v on v.tenant_id = c.tenant_id and v.compra_id = c.id and v.n = c.version_vigente
  left join compra_periodo cp on cp.tenant_id = c.tenant_id and cp.cliente_id = c.cliente_id and cp.periodo = c.periodo
  where c.cliente_id = $1 and c.descartada_en is null and c.periodo between $4::bpchar and $6::bpchar
    and (c.doc_tipo, c.doc_numero) in (select x.tipo, x.numero from unnest($2::text[], $3::text[]) as x(tipo, numero))
  group by c.doc_tipo, c.doc_numero`;

/** `periodo` (AAAAMM) menos `k` meses. */
function restarMeses(periodo: string, k: number): string {
  const total =
    Number(periodo.slice(0, 4)) * 12 + (Number(periodo.slice(4)) - 1) - k;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}`;
}

const clave = (p: ProveedorDoc): string => `${p.tipo}|${p.numero}`;

/** Proveedores sin repetir, en su orden. */
function unicos(proveedores: unknown): ProveedorDoc[] {
  if (!Array.isArray(proveedores))
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const vistos = new Set<string>();
  const salida: ProveedorDoc[] = [];
  for (const p of proveedores as unknown[]) {
    const { tipo, numero } = Object(p) as Partial<ProveedorDoc>;
    if (typeof tipo !== "string" || typeof numero !== "string")
      throw new GastosRepoError(ARGUMENTO_INVALIDO);
    const k = clave({ tipo, numero });
    if (vistos.has(k)) continue;
    vistos.add(k);
    salida.push({ tipo, numero });
  }
  return salida;
}

const aPalabras = (v: unknown): PalabraContexto[] =>
  (Array.isArray(v) ? v : []).map((x: FilaGastos) => ({
    palabra: String(x.palabra),
    categoria: String(x.categoria),
    excepciones: Array.isArray(x.excepciones) ? x.excepciones.map(String) : [],
  }));

const aTextos = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : [];

export async function leerContextoGastos(
  tx: TxConsulta,
  e: { clienteId: string; periodo: string; proveedores: ProveedorDoc[] },
): Promise<ContextoGastosLeido> {
  const clienteId = exigirId(e.clienteId);
  if (typeof e.periodo !== "string" || !PERIODO.test(e.periodo))
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const proveedores = unicos(e.proveedores);
  const rucs = proveedores
    .filter((p) => p.tipo === TIPO_RUC && RUC.test(p.numero))
    .map((p) => p.numero);

  const [f] = await consultarGastos(tx, SQL_ESTUDIO, [clienteId, rucs]);
  const ciiuPorRuc = (f?.ciiu_proveedores ?? {}) as Record<
    string,
    string | null
  >;
  const categorias = (f?.categorias ?? null) as {
    permitidas: unknown;
    quitadas: unknown;
  } | null;

  const conteos = new Map<
    string,
    { aceptadas6: number; excluidas6: number; excluidas12: number }
  >();
  if (proveedores.length > 0) {
    const filas = await consultarGastos(tx, SQL_HISTORIAL, [
      clienteId,
      proveedores.map((p) => p.tipo),
      proveedores.map((p) => p.numero),
      restarMeses(e.periodo, 12),
      restarMeses(e.periodo, 6),
      restarMeses(e.periodo, 1),
    ]);
    for (const h of filas)
      conteos.set(clave({ tipo: h.doc_tipo, numero: h.doc_numero }), {
        aceptadas6: Number(h.aceptadas6),
        excluidas6: Number(h.excluidas6),
        excluidas12: Number(h.excluidas12),
      });
  }

  return {
    umbral: Number(f?.umbral ?? 3),
    globales: aPalabras(f?.globales),
    desactivadas: aTextos(f?.desactivadas),
    propias: aPalabras(f?.propias),
    ciiuCliente: (f?.ciiu_cliente as string | null | undefined) ?? null,
    ciiuProveedores: proveedores.map((proveedor) => ({
      proveedor,
      ciiu:
        proveedor.tipo === TIPO_RUC && RUC.test(proveedor.numero)
          ? (ciiuPorRuc[proveedor.numero] ?? null)
          : null,
    })),
    categoriasCliente: {
      permitidas: aTextos(categorias?.permitidas),
      quitadas: aTextos(categorias?.quitadas),
    },
    historial: proveedores.map((proveedor) => ({
      proveedor,
      ...(conteos.get(clave(proveedor)) ?? {
        aceptadas6: 0,
        excluidas6: 0,
        excluidas12: 0,
      }),
    })),
  };
}

// XML vigente (mayor `n`) del comprobante de la compra: RUC del proveedor, tipo, serie en mayúsculas y número sin ceros a la izquierda
// (la misma identidad normalizada que `normalizarIdentidadXml`).
const SQL_GLOSAS = `select d.detalle
  from compra c
  cross join lateral (
    select y.detalle from documento_xml y
     where y.cliente_id = c.cliente_id and y.ruc_emisor = btrim(c.doc_numero) and y.tipo = btrim(c.tipo_doc)
       and y.serie = upper(btrim(c.serie))
       and y.numero = case when ltrim(btrim(c.numero), '0') = '' and btrim(c.numero) <> '' then '0'
                           else ltrim(btrim(c.numero), '0') end
     order by y.n desc limit 1) d
  where c.id = $1`;

/** Descripciones de los ítems del XML vigente de la compra, en orden; `null` sin XML o si la compra no es visible. */
export async function leerGlosasCompra(
  tx: TxConsulta,
  compraId: string,
): Promise<string[] | null> {
  if (!esUuidGastos(compraId)) return null;
  const [f] = await consultarGastos(tx, SQL_GLOSAS, [compraId]);
  if (f === undefined) return null;
  const items: unknown = (Object(f.detalle) as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .map((i: unknown) => (Object(i) as { descripcion?: unknown }).descripcion)
    .filter((d): d is string => typeof d === "string");
}
