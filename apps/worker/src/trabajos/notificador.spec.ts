// Spec 017 · T4 (rojo). `NotificadorEventos`: el adaptador Redis del puerto `Notificador` (D-9, D-14; CA-6, CA-8).
// Contrato que fijan estas pruebas (T9), en apps/worker/src/trabajos/notificador.ts:
//   class NotificadorEventos implements Notificador   (el puerto, en registro.ts: `avisar(tenantId, usuarioIds): Promise<void>`)
//   new NotificadorEventos(redis: Pick<ClienteRedis, "publish">, opciones?: { prefijo?: string; logger?: LoggerTrabajos })
//   - `avisar` publica con `publicarAvisoNotificacion` en `eventos:{tenantId}` el mensaje `{ evento: "notificacion", destinatarios }`
//     y NO lleva nada más (ni parámetros, ni razón social, ni tenantId); sin destinatarios no publica; sin repetidos.
//   - NUNCA lanza ni rechaza (Redis caído, ids inválidos o más de 200): el hecho ya está confirmado y la campana se pone al día
//     al recargar. Ni la consola ni el logger reciben el mensaje, la causa o las propiedades del error (CA-6, D-14).
//   - `NotificadorLog` ya no existe (lo reemplaza la notificación guardada en la misma transacción del hecho, D-9).
// El módulo se importa en cada prueba para que cada una falle por separado mientras `notificador.ts` no exista.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as registro from "./registro.js";
import type { EventoLog } from "./registro.js";

const RUTA = "./notificador.js";
async function cargar() {
  const m = (await import(/* @vite-ignore */ RUTA)) as {
    NotificadorEventos: new (
      redis: unknown,
      opciones?: { prefijo?: string; logger?: unknown },
    ) => { avisar(tenantId: string, usuarioIds: string[]): Promise<void> };
  };
  return m.NotificadorEventos;
}

const T = randomUUID();
const U1 = randomUUID();
const U2 = randomUUID();
const CANARIO = "CANARIO-notificador-7c1f";

function redisFalso(falla?: () => unknown) {
  const publicados: Array<{ canal: string; texto: string }> = [];
  return {
    publicados,
    publish: vi.fn((canal: string, texto: string) => {
      if (falla) return falla() as Promise<number>;
      publicados.push({ canal, texto });
      return Promise.resolve(1);
    }),
  };
}

function loggerEspia() {
  const eventos: EventoLog[] = [];
  const logger = {
    debug: (e: EventoLog) => eventos.push(e),
    info: (e: EventoLog) => eventos.push(e),
    warn: (e: EventoLog) => eventos.push(e),
    error: (e: EventoLog) => eventos.push(e),
  };
  return { logger, eventos };
}

afterEach(() => vi.restoreAllMocks());

describe("NotificadorEventos", () => {
  it("publica { evento, destinatarios } en eventos:{tenantId} con el prefijo, y nada más", async () => {
    const NotificadorEventos = await cargar();
    const redis = redisFalso();
    await new NotificadorEventos(redis, { prefijo: "t17w:" }).avisar(T, [
      U1,
      U2,
    ]);
    expect(redis.publicados).toHaveLength(1);
    expect(redis.publicados[0]!.canal).toBe(`t17w:eventos:${T}`);
    expect(JSON.parse(redis.publicados[0]!.texto)).toEqual({
      evento: "notificacion",
      destinatarios: [U1, U2],
    });
    expect(redis.publicados[0]!.texto).not.toContain(T);
  });

  it("sin prefijo usa el de las colas (`contapp:`)", async () => {
    const NotificadorEventos = await cargar();
    const redis = redisFalso();
    await new NotificadorEventos(redis).avisar(T, [U1]);
    expect(redis.publicados[0]!.canal).toBe(`contapp:eventos:${T}`);
  });

  it("sin destinatarios no publica; los repetidos se publican una vez", async () => {
    const NotificadorEventos = await cargar();
    const redis = redisFalso();
    const n = new NotificadorEventos(redis);
    await n.avisar(T, []);
    expect(redis.publish).not.toHaveBeenCalled();
    await n.avisar(T, [U1, U2, U1]);
    expect(JSON.parse(redis.publicados[0]!.texto).destinatarios).toEqual([
      U1,
      U2,
    ]);
  });

  it("ids inválidos o más de 200 destinatarios: no publica y no rechaza", async () => {
    const NotificadorEventos = await cargar();
    const redis = redisFalso();
    const n = new NotificadorEventos(redis);
    await expect(n.avisar(T, ["no-es-uuid"])).resolves.toBeUndefined();
    await expect(
      n.avisar(
        T,
        Array.from({ length: 201 }, () => randomUUID()),
      ),
    ).resolves.toBeUndefined();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it.each([
    [
      "rechaza",
      () =>
        Promise.reject(
          Object.assign(new Error(`caído ${CANARIO}`), { detalle: CANARIO }),
        ),
    ],
    [
      "lanza en el acto",
      () => {
        throw Object.assign(new Error(`caído ${CANARIO}`), {
          detalle: CANARIO,
        });
      },
    ],
  ])(
    "si Redis %s: avisar no rechaza y ni la consola ni el logger reciben el error (CA-6)",
    async (_n, falla) => {
      const NotificadorEventos = await cargar();
      const consola = (["log", "info", "warn", "error", "debug"] as const).map(
        (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      const { logger, eventos } = loggerEspia();
      const redis = redisFalso(falla);
      await expect(
        new NotificadorEventos(redis, { logger }).avisar(T, [U1]),
      ).resolves.toBeUndefined();
      expect(redis.publish).toHaveBeenCalledTimes(1);
      const visto =
        JSON.stringify(eventos) +
        consola.map((c) => JSON.stringify(c.mock.calls)).join("\n");
      expect(visto).not.toContain(CANARIO);
    },
  );

  it("el logger solo recibe ids y códigos: ni destinatarios con nombre ni parámetros", async () => {
    const NotificadorEventos = await cargar();
    const { logger, eventos } = loggerEspia();
    const redis = redisFalso(() => Promise.reject(new Error("x")));
    await new NotificadorEventos(redis, { logger }).avisar(T, [U1]);
    for (const e of eventos)
      for (const [campo, valor] of Object.entries(e))
        expect(
          ["string", "number", "boolean"].includes(typeof valor) ||
            valor === null ||
            valor === undefined,
          campo,
        ).toBe(true);
  });
});

describe("registro.ts tras 017", () => {
  it("ya no exporta NotificadorLog (D-9: la notificación se guarda en la transacción del hecho)", () => {
    expect(registro).not.toHaveProperty("NotificadorLog");
  });

  it("sigue exportando los logs de trabajos que usan el ejecutor y los procesadores", () => {
    expect(typeof registro.registrar).toBe("function");
    expect(typeof registro.camposTrabajo).toBe("function");
    expect(typeof registro.loggerConsola.info).toBe("function");
  });
});
