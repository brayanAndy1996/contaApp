// Spec 005 · T15: pruebas propias (sin BD) de las correcciones de la ronda adversarial 1 en `acceso`.
import { ROLES, type Rol } from "@contapp/shared";
import { describe, expect, it, vi } from "vitest";
import { generarToken } from "../auth/sesion/token.js";
import { idDeRuta } from "./entrada.js";
import { InvitacionesService } from "./invitaciones.service.js";
import { rolesQueOtorga } from "./usuarios.service.js";

const ID = "0190a000-0000-7000-8000-0000000000ab";

function armar() {
  const db = { withAuth: vi.fn(), withTenant: vi.fn() };
  const hasher = { calcular: vi.fn(async () => "$argon2id$hash") };
  const cola = { encolar: vi.fn() };
  const cupo = { alInvitar: vi.fn(), alReactivar: vi.fn(), alAceptar: vi.fn() };
  const svc = new InvitacionesService(
    db as never,
    hasher as never,
    cola as never,
    new Set<string>(),
    "http://localhost:3000",
    cupo as never,
  );
  return { svc, db, hasher, cola };
}
const LLAMANTE = { usuarioId: ID, tenantId: ID };

describe("H-005-1a-1 · idDeRuta devuelve el UUID en minúsculas", () => {
  it("mayúsculas o mezcla -> forma canónica (la que guarda la BD y la sesión)", () => {
    expect(idDeRuta(ID.toUpperCase())).toBe(ID);
    expect(idDeRuta("0190A000-0000-7000-8000-0000000000aB")).toBe(ID);
  });

  it("llaves, sin guiones, con espacios o ausente -> 404 no_encontrado", () => {
    for (const v of [`{${ID}}`, ID.replaceAll("-", ""), ` ${ID}`, undefined]) {
      expect(() => idDeRuta(v)).toThrow(expect.objectContaining({ codigo: "no_encontrado" }));
    }
  });
});

describe("H-005-1b-1 · rolesQueOtorga (revocación de pendientes al degradar o desactivar)", () => {
  it("Dueño: todos; Administrador: todos salvo dueno; el resto: ninguno", () => {
    const tabla = Object.fromEntries(ROLES.map((r: Rol) => [r, rolesQueOtorga(r)]));
    expect(tabla).toEqual({
      dueno: ["dueno", "admin", "contador", "asistente", "lectura"],
      admin: ["admin", "contador", "asistente", "lectura"],
      contador: [],
      asistente: [],
      lectura: [],
    });
  });
});

describe("H-005-1b-2 · correo con caracteres de control al invitar", () => {
  it.each([
    ["NUL", "a\u0000b@x.pe"],
    ["BEL", "a\u0007b@x.pe"],
    ["ESC", "ab@x\u001b.pe"],
    ["DEL", "ab@x.pe\u007f"],
    ["C1", "a\u0085b@x.pe"],
  ])("%s -> 400 solicitud_invalida sin abrir transacción ni encolar", async (_n, correo) => {
    const { svc, db, cola } = armar();
    await expect(svc.invitar(LLAMANTE, { correo, rol: "lectura" })).rejects.toMatchObject({
      codigo: "solicitud_invalida",
    });
    expect(db.withTenant).not.toHaveBeenCalled();
    expect(cola.encolar).not.toHaveBeenCalled();
  });

  it("un correo normal sí llega a la transacción", async () => {
    const { svc, db } = armar();
    db.withTenant.mockRejectedValueOnce(new Error("corte de la prueba"));
    await expect(svc.invitar(LLAMANTE, { correo: "ana@x.pe", rol: "lectura" })).rejects.toThrow("corte de la prueba");
    expect(db.withTenant).toHaveBeenCalledTimes(1);
  });
});

describe("H-005-1b-3 · nombre con caracteres de control al aceptar", () => {
  it.each([
    ["NUL", "Ana\u0000r1"],
    ["BEL", "Ana\u0007"],
    ["ESC", "\u001b[31mAna"],
    ["DEL", "Ana\u007f"],
  ])("%s -> 400 solicitud_invalida antes del token y de Argon2", async (_n, nombre) => {
    const { svc, db, hasher } = armar();
    await expect(
      svc.aceptar({ token: generarToken(), nombre, contrasena: "una-clave-larga-y-unica-77" }),
    ).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    expect(db.withAuth).not.toHaveBeenCalled();
    expect(hasher.calcular).not.toHaveBeenCalled();
  });
});
