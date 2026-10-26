// Stub de T8 (rojo): T13 implementa. Contrato: ver apps/frontend/lib/sesion.spec.ts.
export interface Sesion {
  usuario: { id: string; nombre: string; correo: string };
  estudioActivo: { id: string; nombre: string } | null;
  csrf: string;
}

export async function obtenerSesion(forzar = false): Promise<Sesion | null> {
  void forzar;
  throw new Error("no implementado (T13)");
}

export function reiniciarSesion(): void {
  throw new Error("no implementado (T13)");
}
