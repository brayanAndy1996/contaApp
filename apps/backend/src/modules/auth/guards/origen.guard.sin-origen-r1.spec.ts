// Spec 028 · T16 (H-028-1-7, rojo; decisión del 2026-11-24): `@SinOrigen()` exime de `OrigenGuard` solo a la variante de un clic de
// RFC 8058 (POST urlencoded `List-Unsubscribe=One-Click` que manda el servidor del correo, sin `Origin`). La variante JSON del botón de
// `/baja` sí manda `Origin` y debe exigir el origen propio: sin él, o con uno ajeno o `Sec-Fetch-Site` distinto de `same-origin`, 403.
// Las demás pruebas de `origen.guard.sin-origen.spec.ts` (cuerpos que no son JSON, sin efecto alguno) siguen igual.
import "reflect-metadata";
import { Controller, Post, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { SinOrigen } from "./decoradores.js";
import { OrigenGuard } from "./origen.guard.js";

const APP = "http://localhost:3000";
const JSON_CT = "application/json";
const UN_CLIC = "application/x-www-form-urlencoded";

@Controller("x")
class Ruta {
  @SinOrigen()
  @Post("marcada")
  marcada(): void {}
}

const contexto = (headers: Record<string, string>): ExecutionContext =>
  ({
    getHandler: () => Ruta.prototype.marcada,
    getClass: () => Ruta,
    switchToHttp: () => ({ getRequest: () => ({ method: "POST", headers }) }),
  }) as unknown as ExecutionContext;

describe("OrigenGuard con @SinOrigen(): la variante JSON del botón exige el origen propio", () => {
  const guard = new OrigenGuard(APP, new Reflector());

  it("JSON sin Origin ni Sec-Fetch-Site: 403 (origen_invalido)", () => {
    expect(() => guard.canActivate(contexto({ "content-type": JSON_CT }))).toThrow();
    expect(() => guard.canActivate(contexto({ "content-type": "Application/JSON; charset=utf-8" }))).toThrow();
  });

  it("JSON con Origin ajeno o Sec-Fetch-Site distinto de same-origin: 403", () => {
    expect(() => guard.canActivate(contexto({ "content-type": JSON_CT, origin: "https://atacante.example" }))).toThrow();
    expect(() => guard.canActivate(contexto({ "content-type": JSON_CT, origin: APP, "sec-fetch-site": "cross-site" }))).toThrow();
    expect(() => guard.canActivate(contexto({ "content-type": JSON_CT, "sec-fetch-site": "none" }))).toThrow();
  });

  it("JSON con el origen propio (el botón de /baja): pasa", () => {
    expect(guard.canActivate(contexto({ "content-type": JSON_CT, origin: APP }))).toBe(true);
    expect(guard.canActivate(contexto({ "content-type": JSON_CT, origin: APP, "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("la variante de RFC 8058 (urlencoded, sin Origin ni Sec-Fetch-Site) sigue exenta", () => {
    expect(guard.canActivate(contexto({ "content-type": UN_CLIC }))).toBe(true);
  });
});
