// Contrato de un persistidor por libro del SIRE (spec 013, D2, D16; plan "Persistidor común"). El procesador
// `sire.propuesta.descargar` es común: baja la propuesta, compara con lo guardado y deja el encabezado y las diferencias;
// cada libro solo aporta lo suyo (validar sus filas, leer lo existente e insertar las nuevas). 014 agrega el de compras
// en `index.ts` sin tocar nada común.
import type { ContappDb, FilaComplementable, Tx } from "@contapp/db";
import type { ExistenteComplemento } from "@contapp/domain";
import type { RedisEncolado } from "../encolar-xml.js";

export type LibroSire = "compras" | "ventas";

/** Transacción de `withTenant`, ya con el bloqueo del periodo tomado. */
export type TxPersistidor = Tx;

export interface ContextoPersistidor {
  clienteId: string;
  /** AAAAMM. */
  periodo: string;
}

/**
 * Contexto de `trasConfirmar` (spec 016): el del periodo más lo que hace falta para encolar trabajos nuevos después del commit
 * de la descarga (el estudio, el usuario que la pidió, la BD y, si el worker la tiene, la conexión a Redis para publicar).
 */
export interface ContextoTras extends ContextoPersistidor {
  tenantId: string;
  /** Trabajo de descarga en curso: los `withTenant` que abra el gancho llevan su actor `trabajo` (017). */
  trabajoId?: string;
  usuarioId: string;
  db: Pick<ContappDb, "withTenant">;
  redis?: RedisEncolado;
  prefijo?: string;
}

/**
 * Una fila validada y lista para comparar. `campos` son cadenas ya normalizadas con la escala de la columna (lo mismo que
 * devuelve `leerExistentes`); `datos` es lo que `insertar` sabe guardar y el procesador no abre.
 */
export interface FilaPreparada<D = unknown> extends FilaComplementable<D> {
  /** Para el hash del contenido; la serie ya en mayúsculas (D17). */
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
  /**
   * Opcional (016). La descarga lo llama UNA vez, DESPUÉS del commit, con la propuesta creada. Su fallo no hace fallar la
   * descarga ni cambia su `resultado`: el procesador solo registra un código. Compras encola ahí los lotes de XML.
   */
  trasConfirmar?(ctx: ContextoTras, propuestaId: string): Promise<void>;
}

/** Un persistidor por libro; el libro sin el suyo da `libro_no_soportado`. */
export type PersistidoresLibro = Partial<Record<LibroSire, PersistidorLibro>>;
