import { leerContextoGastos, type ProveedorDoc, type Tx } from "@contapp/db";
import { crearDiccionarioEfectivo, type ContextoGastos } from "@contapp/domain";

// El contexto de la R-GP completa para las entradas del backend (spec 027, D-5): diccionario efectivo del estudio, umbral, ajuste de
// categorías del cliente, CIIU de la caché e historial de los proveedores. Lo usan, igual, las acciones de la grilla y la subida del XML
// (`compras/escritura.ts`), la prevalidación de 012 (`archivos/previo.ts`) y «Aprender estas palabras». El backend NUNCA consulta el
// CIIU: solo lo lee de la caché del estudio que dejó el worker. Todo dentro de la transacción `withTenant` de quien llama (RLS).

/** Gramática de `DocProveedor` del dominio: un proveedor fuera de ella invalidaría TODO el contexto, así que se omite. */
const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Za-z-]{1,15}$/;

/** Proveedores sin repetir y dentro de la gramática del dominio, en su orden. */
export function proveedoresValidos(proveedores: readonly ProveedorDoc[]): ProveedorDoc[] {
  const vistos = new Set<string>();
  const salida: ProveedorDoc[] = [];
  for (const p of proveedores) {
    if (!TIPO_DOC.test(p.tipo) || !NUMERO_DOC.test(p.numero)) continue;
    const clave = `${p.tipo}|${p.numero}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ tipo: p.tipo, numero: p.numero });
  }
  return salida;
}

const SQL_PROVEEDORES_PERIODO = `select distinct c.doc_tipo, c.doc_numero from compra c
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null`;

/** Proveedores de las compras vivas del periodo (los que una evaluación del periodo puede necesitar). */
export async function proveedoresDelPeriodo(tx: Tx, clienteId: string, periodo: string): Promise<ProveedorDoc[]> {
  const r = await tx.query<{ doc_tipo: string; doc_numero: string }>(SQL_PROVEEDORES_PERIODO, [clienteId, periodo]);
  return proveedoresValidos(r.rows.map((f) => ({ tipo: f.doc_tipo, numero: f.doc_numero })));
}

/**
 * Contexto de gastos del cliente y periodo con el historial y el CIIU de `proveedores` (por omisión, los del periodo). Dos consultas del
 * lector único de `packages/db` (una más si hay que buscar los proveedores del periodo). El diccionario efectivo lo arma el dominio:
 * global activa − desactivadas por el estudio + propias activas (la propia con el texto de una global la reemplaza).
 */
export async function contextoGastos(
  tx: Tx,
  clienteId: string,
  periodo: string,
  proveedores?: readonly ProveedorDoc[],
): Promise<ContextoGastos> {
  const lista = proveedores === undefined ? await proveedoresDelPeriodo(tx, clienteId, periodo) : proveedoresValidos(proveedores);
  const l = await leerContextoGastos(tx, { clienteId, periodo, proveedores: lista });
  return {
    diccionario: crearDiccionarioEfectivo({
      globales: l.globales.map((p) => ({ ...p, activa: true })),
      desactivadas: l.desactivadas,
      propias: l.propias.map((p) => ({ ...p, activa: true })),
    }),
    umbral: l.umbral,
    ciiuCliente: l.ciiuCliente,
    ciiuProveedores: l.ciiuProveedores,
    categoriasCliente: l.categoriasCliente,
    historial: l.historial,
  };
}
