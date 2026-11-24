// Spec 028 (T12): `BajaService` sin BD. Límite por IP con el tipo `correo_baja_ip`, 400 por `bajaSchema`, hash SHA-256 del texto del token y
// la baja de un clic solo con el cuerpo exacto de RFC 8058.
import "reflect-metadata";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BajaService } from "./baja.service.js";

const TOKEN = "A".repeat(43);
const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const repo = { limiteConsumir: vi.fn(), aplicarBaja: vi.fn() };
const servicio = () => new BajaService({ withAuth: (f: (a: typeof repo) => Promise<unknown>) => f(repo) } as never);
const UN_CLIC = Buffer.from("List-Unsubscribe=One-Click");
const fallo = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { getStatus(): number; getResponse(): unknown });

beforeEach(() => {
  repo.limiteConsumir.mockReset().mockResolvedValue(true);
  repo.aplicarBaja.mockReset().mockResolvedValue(undefined);
});

describe("confirmar ({token})", () => {
  it("aplica la baja con el SHA-256 del texto del token y responde {}", async () => {
    expect(await servicio().confirmar({ token: TOKEN }, "10.1.2.3")).toEqual({});
    expect(repo.limiteConsumir).toHaveBeenCalledWith("correo_baja_ip", "10.1.2.3");
    expect(repo.aplicarBaja).toHaveBeenCalledWith(HASH);
  });

  it("cuerpo que no cumple bajaSchema: 400 sin aplicar; pasado el límite: 429 sin leer el cuerpo", async () => {
    for (const cuerpo of [undefined, {}, { token: "corto" }, { token: TOKEN, x: 1 }]) {
      const e = await fallo(servicio().confirmar(cuerpo, "10.1.2.3"));
      expect(e?.getStatus()).toBe(400);
      expect(e?.getResponse()).toEqual({ codigo: "solicitud_invalida" });
    }
    repo.limiteConsumir.mockResolvedValue(false);
    const e = await fallo(servicio().confirmar({ token: TOKEN }, "10.1.2.3"));
    expect(e?.getStatus()).toBe(429);
    expect(e?.getResponse()).toEqual({ codigo: "demasiados_intentos" });
    expect(repo.aplicarBaja).not.toHaveBeenCalled();
  });

  it("una IP que no es IP cae en la cubeta común", async () => {
    await servicio().confirmar({ token: TOKEN }, undefined);
    expect(repo.limiteConsumir).toHaveBeenCalledWith("correo_baja_ip", "ip_invalida");
  });
});

describe("unClic (RFC 8058)", () => {
  it("con el cuerpo exacto y un token con forma de token aplica la baja", async () => {
    expect(await servicio().unClic(TOKEN, UN_CLIC, "10.1.2.3")).toEqual({});
    expect(repo.aplicarBaja).toHaveBeenCalledWith(HASH);
  });

  it("sin cuerpo exacto, sin cuerpo crudo o con token ausente, repetido o mal formado: {} sin efectos", async () => {
    const s = servicio();
    for (const [t, c] of [
      [TOKEN, Buffer.from("List-Unsubscribe=Other")],
      [TOKEN, Buffer.from("List-Unsubscribe=One-Click&x=1")],
      [TOKEN, undefined],
      [TOKEN, { "List-Unsubscribe": "One-Click" }],
      [undefined, UN_CLIC],
      [[TOKEN, TOKEN], UN_CLIC],
      ["corto", UN_CLIC],
    ] as const)
      expect(await s.unClic(t, c, "10.1.2.3")).toEqual({});
    expect(repo.aplicarBaja).not.toHaveBeenCalled();
  });

  it("comparte el límite por IP: pasado el límite, 429 aun con el cuerpo exacto", async () => {
    repo.limiteConsumir.mockResolvedValue(false);
    const e = await fallo(servicio().unClic(TOKEN, UN_CLIC, "10.1.2.3"));
    expect(e?.getStatus()).toBe(429);
    expect(repo.aplicarBaja).not.toHaveBeenCalled();
  });
});
