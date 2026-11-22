// Error del repositorio de la prorrata (spec 026, T4 rojo: contrato; lo completa T10). De todo error de `pg` solo se conserva el
// SQLSTATE (P0002, 55000, CA409, CA412, CA413, 22023, 42501...) o "desconocido"; nunca el mensaje, el detalle ni la tabla (pueden
// traer RUC o montos). El mensaje es fijo.
const SQLSTATE = /^[0-9A-Z]{5}$/;

export class ProrrataRepoError extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en prorrata (SQLSTATE ${codigo})`);
    this.name = "ProrrataRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): ProrrataRepoError {
    const code: unknown = (Object(error) as { code?: unknown }).code;
    return new ProrrataRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

export const NO_IMPLEMENTADO = "no implementado (spec 026, T10)";
