import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth.service.js";
import { AuthError } from "../errores.js";
import { derivarCsrf } from "../sesion/csrf.js";
import { generarToken } from "../sesion/token.js";
import { CsrfGuard } from "./csrf.guard.js";
import {
  esMetodoSeguro,
  extraerSesion,
  fijarSesion,
  Publico,
  SESION,
  SesionOpcional,
  SinEstudio,
  type PeticionAuth,
} from "./decoradores.js";
import { EstudioGuard } from "./estudio.guard.js";
import { SesionGuard } from "./sesion.guard.js";

// Unitarias de los guards de sesión, estudio y CSRF y de los decoradores (T11 de 004).
const T_A = "0190a000-0000-7000-8000-0000000000aa";
const reflector = new Reflector();

type Marca = "publico" | "sinEstudio" | "opcional" | null;
function handler(marca: Marca): () => void {
  const fn = () => undefined;
  if (marca === "publico") Publico()(fn);
  if (marca === "sinEstudio") SinEstudio()(fn);
  if (marca === "opcional") SesionOpcional()(fn);
  return fn;
}
class Controlador {}

function ctx(req: PeticionAuth, marca: Marca = null): ExecutionContext {
  const h = handler(marca);
  return {
    getHandler: () => h,
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function sesion(o: Partial<SesionResuelta> = {}): SesionResuelta {
  return {
    token: generarToken(),
    sesionId: "s1",
    usuarioId: "u1",
    tenantActivo: T_A,
    estudioRevocado: false,
    expiraAbsoluta: new Date(Date.now() + 3_600_000),
    ...o,
  };
}

const peticion = (method: string, headers: PeticionAuth["headers"] = {}, s?: SesionResuelta): PeticionAuth => {
  const req: PeticionAuth = { method, headers };
  if (s) fijarSesion(req, s);
  return req;
};

function rechazo(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError);
    return (e as AuthError).codigo;
  }
  throw new Error("se esperaba un rechazo");
}

describe("decoradores", () => {
  it("fijarSesion deja el contexto público y la sesión fuera de la serialización", () => {
    const s = sesion();
    const req = peticion("GET", {}, s);
    expect(req.contexto).toEqual({ userId: "u1", tenantId: T_A, sesionId: "s1" });
    expect(req[SESION]).toBe(s);
    expect(JSON.stringify(req)).not.toContain(s.token);
    expect(Object.keys(req)).not.toContain(String(SESION));
    expect(extraerSesion(undefined, ctx(req))).toBe(s);
    expect(extraerSesion(undefined, ctx(peticion("GET")))).toBeNull();
  });

  it("GET, HEAD y OPTIONS son seguros; el resto no", () => {
    expect(["GET", "head", "OPTIONS"].every(esMetodoSeguro)).toBe(true);
    expect(["POST", "PUT", "PATCH", "DELETE"].some(esMetodoSeguro)).toBe(false);
  });
});

describe("SesionGuard", () => {
  const guard = (resultado: SesionResuelta | null) => {
    const auth = { resolverSesion: vi.fn(async () => resultado) };
    return { auth, g: new SesionGuard(reflector, auth) };
  };

  it("con sesión válida fija el contexto", async () => {
    const s = sesion();
    const { auth, g } = guard(s);
    const req = peticion("GET", { cookie: "a=1" });
    expect(await g.canActivate(ctx(req))).toBe(true);
    expect(auth.resolverSesion).toHaveBeenCalledWith("a=1");
    expect(req.contexto?.userId).toBe("u1");
  });

  it("sin sesión: 401 sesion_invalida; en @SesionOpcional sigue sin sesión", async () => {
    const { auth, g } = guard(null);
    await expect(g.canActivate(ctx(peticion("GET", { cookie: ["x", "y"] })))).rejects.toMatchObject({
      codigo: "sesion_invalida",
    });
    expect(auth.resolverSesion).toHaveBeenCalledWith(undefined);
    const req = peticion("POST");
    expect(await g.canActivate(ctx(req, "opcional"))).toBe(true);
    expect(req.contexto).toBeUndefined();
  });

  it("@Publico no resuelve la sesión", async () => {
    const { auth, g } = guard(sesion());
    expect(await g.canActivate(ctx(peticion("POST"), "publico"))).toBe(true);
    expect(auth.resolverSesion).not.toHaveBeenCalled();
  });
});

describe("EstudioGuard (D12, CA-9)", () => {
  const g = new EstudioGuard(reflector);

  it("con estudio activo y X-Estudio igual pasa", () => {
    expect(g.canActivate(ctx(peticion("GET", { "x-estudio": T_A }, sesion())))).toBe(true);
  });

  it("sin estudio o con la membresía revocada: 403 estudio_requerido (antes que el 409)", () => {
    expect(rechazo(() => g.canActivate(ctx(peticion("GET", { "x-estudio": T_A }, sesion({ tenantActivo: null })))))).toBe(
      "estudio_requerido",
    );
    expect(rechazo(() => g.canActivate(ctx(peticion("GET", { "x-estudio": T_A }, sesion({ estudioRevocado: true })))))).toBe(
      "estudio_requerido",
    );
  });

  it.each([[undefined], ["0190a000-0000-7000-8000-0000000000bb"], [[T_A, T_A]]])(
    "X-Estudio ausente o distinto (%j): 409 estudio_desfasado",
    (cabecera) => {
      expect(rechazo(() => g.canActivate(ctx(peticion("GET", { "x-estudio": cabecera }, sesion()))))).toBe(
        "estudio_desfasado",
      );
    },
  );

  it("@Publico, @SinEstudio y @SesionOpcional no exigen estudio; sin sesión en ruta normal: 401", () => {
    for (const m of ["publico", "sinEstudio", "opcional"] as const) {
      expect(g.canActivate(ctx(peticion("POST"), m))).toBe(true);
    }
    expect(rechazo(() => g.canActivate(ctx(peticion("GET"))))).toBe("sesion_invalida");
  });
});

describe("CsrfGuard (D6, CA-7)", () => {
  const g = new CsrfGuard(reflector);

  it("no-GET con sesión y X-CSRF-Token derivado pasa", () => {
    const s = sesion();
    expect(g.canActivate(ctx(peticion("POST", { "x-csrf-token": derivarCsrf(s.token) }, s), "sinEstudio"))).toBe(true);
  });

  it.each([[undefined], ["x"], [[]]])("token ausente o inválido (%j): 403 csrf_invalido", (valor) => {
    const s = sesion();
    expect(rechazo(() => g.canActivate(ctx(peticion("POST", { "x-csrf-token": valor }, s))))).toBe("csrf_invalido");
  });

  it("el token de otra sesión o el propio token de sesión no sirven", () => {
    const s = sesion();
    for (const valor of [derivarCsrf(generarToken()), s.token]) {
      expect(rechazo(() => g.canActivate(ctx(peticion("DELETE", { "x-csrf-token": valor }, s))))).toBe("csrf_invalido");
    }
  });

  it("GET y @Publico no se validan; sin sesión en @SesionOpcional pasa y en ruta normal da 401", () => {
    expect(g.canActivate(ctx(peticion("GET", {}, sesion())))).toBe(true);
    expect(g.canActivate(ctx(peticion("POST"), "publico"))).toBe(true);
    expect(g.canActivate(ctx(peticion("POST"), "opcional"))).toBe(true);
    expect(rechazo(() => g.canActivate(ctx(peticion("POST"))))).toBe("sesion_invalida");
  });
});
