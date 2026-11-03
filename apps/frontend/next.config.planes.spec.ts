import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contrato (plan 006, Archivos; D3): `next.config.ts` fija `Referrer-Policy: no-referrer` en
// `/registro/confirmar` (el token del enlace viaja en el fragmento `#t=`), sin otra política
// contradictoria, y conserva las de 004 y 005.

type Fuente = { source: string; headers: { key: string; value: string }[] };

async function cargar() {
  vi.resetModules();
  const modulo = await import("./next.config");
  return modulo.default;
}

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

describe("next.config.ts · /registro/confirmar", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_URL", "http://backend.test:4000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Referrer-Policy: no-referrer para /registro/confirmar, sin política contradictoria", async () => {
    const config = await cargar();
    const fuentes = (await config.headers?.()) as Fuente[];
    expect(politicasPara(fuentes, "/registro/confirmar")).toEqual([
      "no-referrer",
    ]);
  });

  it("conserva no-referrer en /login, /recuperar e /invitacion", async () => {
    const config = await cargar();
    const fuentes = (await config.headers?.()) as Fuente[];
    for (const ruta of ["/login", "/recuperar", "/invitacion"]) {
      expect(politicasPara(fuentes, ruta), ruta).toEqual(["no-referrer"]);
    }
  });
});
