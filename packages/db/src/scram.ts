/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T3 (tester): T6 lo reemplaza con la implementación final (node:crypto, SCRAM-SHA-256).
export interface OpcionesVerificador {
  sal?: Buffer;
  iteraciones?: number;
}

export function generaVerificador(
  _password: string,
  _opciones?: OpcionesVerificador,
): string {
  throw new Error("no implementado");
}

export function verificaPassword(
  _verificador: string,
  _password: string,
): boolean {
  throw new Error("no implementado");
}
