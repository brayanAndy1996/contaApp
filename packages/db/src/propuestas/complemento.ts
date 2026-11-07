// Aplicación del complemento de una propuesta (spec 013, D3, D16, D18; CA-11). Es la misma secuencia para la descarga del
// worker y para la importación del backend, y para cualquier libro (014 la reutiliza): bloqueo advisory (cliente, periodo,
// libro) -> existentes -> plan -> tope de filas vivas -> encabezado -> diferencias -> filas nuevas. Todo dentro de la
// transacción de `withTenant` que recibe: o se guarda completo o no se guarda nada.
//
// No conoce el dominio (`packages/db` no depende de `packages/domain`): quien llama pasa `planificar` (por lo común,
// `planificarComplemento`). Tampoco conoce las columnas de ningún libro: `existentes` e `insertar` son del persistidor.
import { createHash } from "node:crypto";
import {
  bloquearPeriodoLibro,
  crearPropuesta,
  insertarDiferencias,
  type FuentePropuesta,
  type LibroPropuesta,
  type NuevaDiferencia,
  type PropuestaFila,
} from "./repositorio";
import type { TxConsulta } from "./errores";

/** Una fila recibida, validada y con sus campos normalizados. `datos` es lo que `insertar` sabe guardar. */
export interface FilaComplementable<D = unknown> {
  /** `claveNormalizada` (D17). */
  clave: string;
  /** Cadenas con la escala de la columna: lo que se compara contra lo guardado. */
  campos: Readonly<Record<string, string>>;
  datos: D;
}

export interface ExistenteComplementable {
  clave: string;
  origen: "sire" | "manual";
  campos: Readonly<Record<string, string>>;
}

export interface PlanComplementable {
  readonly nuevas: readonly string[];
  readonly iguales: number;
  readonly distintas: readonly {
    readonly clave: string;
    readonly origenExistente: "sire" | "manual";
    readonly campos: readonly string[];
    readonly valoresSire: Readonly<Record<string, string>>;
  }[];
}

export interface EntradaComplemento<F extends FilaComplementable, T extends TxConsulta = TxConsulta> {
  clienteId: string;
  /** AAAAMM. */
  periodo: string;
  libro: LibroPropuesta;
  fuente: FuentePropuesta;
  /** SHA-256 hexadecimal del contenido recibido. */
  hash: string;
  usuarioId: string;
  trabajoId: string | null;
  /** Todas las recibidas, en el orden en que llegaron (la primera aparición de una clave repetida decide, D18). */
  filas: readonly F[];
  /** Filas vivas máximas del periodo tras complementar (P-9). */
  topeVivas: number;
  /** Lo ya guardado del periodo (sire y manual); se llama con el bloqueo tomado. */
  leerExistentes(tx: T): Promise<readonly ExistenteComplementable[]>;
  /** `planificarComplemento` del dominio: pura, sin IO. */
  planificar(
    existentes: readonly ExistenteComplementable[],
    recibidas: readonly { clave: string; campos: Readonly<Record<string, string>> }[],
  ): PlanComplementable;
  /** Inserta las filas nuevas con su propuesta. Nunca actualiza. */
  insertar(tx: T, propuestaId: string, nuevas: readonly F[]): Promise<void>;
}

export type ResultadoComplemento =
  /** Lo vivo del periodo pasaría del tope: no se escribió nada (ni el encabezado). */
  | { excedeTope: true }
  | { excedeTope: false; propuesta: PropuestaFila; plan: PlanComplementable };

/** Claves de una diferencia: `tipo|SERIE|numero` (D17); ninguna parte contiene `|`. */
function partesDeClave(clave: string): [string, string, string] {
  const [tipo = "", serie = "", numero = ""] = clave.split("|");
  return [tipo, serie, numero];
}

export async function aplicarComplemento<F extends FilaComplementable, T extends TxConsulta>(
  tx: T,
  e: EntradaComplemento<F, T>,
): Promise<ResultadoComplemento> {
  await bloquearPeriodoLibro(tx, e.clienteId, e.periodo, e.libro);
  const existentes = await e.leerExistentes(tx);
  const plan = e.planificar(
    existentes,
    e.filas.map((f) => ({ clave: f.clave, campos: f.campos })),
  );
  if (existentes.length + plan.nuevas.length > e.topeVivas) return { excedeTope: true };

  // La primera aparición de cada clave nueva es la que se guarda (D18).
  const porGuardar = new Set(plan.nuevas);
  const nuevas: F[] = [];
  for (const f of e.filas) if (porGuardar.delete(f.clave)) nuevas.push(f);

  const propuesta = await crearPropuesta(tx, {
    clienteId: e.clienteId,
    periodo: e.periodo,
    libro: e.libro,
    fuente: e.fuente,
    hash: e.hash,
    filasRecibidas: e.filas.length,
    filasNuevas: plan.nuevas.length,
    filasIguales: plan.iguales,
    filasDistintas: plan.distintas.length,
    usuarioId: e.usuarioId,
    trabajoId: e.trabajoId,
  });
  const diferencias: NuevaDiferencia[] = plan.distintas.map((x) => {
    const [tipo, serie, numero] = partesDeClave(x.clave);
    return {
      clave: x.clave,
      tipo,
      serie,
      numero,
      origenExistente: x.origenExistente,
      campos: [...x.campos],
      valoresSire: { ...x.valoresSire },
    };
  });
  await insertarDiferencias(tx, propuesta.id, diferencias);
  await e.insertar(tx, propuesta.id, nuevas);
  return { excedeTope: false, propuesta, plan };
}

/** Una fila para el hash: la clave de lo recibido tal como llegó (tipo, serie y número) y sus campos comparables. */
export interface FilaParaHash {
  tipo: string;
  serie: string;
  numero: string;
  campos: Readonly<Record<string, string>>;
}

/**
 * Hash del contenido recibido (`propuesta.hash`): no depende del orden de las filas ni de nada ajeno a ellas, así que el
 * mismo conjunto da siempre el mismo SHA-256, venga del SIRE o de un archivo. Cada fila entra con sus valores tal como
 * llegaron; las filas se ordenan antes de resumir.
 */
export function hashContenido(libro: string, periodo: string, filas: readonly FilaParaHash[]): string {
  const lineas = filas
    .map((f) =>
      JSON.stringify([
        f.tipo,
        f.serie,
        f.numero,
        ...Object.keys(f.campos)
          .sort()
          .map((k) => f.campos[k]),
      ]),
    )
    .sort();
  const h = createHash("sha256");
  h.update(JSON.stringify([libro, periodo, lineas]));
  return h.digest("hex");
}
