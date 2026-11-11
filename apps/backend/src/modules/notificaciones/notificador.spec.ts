// Spec 017 (T14a, D-9): `NotificadorRedis` y `destinatariosPendientes` sin Redis ni BD. El aviso nunca lanza y no filtra datos.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/queue", async (original) => ({
  ...(await original<typeof import("@contapp/queue")>()),
  publicarAvisoNotificacion: vi.fn(),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  destinatariosNuevos: vi.fn(),
}));

import { destinatariosNuevos } from "@contapp/db";
import { publicarAvisoNotificacion } from "@contapp/queue";
import { destinatariosPendientes, NotificadorRedis } from "./notificador.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const U1 = "0190a000-0000-7000-8000-0000000000b1";
const U2 = "0190a000-0000-7000-8000-0000000000b2";
const CONEXION = { nombre: "pub" };

function redisCon(pub: unknown) {
  return { prefijo: "contapp:", publicador: vi.fn(() => pub) } as never;
}

describe("NotificadorRedis", () => {
  beforeEach(() => {
    vi.mocked(publicarAvisoNotificacion).mockReset();
    vi.mocked(publicarAvisoNotificacion).mockResolvedValue(undefined as never);
  });

  it("publica el aviso con el estudio, una copia de los destinatarios y el prefijo", async () => {
    const destinatarios = [U1, U2];
    await new NotificadorRedis(redisCon(CONEXION)).avisar(TENANT, destinatarios);
    expect(publicarAvisoNotificacion).toHaveBeenCalledTimes(1);
    const args = vi.mocked(publicarAvisoNotificacion).mock.calls[0]!;
    expect(args[0]).toBe(CONEXION);
    expect(args[1]).toBe(TENANT);
    expect(args[2]).toEqual([U1, U2]);
    expect(args[2]).not.toBe(destinatarios);
    expect(args[3]).toEqual({ prefijo: "contapp:" });
  });

  it("sin destinatarios no abre la conexión ni publica", async () => {
    const redis = redisCon(CONEXION);
    await new NotificadorRedis(redis).avisar(TENANT, []);
    expect((redis as { publicador: ReturnType<typeof vi.fn> }).publicador).not.toHaveBeenCalled();
    expect(publicarAvisoNotificacion).not.toHaveBeenCalled();
  });

  it("con la conexión cerrada (publicador null) no publica y no lanza", async () => {
    await expect(new NotificadorRedis(redisCon(null)).avisar(TENANT, [U1])).resolves.toBeUndefined();
    expect(publicarAvisoNotificacion).not.toHaveBeenCalled();
  });

  it("si Redis falla al publicar, el aviso se traga el error sin lanzar", async () => {
    vi.mocked(publicarAvisoNotificacion).mockRejectedValue(new Error("ECONNREFUSED redis://clave@host"));
    await expect(new NotificadorRedis(redisCon(CONEXION)).avisar(TENANT, [U1])).resolves.toBeUndefined();
  });

  it("si el publicador mismo lanza, tampoco lanza", async () => {
    const redis = { prefijo: "contapp:", publicador: vi.fn(() => { throw new Error("boom"); }) } as never;
    await expect(new NotificadorRedis(redis).avisar(TENANT, [U1])).resolves.toBeUndefined();
    expect(publicarAvisoNotificacion).not.toHaveBeenCalled();
  });
});

describe("destinatariosPendientes", () => {
  beforeEach(() => vi.mocked(destinatariosNuevos).mockReset());

  it("sin notificador no consulta nada", async () => {
    expect(await destinatariosPendientes(undefined, {} as never)).toEqual([]);
    expect(destinatariosNuevos).not.toHaveBeenCalled();
  });

  it("con notificador devuelve los destinatarios que acaba de crear la transacción", async () => {
    const tx = { tx: 1 } as never;
    vi.mocked(destinatariosNuevos).mockResolvedValue([U1, U2]);
    const notificador = { avisar: vi.fn() };
    expect(await destinatariosPendientes(notificador, tx)).toEqual([U1, U2]);
    expect(destinatariosNuevos).toHaveBeenCalledWith(tx);
    expect(notificador.avisar).not.toHaveBeenCalled();
  });
});
