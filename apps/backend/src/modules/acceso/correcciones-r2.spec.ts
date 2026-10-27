// Spec 005 · T17: pruebas propias (sin BD) de la corrección de nombres de la ronda adversarial 2 (H-005-2a-2 =
// H-005-2b-2). La validación equivalente de la BD está en tests/aislamiento/acceso-correcciones-r2.spec.ts.
import { describe, expect, it, vi } from "vitest";
import { generarToken } from "../auth/sesion/token.js";
import { InvitacionesService, nombreValido } from "./invitaciones.service.js";

function armar() {
  const db = { withAuth: vi.fn(), withTenant: vi.fn() };
  const hasher = { calcular: vi.fn(async () => "$argon2id$hash") };
  const svc = new InvitacionesService(
    db as never,
    hasher as never,
    { encolar: vi.fn() } as never,
    new Set<string>(),
    "http://localhost:3000",
    { alInvitar: vi.fn(), alReactivar: vi.fn(), alAceptar: vi.fn() } as never,
  );
  return { svc, db, hasher };
}

describe("H-005-2a-2 · nombres invisibles, con formato o sin letra ni dígito", () => {
  it.each([
    ["ZWSP", "​​"],
    ["WJ", "⁠"],
    ["RLO + PDF", "‮‬"],
    ["RLO dentro", "Ana‮nimda"],
    ["RLI (aislamiento)", "Ana⁧x"],
    ["ZWJ", "Ana‍"],
    ["BOM dentro", "A﻿na"],
    ["guion suave", "Ana­"],
    ["etiqueta", "Ana\u{e0041}"],
    ["solo signos", "-- . --"],
    ["solo espacio ideográfico", "　"],
    ["solo marca combinante", "́"],
  ])("%s -> 400 solicitud_invalida antes del token y de Argon2", async (_n, nombre) => {
    const { svc, db, hasher } = armar();
    await expect(
      svc.aceptar({ token: generarToken(), nombre, contrasena: "una-clave-larga-y-unica-77" }),
    ).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    expect(db.withAuth).not.toHaveBeenCalled();
    expect(hasher.calcular).not.toHaveBeenCalled();
  });

  it("nombres reales pasan: acentos, CJK, devanagari, dígitos árabes, apóstrofo y guion", () => {
    for (const n of ["José Ñúñez", "李明", "कि", "٣", "O'Brien-Pérez", "Ana María 2"]) {
      expect(nombreValido(n), n).toBe(true);
    }
  });

  it("límites: vacío y más de 200 no; 200 sí", () => {
    expect(nombreValido("")).toBe(false);
    expect(nombreValido("a".repeat(200))).toBe(true);
    expect(nombreValido("a".repeat(201))).toBe(false);
  });
});
