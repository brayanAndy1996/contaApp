// Spec 009 · T7 (D11, D18): qué hacer cuando la BD compartida tiene trabajos vivos de otras suites antes de las
// pruebas de cierre de 008. Con `CI=true` es un fallo (no se puede dejar sin cubrir el cierre en silencio); sin `CI`
// se omite, como antes (en local la BD suele compartirse con otras suites).
export const MENSAJE_BD_NO_DESPEJADA =
  "BD no despejada: hay trabajos vivos de otras suites (job_registro en en_cola/ejecutando con más de 20 s sin cambios); " +
  "las pruebas de cierre deben correr en serie y con la BD despejada (ci:cierre)";

export type AccionBdNoDespejada = "fallar" | "omitir";

export function accionBdNoDespejada(env: {
  CI?: string | undefined;
}): AccionBdNoDespejada {
  return env.CI === "true" ? "fallar" : "omitir";
}

/** Si la BD no está despejada: falla con la causa (`CI=true`) u omite la prueba (sin `CI`). */
export function exigirBdDespejada(
  despejada: boolean,
  ctx: { skip: () => never },
  env: { CI?: string | undefined } = process.env,
): void {
  if (despejada) return;
  if (accionBdNoDespejada(env) === "fallar") {
    throw new Error(MENSAJE_BD_NO_DESPEJADA);
  }
  ctx.skip();
}
