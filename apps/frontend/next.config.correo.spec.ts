import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spec 028 · T7 (rojo; R-7, D-4; plan, Frontend). `next.config.ts` protege la página pública `/baja`, cuya URL lleva el token
// de baja en la consulta (`?t=`): `Referrer-Policy: no-referrer` (el token no sale en el Referer hacia terceros) y
// `X-Robots-Tag: noindex` (no se indexa), sin otra política que las contradiga. Mismo patrón que `next.config.acceso.spec.ts`.

type Fuente = { source: string; headers: { key: string; value: string }[] };

async function cargar() {
  vi.resetModules();
  const modulo = await import("./next.config");
  return modulo.default;
}

/** Convierte un `source` de Next (`/x/:path*`) en regex para ver qué rutas cubre. */
function cubre(source: string, ruta: string): boolean {
  const patron = source.replace(/\/:[A-Za-z]+\*/g, "(?:/.*)?").replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${patron}$`).test(ruta);
}

function valores(fuentes: Fuente[], ruta: string, cabecera: string): string[] {
  return fuentes
    .filter((f) => cubre(f.source, ruta))
    .flatMap((f) => f.headers)
    .filter((h) => h.key.toLowerCase() === cabecera.toLowerCase())
    .map((h) => h.value);
}

describe("next.config.ts · /baja (028)", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:4000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Referrer-Policy: no-referrer para /baja, y ninguna otra política contradictoria", async () => {
    const config = await cargar();
    const fuentes = (await config.headers!()) as Fuente[];
    expect(valores(fuentes, "/baja", "Referrer-Policy")).toContain("no-referrer");
    expect(new Set(valores(fuentes, "/baja", "Referrer-Policy"))).toEqual(new Set(["no-referrer"]));
  });

  it("X-Robots-Tag con noindex para /baja", async () => {
    const config = await cargar();
    const fuentes = (await config.headers!()) as Fuente[];
    const robots = valores(fuentes, "/baja", "X-Robots-Tag");
    expect(robots.length).toBeGreaterThan(0);
    for (const v of robots) expect(v.toLowerCase()).toContain("noindex");
  });

  it("conserva no-referrer en /login, /recuperar, /recuperar/nueva, /invitacion y /registro/confirmar", async () => {
    const config = await cargar();
    const fuentes = (await config.headers!()) as Fuente[];
    for (const ruta of ["/login", "/recuperar", "/recuperar/nueva", "/invitacion", "/registro/confirmar"]) {
      expect(valores(fuentes, ruta, "Referrer-Policy"), ruta).toContain("no-referrer");
    }
  });

  it("no pone noindex al resto de la aplicación (solo a /baja)", async () => {
    const config = await cargar();
    const fuentes = (await config.headers!()) as Fuente[];
    for (const ruta of ["/", "/clientes", "/cuenta/correo", "/notificaciones"]) {
      expect(valores(fuentes, ruta, "X-Robots-Tag"), ruta).toEqual([]);
    }
  });
});
