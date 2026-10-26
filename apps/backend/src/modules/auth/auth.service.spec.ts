import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CORREO,
  crearEntorno,
  FICTICIO,
  HASH,
  HORA,
  PWD,
  T_A,
  T_B,
  U,
  type Entorno,
} from "../../../test/fakes-auth.js";
import { AuthService, excedeMaximo, segundosRestantes, type SesionResuelta } from "./auth.service.js";
import { AuthError, ContrasenaInvalidaError } from "./errores.js";
import { COOKIE_NOMBRE } from "./sesion/cookie.js";
import { derivarCsrf } from "./sesion/csrf.js";
import { generarToken, hashToken } from "./sesion/token.js";

// Unitarias del núcleo de sesión (T11 de 004) con dobles de AuthRepo/withUsuario/Hasher/cola. Las de
// punta a punta por HTTP son los *.int.spec.ts (T7), que dependen de los controladores (T12).
let e: Entorno;
let svc: AuthService;
const COMUNES = new Set(["qwertyuiop12"]);

beforeEach(() => {
  e = crearEntorno();
  svc = new AuthService(e.db, e.hasher, e.cola, COMUNES);
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
const tokenDeCookie = (c: string) => /^__Host-contapp_sid=([A-Za-z0-9_-]{43});/.exec(c)?.[1];
const maxAge = (c: string) => Number(/Max-Age=(\d+)/.exec(c)?.[1]);

async function codigo(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(AuthError);
  return (err as AuthError).codigo;
}

function sesion(o: Partial<SesionResuelta> = {}): SesionResuelta {
  return {
    token: generarToken(),
    sesionId: "s1",
    usuarioId: U,
    tenantActivo: null,
    estudioRevocado: false,
    expiraAbsoluta: new Date(Date.now() + 2 * HORA),
    ...o,
  };
}

describe("login", () => {
  it("con credenciales válidas y un estudio: sesión nueva con ese estudio activo (CA-1, P7)", async () => {
    const r = await svc.login({ correo: `  ${CORREO.toUpperCase()} `, contrasena: PWD }, "10.0.0.1");
    expect(r.respuesta).toEqual({ estudioActivo: { id: T_A, nombre: "Estudio A" }, requiereEstudio: false });
    const token = tokenDeCookie(r.cookie)!;
    expect(token).toBeDefined();
    expect(maxAge(r.cookie)).toBeGreaterThan(43_000);
    expect(e.repo.limiteConsumir).toHaveBeenCalledWith("login_ip", "10.0.0.1");
    expect(e.repo.loginPreparar).toHaveBeenCalledWith(CORREO, sha(CORREO));
    expect(e.hasher.verificar).toHaveBeenCalledTimes(1);
    expect(e.hasher.verificar).toHaveBeenCalledWith(HASH, PWD);
    const args = e.repo.loginExito.mock.calls[0]![0];
    expect(args).toMatchObject({ usuarioId: U, tenantActivo: T_A, hashNuevo: null, tokenAnteriorHash: null });
    expect(args.tokenHash.equals(hashToken(token))).toBe(true);
    expect(args.clave.equals(sha(CORREO))).toBe(true);
    expect(e.cola.encolar).not.toHaveBeenCalled();
  });

  it("con varios estudios pide elegir y sin estudios entra sin estudio (P7)", async () => {
    e.datos.tenants.push({ id: T_B, nombre: "Estudio B" });
    const varios = await svc.login({ correo: CORREO, contrasena: PWD }, "10.0.0.1");
    expect(varios.respuesta).toEqual({ estudioActivo: null, requiereEstudio: true });
    e.datos.tenants.length = 0;
    const ninguno = await svc.login({ correo: CORREO, contrasena: PWD }, undefined);
    expect(ninguno.respuesta).toEqual({ estudioActivo: null, requiereEstudio: false });
    expect(e.repo.limiteConsumir).toHaveBeenLastCalledWith("login_ip", "");
  });

  it("límite por IP agotado: 429 sin preparar ni verificar", async () => {
    e.repo.limiteConsumir.mockResolvedValueOnce(false);
    expect(await codigo(svc.login({ correo: CORREO, contrasena: PWD }, "10.0.0.1"))).toBe("demasiados_intentos");
    expect(e.repo.loginPreparar).not.toHaveBeenCalled();
    expect(e.hasher.verificar).not.toHaveBeenCalled();
  });

  it("cuerpo inválido: 400 solicitud_invalida", async () => {
    expect(await codigo(svc.login({ correo: CORREO, contrasena: 12345 }, "10.0.0.1"))).toBe("solicitud_invalida");
    expect(await codigo(svc.login(null, "10.0.0.1"))).toBe("solicitud_invalida");
  });

  // T16 (decisión del usuario, H-r1b-4): correos solo ASCII.
  it("correo no ASCII: 400 solicitud_invalida sin reservar intento ni verificar; el ASCII equivalente sigue entrando", async () => {
    expect(await codigo(svc.login({ correo: "straße@t004.contapp.test", contrasena: PWD }, "10.0.0.1"))).toBe(
      "solicitud_invalida",
    );
    expect(e.repo.loginPreparar).not.toHaveBeenCalled();
    expect(e.hasher.verificar).not.toHaveBeenCalled();
    await svc.login({ correo: ` ${CORREO.toUpperCase()} `, contrasena: PWD }, "10.0.0.1");
    expect(e.repo.loginPreparar).toHaveBeenCalledWith(CORREO, expect.any(Buffer));
  });

  it("contraseña errónea: 401 con UNA verificación contra el hash real y sin sesión", async () => {
    expect(await codigo(svc.login({ correo: CORREO, contrasena: "otra-Zz-1234" }, "1.1.1.1"))).toBe(
      "credenciales_invalidas",
    );
    expect(e.hasher.verificar).toHaveBeenCalledTimes(1);
    expect(e.hasher.verificar).toHaveBeenCalledWith(HASH, "otra-Zz-1234");
    expect(e.repo.loginExito).not.toHaveBeenCalled();
  });

  it.each([
    ["inexistente", { permitido: true, usuarioId: null, hash: null, alcanzaBloqueo: false }],
    ["bloqueada", { permitido: false, usuarioId: null, hash: null, alcanzaBloqueo: false }],
    ["sin credencial", { permitido: true, usuarioId: U, hash: null, alcanzaBloqueo: false }],
  ])("cuenta %s: mismo 401 tras UNA verificación contra el hash ficticio (D9)", async (_n, prep) => {
    e.repo.loginPreparar.mockResolvedValueOnce(prep);
    expect(await codigo(svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1"))).toBe("credenciales_invalidas");
    expect(e.hasher.verificar).toHaveBeenCalledTimes(1);
    expect(e.hasher.verificar).toHaveBeenCalledWith(FICTICIO, PWD);
    expect(e.repo.loginExito).not.toHaveBeenCalled();
  });

  it("si la reserva bloquea una cuenta existente y la verificación falla, avisa al titular por la cola (P3)", async () => {
    e.repo.loginPreparar.mockResolvedValueOnce({ permitido: true, usuarioId: U, hash: HASH, alcanzaBloqueo: true });
    await codigo(svc.login({ correo: CORREO, contrasena: "mala-Zz-12345" }, "1.1.1.1"));
    expect(e.cola.encolar).toHaveBeenCalledTimes(1);
    const m = e.cola.encolar.mock.calls[0]![0];
    expect(m.para).toBe(CORREO);
    expect(m.texto).not.toContain("mala-Zz-12345");
  });

  it("un correo inexistente que se bloquea no envía aviso", async () => {
    e.repo.loginPreparar.mockResolvedValueOnce({ permitido: true, usuarioId: null, hash: null, alcanzaBloqueo: true });
    await codigo(svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1"));
    expect(e.cola.encolar).not.toHaveBeenCalled();
  });

  it("más de 128 puntos de código: 401 sin reservar intento ni verificar (CA-4)", async () => {
    expect(await codigo(svc.login({ correo: CORREO, contrasena: "😀".repeat(129) }, "1.1.1.1"))).toBe(
      "credenciales_invalidas",
    );
    expect(e.repo.loginPreparar).not.toHaveBeenCalled();
    expect(e.hasher.verificar).not.toHaveBeenCalled();
  });

  it("un fallo del hasher responde el 401 genérico sin propagar su mensaje (CA-10)", async () => {
    e.hasher.verificar.mockRejectedValueOnce(new Error(`fallo con ${PWD}`));
    expect(await codigo(svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1"))).toBe("credenciales_invalidas");
  });

  it("re-calcula un hash con parámetros viejos en el login válido (CA-4)", async () => {
    e.hasher.necesitaRehash.mockReturnValueOnce(true);
    await svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1");
    expect(e.hasher.calcular).toHaveBeenCalledWith(PWD);
    expect(e.repo.loginExito.mock.calls[0]![0].hashNuevo).toMatch(/^\$argon2id\$/);
  });

  it("revoca la cookie previa válida y siempre emite un token nuevo (CA-5)", async () => {
    const previo = generarToken();
    const r = await svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1", `${COOKIE_NOMBRE}=${previo}`);
    expect(tokenDeCookie(r.cookie)).not.toBe(previo);
    expect(e.repo.loginExito.mock.calls[0]![0].tokenAnteriorHash!.equals(hashToken(previo))).toBe(true);
  });

  it("si la membresía desaparece antes de crear la sesión, entra sin estudio", async () => {
    e.repo.loginExito.mockResolvedValueOnce(null);
    const r = await svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1");
    expect(r.respuesta.estudioActivo).toBeNull();
    expect(e.repo.loginExito).toHaveBeenCalledTimes(2);
    expect(e.repo.loginExito.mock.calls[1]![0].tenantActivo).toBeNull();
  });

  it("si no se pudo crear la sesión, 401 sin cookie", async () => {
    e.datos.tenants.length = 0;
    e.repo.loginExito.mockResolvedValueOnce(null);
    expect(await codigo(svc.login({ correo: CORREO, contrasena: PWD }, "1.1.1.1"))).toBe("credenciales_invalidas");
    expect(e.repo.loginExito).toHaveBeenCalledTimes(1);
  });
});

describe("resolverSesion", () => {
  it("sin cookie o con formato inválido: null sin consultar la BD", async () => {
    expect(await svc.resolverSesion(undefined)).toBeNull();
    expect(await svc.resolverSesion(`${COOKIE_NOMBRE}=corto`)).toBeNull();
    expect(e.db.withAuth).not.toHaveBeenCalled();
  });

  it("valida por el hash del token y devuelve la sesión con su token", async () => {
    const token = generarToken();
    expect(await svc.resolverSesion(`${COOKIE_NOMBRE}=${token}`)).toBeNull();
    const valida = { sesionId: "s1", usuarioId: U, tenantActivo: T_A, estudioRevocado: false, expiraAbsoluta: new Date() };
    e.repo.sesionValidar.mockResolvedValueOnce(valida);
    expect(await svc.resolverSesion(`a=1; ${COOKIE_NOMBRE}=${token}`)).toEqual({ ...valida, token });
    expect(e.repo.sesionValidar.mock.calls[1]![0].equals(hashToken(token))).toBe(true);
  });
});

describe("estadoSesion", () => {
  it("devuelve usuario, estudio activo y el CSRF derivado (D6)", async () => {
    const s = sesion({ tenantActivo: T_A });
    expect(await svc.estadoSesion(s)).toEqual({
      usuario: { id: U, nombre: "Ana", correo: CORREO },
      estudioActivo: { id: T_A, nombre: "Estudio A" },
      csrf: derivarCsrf(s.token),
    });
    expect(e.db.withUsuario).toHaveBeenCalledWith({ userId: U }, expect.any(Function));
  });

  it("sin estudio activo da null y sin la fila del usuario da 401", async () => {
    expect((await svc.estadoSesion(sesion())).estudioActivo).toBeNull();
    e.datos.usuarios.length = 0;
    expect(await codigo(svc.estadoSesion(sesion()))).toBe("sesion_invalida");
  });
});

describe("listarEstudios", () => {
  it("lista las membresías ordenadas por nombre y marca el último usado", async () => {
    e.datos.tenants.unshift({ id: T_B, nombre: "Zeta" });
    e.datos.tenants.push({ id: "0190a000-0000-7000-8000-0000000000cc", nombre: "Estudio A" });
    e.repo.ultimoEstudio.mockResolvedValueOnce(T_B);
    const l = await svc.listarEstudios(sesion());
    expect(l.map((x) => x.nombre)).toEqual(["Estudio A", "Estudio A", "Zeta"]);
    expect(l.filter((x) => x.ultimoUsado).map((x) => x.id)).toEqual([T_B]);
  });
});

describe("cambiarEstudio (D4, D12)", () => {
  it("rota el token sin extender la caducidad y devuelve el estudio", async () => {
    const s = sesion();
    const r = await svc.cambiarEstudio(s, { tenantId: T_A });
    expect(r.respuesta).toEqual({ estudioActivo: { id: T_A, nombre: "Estudio A" } });
    expect(maxAge(r.cookie)).toBeLessThanOrEqual(3600);
    const [viejo, nuevo, tenant] = e.repo.sesionRotar.mock.calls[0]!;
    expect(viejo.equals(hashToken(s.token))).toBe(true);
    expect(nuevo.equals(hashToken(tokenDeCookie(r.cookie)!))).toBe(true);
    expect(tenant).toBe(T_A);
  });

  it("estudio sin membresía: 403 sin tocar la sesión; cuerpo inválido: 400", async () => {
    expect(await codigo(svc.cambiarEstudio(sesion(), { tenantId: T_B }))).toBe("estudio_no_disponible");
    expect(e.repo.sesionRotar).not.toHaveBeenCalled();
    expect(await codigo(svc.cambiarEstudio(sesion(), { tenantId: "no-uuid" }))).toBe("solicitud_invalida");
  });

  it("si la BD rechaza la rotación: 403 estudio_no_disponible", async () => {
    e.repo.sesionRotar.mockResolvedValueOnce(null);
    expect(await codigo(svc.cambiarEstudio(sesion(), { tenantId: T_A }))).toBe("estudio_no_disponible");
  });
});

describe("logout y cerrar todas (P2)", () => {
  it("logout revoca la sesión si la hay y siempre borra la cookie", async () => {
    const s = sesion();
    expect(await svc.logout(s)).toMatch(/^__Host-contapp_sid=;.*Max-Age=0/);
    expect(e.repo.sesionRevocar.mock.calls[0]![0].equals(hashToken(s.token))).toBe(true);
    expect(await svc.logout(null)).toContain("Max-Age=0");
    expect(e.repo.sesionRevocar).toHaveBeenCalledTimes(1);
  });

  it("cerrar todas revoca por el token de la sesión y borra la cookie", async () => {
    const s = sesion();
    expect(await svc.cerrarTodas(s)).toContain("Max-Age=0");
    expect(e.repo.sesionesCerrarTodas.mock.calls[0]![0].equals(hashToken(s.token))).toBe(true);
  });
});

describe("cambiarContrasena (P11)", () => {
  const NUEVA = "Contrasena-nueva-unit-004";

  it("verifica la actual, guarda el hash nuevo, rota la sesión y avisa (P9)", async () => {
    const s = sesion();
    const cookie = await svc.cambiarContrasena(s, { actual: PWD, nueva: NUEVA });
    expect(e.hasher.verificar).toHaveBeenCalledWith(HASH, PWD);
    expect(e.hasher.calcular).toHaveBeenCalledWith(NUEVA);
    const [viejo, hashNuevo, nuevo] = e.repo.contrasenaCambiar.mock.calls[0]!;
    expect(viejo.equals(hashToken(s.token))).toBe(true);
    expect(hashNuevo).toMatch(/^\$argon2id\$/);
    expect(nuevo.equals(hashToken(tokenDeCookie(cookie)!))).toBe(true);
    expect(maxAge(cookie)).toBeLessThanOrEqual(2 * 3600);
    const aviso = e.cola.encolar.mock.calls[0]![0];
    expect(aviso.para).toBe(CORREO);
    expect(aviso.texto).not.toContain(NUEVA);
    expect(aviso.texto).not.toContain(PWD);
  });

  it.each([
    ["corta", "Corta-1234", "longitud"],
    ["común", "QWERTYUIOP12", "comun"],
  ])("contraseña nueva %s: 400 con su motivo, sin verificar ni calcular", async (_n, nueva, motivo) => {
    const err = await svc.cambiarContrasena(sesion(), { actual: PWD, nueva }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ContrasenaInvalidaError);
    expect((err as ContrasenaInvalidaError).motivo).toBe(motivo);
    expect(e.hasher.verificar).not.toHaveBeenCalled();
    expect(e.hasher.calcular).not.toHaveBeenCalled();
  });

  it("actual equivocada: 401 sin cambiar nada; cuerpo inválido: 400", async () => {
    expect(await codigo(svc.cambiarContrasena(sesion(), { actual: "no-es-Zz-1234", nueva: NUEVA }))).toBe(
      "credenciales_invalidas",
    );
    expect(e.repo.contrasenaCambiar).not.toHaveBeenCalled();
    expect(await codigo(svc.cambiarContrasena(sesion(), { nueva: NUEVA }))).toBe("solicitud_invalida");
  });

  it("la credencial verificada debe ser del usuario de la sesión", async () => {
    e.repo.loginPreparar.mockResolvedValueOnce({ permitido: true, usuarioId: "otro", hash: HASH, alcanzaBloqueo: false });
    expect(await codigo(svc.cambiarContrasena(sesion(), { actual: PWD, nueva: NUEVA }))).toBe("credenciales_invalidas");
  });

  it("sin la fila del usuario o con la sesión ya inválida en la BD: 401 sesion_invalida", async () => {
    e.repo.contrasenaCambiar.mockResolvedValueOnce(null);
    expect(await codigo(svc.cambiarContrasena(sesion(), { actual: PWD, nueva: NUEVA }))).toBe("sesion_invalida");
    expect(e.cola.encolar).not.toHaveBeenCalled();
    e.datos.usuarios.length = 0;
    expect(await codigo(svc.cambiarContrasena(sesion(), { actual: PWD, nueva: NUEVA }))).toBe("sesion_invalida");
  });
});

describe("utilidades", () => {
  it("segundosRestantes trunca y nunca es negativo", () => {
    expect(segundosRestantes(new Date(10_500), 0)).toBe(10);
    expect(segundosRestantes(new Date(0), 5_000)).toBe(0);
  });

  it("excedeMaximo cuenta puntos de código", () => {
    expect(excedeMaximo("😀".repeat(128))).toBe(false);
    expect(excedeMaximo("😀".repeat(129))).toBe(true);
    expect(excedeMaximo("x".repeat(300))).toBe(true);
  });
});
