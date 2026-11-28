// Spec 041 · T4 (rojo): selección `SIRE_CLIENT=http` en el worker (CA-1; plan, «Archivos del worker»).
//
// CONTRATO que fija (T7), en apps/worker/src/adaptadores/adaptadores.module.ts:
// - `crearAdaptadores(env, logger?, { redis, prefijo? })`: con `SIRE_CLIENT=http`, `sireAuth` es `HttpSireAuth` y `sireApiClient` es
//   `HttpSireApiClient` (de `@contapp/sunat`, con `almacenTickets` = `AlmacenTicketsRedis({ redis, prefijo })`). `SIRE_CLIENT`
//   ausente o `mock` → `MockSireAuth` + `MockSireApiClient` (aunque se pasen `redis` y `prefijo`). Otro valor → error que nombra
//   la variable y nunca imprime el valor. `sireAuthDesdeEntorno(env)` y `sireApiClientDesdeEntorno(env, { redis, prefijo? })` siguen
//   la misma regla. Los otros tres adaptadores (`SOL_PORTAL`, `RUC_CLIENT`, `XML_PROVIDER`) siguen solo en `mock`.
// - La guarda de producción NO cuenta `SIRE_CLIENT=http` como mock: la lista de variables en mock no lo nombra.
// - Las URL de SUNAT son fijas en `@contapp/sunat`: ninguna variable de entorno las cambia (`urlsDePrueba` solo por constructor).
// - `TokenRechazadoError` es UNA sola clase, la de `@contapp/sunat`; `cache-token.ts` la reexporta (mismo `codigo`, mismo mensaje).
import { describe, expect, it, vi } from "vitest";
import * as sunat from "@contapp/sunat";
import {
  MockSireApiClient,
  MockSireAuth,
  type SireApiClient,
  type SireAuth,
} from "@contapp/sunat";
import {
  ConfiguracionAdaptadoresError,
  crearAdaptadores,
  sireApiClientDesdeEntorno,
  sireAuthDesdeEntorno,
  variablesEnMock,
  verificarGuardaProduccion,
  type Adaptadores,
} from "./adaptadores.module.js";
import { TokenRechazadoError } from "../trabajos/token-sire/cache-token.js";

// Los adaptadores HTTP los agrega T6; se leen por nombre para que la prueba compile y falle por «no existe».
const { HttpSireAuth, HttpSireApiClient } = sunat as unknown as {
  HttpSireAuth: new (...a: never[]) => SireAuth;
  HttpSireApiClient: new (...a: never[]) => SireApiClient;
};
const { TokenRechazadoError: TokenRechazadoSunat } = sunat as unknown as {
  TokenRechazadoError: new () => Error & { codigo: string };
};

interface OpcionesSire {
  redis: unknown;
  prefijo?: string;
}
const crear = crearAdaptadores as unknown as (
  env: Record<string, string | undefined>,
  logger: { warn(m: string): void },
  opciones: OpcionesSire,
) => Adaptadores;
const authDe = sireAuthDesdeEntorno as unknown as (
  env: Record<string, string | undefined>,
  opciones?: OpcionesSire,
) => SireAuth;
const apiDe = sireApiClientDesdeEntorno as unknown as (
  env: Record<string, string | undefined>,
  opciones?: OpcionesSire,
) => SireApiClient;

const logger = () => ({ warn: vi.fn() });
// Doble mínimo de Redis: el constructor no debe hablar con Redis (solo guardarlo).
const redis = () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() });
const OPC = (): OpcionesSire => ({ redis: redis(), prefijo: "t041:" });

