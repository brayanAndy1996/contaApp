// Stub de T8 (rojo): T13 implementa. Contrato: ver apps/frontend/lib/api.spec.ts.
export interface RespuestaApi<T = unknown> {
  ok: boolean;
  status: number;
  datos: T | null;
}

export interface OpcionesApi {
  method?: string;
  body?: unknown;
  sinSesion?: boolean;
}

export async function api<T = unknown>(
  ruta: string,
  opciones?: OpcionesApi,
): Promise<RespuestaApi<T>> {
  void ruta;
  void opciones;
  throw new Error("no implementado (T13)");
}
