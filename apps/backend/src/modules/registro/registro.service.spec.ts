import "reflect-metadata";
import { AuthRepoError } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AuthError, ContrasenaInvalidaError } from "../auth/errores.js";
import { generarToken, hashToken } from "../auth/sesion/token.js";
import { RegistroError } from "./errores.js";
import { RegistroService } from "./registro.service.js";

// T11 de 006 (cobertura): ramas de error del servicio de registro con dobles (sin BD ni HTTP). El flujo completo con la
// BD y las cookies lo cubre registro.int.spec.ts.
const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const PHC = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
const CLAVE = "Contrasena-Segura-123";
const COMUNES = new Set(["passwordpassword"]);
const sesion = { token: generarToken(), usuarioId: "u1", tenantActivo: TENANT } as unknown as SesionResuelta;

function armar() {
  const repo = {
    limiteConsumir: vi.fn(async () => true),
    registroCrear: vi.fn(async () => undefined),
    registroVigente: vi.fn(async () => ({
      nombreEstudio: "Estudio Uno",
      correo: "titular@ejemplo.test",
      cuentaExiste: false,
    })),
    registroConfirmarNueva: vi.fn(async () => "creado" as string),
    // Ajuste de 006 (T13a, D14): el repo informa si este estudio originó la prueba de la cuenta (`conPrueba`).
    registroConfirmarExistente: vi.fn(
      async () => ({ tenantId: TENANT, estudioNombre: "Estudio Uno", conPrueba: true }) as unknown,
    ),
  };
  const db = { withAuth: vi.fn(async (fn: (a: unknown) => unknown) => fn(repo)) };
  const hasher = { calcular: vi.fn(async () => PHC) };
  const cola = { encolar: vi.fn() };
  const servicio = new RegistroService(db as never, hasher as never, cola, COMUNES, "https://app.ejemplo.test");
  return { servicio, repo, db, hasher, cola };
}

const SOLICITUD = { estudio: "Estudio Uno", nombre: "Ana Pérez", correo: "Titular@Ejemplo.test", ruc: "20123456789" };
const codigoDe = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { codigo?: string });

