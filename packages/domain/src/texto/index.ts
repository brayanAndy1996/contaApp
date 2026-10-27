// STUB de T4 (tester) para que compile el contexto de reglas: T8 lo reemplaza con la implementación real.
export interface EntradaDiccionario { readonly categoria: string; readonly palabras: readonly string[] }
export function tokensDeGlosa(_glosa: string): readonly string[] {
  throw new Error("no implementado");
}
export class DiccionarioGlosas {
  static desde(_e: readonly EntradaDiccionario[]): DiccionarioGlosas {
    throw new Error("no implementado");
  }
  buscar(_glosas: readonly string[]): { palabra: string; categoria: string } | null {
    throw new Error("no implementado");
  }
}
export const DICCIONARIO_GLOSAS_BASE: DiccionarioGlosas = Object.freeze(
  Object.create(DiccionarioGlosas.prototype) as DiccionarioGlosas,
);
