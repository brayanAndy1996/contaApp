import "reflect-metadata";
import { HttpException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ContappDb } from "@contapp/db";
import type { Permiso as TipoPermiso, Rol } from "@contapp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../../auth/auth.service.js";
import {
  fijarSesion,
  Publico,
  SesionOpcional,
  SinEstudio,
  type PeticionAuth,
} from "../../auth/guards/decoradores.js";
import { generarToken } from "../../auth/sesion/token.js";
import { Permiso, SoloEstudio } from "./decoradores.js";
import { PermisoGuard } from "./permiso.guard.js";

// Unitarias de PermisoGuard con dobles (T3 de 005). Contrato (plan: Guards y decoradores):
//  - `new PermisoGuard(reflector, db)`; `db` = { withTenant } y la lectura del rol sale de
//    `miembroActual(tx, usuarioId)` de `@contapp/db` -> `{ rol } | null` (null = sin membresia activa).
//  - sin declaracion -> 403 permiso_denegado; @SoloEstudio/@Publico/@SinEstudio/@SesionOpcional pasan
//    sin consultar la BD; @Permiso(p) -> lee el rol en un withTenant propio, fija `req.acceso`
//    (no enumerable) y, sin el permiso, 403 permiso_denegado; sin fila -> 403 estudio_requerido.
//  - `req.acceso = { usuarioId, rol, permisos (iterable), alcance: 'global' | 'asignado' }`.
const { miembroActual } = vi.hoisted(() => ({ miembroActual: vi.fn() }));
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  miembroActual: (...a: unknown[]) => miembroActual(...a),
}));

