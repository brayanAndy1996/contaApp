import { vi } from "vitest";
import type { ContextoCompras } from "../lib/compras";
import { CLIENTE_ID, PERIODO } from "./compras";

// Contexto de prueba para los componentes de acciones de compras (spec 015, T7 a T9): los tres `recargar*` son
// espías que resuelven al instante. Solo datos de prueba.

export type ContextoPrueba = ContextoCompras & {
  recargarFila: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  recargarFilas: ReturnType<typeof vi.fn<(ids: string[]) => Promise<void>>>;
  recargarResumen: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

export function contextoDe(
  parcial: Partial<Omit<ContextoCompras, "permisos">> & {
    permisos?: Partial<ContextoCompras["permisos"]>;
  } = {},
): ContextoPrueba {
  const { permisos, ...resto } = parcial;
  return {
    clienteId: CLIENTE_ID,
    periodo: PERIODO,
    estado: "abierto",
    soloLectura: null,
    recargarFila: vi.fn(async () => undefined),
    recargarFilas: vi.fn(async () => undefined),
    recargarResumen: vi.fn(async () => undefined),
    ...resto,
    permisos: {
      ver: true,
      descargar: true,
      clasificar: true,
      aprobarGenerar: true,
      ...permisos,
    },
  } as ContextoPrueba;
}
