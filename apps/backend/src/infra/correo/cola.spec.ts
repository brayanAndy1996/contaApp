import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ColaCorreo } from "./cola.js";
import type { Correo } from "./correo.js";

// D8 / CA-3 / CA-8 (spec 004). Contrato (plan: Contratos Backend):
//   new ColaCorreo(correo: Correo, registrar?: (codigo: string) => void)
//   encolar(m): void   // síncrono; el envío ocurre con setImmediate, fuera de la petición y de
//                      // cualquier withTenant; NO espera al envío y traga los errores
//                      // (rechazos y lanzamientos síncronos). Solo registra un `codigo` fijo
//                      // (cadena corta tipo "correo_no_enviado"), nunca el error ni el mensaje.
const MENSAJE = { para: "ana@estudio.pe", asunto: "Aviso", texto: "cuerpo" };
const siguienteTurno = () => new Promise<void>((r) => setImmediate(r));

describe("ColaCorreo.encolar", () => {
  it("devuelve de inmediato aunque el envío nunca termine (no espera)", async () => {
    const enviar = vi.fn(() => new Promise<void>(() => {}));
    const cola = new ColaCorreo({ enviar } as Correo);
    const inicio = performance.now();
    const retorno = cola.encolar(MENSAJE);
    expect(retorno).toBeUndefined();
    expect(performance.now() - inicio).toBeLessThan(50);
  });

  it("no envía de forma síncrona: lo hace en un turno posterior (setImmediate)", async () => {
    const enviar = vi.fn(async () => {});
    const cola = new ColaCorreo({ enviar } as Correo);
    cola.encolar(MENSAJE);
    expect(enviar).not.toHaveBeenCalled();
    await siguienteTurno();
    await siguienteTurno();
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith(MENSAJE);
  });

  it("el envío es independiente del llamador: un envío lento no retrasa al siguiente encolar", async () => {
    const enviar = vi.fn(() => new Promise<void>(() => {}));
    const cola = new ColaCorreo({ enviar } as Correo);
    const inicio = performance.now();
    for (let i = 0; i < 50; i++) cola.encolar(MENSAJE);
    expect(performance.now() - inicio).toBeLessThan(100);
    await siguienteTurno();
    await siguienteTurno();
    expect(enviar).toHaveBeenCalledTimes(50);
  });

  it("traga un rechazo del envío: no hay promesa rechazada sin manejar", async () => {
    const enviar = vi.fn(async () => {
      throw new Error("falló el SMTP");
    });
    const registrar = vi.fn();
    const sinManejar = vi.fn();
    process.on("unhandledRejection", sinManejar);
    try {
      new ColaCorreo({ enviar } as Correo, registrar).encolar(MENSAJE);
      await siguienteTurno();
      await siguienteTurno();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", sinManejar);
    }
    expect(sinManejar).not.toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledTimes(1);
  });

  it("traga un lanzamiento síncrono de `enviar`", async () => {
    const enviar = vi.fn(() => {
      throw new Error("explotó antes de devolver la promesa");
    });
    const registrar = vi.fn();
    const sinCapturar = vi.fn();
    process.on("uncaughtException", sinCapturar);
    try {
      new ColaCorreo({ enviar } as unknown as Correo, registrar).encolar(MENSAJE);
      await siguienteTurno();
      await siguienteTurno();
    } finally {
      process.off("uncaughtException", sinCapturar);
    }
    expect(sinCapturar).not.toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledTimes(1);
  });

  it("registra solo un código fijo: ni el error ni los datos del mensaje (CA-10)", async () => {
    const canario = "CANARIO-COLA-5521";
    const enviar = vi.fn(async () => {
      throw new Error(`falló para ${canario}`, { cause: new Error(canario) });
    });
    const registrar = vi.fn();
    new ColaCorreo({ enviar } as Correo, registrar).encolar({
      para: `${canario}@estudio.pe`,
      asunto: canario,
      texto: `enlace #t=${canario}`,
    });
    await siguienteTurno();
    await siguienteTurno();
    expect(registrar).toHaveBeenCalledTimes(1);
    const [codigo, ...resto] = registrar.mock.calls[0]!;
    expect(resto).toEqual([]);
    expect(typeof codigo).toBe("string");
    expect(codigo).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
    expect(inspect(registrar.mock.calls, { depth: 10 })).not.toContain(canario);
  });

  it("un envío correcto no registra nada", async () => {
    const registrar = vi.fn();
    new ColaCorreo({ enviar: vi.fn(async () => {}) } as Correo, registrar).encolar(MENSAJE);
    await siguienteTurno();
    await siguienteTurno();
    expect(registrar).not.toHaveBeenCalled();
  });

  it("sin `registrar` también traga el error y no escribe el canario en stdout/stderr", async () => {
    const canario = "CANARIO-COLA-SIN-REGISTRAR";
    const escrituras: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      escrituras.push(String(c));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      escrituras.push(String(c));
      return true;
    });
    try {
      const enviar = vi.fn(async () => {
        throw new Error(canario);
      });
      new ColaCorreo({ enviar } as Correo).encolar(MENSAJE);
      await siguienteTurno();
      await siguienteTurno();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(escrituras.join("")).not.toContain(canario);
  });
});
