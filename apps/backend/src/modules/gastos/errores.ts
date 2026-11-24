import { HttpException, HttpStatus } from "@nestjs/common";
import { AuthRepoError, GastosRepoError } from "@contapp/db";
import type { CodigoErrorGastos } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";

const ESTADO: Record<CodigoErrorGastos, number> = {
  // R-8, D-4: la versión que vio quien guarda ya no es la vigente (compare-and-set).
  version_cambiada: HttpStatus.CONFLICT,
  // R-4: la palabra ya existe en el diccionario (propio del estudio o global).
  palabra_existente: HttpStatus.CONFLICT,
  // R-4: el estudio ya tiene 2.000 palabras propias activas.
  limite_palabras: HttpStatus.CONFLICT,
  // R-7: aprender exige una compra con exclusión vigente.
  compra_no_excluida: HttpStatus.CONFLICT,
  // R-7: aprender exige el XML vigente del comprobante (las glosas salen de él).
  compra_sin_xml: HttpStatus.CONFLICT,
  // R-12: «Volver a evaluar» solo en un periodo `abierto`.
  periodo_no_abierto: HttpStatus.CONFLICT,
};

/** Error de gastos no deducibles (spec 027): el cuerpo es solo `{ codigo }`, sin palabras, glosas ni ids (CA-11). */
export class GastosError extends HttpException {
  readonly codigo: CodigoErrorGastos;

  constructor(codigo: CodigoErrorGastos) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "GastosError";
    this.codigo = codigo;
  }
}

/** SQLSTATE de un error del repositorio de gastos o del de plataforma; `null` si es de otra clase (se propaga tal cual). */
function sqlstateDe(e: unknown): string | null {
  return e instanceof GastosRepoError || e instanceof AuthRepoError ? e.codigo : null;
}

/** `true` si el error es el SQLSTATE dado (p. ej. `22023` «sin cambios» de `gnd_global_estado`). */
export const esSqlstate = (e: unknown, codigo: string): boolean => sqlstateDe(e) === codigo;

/**
 * SQLSTATE de las funciones de 0070 → HTTP (plan 027, «Mapeo»): `P0002` → 404 `no_encontrado` (id ajeno o inexistente: el mismo 404),
 * `55000` → 409 `cliente_archivado`, `CA409` → `version_cambiada`, `CA420` → `palabra_existente`, `CA421` → `limite_palabras`, `CA422` →
 * `compra_no_excluida`, `CA423` → `compra_sin_xml`, `22023` → 400 `solicitud_invalida`, `42501` → 403 `permiso_denegado` (sesión sin
 * alta o sin membresía viva). Cualquier otro error pasa tal cual (los interbloqueos los reintenta `conReintentoUnico`; el resto el filtro
 * global lo responde 500 sin detalle).
 */
export function aErrorHttp(e: unknown): unknown {
  switch (sqlstateDe(e)) {
    case "P0002":
      return new AccesoError("no_encontrado");
    case "55000":
      return new AccesoError("cliente_archivado");
    case "CA409":
      return new GastosError("version_cambiada");
    case "CA420":
      return new GastosError("palabra_existente");
    case "CA421":
      return new GastosError("limite_palabras");
    case "CA422":
      return new GastosError("compra_no_excluida");
    case "CA423":
      return new GastosError("compra_sin_xml");
    case "22023":
      return new AccesoError("solicitud_invalida");
    case "42501":
      return new AccesoError("permiso_denegado");
    default:
      return e;
  }
}
