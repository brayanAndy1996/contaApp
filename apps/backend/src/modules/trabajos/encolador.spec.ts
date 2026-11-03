// T11 (008) · Unitarias del `Encolador` y de la respuesta HTTP de los errores de la cola: `ColaLlenaError` se propaga
// sin envolver y sin publicar nada, y el filtro global lo responde 429 `cola_llena` (D8). Sin BD ni Redis: dobles.
import {
  ClienteDesconocidoError,
  ColaLlenaError,
  ColaNoConfiguradaError,
  ParametrosInvalidosError,
  TipoDesconocidoError,
  type EntradaEncolar,
} from "@contapp/queue";
import type { TrabajoVista } from "@contapp/shared";
import { describe, expect, it, vi } from "vitest";
import { FiltroErrores } from "../../comun/filtro-errores.js";
import { Encolador } from "./encolador.js";
import { respuestaDeErrorCola, TrabajosError } from "./errores.js";
import type { RedisTrabajos } from "./redis.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const entrada: EntradaEncolar = {
  tipo: "prueba.eco",
  clienteId: "33333333-3333-4333-8333-333333333333",
  parametros: { n: 1 },
  prioridad: "interactivo",
  creadoPor: null,
};
const trabajo: TrabajoVista = {
  id: "55555555-5555-4555-8555-555555555555",
  tipo: "prueba.eco",
  clienteId: entrada.clienteId,
  estado: "en_cola",
  posicion: null,
  intentos: 0,
  motivo: null,
  creadoEn: new Date(0).toISOString(),
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: null,
};

function redisFalso(publicador: unknown) {
  return {
    prefijo: "p:",
    publicador: () => publicador,
  } as unknown as RedisTrabajos;
}
const conexion = () => ({
  zadd: vi.fn(async () => 1),
  sadd: vi.fn(async () => 1),
  publish: vi.fn(async () => 1),
});

/** Responde un error con el filtro global y devuelve estado y cuerpo. */
function responder(e: unknown): { estado: number; cuerpo: unknown } {
  const salida = { estado: 0, cuerpo: undefined as unknown };
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        status: (n: number) => {
          salida.estado = n;
          return {
            json: (c: unknown) => {
              salida.cuerpo = c;
            },
          };
        },
      }),
    }),
  };
  new FiltroErrores(() => undefined).catch(e, host as never);
  return salida;
}

describe("Encolador", () => {
  it("con cola llena propaga ColaLlenaError sin envolver, no publica nada y el filtro responde 429 cola_llena", async () => {
    const r = conexion();
    const db = {
      withTenant: vi.fn(async () => {
        throw new ColaLlenaError();
      }),
    };
    const enc = new Encolador(db as never, redisFalso(r));
    const error = await enc
      .encolar({ tenantId: TENANT }, entrada)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ColaLlenaError);
    expect(r.zadd).not.toHaveBeenCalled();
    expect(r.publish).not.toHaveBeenCalled();
    expect(responder(error)).toEqual({
      estado: 429,
      cuerpo: { codigo: "cola_llena" },
    });
  });

  it("tras el commit publica la pista y el evento en_cola; con dedupe no publica", async () => {
    const r = conexion();
    let nuevo = true;
    const db = {
      withTenant: vi.fn(async () => ({ trabajo, nuevo })),
    };
    const enc = new Encolador(db as never, redisFalso(r));
    await expect(enc.encolar({ tenantId: TENANT }, entrada)).resolves.toEqual({
      trabajo,
      nuevo: true,
    });
    expect(r.zadd).toHaveBeenCalledWith(
      `p:pend:sire:${TENANT}`,
      expect.any(Number),
      trabajo.id,
    );
    expect(r.publish).toHaveBeenCalledWith(
      `p:eventos:${TENANT}`,
      JSON.stringify(trabajo),
    );
    nuevo = false;
    await enc.encolar({ tenantId: TENANT }, entrada);
    expect(r.zadd).toHaveBeenCalledTimes(1);
    expect(r.publish).toHaveBeenCalledTimes(1);
  });

  it("con la app cerrando (sin conexión de publicación) devuelve el trabajo sin publicar", async () => {
    const db = { withTenant: vi.fn(async () => ({ trabajo, nuevo: true })) };
    const enc = new Encolador(db as never, redisFalso(null));
    await expect(enc.encolar({ tenantId: TENANT }, entrada)).resolves.toEqual({
      trabajo,
      nuevo: true,
    });
  });
});

describe("respuesta HTTP de los errores de la cola", () => {
  it("cliente desconocido es 404 no_encontrado y parámetros inválidos 400 solicitud_invalida", () => {
    expect(responder(new ClienteDesconocidoError())).toEqual({
      estado: 404,
      cuerpo: { codigo: "no_encontrado" },
    });
    expect(responder(new ParametrosInvalidosError())).toEqual({
      estado: 400,
      cuerpo: { codigo: "solicitud_invalida" },
    });
  });

  it("cola no configurada y tipo desconocido son errores de despliegue: 500 genérico", () => {
    expect(respuestaDeErrorCola(new ColaNoConfiguradaError())).toBeNull();
    expect(respuestaDeErrorCola(new TipoDesconocidoError())).toBeNull();
    expect(responder(new ColaNoConfiguradaError())).toEqual({
      estado: 500,
      cuerpo: { codigo: "error_interno" },
    });
  });

  it("TrabajosError lleva su estado: 409 trabajo_iniciado y 429 streams_excedidos", () => {
    expect(responder(new TrabajosError("trabajo_iniciado"))).toEqual({
      estado: 409,
      cuerpo: { codigo: "trabajo_iniciado" },
    });
    expect(responder(new TrabajosError("streams_excedidos"))).toEqual({
      estado: 429,
      cuerpo: { codigo: "streams_excedidos" },
    });
  });
});
