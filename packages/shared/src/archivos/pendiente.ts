// Stub de T2 (012b): esquemas aún no implementados. T8 reemplaza estos archivos por los esquemas zod reales.
export function noImplementado(): never {
  throw new Error("no implementado");
}

export interface EsquemaPendiente<T = unknown> {
  safeParse: (valor: unknown) => { success: boolean; data?: T; error?: unknown };
}

export function esquemaPendiente<T = unknown>(): EsquemaPendiente<T> {
  return { safeParse: () => noImplementado() };
}
