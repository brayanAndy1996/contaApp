import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contrato (plan 005, Frontend; CA-15, D7): `next.config.ts` fija `Referrer-Policy: no-referrer` en
// `/invitacion` (el token viaja en el fragmento `#t=`) además de las rutas de 004, y sin otra
// política contradictoria.

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

describe("next.config.ts · /invitacion", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:4000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Referrer-Policy: no-referrer para /invitacion", async () => {
    const config = await cargar();
    expect(typeof config.headers).toBe("function");
    const fuentes = (await config.headers!()) as Fuente[];
    expect(politicasPara(fuentes, "/invitacion")).toContain("no-referrer");
  });

  it("ninguna regla da otra Referrer-Policy a /invitacion", async () => {
    const config = await cargar();
    const fuentes = (await config.headers!()) as Fuente[];
    expect(new Set(politicasPara(fuentes, "/invitacion"))).toEqual(
      new Set(["no-referrer"]),
    );
  });

  it("conserva no-referrer en /login, /recuperar y /recuperar/nueva", async () => {
    const config = await cargar();
    const fuentes = (await config.headers!()) as Fuente[];
    for (const ruta of ["/login", "/recuperar", "/recuperar/nueva"]) {
      expect(politicasPara(fuentes, ruta), ruta).toContain("no-referrer");
    }
  });
});
