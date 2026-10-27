// Arranque de los CLI del paquete. La guarda `require.main === module` vive aquí, con sus valores
// recibidos como parámetros, para poder probar sus dos ramas (bajo vitest `require.main` no es el
// módulo del CLI y la rama de ejecución directa nunca se alcanza desde el propio CLI).

/** ¿El proceso arrancó con este módulo como entrada (`node dist/cli/x.js`)? */
export function esEjecucionDirecta(principal: unknown, modulo: unknown): boolean {
  return principal === modulo;
}

/**
 * Si el módulo es la entrada del proceso, corre `ejecutor(argv)` y fija `process.exitCode` con el
 * código devuelto. Si fue importado (pruebas, otro módulo), no hace nada.
 */
export function arrancarSiDirecta(
  principal: unknown,
  modulo: unknown,
  ejecutor: (argv: string[]) => Promise<number>,
  argv: string[],
): void {
  if (!esEjecucionDirecta(principal, modulo)) return;
  void ejecutor(argv).then((codigo) => {
    process.exitCode = codigo;
  });
}
