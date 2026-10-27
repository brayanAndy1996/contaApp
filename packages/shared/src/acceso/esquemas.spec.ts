import { describe, expect, it } from "vitest";
import {
  aceptarConSesionSchema,
  aceptarInvitacionSchema,
  asignarClienteSchema,
  asignarPorClienteSchema,
  asignarPorUsuarioSchema,
  cambiarRolSchema,
  consultarInvitacionSchema,
  invitarSchema,
} from "./index.js";

// Contrato (plan 005, shared/acceso/esquemas.ts): un `z.object` por cuerpo de HTTP. Las claves
// desconocidas se DESCARTAN (no se rechazan): `tenantId`, `rol` extra, `usuarioId` ajeno... (CA-4,
// "asignacion masiva de campos"). Los lotes van de 1 a 500 ids (CA-8).
//  - cambiarRolSchema            PATCH /usuarios/:id/rol          {rol}
//  - invitarSchema               POST  /invitaciones              {correo, rol}
//  - consultarInvitacionSchema   POST  /invitaciones/consultar    {token}
//  - aceptarInvitacionSchema     POST  /invitaciones/aceptar      {token, nombre, contrasena}
//  - aceptarConSesionSchema      POST  /invitaciones/aceptar-con-sesion {token}
//  - asignarClienteSchema        PUT   /clientes/:c/asignaciones/:u {tipo, anterior?}
//  - asignarPorUsuarioSchema     POST  /asignaciones/por-usuario  {usuarioId, clienteIds, tipo, anterior?}
//  - asignarPorClienteSchema     POST  /asignaciones/por-cliente  {clienteId, usuarioIds}
const uuid = (n: number): string =>
  `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => uuid(i + 1));
const AJENO = { tenantId: uuid(999), tenant_id: uuid(999), esAdmin: true };

describe("cambiarRolSchema", () => {
  it.each(["dueno", "admin", "contador", "asistente", "lectura"])(
    "acepta el rol %s",
    (rol) => {
      expect(cambiarRolSchema.parse({ rol })).toEqual({ rol });
    },
  );

  it("rechaza un rol fuera del catalogo, vacio o de otro tipo", () => {
    for (const rol of [
      "superadmin",
      "",
      "DUENO",
      null,
      undefined,
      1,
      ["dueno"],
    ]) {
      expect(cambiarRolSchema.safeParse({ rol }).success, String(rol)).toBe(
        false,
      );
    }
    expect(cambiarRolSchema.safeParse({}).success).toBe(false);
  });

  it("descarta tenantId y cualquier otro campo extra", () => {
    const salida = cambiarRolSchema.parse({
      rol: "contador",
      tenantId: uuid(9),
      usuarioId: uuid(8),
      activo: true,
    });
    expect(salida).toEqual({ rol: "contador" });
    expect(Object.keys(salida)).toEqual(["rol"]);
  });
});

describe("invitarSchema", () => {
  it("acepta correo y rol y descarta tenantId y campos extra", () => {
    const salida = invitarSchema.parse({
      correo: "nuevo@estudio.test",
      rol: "asistente",
      ...AJENO,
    });
    expect(salida).toEqual({ correo: "nuevo@estudio.test", rol: "asistente" });
    expect(Object.keys(salida).sort()).toEqual(["correo", "rol"]);
  });

  it("exige correo (texto) y un rol valido", () => {
    expect(invitarSchema.safeParse({ rol: "asistente" }).success).toBe(false);
    expect(invitarSchema.safeParse({ correo: "a@b.test" }).success).toBe(false);
    expect(
      invitarSchema.safeParse({ correo: "a@b.test", rol: "superadmin" })
        .success,
    ).toBe(false);
    expect(invitarSchema.safeParse({ correo: 5, rol: "lectura" }).success).toBe(
      false,
    );
  });
});

describe("consultar y aceptar invitacion", () => {
  it("consultar y aceptar-con-sesion solo conservan token", () => {
    expect(
      consultarInvitacionSchema.parse({ token: "abc", rol: "dueno", ...AJENO }),
    ).toEqual({ token: "abc" });
    expect(
      aceptarConSesionSchema.parse({ token: "abc", rol: "dueno", ...AJENO }),
    ).toEqual({ token: "abc" });
    expect(consultarInvitacionSchema.safeParse({}).success).toBe(false);
    expect(aceptarConSesionSchema.safeParse({ token: 1 }).success).toBe(false);
  });

  it("aceptar conserva token, nombre y contrasena y descarta rol y tenantId", () => {
    const entrada = {
      token: "t",
      nombre: "Ana",
      contrasena: "clave-larga-de-prueba",
      rol: "dueno",
      ...AJENO,
    };
    expect(aceptarInvitacionSchema.parse(entrada)).toEqual({
      token: "t",
      nombre: "Ana",
      contrasena: "clave-larga-de-prueba",
    });
  });

  it("aceptar exige los tres campos como texto", () => {
    for (const falta of ["token", "nombre", "contrasena"]) {
      const base: Record<string, unknown> = {
        token: "t",
        nombre: "Ana",
        contrasena: "clave-larga-de-prueba",
      };
      delete base[falta];
      expect(aceptarInvitacionSchema.safeParse(base).success, falta).toBe(
        false,
      );
    }
    expect(
      aceptarInvitacionSchema.safeParse({
        token: "t",
        nombre: "Ana",
        contrasena: 1234,
      }).success,
    ).toBe(false);
  });
});

describe("asignarClienteSchema (PUT individual)", () => {
  it("acepta tipo responsable o colaborador, con o sin anterior", () => {
    expect(asignarClienteSchema.parse({ tipo: "colaborador" })).toEqual({
      tipo: "colaborador",
    });
    expect(
      asignarClienteSchema.parse({ tipo: "responsable", anterior: "retirar" }),
    ).toEqual({
      tipo: "responsable",
      anterior: "retirar",
    });
    expect(
      asignarClienteSchema.parse({
        tipo: "responsable",
        anterior: "colaborador",
      }),
    ).toEqual({
      tipo: "responsable",
      anterior: "colaborador",
    });
  });

  it("rechaza tipo o anterior fuera de los valores permitidos", () => {
    expect(asignarClienteSchema.safeParse({ tipo: "dueno" }).success).toBe(
      false,
    );
    expect(asignarClienteSchema.safeParse({}).success).toBe(false);
    expect(
      asignarClienteSchema.safeParse({
        tipo: "responsable",
        anterior: "responsable",
      }).success,
    ).toBe(false);
    expect(
      asignarClienteSchema.safeParse({
        tipo: "responsable",
        anterior: "borrar",
      }).success,
    ).toBe(false);
  });

  it("descarta usuarioId, clienteId, tenantId y rol del cuerpo (vienen de la URL o de la sesion)", () => {
    const salida = asignarClienteSchema.parse({
      tipo: "colaborador",
      usuarioId: uuid(5),
      clienteId: uuid(6),
      rol: "dueno",
      ...AJENO,
    });
    expect(salida).toEqual({ tipo: "colaborador" });
  });
});

describe("asignarPorUsuarioSchema (masiva, CA-8)", () => {
  const base = { usuarioId: uuid(1000), tipo: "colaborador" as const };

  it("acepta lotes de 1 y de 500 clientes", () => {
    expect(
      asignarPorUsuarioSchema.safeParse({ ...base, clienteIds: ids(1) })
        .success,
    ).toBe(true);
    expect(
      asignarPorUsuarioSchema.safeParse({ ...base, clienteIds: ids(500) })
        .success,
    ).toBe(true);
  });

  it("rechaza un lote vacio y uno de 501", () => {
    expect(
      asignarPorUsuarioSchema.safeParse({ ...base, clienteIds: [] }).success,
    ).toBe(false);
    expect(
      asignarPorUsuarioSchema.safeParse({ ...base, clienteIds: ids(501) })
        .success,
    ).toBe(false);
  });

  it("rechaza ids que no son UUID, elementos de otro tipo y clienteIds que no es lista", () => {
    expect(
      asignarPorUsuarioSchema.safeParse({
        ...base,
        clienteIds: [uuid(1), "no-uuid"],
      }).success,
    ).toBe(false);
    expect(
      asignarPorUsuarioSchema.safeParse({ ...base, clienteIds: [uuid(1), 7] })
        .success,
    ).toBe(false);
    expect(
      asignarPorUsuarioSchema.safeParse({ ...base, clienteIds: uuid(1) })
        .success,
    ).toBe(false);
    expect(
      asignarPorUsuarioSchema.safeParse({
        ...base,
        usuarioId: "x",
        clienteIds: ids(1),
      }).success,
    ).toBe(false);
  });

  it("acepta anterior y exige tipo valido", () => {
    expect(
      asignarPorUsuarioSchema.safeParse({
        ...base,
        tipo: "responsable",
        anterior: "retirar",
        clienteIds: ids(2),
      }).success,
    ).toBe(true);
    expect(
      asignarPorUsuarioSchema.safeParse({
        ...base,
        tipo: "otro",
        clienteIds: ids(2),
      }).success,
    ).toBe(false);
  });

  it("descarta rol, tenantId y cualquier campo extra (asignacion masiva de campos)", () => {
    const salida = asignarPorUsuarioSchema.parse({
      ...base,
      clienteIds: ids(2),
      rol: "dueno",
      ...AJENO,
    });
    expect(Object.keys(salida).sort()).toEqual([
      "clienteIds",
      "tipo",
      "usuarioId",
    ]);
    expect(salida.usuarioId).toBe(base.usuarioId);
  });
});

describe("asignarPorClienteSchema (masiva, CA-8)", () => {
  const base = { clienteId: uuid(2000) };

  it("acepta lotes de 1 y de 500 usuarios", () => {
    expect(
      asignarPorClienteSchema.safeParse({ ...base, usuarioIds: ids(1) })
        .success,
    ).toBe(true);
    expect(
      asignarPorClienteSchema.safeParse({ ...base, usuarioIds: ids(500) })
        .success,
    ).toBe(true);
  });

  it("rechaza un lote vacio y uno de 501", () => {
    expect(
      asignarPorClienteSchema.safeParse({ ...base, usuarioIds: [] }).success,
    ).toBe(false);
    expect(
      asignarPorClienteSchema.safeParse({ ...base, usuarioIds: ids(501) })
        .success,
    ).toBe(false);
  });

  it("rechaza ids que no son UUID y clienteId malformado", () => {
    expect(
      asignarPorClienteSchema.safeParse({ ...base, usuarioIds: ["x"] }).success,
    ).toBe(false);
    expect(
      asignarPorClienteSchema.safeParse({ clienteId: "x", usuarioIds: ids(1) })
        .success,
    ).toBe(false);
    expect(
      asignarPorClienteSchema.safeParse({ usuarioIds: ids(1) }).success,
    ).toBe(false);
  });

  it("descarta tipo, rol, tenantId y campos extra: las asignaciones por cliente son colaboradores", () => {
    const salida = asignarPorClienteSchema.parse({
      ...base,
      usuarioIds: ids(3),
      tipo: "responsable",
      rol: "dueno",
      ...AJENO,
    });
    expect(Object.keys(salida).sort()).toEqual(["clienteId", "usuarioIds"]);
  });
});
