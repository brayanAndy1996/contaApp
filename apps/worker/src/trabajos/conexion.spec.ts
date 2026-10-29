// Unitarias de la conexión de BullMQ desde REDIS_URL (T10).
import { describe, expect, it } from "vitest";
import { conexionDesdeUrl, RedisUrlInvalidaError } from "./conexion.js";

describe("conexionDesdeUrl", () => {
  it("redis:// con usuario, clave, puerto y base; rediss:// con TLS; valores por defecto", () => {
    expect(conexionDesdeUrl("redis://u%40x:cl%3Ave@h:6380/15")).toEqual({
      host: "h",
      port: 6380,
      db: 15,
      username: "u@x",
      password: "cl:ve",
    });
    expect(conexionDesdeUrl("redis://localhost")).toEqual({
      host: "localhost",
      port: 6379,
      db: 0,
    });
    expect(conexionDesdeUrl("rediss://h/2")).toEqual({
      host: "h",
      port: 6379,
      db: 2,
      tls: {},
    });
  });

  it.each([
    [undefined],
    [""],
    ["no es url"],
    ["http://h"],
    ["redis://h/base"],
    ["redis:///1"],
  ])("rechaza %s sin mostrar la URL", (url) => {
    expect(() => conexionDesdeUrl(url)).toThrow(RedisUrlInvalidaError);
    try {
      conexionDesdeUrl(url);
    } catch (e) {
      expect((e as Error).message).toBe("REDIS_URL ausente o inválida");
    }
  });
});