describe("CA-1 · SIRE_CLIENT=http", () => {
  it("crearAdaptadores: SIRE_CLIENT=http da HttpSireAuth + HttpSireApiClient y deja los otros 3 en mock", () => {
    const l = logger();
    const a = crear({ SIRE_CLIENT: "http" }, l, OPC());
    expect(a.sireAuth).toBeInstanceOf(HttpSireAuth);
    expect(a.sireApiClient).toBeInstanceOf(HttpSireApiClient);
    expect(a.sireAuth).not.toBeInstanceOf(MockSireAuth);
    expect(a.sireApiClient).not.toBeInstanceOf(MockSireApiClient);
    expect(a.solPortal.constructor.name).toBe("MockSolPortal");
    expect(a.consultaRuc.constructor.name).toBe("MockConsultaRuc");
    expect(a.xmlProvider.constructor.name).toBe("MockXmlProvider");
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("sireAuthDesdeEntorno y sireApiClientDesdeEntorno con http devuelven los adaptadores reales", () => {
    expect(authDe({ SIRE_CLIENT: "http" }, OPC())).toBeInstanceOf(HttpSireAuth);
    expect(apiDe({ SIRE_CLIENT: "http" }, OPC())).toBeInstanceOf(HttpSireApiClient);
  });

  it.each([{}, { SIRE_CLIENT: "mock" }, { SIRE_CLIENT: undefined }])(
    "SIRE_CLIENT ausente o mock (%j): mocks, aunque se entreguen redis y prefijo",
    (env) => {
      const a = crear(env, logger(), OPC());
      expect(a.sireAuth).toBeInstanceOf(MockSireAuth);
      expect(a.sireApiClient).toBeInstanceOf(MockSireApiClient);
      expect(authDe(env, OPC())).toBeInstanceOf(MockSireAuth);
      expect(apiDe(env, OPC())).toBeInstanceOf(MockSireApiClient);
    },
  );

  it("sin las opciones nuevas el comportamiento de 009 no cambia: crearAdaptadores({}, logger) sigue creando mocks", () => {
    const a = crearAdaptadores({}, logger());
    expect(a.sireAuth).toBeInstanceOf(MockSireAuth);
    expect(a.sireApiClient).toBeInstanceOf(MockSireApiClient);
  });

  it.each(["real", "valor-secreto-xyz", "https://otro-host.example"])(
    "SIRE_CLIENT=%s (valor no soportado): error de arranque que nombra la variable y no el valor",
    (valor) => {
      for (const crearConValor of [
        () => crear({ SIRE_CLIENT: valor }, logger(), OPC()),
        () => authDe({ SIRE_CLIENT: valor }, OPC()),
        () => apiDe({ SIRE_CLIENT: valor }, OPC()),
      ]) {
        let error: unknown;
        try {
          crearConValor();
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(ConfiguracionAdaptadoresError);
        const e = error as ConfiguracionAdaptadoresError;
        expect(e.variable).toBe("SIRE_CLIENT");
        expect(e.message).toContain("SIRE_CLIENT");
        expect(e.message).not.toContain(valor);
      }
    },
  );

  it("SOL_PORTAL, RUC_CLIENT y XML_PROVIDER siguen aceptando solo mock aunque SIRE_CLIENT sea http", () => {
    for (const v of ["SOL_PORTAL", "RUC_CLIENT", "XML_PROVIDER"]) {
      expect(() =>
        crear({ SIRE_CLIENT: "http", [v]: "http" }, logger(), OPC()),
      ).toThrow(v);
    }
  });
});

describe("CA-1 · producción: http no cuenta como mock", () => {
  it("variablesEnMock no nombra SIRE_CLIENT cuando es http", () => {
    expect(variablesEnMock({ SIRE_CLIENT: "http" })).toEqual([
      "SOL_PORTAL",
      "RUC_CLIENT",
      "XML_PROVIDER",
    ]);
    expect(variablesEnMock({ SIRE_CLIENT: "mock" })).toContain("SIRE_CLIENT");
  });

  it("NODE_ENV=production con http y lo demás en mock: el error nombra los otros tres y no SIRE_CLIENT", () => {
    let error: unknown;
    try {
      crear({ NODE_ENV: "production", SIRE_CLIENT: "http" }, logger(), OPC());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfiguracionAdaptadoresError);
    const m = (error as Error).message;
    for (const v of ["SOL_PORTAL", "RUC_CLIENT", "XML_PROVIDER"])
      expect(m).toContain(v);
    expect(m).not.toContain("SIRE_CLIENT");
  });

  it("producción con PERMITIR_ADAPTADORES_MOCK=1 y http: arranca y el aviso no lista SIRE_CLIENT", () => {
    const l = logger();
    const a = crear(
      { NODE_ENV: "production", SIRE_CLIENT: "http", PERMITIR_ADAPTADORES_MOCK: "1" },
      l,
      OPC(),
    );
    expect(a.sireApiClient).toBeInstanceOf(HttpSireApiClient);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0]?.[0]).not.toContain("SIRE_CLIENT");
    expect(() =>
      verificarGuardaProduccion(
        { NODE_ENV: "production", SIRE_CLIENT: "http", PERMITIR_ADAPTADORES_MOCK: "1" },
        logger(),
      ),
    ).not.toThrow();
  });
});

describe("CA-1 · las URL de SUNAT no vienen del entorno", () => {
  it("con variables SIRE_*_URL en el entorno, el adaptador se crea igual (se ignoran) y no se habla con ningún host", () => {
    const fetchEspia = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchEspia as unknown as typeof fetch;
    try {
      const a = crear(
        {
          SIRE_CLIENT: "http",
          SIRE_URL: "http://127.0.0.1:1",
          SIRE_SEGURIDAD_URL: "http://127.0.0.1:2",
          URL_SIRE: "http://127.0.0.1:3",
        },
        logger(),
        OPC(),
      );
      expect(a.sireAuth).toBeInstanceOf(HttpSireAuth);
      expect(fetchEspia).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("TokenRechazadoError compartido (plan, Decisiones)", () => {
  it("cache-token.ts reexporta la clase de @contapp/sunat (una sola identidad)", () => {
    expect(TokenRechazadoSunat).toBeTypeOf("function");
    expect(TokenRechazadoError).toBe(TokenRechazadoSunat);
  });

  it("conserva su forma: codigo token_rechazado, mensaje fijo y nombre", () => {
    const e = new TokenRechazadoError();
    expect(e).toBeInstanceOf(Error);
    expect(e.codigo).toBe("token_rechazado");
    expect(e.name).toBe("TokenRechazadoError");
    expect(e.message).toBe("El servicio SIRE rechazó el token");
    expect(new TokenRechazadoSunat()).toBeInstanceOf(TokenRechazadoError);
  });
});