describe("RegistroService.solicitar", () => {
  it("normaliza el correo, guarda solo el hash del token, encola el correo y responde { ok: true }", async () => {
    const { servicio, repo, cola } = armar();
    expect(await servicio.solicitar(SOLICITUD, "203.0.113.7")).toEqual({ ok: true });
    const args = (repo.registroCrear.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(args).toMatchObject({ correo: "titular@ejemplo.test", estudio: "Estudio Uno", ruc: "20123456789", nombre: "Ana Pérez" });
    const mensaje = (cola.encolar.mock.calls[0] as unknown as [{ para: string; texto: string }])[0];
    expect(mensaje.para).toBe("titular@ejemplo.test");
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(mensaje.texto)![1]!;
    expect((args.tokenHash as Buffer).equals(hashToken(token))).toBe(true);
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it("sin RUC guarda null y sin IP usa igual el límite por IP", async () => {
    const { servicio, repo } = armar();
    await servicio.solicitar({ ...SOLICITUD, ruc: undefined }, undefined);
    expect((repo.registroCrear.mock.calls[0] as unknown as [{ ruc: unknown }])[0].ruc).toBeNull();
    expect(repo.limiteConsumir).toHaveBeenCalledWith("registro_ip", expect.any(String));
  });

  it("límite por IP agotado -> demasiados_intentos, sin tocar nada más", async () => {
    const { servicio, repo, cola } = armar();
    repo.limiteConsumir.mockResolvedValueOnce(false);
    const e = await servicio.solicitar(SOLICITUD, "203.0.113.7").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect((e as AuthError).codigo).toBe("demasiados_intentos");
    expect(repo.limiteConsumir).toHaveBeenCalledTimes(1);
    expect(repo.registroCrear).not.toHaveBeenCalled();
    expect(cola.encolar).not.toHaveBeenCalled();
  });

  it("límite por correo agotado -> demasiados_intentos, sin crear ni encolar", async () => {
    const { servicio, repo, cola } = armar();
    repo.limiteConsumir.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const e = await servicio.solicitar(SOLICITUD, "203.0.113.7").catch((x: unknown) => x);
    expect((e as AuthError).codigo).toBe("demasiados_intentos");
    expect(repo.limiteConsumir).toHaveBeenLastCalledWith("registro_correo", expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(repo.registroCrear).not.toHaveBeenCalled();
    expect(cola.encolar).not.toHaveBeenCalled();
  });

  it.each([
    ["cuerpo que no es objeto", null],
    ["sin correo", { ...SOLICITUD, correo: undefined }],
    ["RUC de 10 dígitos", { ...SOLICITUD, ruc: "2012345678" }],
    ["correo sin arroba", { ...SOLICITUD, correo: "sin-arroba" }],
    ["parte local de más de 64 caracteres", { ...SOLICITUD, correo: `${"a".repeat(65)}@ejemplo.test` }],
    ["estudio de un solo carácter", { ...SOLICITUD, estudio: " x " }],
    ["estudio de más de 200 caracteres", { ...SOLICITUD, estudio: "e".repeat(201) }],
    ["estudio con carácter de control", { ...SOLICITUD, estudio: "Estudio\u0007Uno" }],
    ["estudio con carácter de formato (ancho cero)", { ...SOLICITUD, estudio: "Estudio​Uno" }],
    ["nombre sin letras ni dígitos", { ...SOLICITUD, nombre: "***" }],
    ["nombre en blanco", { ...SOLICITUD, nombre: "   " }],
  ])("%s -> solicitud_invalida y no se crea nada", async (_caso, cuerpo) => {
    const { servicio, repo, cola } = armar();
    expect((await codigoDe(servicio.solicitar(cuerpo, "203.0.113.7"))).codigo).toBe("solicitud_invalida");
    expect(repo.registroCrear).not.toHaveBeenCalled();
    expect(cola.encolar).not.toHaveBeenCalled();
  });
});

describe("RegistroService.consultar", () => {
  it("devuelve el estudio por nombre, el correo y si la cuenta existe (nunca IDs)", async () => {
    const { servicio, repo } = armar();
    const token = generarToken();
    expect(await servicio.consultar({ token })).toEqual({
      estudio: { nombre: "Estudio Uno" },
      correo: "titular@ejemplo.test",
      cuentaExiste: false,
    });
    expect((repo.registroVigente.mock.calls[0] as unknown as [Buffer])[0].equals(hashToken(token))).toBe(true);
  });

  it("cuerpo inválido -> solicitud_invalida; token mal formado o sin enlace vivo -> registro_invalido sin llegar a la BD o igual", async () => {
    const a = armar();
    expect((await codigoDe(a.servicio.consultar({}))).codigo).toBe("solicitud_invalida");
    expect((await codigoDe(a.servicio.consultar({ token: "corto" }))).codigo).toBe("registro_invalido");
    expect(a.db.withAuth).not.toHaveBeenCalled();
    a.repo.registroVigente.mockResolvedValueOnce(null as never);
    const e = await a.servicio.consultar({ token: generarToken() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RegistroError);
    expect((e as RegistroError).getStatus()).toBe(400);
  });
});

describe("RegistroService.confirmar", () => {
  let c: ReturnType<typeof armar>;
  beforeEach(() => {
    c = armar();
  });
  const cuerpo = () => ({ token: generarToken(), contrasena: CLAVE });

  it("enlace vivo sin cuenta: calcula Argon2 una vez y confirma con el hash de la contraseña", async () => {
    const b = cuerpo();
    await expect(c.servicio.confirmar(b)).resolves.toBeUndefined();
    expect(c.hasher.calcular).toHaveBeenCalledWith(CLAVE);
    expect(c.repo.registroConfirmarNueva).toHaveBeenCalledWith(hashToken(b.token), PHC);
  });

  it("cuerpo inválido -> solicitud_invalida", async () => {
    expect((await codigoDe(c.servicio.confirmar({ token: generarToken() }))).codigo).toBe("solicitud_invalida");
  });

  // Ajuste de 006 (T13b, D15): el orden es forma -> límite por IP -> política -> hash. El límite consume con `withAuth`
  // (una sola llamada, `registro_confirmar_ip`) antes de la política; la contraseña inválida no calcula hash ni toca el enlace.
  it.each([
    ["corta", "corta", "longitud"],
    ["común", "PasswordPassword", "comun"],
  ])("contraseña %s -> ContrasenaInvalidaError(%s) tras el límite y antes de tocar el token", async (_n, contrasena, motivo) => {
    const e = await c.servicio.confirmar({ token: generarToken(), contrasena }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ContrasenaInvalidaError);
    expect((e as ContrasenaInvalidaError).motivo).toBe(motivo);
    expect(c.db.withAuth).toHaveBeenCalledTimes(1); // solo el límite
    expect(c.repo.limiteConsumir).toHaveBeenCalledWith("registro_confirmar_ip", expect.any(String));
    expect(c.repo.registroVigente).not.toHaveBeenCalled();
    expect(c.repo.registroConfirmarNueva).not.toHaveBeenCalled();
    expect(c.hasher.calcular).not.toHaveBeenCalled();
  });

  it("token mal formado o enlace no vivo -> registro_invalido sin Argon2", async () => {
    expect((await codigoDe(c.servicio.confirmar({ token: "x", contrasena: CLAVE }))).codigo).toBe("registro_invalido");
    c.repo.registroVigente.mockResolvedValueOnce(null as never);
    expect((await codigoDe(c.servicio.confirmar(cuerpo()))).codigo).toBe("registro_invalido");
    expect(c.hasher.calcular).not.toHaveBeenCalled();
  });

  it("la cuenta ya existe -> requiere_sesion (409) sin Argon2 y sin consumir el enlace", async () => {
    c.repo.registroVigente.mockResolvedValueOnce({ nombreEstudio: "E", correo: "a@b.test", cuentaExiste: true });
    const e = await c.servicio.confirmar(cuerpo()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).codigo).toBe("requiere_sesion");
    expect(c.hasher.calcular).not.toHaveBeenCalled();
    expect(c.repo.registroConfirmarNueva).not.toHaveBeenCalled();
  });

  it.each([
    ["cuenta_existe", AccesoError, "requiere_sesion"],
    ["invalida", RegistroError, "registro_invalido"],
    ["sin_plan", RegistroError, "registro_no_disponible"],
  ] as const)("registro_confirmar_nueva = %s -> %s", async (resultado, clase, codigo) => {
    c.repo.registroConfirmarNueva.mockResolvedValueOnce(resultado);
    const e = await c.servicio.confirmar(cuerpo()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(clase);
    expect((e as { codigo: string }).codigo).toBe(codigo);
  });

  it("carrera: la cuenta se crea por otra vía entre la consulta y la confirmación (23505) -> registro_invalido", async () => {
    c.repo.registroConfirmarNueva.mockRejectedValueOnce(new AuthRepoError("23505"));
    expect((await codigoDe(c.servicio.confirmar(cuerpo()))).codigo).toBe("registro_invalido");
  });

  it("cualquier otro error de la BD sigue su camino (no se disfraza de registro_invalido)", async () => {
    const otro = new AuthRepoError("40001");
    c.repo.registroConfirmarNueva.mockRejectedValueOnce(otro);
    expect(await c.servicio.confirmar(cuerpo()).catch((x: unknown) => x)).toBe(otro);
    const ajeno = new Error("caída");
    c.repo.registroConfirmarNueva.mockRejectedValueOnce(ajeno);
    expect(await c.servicio.confirmar(cuerpo()).catch((x: unknown) => x)).toBe(ajeno);
  });
});

describe("RegistroService.confirmarConSesion", () => {
  it("crea el estudio con la sesión del titular y devuelve su id, nombre y sinPlan: false si originó la prueba", async () => {
    const c = armar();
    const token = generarToken();
    expect(await c.servicio.confirmarConSesion(sesion, { token }, TENANT)).toEqual({
      estudio: { id: TENANT, nombre: "Estudio Uno" },
      sinPlan: false,
    });
    expect(c.repo.registroConfirmarExistente).toHaveBeenCalledWith(hashToken(token), hashToken(sesion.token));
  });

  // D14 (T13a): la cuenta ya originó su prueba → el estudio nace sin suscripción y la respuesta lo dice.
  it("sinPlan: true cuando la cuenta ya usó su prueba (conPrueba false)", async () => {
    const c = armar();
    c.repo.registroConfirmarExistente.mockResolvedValueOnce({ tenantId: TENANT, estudioNombre: "Estudio Dos", conPrueba: false });
    expect(await c.servicio.confirmarConSesion(sesion, { token: generarToken() }, TENANT)).toEqual({
      estudio: { id: TENANT, nombre: "Estudio Dos" },
      sinPlan: true,
    });
  });

  it("sin cabecera X-Estudio también procede", async () => {
    const c = armar();
    await expect(c.servicio.confirmarConSesion(sesion, { token: generarToken() })).resolves.toBeDefined();
  });

  it("X-Estudio distinto del estudio de la sesión -> estudio_desfasado, antes de leer el cuerpo", async () => {
    const c = armar();
    const e = await c.servicio
      .confirmarConSesion(sesion, { token: generarToken() }, "0190a000-0000-7000-8000-0000000000ff")
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect((e as AuthError).codigo).toBe("estudio_desfasado");
    expect(c.db.withAuth).not.toHaveBeenCalled();
  });

  it("cuerpo inválido -> solicitud_invalida; token mal formado o ajeno (null) -> registro_invalido", async () => {
    const c = armar();
    expect((await codigoDe(c.servicio.confirmarConSesion(sesion, {}))).codigo).toBe("solicitud_invalida");
    expect((await codigoDe(c.servicio.confirmarConSesion(sesion, { token: "corto" }))).codigo).toBe("registro_invalido");
    expect(c.db.withAuth).not.toHaveBeenCalled();
    c.repo.registroConfirmarExistente.mockResolvedValueOnce(null);
    expect((await codigoDe(c.servicio.confirmarConSesion(sesion, { token: generarToken() }))).codigo).toBe(
      "registro_invalido",
    );
  });
});
