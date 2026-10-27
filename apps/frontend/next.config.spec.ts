import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contrato (plan 004, Frontend; CA-12): `next.config.ts` reescribe `/api/:path*` hacia
// `${BACKEND_URL}/:path*` y fija `Referrer-Policy: no-referrer` en `/recuperar/:path*` y `/login`.

type Fuente = { source: string; headers: { key: string; value: string }[] };

async function cargar() {
  vi.resetModules();
  const modulo = await import("./next.config");
  return modulo.default;
}

/** Convierte un `source` de Next (`/x/:path*`) en regex para ver qué rutas cubre. */
function cubre(source: string, ruta: string): boolean {
  const patron = source
    .replace(/\/:[A-Za-z]+\*/g, "(?:/.*)?")
    .replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${patron}$`).test(ruta);
}

function politicasPara(fuentes: Fuente[], ruta: string): string[] {
  return fuentes
    .filter((f) => cubre(f.source, ruta))
    .flatMap((f) => f.headers)
    .filter((h) => h.key.toLowerCase() === "referrer-policy")
    .map((h) => h.value);
}

describe("next.config.ts", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:4000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Referrer-Policy: no-referrer para /recuperar/nueva, /recuperar y /login", async () => {
    const config = await cargar();
    expect(typeof config.headers).toBe("function");
    const fuentes = (await config.headers!()) as Fuente[];
    for (const ruta of ["/recuperar/nueva", "/recuperar", "/login"]) {
      expect(politicasPara(fuentes, ruta), ruta).toContain("no-referrer");
    }
  });

  it("ninguna regla de cabeceras da otra Referrer-Policy a /recuperar/nueva", async () => {
    const config = await cargar();
    expect(typeof config.headers).toBe("function");
    const fuentes = (await config.headers!()) as Fuente[];
    expect(new Set(politicasPara(fuentes, "/recuperar/nueva"))).toEqual(
      new Set(["no-referrer"]),
    );
  });

  it("rewrite /api/:path* → ${BACKEND_URL}/:path*", async () => {
    const config = await cargar();
    expect(typeof config.rewrites).toBe("function");
    const r = await config.rewrites!();
    const reglas = Array.isArray(r)
      ? r
      : [
          ...(r.beforeFiles ?? []),
          ...(r.afterFiles ?? []),
          ...(r.fallback ?? []),
        ];
    const regla = reglas.find((x) => x.source === "/api/:path*");
    expect(regla?.destination).toBe("http://backend.test:4000/:path*");
  });

  it("conserva la configuración previa (cacheComponents)", async () => {
    const config = await cargar();
    expect(config.cacheComponents).toBe(true);
  });
});
