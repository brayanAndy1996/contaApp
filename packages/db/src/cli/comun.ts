// Utilidades de los CLI de migración y seed. Únicos lectores de MIGRATIONS_DATABASE_URL (CA-2b).
// Nunca imprimen URLs, contraseñas ni verificadores: solo mensajes fijos o el código/mensaje de PostgreSQL.

/** Error con mensaje fijo, seguro de mostrar. */
export class ErrorCli extends Error {}

export function urlMigraciones(): string {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new ErrorCli("falta MIGRATIONS_DATABASE_URL");
  return url;
}

/** Mensaje mostrable de un error sin filtrar valores de conexión. */
export function mensajeSeguro(e: unknown): string {
  if (e instanceof ErrorCli) return e.message;
  const err = e as { code?: unknown; message?: unknown; severity?: unknown; cause?: unknown };
  // Drizzle envuelve el error de pg (DrizzleQueryError) y su mensaje incluye parámetros: usar la causa.
  if (err?.cause !== undefined && err.cause !== e) return mensajeSeguro(err.cause);
  // Errores del servidor PostgreSQL (traen severity y SQLSTATE): su mensaje no incluye la URL.
  if (typeof err?.severity === "string" && typeof err.code === "string") {
    return `PostgreSQL ${err.code}: ${String(err.message)}`;
  }
  // Errores de red/parsing pueden incluir la cadena de conexión: solo el código.
  const codigo = typeof err?.code === "string" ? err.code : "desconocido";
  return `error de conexion o de ejecucion (${codigo})`;
}

export function ejecutar(nombre: string, fn: () => Promise<void>): void {
  fn().then(
    () => {
      console.log(`${nombre}: OK`);
    },
    (e: unknown) => {
      console.error(`${nombre}: ${mensajeSeguro(e)}`);
      process.exitCode = 1;
    },
  );
}
