import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contrato (plan 007b, Decisiones: Panel; D10): `next.config.ts` conserva el rewrite `/api/:path*` →
// `${BACKEND_URL}/:path*` por el que pasan el stream SSE y la subida de archivos, sin reglas que lo
// desvíen o lo dupliquen. La decisión de `compress: false` queda para T18 (prueba manual con Next
// real): aquí solo se exige que, si se define, sea un booleano explícito.

type Regla = { source: string; destination: string };

async function cargar() {
  vi.resetModules();
  const modulo = await import("./next.config");
  return modulo.default;
}

async function reglas(): Promise<Regla[]> {
  const config = await cargar();
  const r = await config.rewrites!();
  return (
    Array.isArray(r)
      ? r
      : [
          ...(r.beforeFiles ?? []),
          ...(r.afterFiles ?? []),
          ...(r.fallback ?? []),
        ]
  ) as Regla[];
}

describe("next.config.ts · proxy de /api/* para el panel y la importación (007b)", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:4000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("una sola regla cubre /api/*, hacia el backend, sin tocar la ruta del stream ni la de importación", async () => {
    const todas = await reglas();
    const api = todas.filter((r) => r.source.startsWith("/api"));
    expect(api).toEqual([
      { source: "/api/:path*", destination: "http://backend.test:4000/:path*" },
    ]);
  });

  it("ninguna regla redirige /trabajos ni /clientes/importar (son pantallas de Next, no del backend)", async () => {
    const todas = await reglas();
    for (const r of todas) {
      expect(r.source, r.source).not.toMatch(/^\/trabajos/);
      expect(r.source, r.source).not.toMatch(/^\/clientes/);
    }
  });

  it("compress, si se define, es un booleano explícito", async () => {
    const config = await cargar();
    if ("compress" in config && config.compress !== undefined) {
      expect(typeof config.compress).toBe("boolean");
    }
  });

  it("conserva cacheComponents y las cabeceras previas", async () => {
    const config = await cargar();
    expect(config.cacheComponents).toBe(true);
    expect(typeof config.headers).toBe("function");
  });
});
