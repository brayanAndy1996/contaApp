import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CORREO, crearEntorno, type Entorno } from "../../../test/fakes-auth.js";
import { AuthError, ContrasenaInvalidaError } from "./errores.js";
import { RecuperacionService } from "./recuperacion.service.js";
import { generarToken, hashToken } from "./sesion/token.js";

// Unitarias de la recuperación (T11 de 004, D8, CA-8, P9) con dobles de AuthRepo, Hasher y cola.
const ORIGEN = "https://app.estudio.pe";
const NUEVA = "Contrasena-restablecida-unit";
let e: Entorno;
let svc: RecuperacionService;

beforeEach(() => {
  e = crearEntorno();
  svc = new RecuperacionService(e.db, e.hasher, e.cola, new Set(["qwertyuiop12"]), ORIGEN);
});

async function codigo(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(AuthError);
  return (err as AuthError).codigo;
}

describe("solicitar", () => {
  it("correo existente: guarda el hash del token y encola el enlace con #t=<token> (D8)", async () => {
    expect(await svc.solicitar({ correo: `  ${CORREO.toUpperCase()} ` }, "10.1.1.1")).toEqual({ ok: true });
    expect(e.repo.limiteConsumir).toHaveBeenNthCalledWith(1, "recup_ip", "10.1.1.1");
    const clave = createHash("sha256").update(CORREO).digest("hex");
    expect(e.repo.limiteConsumir).toHaveBeenNthCalledWith(2, "recup_correo", clave);
    const [correo, hash] = e.repo.recuperacionCrear.mock.calls[0]!;
    expect(correo).toBe(CORREO);
    const m = e.cola.encolar.mock.calls[0]![0];
    expect(m.para).toBe(CORREO);
    const token = /\/recuperar\/nueva#t=([A-Za-z0-9_-]{43})/.exec(m.texto)?.[1];
    expect(m.texto).toContain(`${ORIGEN}/recuperar/nueva#t=`);
    expect(hash.equals(hashToken(token!))).toBe(true);
  });

  it("correo inexistente: misma respuesta y ningún correo", async () => {
    e.repo.recuperacionCrear.mockResolvedValueOnce(false);
    expect(await svc.solicitar({ correo: "nadie@t004.contapp.test" }, undefined)).toEqual({ ok: true });
    expect(e.repo.limiteConsumir).toHaveBeenNthCalledWith(1, "recup_ip", "");
    expect(e.cola.encolar).not.toHaveBeenCalled();
  });

  it("límite por IP o por correo agotado: 429 sin crear token", async () => {
    e.repo.limiteConsumir.mockResolvedValueOnce(false);
    expect(await codigo(svc.solicitar({ correo: CORREO }, "1.1.1.1"))).toBe("demasiados_intentos");
    e.repo.limiteConsumir.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await codigo(svc.solicitar({ correo: CORREO }, "1.1.1.1"))).toBe("demasiados_intentos");
    expect(e.repo.recuperacionCrear).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ correo: 7 }], [{ correo: "no-es-un-correo" }], [{ correo: "a b@c.pe" }]])(
    "cuerpo o correo inválido (%j): 400 solicitud_invalida",
    async (cuerpo) => {
      expect(await codigo(svc.solicitar(cuerpo, "1.1.1.1"))).toBe("solicitud_invalida");
      expect(e.repo.recuperacionCrear).not.toHaveBeenCalled();
    },
  );
});

describe("restablecer", () => {
  it("consume el token por su hash con la contraseña nueva y avisa al titular (P9)", async () => {
    const token = generarToken();
    await svc.restablecer({ token, contrasena: NUEVA });
    expect(e.hasher.calcular).toHaveBeenCalledWith(NUEVA);
    const [hash, phc] = e.repo.recuperacionConsumir.mock.calls[0]!;
    expect(hash.equals(hashToken(token))).toBe(true);
    expect(phc).toMatch(/^\$argon2id\$/);
    const aviso = e.cola.encolar.mock.calls[0]![0];
    expect(aviso.para).toBe(CORREO);
    expect(aviso.texto).not.toContain(token);
    expect(aviso.texto).not.toContain(NUEVA);
  });

  it.each([
    ["corta", "Corta-123", "longitud"],
    ["común", "qwertyuiop12", "comun"],
  ])("contraseña %s: 400 con motivo antes de mirar el token (P5)", async (_n, contrasena, motivo) => {
    const err = await svc.restablecer({ token: "mal formado", contrasena }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ContrasenaInvalidaError);
    expect((err as ContrasenaInvalidaError).motivo).toBe(motivo);
    expect(e.repo.recuperacionConsumir).not.toHaveBeenCalled();
  });

  it("token mal formado: token_invalido sin calcular hash ni consultar", async () => {
    expect(await codigo(svc.restablecer({ token: "A".repeat(42), contrasena: NUEVA }))).toBe("token_invalido");
    expect(e.hasher.calcular).not.toHaveBeenCalled();
    expect(e.repo.recuperacionConsumir).not.toHaveBeenCalled();
  });

  it("token reusado, vencido o desconocido: token_invalido y sin aviso", async () => {
    e.repo.recuperacionConsumir.mockResolvedValueOnce(null);
    expect(await codigo(svc.restablecer({ token: generarToken(), contrasena: NUEVA }))).toBe("token_invalido");
    expect(e.cola.encolar).not.toHaveBeenCalled();
  });

  it("cuerpo inválido: 400 solicitud_invalida", async () => {
    expect(await codigo(svc.restablecer({ token: generarToken() }))).toBe("solicitud_invalida");
  });
});
