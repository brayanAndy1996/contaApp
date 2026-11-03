// Filtros del listado de clientes (spec 007a, D7). Devuelven condiciones de drizzle con el texto del usuario SIEMPRE
// como parámetro ($n): nada de concatenar. Todas se combinan con AND (y con filtroAlcance en el repositorio).
import { sql, type SQL } from "drizzle-orm";
import { cliente } from "../schema/clientes";

export interface FiltrosListado {
  /** uuid del responsable, o "ninguno" para los clientes sin responsable. */
  responsable?: string;
  /** coincide si alguno de los dos tipos (sol, sire_api) está en ese estado; no_configurada = tipo sin fila. */
  credencial?: string;
  archivados?: boolean;
  q?: string;
}

/** Escapa los comodines de LIKE (\, % y _) del usuario; se usa con `ESCAPE '\'`. */
export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Condiciones del listado. Supone los alias del repositorio: `r` (asignación responsable) y `cr` (estado de las
 * credenciales por tipo, columnas `sol` y `sire_api`, nulas si el tipo no tiene fila).
 */
export function condicionesFiltros(f: FiltrosListado): SQL[] {
  const c: SQL[] = [];
  if (f.archivados !== true) c.push(sql`cliente.archivado_at is null`);
  if (f.responsable !== undefined) {
    c.push(
      f.responsable === "ninguno"
        ? sql`r.id is null`
        : sql`r.usuario_id = ${f.responsable}::uuid`,
    );
  }
  if (f.credencial !== undefined) {
    c.push(
      sql`(${f.credencial}::text = coalesce(cr.sol, 'no_configurada') or ${f.credencial}::text = coalesce(cr.sire_api, 'no_configurada'))`,
    );
  }
  if (f.q !== undefined && f.q !== "") {
    // Prefijo de RUC siempre; fragmento de razón social solo si q parece un nombre (tiene una letra) o son solo
    // dígitos. Un q sin letras con comodines (p. ej. «50%_\») es un RUC mal escrito, no un nombre.
    const esc = escaparLike(f.q);
    const buscaNombre = /\p{L}/u.test(f.q) || /^\d+$/.test(f.q);
    c.push(
      buscaNombre
        ? sql`(${cliente.ruc}::text ilike ${`${esc}%`} escape '\\' or ${cliente.razonSocial} ilike ${`%${esc}%`} escape '\\')`
        : sql`${cliente.ruc}::text ilike ${`${esc}%`} escape '\\'`,
    );
  }
  return c;
}
