// Unitarias de la selección de adaptadores por entorno y de la guarda de producción (spec 009, CA-6 y CA-11).
import { describe, expect, it, vi } from "vitest";
import {
  MockConsultaRuc,
  MockSireApiClient,
  MockSireAuth,
  MockSolAuth,
  MockXmlProvider,
} from "@contapp/sunat";
import {
  ConfiguracionAdaptadoresError,
  crearAdaptadores,
  verificarGuardaProduccion,
  xmlProviderDesdeEntorno,
} from "./adaptadores.module.js";
import { ConfiguracionTrabajosError } from "../trabajos/trabajos.module.js";

const logger = () => ({ warn: vi.fn() });

describe("crearAdaptadores", () => {
  it("entorno vacío: los 5 puertos son mock y no hay aviso", () => {
    const l = logger();
    const a = crearAdaptadores({}, l);
    expect(a.sireAuth).toBeInstanceOf(MockSireAuth);
    expect(a.sireApiClient).toBeInstanceOf(MockSireApiClient);
    expect(a.solAuth).toBeInstanceOf(MockSolAuth);
    expect(a.consultaRuc).toBeInstanceOf(MockConsultaRuc);
    expect(a.xmlProvider).toBeInstanceOf(MockXmlProvider);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it.each(["SIRE_CLIENT", "SOL_PORTAL", "RUC_CLIENT", "XML_PROVIDER"])(
    "error: %s con valor no soportado falla con su nombre y sin el valor",
    (variable) => {
      let error: unknown;
      try {
        crearAdaptadores({ [variable]: "valor-secreto-xyz" }, logger());
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfiguracionAdaptadoresError);
      expect(error).toBeInstanceOf(ConfiguracionTrabajosError);
      const e = error as ConfiguracionAdaptadoresError;
      expect(e.message).toContain(variable);
      expect(e.message).not.toContain("valor-secreto-xyz");
      expect(e.variable).toBe(variable);
    },
  );

  it("XML_FIXTURES_DIR y XML_MOCK_LATENCIA_MS llegan al mock; una latencia inválida falla con su nombre", () => {
    expect(
      xmlProviderDesdeEntorno({
        XML_FIXTURES_DIR: "/tmp/fx",
        XML_MOCK_LATENCIA_MS: "25",
      }),
    ).toBeInstanceOf(MockXmlProvider);
    expect(() =>
      xmlProviderDesdeEntorno({ XML_MOCK_LATENCIA_MS: "rápido" }),
    ).toThrow(/XML_MOCK_LATENCIA_MS/);
  });
});

describe("guarda de producción (D15)", () => {
  it("producción con mock y sin permiso: falla nombrando las variables en mock", () => {
    const l = logger();
    let error: unknown;
    try {
      crearAdaptadores({ NODE_ENV: "production" }, l);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfiguracionAdaptadoresError);
    const mensaje = (error as Error).message;
    for (const v of ["SIRE_CLIENT", "SOL_PORTAL", "RUC_CLIENT", "XML_PROVIDER"])
      expect(mensaje).toContain(v);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("producción con PERMITIR_ADAPTADORES_MOCK=1: arranca y registra un warn", () => {
    const l = logger();
    expect(() =>
      crearAdaptadores(
        { NODE_ENV: "production", PERMITIR_ADAPTADORES_MOCK: "1" },
        l,
      ),
    ).not.toThrow();
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0]?.[0]).toContain("XML_PROVIDER");
  });

  it("el permiso solo vale con el valor 1", () => {
    expect(() =>
      verificarGuardaProduccion(
        { NODE_ENV: "production", PERMITIR_ADAPTADORES_MOCK: "true" },
        logger(),
      ),
    ).toThrow(ConfiguracionAdaptadoresError);
  });

  it.each(["development", "test", undefined])(
    "NODE_ENV=%s: sin guarda, sin aviso ni error",
    (nodeEnv) => {
      const l = logger();
      expect(() =>
        crearAdaptadores(nodeEnv ? { NODE_ENV: nodeEnv } : {}, l),
      ).not.toThrow();
      expect(l.warn).not.toHaveBeenCalled();
    },
  );
});

describe("AdaptadoresModule", () => {
  it("exporta los 5 puertos por token y, en producción sin permiso, falla al crear el contexto", async () => {
    const { NestFactory } = await import("@nestjs/core");
    const { AdaptadoresModule, SIRE_API_CLIENT, XML_PROVIDER } = await import(
      "./adaptadores.module.js"
    );
    const antes = { ...process.env };
    try {
      delete process.env.NODE_ENV;
      const ctx = await NestFactory.createApplicationContext(AdaptadoresModule, {
        logger: false,
      });
      expect(ctx.get(XML_PROVIDER)).toBeInstanceOf(MockXmlProvider);
      expect(ctx.get(SIRE_API_CLIENT)).toBeInstanceOf(MockSireApiClient);
      await ctx.close();

      process.env.NODE_ENV = "production";
      delete process.env.PERMITIR_ADAPTADORES_MOCK;
      await expect(
        NestFactory.createApplicationContext(AdaptadoresModule, {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toBeInstanceOf(ConfiguracionAdaptadoresError);
    } finally {
      process.env = antes;
    }
  });
});
