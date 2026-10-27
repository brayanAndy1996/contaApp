import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";

// Prueba humo del andamiaje (T2 de 004): la inyección con @Inject(TOKEN) resuelve bajo
// vitest (esbuild no emite design:paramtypes) y el binario nativo de @node-rs/argon2 carga.
const VALOR = Symbol("VALOR_HUMO");

@Injectable()
class ServicioHumo {
  constructor(@Inject(VALOR) readonly valor: string) {}
}

@Module({
  providers: [{ provide: VALOR, useValue: "resuelto" }, ServicioHumo],
})
class ModuloHumo {}

describe("humo del andamiaje de pruebas", () => {
  it("resuelve un proveedor inyectado con @Inject(TOKEN)", async () => {
    const app = await NestFactory.createApplicationContext(ModuloHumo, {
      logger: false,
    });
    try {
      expect(app.get(ServicioHumo).valor).toBe("resuelto");
    } finally {
      await app.close();
    }
  });

  it("carga @node-rs/argon2 y produce un hash argon2id", async () => {
    expect(await hash("prueba-humo")).toMatch(/^\$argon2id\$/);
  });
});
