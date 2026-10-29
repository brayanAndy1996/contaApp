// T11 (008) · Unitarias de los bordes de `TrabajosService` que los guards impiden alcanzar por HTTP: sesión sin estudio
// (falla cerrado) y miembro que dejó de estar activo entre el guard y la consulta. Sin BD: doble de `withTenant`.
import { describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import type { RedisTrabajos } from "./redis.js";
import { contextoSesion, TrabajosService } from "./trabajos.service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const TRABAJO = "55555555-5555-4555-8555-555555555555";

const sesion = (o: Partial<SesionResuelta> = {}): SesionResuelta => ({
  sesionId: "s-1",
  usuarioId: USUARIO,
  tenantActivo: TENANT,
  estudioRevocado: false,
  expiraAbsoluta: new Date(),
  token: "t",
  ...o,
});

/** `withTenant` cuya única consulta (la membresía) devuelve `filas`. */
const db = (filas: object[]) => ({
  withTenant: vi.fn(async (_c: unknown, fn: (tx: never) => unknown) =>
    fn({ query: async () => ({ rows: filas, rowCount: filas.length }) } as never),
  ),
});
const redis = { prefijo: "p:", publicador: () => null } as unknown as RedisTrabajos;

describe("contextoSesion", () => {
  it("devuelve el estudio y el usuario de la sesión", () => {
    expect(contextoSesion(sesion())).toEqual({ tenantId: TENANT, userId: USUARIO });
  });

  it("sin estudio activo o con el estudio revocado falla cerrado con estudio_requerido", () => {
    expect(() => contextoSesion(sesion({ tenantActivo: null }))).toThrow(
      expect.objectContaining({ codigo: "estudio_requerido" }),
    );
    expect(() => contextoSesion(sesion({ estudioRevocado: true }))).toThrow(
      expect.objectContaining({ codigo: "estudio_requerido" }),
    );
  });
});

describe("TrabajosService sin membresía activa", () => {
  it("listar y cancelar responden estudio_requerido si el miembro ya no está activo", async () => {
    const s = new TrabajosService(db([]) as never, redis);
    await expect(s.listar(sesion(), {})).rejects.toMatchObject({
      codigo: "estudio_requerido",
    });
    await expect(s.cancelar(sesion(), TRABAJO)).rejects.toMatchObject({
      codigo: "estudio_requerido",
    });
  });

  it("una fila de membresía de otro usuario no cuenta como actor (falla cerrado)", async () => {
    const otro = db([{ usuario_id: TENANT, rol: "dueno" }]);
    const s = new TrabajosService(otro as never, redis);
    await expect(s.listar(sesion(), {})).rejects.toMatchObject({
      codigo: "estudio_requerido",
    });
  });
});
