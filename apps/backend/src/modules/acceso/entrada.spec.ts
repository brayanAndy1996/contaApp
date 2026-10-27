import { AccesoRepoError } from "@contapp/db";
import { describe, expect, it } from "vitest";
import {
  idDeRuta,
  parsearCuerpo,
  traducirInvitacionExistente,
  traducirUltimoDueno,
} from "./entrada.js";
import { AccesoError } from "./errores.js";

describe("traducirUltimoDueno (trigger del último Dueño, D10)", () => {
  it("SQLSTATE P0001 -> 409 ultimo_dueno", () => {
    const r = traducirUltimoDueno(new AccesoRepoError("P0001"));
    expect(r).toBeInstanceOf(AccesoError);
    expect((r as AccesoError).codigo).toBe("ultimo_dueno");
    expect((r as AccesoError).getStatus()).toBe(409);
  });

  it("otro SQLSTATE o un error ajeno pasan intactos", () => {
    const otro = new AccesoRepoError("23505");
    expect(traducirUltimoDueno(otro)).toBe(otro);
    const ajeno = new Error("P0001");
    expect(traducirUltimoDueno(ajeno)).toBe(ajeno);
    expect(traducirUltimoDueno("texto")).toBe("texto");
  });
});

describe("traducirInvitacionExistente (índice único parcial)", () => {
  it("SQLSTATE 23505 -> 409 invitacion_existente", () => {
    const r = traducirInvitacionExistente(new AccesoRepoError("23505"));
    expect((r as AccesoError).codigo).toBe("invitacion_existente");
    expect((r as AccesoError).getStatus()).toBe(409);
  });

  it("otro SQLSTATE o un error ajeno pasan intactos", () => {
    const otro = new AccesoRepoError("P0001");
    expect(traducirInvitacionExistente(otro)).toBe(otro);
    const ajeno = new Error("23505");
    expect(traducirInvitacionExistente(ajeno)).toBe(ajeno);
  });
});

describe("idDeRuta y parsearCuerpo", () => {
  it("ID ausente o que no es UUID -> 404 no_encontrado", () => {
    for (const malo of [undefined, "", "abc", "1; drop table x"]) {
      expect(() => idDeRuta(malo)).toThrowError(
        expect.objectContaining({ codigo: "no_encontrado" }),
      );
    }
  });

  it("UUID canónico se devuelve tal cual", () => {
    const id = "0190a000-0000-7000-8000-000000000001";
    expect(idDeRuta(id)).toBe(id);
  });

  it("cuerpo inválido -> 400 solicitud_invalida sin eco; válido devuelve los datos", () => {
    const esquema = {
      safeParse: (v: unknown) =>
        typeof v === "string"
          ? { success: true, data: v }
          : { success: false },
    };
    expect(parsearCuerpo(esquema, "ok")).toBe("ok");
    let error: unknown;
    try {
      parsearCuerpo(esquema, { secreto: 1 });
    } catch (e) {
      error = e;
    }
    expect((error as AccesoError).getResponse()).toEqual({
      codigo: "solicitud_invalida",
    });
    expect((error as AccesoError).getStatus()).toBe(400);
  });
});
