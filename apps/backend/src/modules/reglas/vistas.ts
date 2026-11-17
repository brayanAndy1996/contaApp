import type { ReglaFila } from "@contapp/db";
import { reglaVistaSchema, type ReglaVista } from "@contapp/shared";
import { autorDe, type Autores } from "../compras/autor.js";

/** Fila de la BD → `ReglaVista`. El esquema es la última puerta: descarta toda clave que la vista no declara. */
export function aReglaVista(f: ReglaFila, autores: Autores): ReglaVista {
  return reglaVistaSchema.parse({
    id: f.id,
    proveedor: { tipo: f.docTipo, numero: f.docNumero, razonSocial: f.razonSocial },
    destino: f.destino,
    activa: f.activa,
    version: f.version,
    periodoAprendido: f.periodoAprendido,
    aplicada: f.aplicada,
    aceptada: f.aceptada,
    creadaPor: autorDe(autores, f.creadaPor),
    creadaEn: f.creadaEn.toISOString(),
    actualizadaEn: f.actualizadaEn.toISOString(),
  });
}
