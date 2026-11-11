import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crearClaves } from "./claves.js";
import * as raiz from "./index.js";
import { publicarAvisoNotificacion } from "./eventos.js";

// Spec 017 · T4 (rojo). `publicarAvisoNotificacion` (D-9; plan, Contratos: Aviso en vivo; CA-6, CA-8).
// Contrato que fijan estas pruebas (packages/queue/src/eventos.ts, exportada desde el índice de `queue`):
//   publicarAvisoNotificacion(redis: Pick<ClienteRedis, "publish">, tenantId: string, destinatarios: string[],
//     opciones: { prefijo?: string } = {}): Promise<void>
//   - PUBLISH en `eventos:{tenantId}` (con el prefijo) del mensaje `{ evento: "notificacion", destinatarios }`: solo esas dos
//     claves, validado con `avisoNotificacionSchema` de shared (uuid[1..200]), sin contenido, sin tenantId, sin parámetros.
//   - NUNCA lanza: lista vacía, ids que no son uuid o más de 200 = no publica; un fallo de Redis (rechazo o excepción
//     síncrona) se traga y solo deja un aviso genérico en consola, sin el mensaje del error (CA-6).
//   - Sin ids repetidos en el mensaje.
const T = randomUUID();
const U1 = randomUUID();
const U2 = randomUUID();

function redisFalso(falla?: () => unknown) {
  const publicados: Array<{ canal: string; texto: string }> = [];
  return {
    publicados,
    publish: vi.fn(async (canal: string, texto: string) => {
      if (falla) await falla();
      publicados.push({ canal, texto });
      return 1;
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("publicarAvisoNotificacion", () => {
  it("se exporta desde el índice del paquete", () => {
    expect(typeof raiz.publicarAvisoNotificacion).toBe("function");
    expect(raiz.publicarAvisoNotificacion).toBe(publicarAvisoNotificacion);
  });

  it("publica { evento, destinatarios } en eventos:{tenantId}, sin nada más", async () => {
    const redis = redisFalso();
    await publicarAvisoNotificacion(redis as never, T, [U1, U2]);
    expect(redis.publicados).toHaveLength(1);
    expect(redis.publicados[0]!.canal).toBe(crearClaves().eventos(T));
    const msg = JSON.parse(redis.publicados[0]!.texto) as Record<
      string,
      unknown
    >;
    expect(msg).toEqual({ evento: "notificacion", destinatarios: [U1, U2] });
    expect(Object.keys(msg).sort()).toEqual(["destinatarios", "evento"]);
  });

  it("respeta el prefijo de las claves", async () => {
    const redis = redisFalso();
    await publicarAvisoNotificacion(redis as never, T, [U1], {
      prefijo: "t17:",
    });
    expect(redis.publicados[0]!.canal).toBe(`t17:eventos:${T}`);
  });

  it("no repite destinatarios", async () => {
    const redis = redisFalso();
    await publicarAvisoNotificacion(redis as never, T, [U1, U2, U1]);
    expect(JSON.parse(redis.publicados[0]!.texto).destinatarios).toEqual([
      U1,
      U2,
    ]);
  });

  it("sin destinatarios, con un id que no es uuid o con más de 200: no publica y no lanza", async () => {
    const redis = redisFalso();
    const avisar = (d: string[]) =>
      publicarAvisoNotificacion(redis as never, T, d);
    await expect(avisar([])).resolves.toBeUndefined();
    await expect(avisar([U1, "no-es-uuid"])).resolves.toBeUndefined();
    await expect(
      avisar(Array.from({ length: 201 }, () => randomUUID())),
    ).resolves.toBeUndefined();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it.each([
    ["rechaza", () => Promise.reject(new Error("redis caído CANARIO-A"))],
    [
      "lanza en el acto",
      () => {
        throw new Error("redis caído CANARIO-A");
      },
    ],
  ])(
    "si Redis %s, no lanza y la consola no recibe el mensaje del error (CA-6)",
    async (_n, falla) => {
      const aviso = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const redis = {
        publish: vi.fn((): Promise<number> => {
          const r = falla();
          return r as Promise<number>;
        }),
      };
      await expect(
        publicarAvisoNotificacion(redis as never, T, [U1]),
      ).resolves.toBeUndefined();
      expect(redis.publish).toHaveBeenCalledTimes(1);
      expect(aviso.mock.calls.flat().join("\n")).not.toContain("CANARIO-A");
    },
  );
});
