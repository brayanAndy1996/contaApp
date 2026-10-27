import { AuthRepoError } from "@contapp/db";
import { describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AuthError } from "../auth/errores.js";
import { generarToken } from "../auth/sesion/token.js";
import { InvitacionesService } from "./invitaciones.service.js";

// Ramas defensivas y de carrera de `aceptar` / `aceptarConSesion` con dobles (sin BD). No dependen de la
// forma exacta de `InvitacionVigente`: el doble devuelve lo mínimo que lee el servicio.
const CONTRASENA = "una-clave-larga-y-unica-77";
const TENANT = "0190a000-0000-7000-8000-0000000000a1";

const VIGENTE = {
  tenantId: TENANT,
  estudioNombre: "Estudio",
  correo: "ana@x.pe",
  rol: "contador",
  cuentaExiste: false,
};

function armar(
  opciones: {
    vigente?: unknown;
    aceptarNueva?: () => Promise<unknown>;
    cupo?: () => Promise<void>;
  } = {},
) {
  const a = {
    invitacionVigente: vi.fn(async () =>
      opciones.vigente === undefined ? VIGENTE : opciones.vigente,
    ),
    invitacionAceptarNueva: vi.fn(
      opciones.aceptarNueva ?? (async () => "aceptada"),
    ),
    invitacionAceptarExistente: vi.fn(async () => null),
  };
  const db = {
    withAuth: vi.fn((fn: (a: unknown) => unknown) => Promise.resolve(fn(a))),
    withTenant: vi.fn(),
  };
  const hasher = { calcular: vi.fn(async () => "$argon2id$hash") };
  const cupo = {
    alInvitar: vi.fn(),
    alReactivar: vi.fn(),
    alAceptar: vi.fn(opciones.cupo ?? (async () => undefined)),
  };
  const svc = new InvitacionesService(
    db as never,
    hasher as never,
    { encolar: vi.fn() } as never,
    new Set<string>(),
    "http://localhost:3000",
    cupo as never,
  );
  return { svc, a, db, hasher, cupo };
}

const cuerpo = (nombre: string) => ({
  token: generarToken(),
  nombre,
  contrasena: CONTRASENA,
});

describe("aceptar: nombre inválido (defensivo)", () => {
  it.each([
    ["vacío", ""],
    ["solo espacios", "   \t "],
    ["más de 200 caracteres", "a".repeat(201)],
  ])(
    "nombre %s -> 400 solicitud_invalida sin tocar la BD ni Argon2",
    async (_n, nombre) => {
      const { svc, db, hasher } = armar();
      await expect(svc.aceptar(cuerpo(nombre))).rejects.toMatchObject({
        codigo: "solicitud_invalida",
      });
      expect(db.withAuth).not.toHaveBeenCalled();
      expect(hasher.calcular).not.toHaveBeenCalled();
    },
  );

  it("el nombre se recorta y 200 caracteres exactos son válidos", async () => {
    const nombre = "a".repeat(200);
    const { svc, a } = armar();
    await expect(svc.aceptar(cuerpo(`  ${nombre}  `))).resolves.toBeUndefined();
    expect(a.invitacionAceptarNueva).toHaveBeenCalledWith(
      expect.any(Buffer),
      nombre,
      "$argon2id$hash",
    );
  });
});

describe("aceptar: carrera en la aceptación", () => {
  it("AuthRepoError (p. ej. dos invitaciones al mismo correo nuevo) -> 400 invitacion_invalida", async () => {
    const { svc } = armar({
      aceptarNueva: async () => {
        throw new AuthRepoError("23505");
      },
    });
    await expect(svc.aceptar(cuerpo("Ana"))).rejects.toMatchObject({
      codigo: "invitacion_invalida",
    });
  });

  it("un error que no es AuthRepoError se propaga tal cual (no se enmascara)", async () => {
    const boom = new Error("conexión caída");
    const { svc } = armar({
      aceptarNueva: async () => {
        throw boom;
      },
    });
    await expect(svc.aceptar(cuerpo("Ana"))).rejects.toBe(boom);
  });

  it.each([
    ["invalida", "invitacion_invalida"],
    ["cuenta_existe", "requiere_sesion"],
  ])("resultado %s de la BD -> %s", async (resultado, codigo) => {
    const { svc } = armar({ aceptarNueva: async () => resultado });
    await expect(svc.aceptar(cuerpo("Ana"))).rejects.toMatchObject({ codigo });
  });

  it("invitación no viva (null) -> invitacion_invalida sin Argon2 ni creación", async () => {
    const { svc, hasher, a } = armar({ vigente: null });
    await expect(svc.aceptar(cuerpo("Ana"))).rejects.toMatchObject({
      codigo: "invitacion_invalida",
    });
    expect(hasher.calcular).not.toHaveBeenCalled();
    expect(a.invitacionAceptarNueva).not.toHaveBeenCalled();
  });

  it("cuenta ya existente -> 409 requiere_sesion sin consumir ni hashear", async () => {
    const { svc, hasher, a } = armar({
      vigente: { ...VIGENTE, cuentaExiste: true },
    });
    await expect(svc.aceptar(cuerpo("Ana"))).rejects.toMatchObject({
      codigo: "requiere_sesion",
    });
    expect(hasher.calcular).not.toHaveBeenCalled();
    expect(a.invitacionAceptarNueva).not.toHaveBeenCalled();
  });

  it("si el cupo rechaza, el error se propaga y no se crea la cuenta", async () => {
    const sinCupo = new Error("sin cupo");
    const { svc, a } = armar({
      cupo: async () => {
        throw sinCupo;
      },
    });
    await expect(svc.aceptar(cuerpo("Ana"))).rejects.toBe(sinCupo);
    expect(a.invitacionAceptarNueva).not.toHaveBeenCalled();
  });
});

describe("aceptarConSesion: ramas defensivas", () => {
  const sesion = { tenantActivo: TENANT, token: generarToken() } as SesionResuelta;

  it("X-Estudio distinto del de la sesión -> AuthError sin tocar la BD", async () => {
    const { svc, db } = armar();
    await expect(
      svc.aceptarConSesion(
        sesion,
        { token: generarToken() },
        "0190a000-0000-7000-8000-0000000000ff",
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(db.withAuth).not.toHaveBeenCalled();
  });

  it("token con formato inválido -> invitacion_invalida sin tocar la BD", async () => {
    const { svc, db } = armar();
    await expect(
      svc.aceptarConSesion(sesion, { token: "corto" }),
    ).rejects.toMatchObject({ codigo: "invitacion_invalida" });
    expect(db.withAuth).not.toHaveBeenCalled();
  });

  it("la BD no acepta (null: otro correo, ya miembro, vencida) -> invitacion_invalida y no se consulta el cupo", async () => {
    const { svc, a, cupo } = armar();
    await expect(
      svc.aceptarConSesion(sesion, { token: generarToken() }),
    ).rejects.toMatchObject({ codigo: "invitacion_invalida" });
    expect(a.invitacionAceptarExistente).toHaveBeenCalledTimes(1);
    expect(cupo.alAceptar).not.toHaveBeenCalled();
  });
});
