import { useSyncExternalStore } from "react";
import { vi } from "vitest";

// Navegación simulada de `next/navigation` con URL VIVA (spec 024, T5): `push` y `replace` cambian la ruta y la
// búsqueda, y `useSearchParams` / `usePathname` se vuelven a leer, así una pantalla que guarda sus filtros en la URL se
// puede probar de punta a punta. Uso en una prueba:
//   vi.mock("next/navigation", async () => import("../../pruebas/navegacion"));
//   import { navegacion } from "../../pruebas/navegacion";
//   beforeEach(() => navegacion.reiniciar("/buzon?atencion=todos"));
// Solo datos y simulación de prueba; sin lógica de producción.

let ruta = "/";
let busqueda = "";
let parametros = new URLSearchParams();
const oyentes = new Set<() => void>();

function aplicar(url: string): void {
  const [rutaNueva = "/", resto = ""] = url.split("?", 2);
  ruta = rutaNueva === "" ? ruta : rutaNueva;
  busqueda = resto.split("#")[0] ?? "";
  parametros = new URLSearchParams(busqueda);
  oyentes.forEach((o) => o());
}

const suscribir = (o: () => void): (() => void) => {
  oyentes.add(o);
  return () => oyentes.delete(o);
};

export const navegacion = {
  /** Deja la URL como `url` (ruta y búsqueda) y limpia los espías. */
  reiniciar(url = "/"): void {
    this.push.mockClear();
    this.replace.mockClear();
    this.back.mockClear();
    aplicar(url);
  },
  /** URL actual (ruta + búsqueda). */
  url: (): string => (busqueda ? `${ruta}?${busqueda}` : ruta),
  ruta: (): string => ruta,
  /** Parámetros actuales como objeto plano. */
  parametros: (): Record<string, string> => Object.fromEntries(parametros),
  push: vi.fn((url: string) => aplicar(url)),
  replace: vi.fn((url: string) => aplicar(url)),
  back: vi.fn(),
  /** Destinos a los que se navegó con `push` o `replace`, en orden. */
  destinos: (): string[] => [...navegacion.push.mock.calls, ...navegacion.replace.mock.calls].map((c) => String(c[0])),
};

// --- exports que reemplazan a `next/navigation` ---
export const usePathname = (): string => useSyncExternalStore(suscribir, () => ruta, () => ruta);
export const useSearchParams = (): URLSearchParams =>
  useSyncExternalStore(suscribir, () => parametros, () => parametros);
export const useRouter = () => ({
  push: navegacion.push,
  replace: navegacion.replace,
  back: navegacion.back,
  refresh: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
});
export const useParams = (): Record<string, string> => ({});
