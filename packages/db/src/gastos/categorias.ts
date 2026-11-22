// Categorías permitidas y quitadas por cliente (spec 027, R-13). Escribe solo por `gnd_cliente_categorias_fijar` (0070, backend con
// usuario); lee con la RLS del estudio.
import type { TxConsulta } from "../compras/errores";
import {
  consultarGastos,
  esUuidGastos,
  exigirId,
  exigirTextos,
  exigirVersion,
} from "./errores";

export interface CategoriasClienteLeidas {
  /** Clase CIIU del cliente en la caché del estudio, o `null`. */
  ciiu: string | null;
  permitidas: string[];
  quitadas: string[];
  /** 0 si el estudio nunca las fijó. */
  version: number;
}

const SQL_LEER = `select (select g.ciiu::text from gnd_ciiu g where g.ruc = k.ruc::bpchar) as ciiu,
    coalesce(c.permitidas, '{}'::text[]) as permitidas, coalesce(c.quitadas, '{}'::text[]) as quitadas,
    coalesce(c.version, 0) as version
  from cliente k left join gnd_cliente_categorias c on c.tenant_id = k.tenant_id and c.cliente_id = k.id
  where k.id = $1`;

const SQL_FIJAR =
  "select public.gnd_cliente_categorias_fijar($1::uuid, $2::text[], $3::text[], $4::integer) as version";

/** `null` si el cliente no existe, es de otro estudio o el id está mal formado. */
export async function leerCategoriasCliente(
  tx: TxConsulta,
  clienteId: string,
): Promise<CategoriasClienteLeidas | null> {
  if (!esUuidGastos(clienteId)) return null;
  const [f] = await consultarGastos(tx, SQL_LEER, [clienteId]);
  if (f === undefined) return null;
  return {
    ciiu: (f.ciiu as string | null) ?? null,
    permitidas: f.permitidas as string[],
    quitadas: f.quitadas as string[],
    version: Number(f.version),
  };
}

/** `gnd_cliente_categorias_fijar`: devuelve la versión nueva. */
export async function fijarCategoriasCliente(
  tx: TxConsulta,
  e: {
    clienteId: string;
    permitidas: string[];
    quitadas: string[];
    version: number;
  },
): Promise<number> {
  const clienteId = exigirId(e.clienteId);
  const permitidas = exigirTextos(e.permitidas);
  const quitadas = exigirTextos(e.quitadas);
  const version = exigirVersion(e.version);
  const [f] = await consultarGastos(tx, SQL_FIJAR, [
    clienteId,
    permitidas,
    quitadas,
    version,
  ]);
  return Number(f!.version);
}
