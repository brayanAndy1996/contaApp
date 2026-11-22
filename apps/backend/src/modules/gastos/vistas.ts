import type { CambioGlobalFila, CategoriasClienteLeidas, GastosEstudioLeido, PalabraGlobalFila } from "@contapp/db";
import { categoriasPermitidas, CATEGORIAS_GND, seccionCiiu } from "@contapp/domain";
import {
  categoriasClienteVistaSchema,
  diccionarioGlobalVistaSchema,
  gastosEstudioVistaSchema,
  historialGlobalVistaSchema,
  LIMITE_PALABRAS_PROPIAS,
  type CategoriasClienteVista,
  type DiccionarioGlobalVista,
  type GastosEstudioVista,
  type HistorialGlobalVista,
} from "@contapp/shared";
import { autorDe, type Autores } from "../compras/autor.js";

// Filas de la BD → vistas de `@contapp/shared`. El esquema es la última puerta: descarta toda clave que la vista no declara y falla (500
// sin detalle) si algo no cumple. Ninguna vista lleva glosas ni texto del XML (R-5): solo palabras del diccionario y conteos.

/** `autores` resuelve el nombre y si sigue activo (017, D-12): quien agregó la palabra puede haberse desactivado después. */
export function aGastosEstudioVista(l: GastosEstudioLeido, autores: Autores): GastosEstudioVista {
  return gastosEstudioVistaSchema.parse({
    umbral: l.umbral,
    versionUmbral: l.versionUmbral,
    activasPropias: l.activasPropias,
    limitePropias: LIMITE_PALABRAS_PROPIAS,
    globales: l.globales.map((g) => ({
      id: g.id,
      palabra: g.palabra,
      categoria: g.categoria,
      excepciones: g.excepciones,
      desactivadaPorEstudio: g.desactivadaPorEstudio,
    })),
    propias: l.propias.map((p) => ({
      id: p.id,
      palabra: p.palabra,
      categoria: p.categoria,
      excepciones: p.excepciones,
      origen: p.origen,
      activa: p.activa,
      version: p.version,
      autor: autorDe(autores, p.autor.id),
      compraOrigenId: p.compraOrigenId,
      creadaEn: p.creadaEn.toISOString(),
    })),
  });
}

/** En el orden fijo de las seis categorías (no en el del conjunto). */
const enOrden = (c: ReadonlySet<string>): string[] => CATEGORIAS_GND.filter((x) => c.has(x));

/**
 * R-13, D-6: sin clase CIIU en la caché no hay base (la vista muestra solo el ajuste); con ella, `efectivas = (base ∪ permitidas) −
 * quitadas` con la matriz del dominio. La sección es la de la división de la clase.
 */
export function aCategoriasClienteVista(l: CategoriasClienteLeidas): CategoriasClienteVista {
  const ajuste = { permitidas: l.permitidas, quitadas: l.quitadas };
  const base = l.ciiu === null ? new Set<string>() : categoriasPermitidas(l.ciiu, { permitidas: [], quitadas: [] });
  const efectivas =
    l.ciiu === null
      ? new Set(l.permitidas.filter((c) => !l.quitadas.includes(c)))
      : categoriasPermitidas(l.ciiu, ajuste);
  return categoriasClienteVistaSchema.parse({
    ciiu: l.ciiu,
    seccion: l.ciiu === null ? null : seccionCiiu(l.ciiu),
    base: enOrden(base),
    permitidas: l.permitidas,
    quitadas: l.quitadas,
    efectivas: enOrden(efectivas),
    version: l.version,
  });
}

type PalabraGlobalVistaDto = DiccionarioGlobalVista["palabras"][number];

const aPalabraGlobal = (f: PalabraGlobalFila) => ({
  id: f.id,
  palabra: f.palabra,
  categoria: f.categoria,
  excepciones: f.excepciones,
  activa: f.activa,
  version: f.version,
  actualizadaEn: f.actualizadaEn.toISOString(),
});

/** Una palabra del diccionario global tal como la lista (también la respuesta de agregar y editar). */
export const aPalabraGlobalVista = (f: PalabraGlobalFila): PalabraGlobalVistaDto =>
  diccionarioGlobalVistaSchema.shape.palabras.element.parse(aPalabraGlobal(f));

export function aDiccionarioGlobalVista(filas: readonly PalabraGlobalFila[]): DiccionarioGlobalVista {
  return diccionarioGlobalVistaSchema.parse({ palabras: filas.map(aPalabraGlobal) });
}

/**
 * Página del historial global: más recientes primero; `siguiente` es el `antes` de la página que sigue (la fecha de la última fila de
 * una página llena) o `null` si ya no hay más.
 */
export function aHistorialGlobalVista(filas: readonly CambioGlobalFila[], limite: number): HistorialGlobalVista {
  const ultima = filas.length === limite ? filas[filas.length - 1] : undefined;
  return historialGlobalVistaSchema.parse({
    items: filas.map((f) => ({
      id: f.id,
      palabraGlobalId: f.palabraGlobalId,
      palabra: f.palabra,
      accion: f.accion,
      antes: f.antes,
      despues: f.despues,
      // El autor es un super-admin de plataforma (no es miembro de ningún estudio): su nombre sale de la función y está activo.
      autor: { id: f.autor.id, nombre: f.autor.nombre, activo: true },
      ocurridaEn: f.ocurridaEn.toISOString(),
    })),
    siguiente: ultima === undefined ? null : ultima.ocurridaEn.toISOString(),
  });
}
