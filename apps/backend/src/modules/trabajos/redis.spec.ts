// T11 (008) · Unitarias de `RedisTrabajos`: conexión perezosa, una sola conexión por uso, cierre ordenado (QUIT si está
// lista, corte si no) y nada nuevo después del cierre. Sin Redis: fábrica de dobles.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RedisTrabajos } from "./redis.js";

class Conexion extends EventEmitter {
  constructor(public status: string) {
    super();
  }
  quit = vi.fn(async () => {
    if (this.status === "rota") throw new Error("x");
    this.status = "end";
  });
  disconnect = vi.fn(() => {
    this.status = "end";
  });
}

const opciones = { url: "redis://localhost:6379/15", prefijo: "p:" };

describe("RedisTrabajos", () => {
  it("no crea conexiones hasta el primer uso y luego reutiliza la misma", () => {
    const crear = vi.fn(() => new Conexion("wait") as never);
    const r = new RedisTrabajos(opciones, crear);
    expect(crear).not.toHaveBeenCalled();
    expect(r.claves.eventos("t")).toBe("p:eventos:t");
    const pub = r.publicador();
    expect(r.publicador()).toBe(pub);
    const sub = r.suscriptor();
    expect(r.suscriptor()).toBe(sub);
    expect(sub).not.toBe(pub);
    expect(crear).toHaveBeenCalledTimes(2);
    expect(crear).toHaveBeenCalledWith(
      opciones.url,
      expect.objectContaining({ lazyConnect: true, maxRetriesPerRequest: 1 }),
    );
    // Los errores de conexión no quedan sin manejar.
    expect(() =>
      (pub as unknown as Conexion).emit("error", new Error("caído")),
    ).not.toThrow();
  });

  it("cierre: QUIT a la conexión lista, corte a la que no lo está o falla al salir; después no abre otra", async () => {
    const conexiones = [new Conexion("ready"), new Conexion("reconnecting")];
    const crear = vi.fn(() => conexiones.shift() as never);
    const r = new RedisTrabajos(opciones, crear);
    const pub = r.publicador() as unknown as Conexion;
    const sub = r.suscriptor() as unknown as Conexion;
    await r.cerrar();
    expect(pub.quit).toHaveBeenCalledTimes(1);
    expect(pub.disconnect).not.toHaveBeenCalled();
    expect(sub.quit).not.toHaveBeenCalled();
    expect(sub.disconnect).toHaveBeenCalledTimes(1);
    expect(r.publicador()).toBeNull();
    expect(r.suscriptor()).toBeNull();

    const rota = new Conexion("rota");
    rota.status = "ready";
    rota.quit.mockRejectedValueOnce(new Error("x"));
    const r2 = new RedisTrabajos(opciones, () => rota as never);
    r2.publicador();
    await r2.onApplicationShutdown();
    expect(rota.disconnect).toHaveBeenCalledTimes(1);
  });

  it("sin fábrica usa ioredis con conexión perezosa: crear y cerrar no conecta ni cuelga con Redis inalcanzable", async () => {
    const r = new RedisTrabajos({
      url: "redis://127.0.0.1:1/15",
      prefijo: "p:",
    });
    const pub = r.publicador();
    expect(pub?.status).toBe("wait");
    await r.cerrar();
    expect(pub?.status).toBe("end");
  });
});
