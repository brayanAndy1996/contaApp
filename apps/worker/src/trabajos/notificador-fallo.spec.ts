// Spec 017 (T14a, D-9, CA-6): la red de seguridad de `NotificadorEventos.avisar`. `publicarAvisoNotificacion` no lanza, pero si
// lo hiciera (un cambio futuro, un fallo del módulo) el aviso se traga el error y deja un único log de advertencia con códigos.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/queue", async (original) => ({
  ...(await original<typeof import("@contapp/queue")>()),
  publicarAvisoNotificacion: vi.fn(),
}));

import { publicarAvisoNotificacion } from "@contapp/queue";
import { NotificadorEventos } from "./notificador.js";
import type { EventoLog } from "./registro.js";

const T = randomUUID();
const U1 = randomUUID();
const CANARIO = "CANARIO-aviso-5d2e";
const REDIS = { publish: vi.fn() };

function loggerEspia() {
  const eventos: Array<{ nivel: string; e: EventoLog }> = [];
  const registrar = (nivel: string) => (e: EventoLog) => void eventos.push({ nivel, e });
  return {
    eventos,
    logger: { debug: registrar("debug"), info: registrar("info"), warn: registrar("warn"), error: registrar("error") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(publicarAvisoNotificacion).mockReset();
});

describe("NotificadorEventos: si publicarAvisoNotificacion lanza", () => {
  it.each([
    ["rechaza", () => Promise.reject(Object.assign(new Error(`caído ${CANARIO}`), { detalle: CANARIO }))],
    ["lanza en el acto", () => { throw Object.assign(new Error(`caído ${CANARIO}`), { detalle: CANARIO }); }],
  ])("%s: avisar no rechaza y deja un solo log con el estudio y un código, sin la causa", async (_n, falla) => {
    vi.mocked(publicarAvisoNotificacion).mockImplementation(falla as never);
    const { logger, eventos } = loggerEspia();
    await expect(new NotificadorEventos(REDIS, { logger, prefijo: "t17w:" }).avisar(T, [U1])).resolves.toBeUndefined();
    expect(publicarAvisoNotificacion).toHaveBeenCalledWith(REDIS, T, [U1], { prefijo: "t17w:" });
    expect(eventos).toEqual([
      { nivel: "warn", e: { evento: "aviso_notificacion_fallo", tenant_id: T, codigo: "publicacion_fallida" } },
    ]);
    expect(JSON.stringify(eventos)).not.toContain(CANARIO);
    expect(JSON.stringify(eventos)).not.toContain(U1);
  });

  it("sin logger usa la consola y tampoco filtra el error ni los destinatarios", async () => {
    vi.mocked(publicarAvisoNotificacion).mockRejectedValue(new Error(`caído ${CANARIO}`));
    const consola = (["debug", "info", "warn", "error", "log"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await expect(new NotificadorEventos(REDIS).avisar(T, [U1])).resolves.toBeUndefined();
    expect(vi.mocked(publicarAvisoNotificacion).mock.calls[0]![3]).toEqual({});
    const visto = consola.map((c) => JSON.stringify(c.mock.calls)).join("\n");
    expect(visto).toContain("aviso_notificacion_fallo");
    expect(visto).not.toContain(CANARIO);
    expect(visto).not.toContain(U1);
  });

  it("un logger defectuoso tampoco tumba el aviso", async () => {
    vi.mocked(publicarAvisoNotificacion).mockRejectedValue(new Error("x"));
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => { throw new Error("logger roto"); },
      error: () => undefined,
    };
    await expect(new NotificadorEventos(REDIS, { logger }).avisar(T, [U1])).resolves.toBeUndefined();
  });
});
