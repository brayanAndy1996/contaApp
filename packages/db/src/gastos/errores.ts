// Error del repositorio de gastos no deducibles (spec 027, T4 rojo: contrato; lo completa T10). De todo error de `pg` solo se
// conserva el SQLSTATE (P0002, 55000, CA409, CA420-CA423, 22023, 42501...) o "desconocido"; nunca el mensaje, el detalle ni la tabla
// (pueden traer palabras del estudio, RUC o glosas). El mensaje es fijo.
const SQLSTATE = /^[0-9A-Z]{5}$/;

export class GastosRepoError extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en gastos (SQLSTATE ${codigo})`);
    this.name = "GastosRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): GastosRepoError {
    const code: unknown = (Object(error) as { code?: unknown }).code;
    return new GastosRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

export const NO_IMPLEMENTADO = "no implementado (spec 027, T10)";