const T_A = "0190a000-0000-7000-8000-0000000000aa";
const reflector = new Reflector();
const tx = { marca: "tx-de-prueba" };
const withTenant = vi.fn(
  async (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
);
const db = { withTenant } as unknown as Pick<ContappDb, "withTenant">;

type Req = PeticionAuth & {
  acceso?: Record<string, unknown>;
  params?: Record<string, string>;
};
class Controlador {}

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

function peticion(s: SesionResuelta | null = sesion()): Req {
  const req: Req = { method: "GET", headers: {} };
  if (s) fijarSesion(req, s);
  return req;
}

/** Contexto con el handler decorado por `decorar` (sin decorar = ruta sin declaracion). */
function ctx(
  req: Req,
  decorar?: (fn: () => void) => void,
  clase: object = Controlador,
): ExecutionContext {
  const handler = () => undefined;
  decorar?.(handler);
  return {
    getHandler: () => handler,
    getClass: () => clase,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

async function rechazo(
  p: Promise<unknown>,
): Promise<{ estado: number; cuerpo: unknown }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return {
      estado: (e as HttpException).getStatus(),
      cuerpo: (e as HttpException).getResponse(),
    };
  }
  throw new Error("se esperaba un rechazo");
}

const guard = () => new PermisoGuard(reflector, db);
const conRol = (rol: Rol) =>
  miembroActual.mockResolvedValue({ usuarioId: "u1", rol });
const exigir = (p: TipoPermiso) => (fn: () => void) => Permiso(p)(fn);

beforeEach(() => {
  miembroActual.mockReset();
  withTenant.mockClear();
});

describe("PermisoGuard: denegacion por defecto (D4)", () => {
  it("una ruta sin ninguna declaracion responde 403 permiso_denegado sin consultar la BD", async () => {
    conRol("dueno");
    const r = await rechazo(
      Promise.resolve().then(() => guard().canActivate(ctx(peticion()))),
    );
    expect(r).toEqual({ estado: 403, cuerpo: { codigo: "permiso_denegado" } });
    expect(withTenant).not.toHaveBeenCalled();
    expect(miembroActual).not.toHaveBeenCalled();
  });

  it("@SoloEstudio pasa sin permiso y sin leer el rol", async () => {
    expect(
      await guard().canActivate(ctx(peticion(), (fn) => SoloEstudio()(fn))),
    ).toBe(true);
    expect(withTenant).not.toHaveBeenCalled();
    expect(miembroActual).not.toHaveBeenCalled();
  });

  it.each([
    ["@Publico", (fn: () => void) => Publico()(fn)],
    ["@SinEstudio", (fn: () => void) => SinEstudio()(fn)],
    ["@SesionOpcional", (fn: () => void) => SesionOpcional()(fn)],
  ])(
    "%s de 004 equivale a una declaracion: pasa sin consultar la BD",
    async (_n, decorar) => {
      expect(await guard().canActivate(ctx(peticion(null), decorar))).toBe(
        true,
      );
      expect(withTenant).not.toHaveBeenCalled();
    },
  );

  it("@Permiso a nivel de clase vale para sus handlers", async () => {
    class ConPermisoDeClase {}
    Permiso("clientes.ver")(ConPermisoDeClase);
    conRol("lectura");
    expect(
      await guard().canActivate(ctx(peticion(), undefined, ConPermisoDeClase)),
    ).toBe(true);
    expect(miembroActual).toHaveBeenCalledTimes(1);
  });

  it("@Permiso en el handler manda sobre el de la clase", async () => {
    class ConPermisoDeClase {}
    Permiso("clientes.ver")(ConPermisoDeClase);
    conRol("lectura");
    const r = await rechazo(
      Promise.resolve().then(() =>
        guard().canActivate(
          ctx(peticion(), exigir("clientes.asignar"), ConPermisoDeClase),
        ),
      ),
    );
    expect(r).toEqual({ estado: 403, cuerpo: { codigo: "permiso_denegado" } });
  });
});

describe("PermisoGuard: rol de la membresia activa (D3)", () => {
  it("lee el rol en un withTenant propio con el estudio y el usuario de la sesion", async () => {
    conRol("contador");
    await guard().canActivate(ctx(peticion(), exigir("sire.descargar")));
    expect(withTenant).toHaveBeenCalledTimes(1);
    expect(withTenant.mock.calls[0]?.[0]).toEqual({
      tenantId: T_A,
      userId: "u1",
    });
    expect(miembroActual).toHaveBeenCalledWith(tx, "u1");
  });

  it.each([
    ["contador", "sire.aprobar_generar", true],
    ["contador", "credenciales.editar", true],
    ["asistente", "sire.clasificar", true],
    ["asistente", "sire.aprobar_generar", false],
    ["asistente", "credenciales.editar", false],
    ["asistente", "clientes.asignar", false],
    ["lectura", "clientes.ver", true],
    ["lectura", "sire.clasificar", false],
    ["lectura", "usuarios.ver", false],
    ["admin", "usuarios.gestionar", true],
    ["admin", "plan.gestionar", false],
    ["dueno", "plan.gestionar", true],
  ] as const)("%s con %s -> %s", async (rol, permiso, permitido) => {
    conRol(rol);
    const intento = Promise.resolve().then(() =>
      guard().canActivate(ctx(peticion(), exigir(permiso))),
    );
    if (permitido) {
      expect(await intento).toBe(true);
    } else {
      expect(await rechazo(intento)).toEqual({
        estado: 403,
        cuerpo: { codigo: "permiso_denegado" },
      });
    }
  });

  it("sin membresia activa (miembroActual devuelve null): 403 estudio_requerido", async () => {
    miembroActual.mockResolvedValue(null);
    const r = await rechazo(
      Promise.resolve().then(() =>
        guard().canActivate(ctx(peticion(), exigir("clientes.ver"))),
      ),
    );
    expect(r).toEqual({ estado: 403, cuerpo: { codigo: "estudio_requerido" } });
  });

  it("sesion sin estudio activo con @Permiso: 403 estudio_requerido y sin consultar la BD", async () => {
    const r = await rechazo(
      Promise.resolve().then(() =>
        guard().canActivate(
          ctx(peticion(sesion({ tenantActivo: null })), exigir("clientes.ver")),
        ),
      ),
    );
    expect(r).toEqual({ estado: 403, cuerpo: { codigo: "estudio_requerido" } });
    expect(miembroActual).not.toHaveBeenCalled();
  });

  it("sin sesion con @Permiso no pasa (401 o 403) ni consulta la BD", async () => {
    const r = await rechazo(
      Promise.resolve().then(() =>
        guard().canActivate(ctx(peticion(null), exigir("clientes.ver"))),
      ),
    );
    expect([401, 403]).toContain(r.estado);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("no hay cache: el rol se vuelve a leer en cada peticion (efecto inmediato, CA-6)", async () => {
    const g = guard();
    conRol("contador");
    expect(
      await g.canActivate(ctx(peticion(), exigir("sire.aprobar_generar"))),
    ).toBe(true);
    conRol("lectura");
    const r = await rechazo(
      Promise.resolve().then(() =>
        g.canActivate(ctx(peticion(), exigir("sire.aprobar_generar"))),
      ),
    );
    expect(r.estado).toBe(403);
    expect(miembroActual).toHaveBeenCalledTimes(2);
    expect(withTenant).toHaveBeenCalledTimes(2);
  });

  it("un fallo de la BD no concede acceso", async () => {
    miembroActual.mockRejectedValue(new Error("falla simulada"));
    await expect(
      guard().canActivate(ctx(peticion(), exigir("clientes.ver"))),
    ).rejects.toThrow();
  });
});

describe("PermisoGuard: req.acceso", () => {
  it.each([
    ["dueno", "global"],
    ["admin", "global"],
    ["contador", "asignado"],
    ["asistente", "asignado"],
    ["lectura", "asignado"],
  ] as const)(
    "con rol %s fija { usuarioId, rol, permisos, alcance: %s }",
    async (rol, alcance) => {
      conRol(rol);
      const req = peticion();
      await guard().canActivate(ctx(req, exigir("clientes.ver")));
      expect(req.acceso).toBeDefined();
      expect(req.acceso).toMatchObject({ usuarioId: "u1", rol, alcance });
      const permisos = [...(req.acceso?.permisos as Iterable<string>)];
      expect(permisos).toContain("clientes.ver");
      expect(permisos.includes("plan.gestionar")).toBe(rol === "dueno");
    },
  );

  it("req.acceso no es enumerable: no se serializa ni aparece en Object.keys", async () => {
    conRol("asistente");
    const req = peticion();
    await guard().canActivate(ctx(req, exigir("clientes.ver")));
    expect(Object.keys(req)).not.toContain("acceso");
    expect(Object.getOwnPropertyDescriptor(req, "acceso")?.enumerable).toBe(
      false,
    );
    expect(JSON.stringify(req)).not.toContain("asistente");
  });

  it("si se rechaza por falta de permiso no deja req.acceso fijado", async () => {
    conRol("lectura");
    const req = peticion();
    await rechazo(
      Promise.resolve().then(() =>
        guard().canActivate(ctx(req, exigir("clientes.asignar"))),
      ),
    );
    expect(req.acceso).toBeUndefined();
  });
});
