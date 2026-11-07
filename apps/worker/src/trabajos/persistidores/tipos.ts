// Contrato de un persistidor por libro del SIRE (spec 013, D2, D16; plan "Persistidor común"). El procesador
// `sire.propuesta.descargar` es común: baja la propuesta, compara con lo guardado y deja el encabezado y las diferencias;
// cada libro solo aporta lo suyo (validar sus filas, leer lo existente e insertar las nuevas). 014 agrega el de compras
// en `index.ts` sin tocar nada común.
import type { FilaComplementable, Tx } from "@contapp/db";
import type { ExistenteComplemento } from "@contapp/domain";

export type LibroSire = "compras" | "ventas";

/** Transacción de `withTenant`, ya con el bloqueo del periodo tomado. */
export type TxPersistidor = Tx;

export interface ContextoPersistidor {
  clienteId: string;
  /** AAAAMM. */
  periodo: string;
}

/**
 * Una fila validada y lista para comparar. `campos` son cadenas ya normalizadas con la escala de la columna (lo mismo que
 * devuelve `leerExistentes`); `datos` es lo que `insertar` sabe guardar y el procesador no abre.
 */
export interface FilaPreparada<D = unknown> extends FilaComplementable<D> {
  /** Tal como llegó, solo para el hash del contenido. */
  tipo: string;
  serie: string;
  numero: string;
}

export interface PersistidorLibro<D = unknown> {
  /**
   * Valida cada fila cruda del puerto y la normaliza. Una fila ilegible lanza `ErrorPropuesta("fila_invalida")` sin
   * incluir su contenido: omitirla en silencio es el daño que HU-12 quiere evitar (D3).
   */
  preparar(filas: readonly unknown[]): FilaPreparada<D>[];
  /** Lo ya guardado del periodo (sire y manual) en la forma de `planificarComplemento`. */
  leerExistentes(
    tx: TxPersistidor,
    ctx: ContextoPersistidor,
  ): Promise<ExistenteComplemento[]>;
  /** Inserta las filas nuevas (primera aparición de cada clave) con su propuesta. Nunca actualiza. */
  insertar(
    tx: TxPersistidor,
    ctx: ContextoPersistidor,
    propuestaId: string,
    nuevas: readonly FilaPreparada<D>[],
  ): Promise<void>;
}

/** Un persistidor por libro; el libro sin el suyo da `libro_no_soportado`. */
export type PersistidoresLibro = Partial<Record<LibroSire, PersistidorLibro>>;
