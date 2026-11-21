// Auxiliares del módulo aprendizaje (spec 025): errores de BD → HTTP, cursor de candidatas y vistas. Nada aquí lleva RUC ni razón
// social a un error o a un log (D-11): los errores salen como códigos y los datos del proveedor solo viajan en `proveedor`.
import {
  AprendizajeRepoError,
  type CandidataFila,
  type ImportacionFila,
  type PosicionCandidata,
} from "@contapp/db";
import {
  candidataVistaSchema,
  importacionVistaSchema,
  type CandidataVista,
  type ImportacionVista,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { autorDe, type Autores } from "../compras/autor.js";
import { ReglasError } from "../reglas/errores.js";

export { exigirCliente, idDe } from "../compras/apoyo.js";

/**
 * SQLSTATE de las funciones de 0062 → respuesta HTTP (plan 025, «Contratos: HTTP»): `P0002` → 404 (cliente, candidata o importación
 * ajena o inexistente: el mismo 404), `55000` → 409 `cliente_archivado`, `23505` → 409 `importacion_en_curso`, `22023` → 400
 * `solicitud_invalida`. En `reemplazar`, `55000` es también «la candidata ya no está pendiente» o «la regla ya no tiene conflicto»
 * (el archivado ya se comprobó antes): el estado cambió bajo el pie de quien pide, es `regla_cambiada`. Cualquier otro error pasa
 * tal cual (los interbloqueos los reintenta `conReintentoUnico`; el resto el filtro global lo responde 500 sin detalle).
 */
export function aErrorHttp(e: unknown, enReemplazo = false): unknown {
  if (!(e instanceof AprendizajeRepoError)) return e;
  switch (e.codigo) {
    case "P0002":
      return new AccesoError("no_encontrado");
    case "55000":
      return enReemplazo ? new ReglasError("regla_cambiada") : new AccesoError("cliente_archivado");
    case "23505":
      return new ReglasError("importacion_en_curso");
    case "22023":
      return new AccesoError("solicitud_invalida");
    default:
      return e;
  }
}

/** Cursor opaco de candidatas: el valor `(doc_tipo, doc_numero)` de la última fila de la página, no un desplazamiento. */
export function codificarCursor(p: PosicionCandidata): string {
  return Buffer.from(JSON.stringify([p.docTipo, p.docNumero]), "utf8").toString("base64url");
}

/** Cursor mal formado (no base64url, no JSON, otra forma o textos largos): 400 `solicitud_invalida`. */
export function decodificarCursor(cursor: string): PosicionCandidata {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new AccesoError("solicitud_invalida");
  let valor: unknown;
  try {
    valor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AccesoError("solicitud_invalida");
  }
  if (
    !Array.isArray(valor) ||
    valor.length !== 2 ||
    !valor.every((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64)
  )
    throw new AccesoError("solicitud_invalida");
  return { docTipo: valor[0] as string, docNumero: valor[1] as string };
}

/** Instante a precisión de segundos (`2026-10-15T14:30:05Z`): la pantalla no muestra fracciones y la respuesta no lleva decimales sueltos. */
const aInstante = (f: Date): string => f.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Fila de la BD → `ImportacionVista`; el esquema descarta toda clave que la vista no declara (solo conteos y periodos, D-11). */
export function aImportacionVista(f: ImportacionFila, autores: Autores): ImportacionVista {
  return importacionVistaSchema.parse({
    id: f.id,
    estado: f.estado,
    periodos: f.periodos,
    solicitadaPor: autorDe(autores, f.solicitadaPor.id),
    solicitadaEn: aInstante(f.solicitadaEn),
    terminadaEn: f.terminadaEn === null ? null : aInstante(f.terminadaEn),
    resumen: f.resumen,
    motivo: f.motivo,
    trabajoId: f.trabajoId,
  });
}

export function aCandidataVista(f: CandidataFila): CandidataVista {
  return candidataVistaSchema.parse(f);
}
