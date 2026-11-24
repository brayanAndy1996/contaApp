// Spec 028 (D-4): `@SinOrigen()` deja una ruta fuera de `OrigenGuard` (POST de un clic de RFC 8058, sin `Origin` ni `Sec-Fetch-Site`);
// sin la marca, o sin `Reflector`, la regla de 004 sigue igual.
import "reflect-metadata";
import { Controller, Post, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { SinOrigen } from "./decoradores.js";
import { OrigenGuard } from "./origen.guard.js";

const APP = "http://localhost:3000";

@Controller("x")
class Ruta {
  @SinOrigen()
  @Post("marcada")
  marcada(): void {}

  @Post("normal")
  normal(): void {}
}

const contexto = (handler: () => void, headers: Record<string, string> = {}): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => Ruta,
    switchToHttp: () => ({ getRequest: () => ({ method: "POST", headers }) }),
  }) as unknown as ExecutionContext;

describe("OrigenGuard con @SinOrigen()", () => {
  const guard = new OrigenGuard(APP, new Reflector());
  const ruta = new Ruta();

  it("la ruta marcada pasa sin Origin ni Sec-Fetch-Site, y aun con un Origin ajeno", () => {
    expect(guard.canActivate(contexto(ruta.marcada))).toBe(true);
    expect(guard.canActivate(contexto(ruta.marcada, { origin: "https://evil.example" }))).toBe(true);
  });

  it("la ruta sin marca sigue exigiendo el origen", () => {
    expect(() => guard.canActivate(contexto(ruta.normal))).toThrow();
    expect(guard.canActivate(contexto(ruta.normal, { origin: APP }))).toBe(true);
  });

  it("sin Reflector la marca no se mira", () => {
    expect(() => new OrigenGuard(APP).canActivate(contexto(ruta.marcada))).toThrow();
  });
});
