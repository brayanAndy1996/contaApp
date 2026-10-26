import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ContrasenaInvalidaError } from "../modules/auth/errores.js";
import { FiltroErrores } from "./filtro-errores.js";

// CA-10 / RNF-004 (spec 004). Contrato (plan: Decisiones: Sin fugas):
//   new FiltroErrores(registrar?: (evento: { clase: string; codigo: string }) => void)
//   catch(excepcion, host): responde con res.status(n).json(cuerpo) y registra SOLO la clase y el
//   código (jamás message, stack, cause, detail ni el cuerpo de la petición).
//   Cuerpo = { codigo } (más `motivo` solo en contrasena_invalida); nunca eco de la entrada.
//   - HttpException con `{ codigo, ... }`: su estado y su `codigo`; se descarta todo lo demás.
//   - ContrasenaInvalidaError(motivo): 400 { codigo: "contrasena_invalida", motivo }.
//   - Cualquier otra cosa (Error, error de pg, valor que no es Error): 500 { codigo: "error_interno" }.
const CANARIO = "CANARIO-FILTRO-4417";

function anfitrion() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  };
  const req = { method: "POST", url: "/auth/login", body: { contrasena: CANARIO, correo: CANARIO } };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { res, host };
}

function ejecutar(excepcion: unknown) {
  const registrar = vi.fn();
  const { res, host } = anfitrion();
  new FiltroErrores(registrar).catch(excepcion, host);
  const estado = res.status.mock.calls[0]?.[0] as number | undefined;
  const cuerpo = res.json.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  return { registrar, res, estado, cuerpo };
}

describe("HttpException con codigo", () => {
  it("conserva el estado y el codigo", () => {
    const { estado, cuerpo } = ejecutar(new HttpException({ codigo: "csrf_invalido" }, 403));
    expect(estado).toBe(403);
    expect(cuerpo).toEqual({ codigo: "csrf_invalido" });
  });

  it.each([
    [401, "credenciales_invalidas"],
    [409, "estudio_desfasado"],
    [429, "demasiados_intentos"],
    [400, "token_invalido"],
  ])("%i %s", (estado, codigo) => {
    const r = ejecutar(new HttpException({ codigo }, estado));
    expect(r.estado).toBe(estado);
    expect(r.cuerpo).toEqual({ codigo });
  });

  it("descarta todo campo que no sea codigo (sin eco de la entrada)", () => {
    const { cuerpo } = ejecutar(
      new HttpException(
        {
          codigo: "solicitud_invalida",
          message: [`contrasena ${CANARIO} inválida`],
          recibido: { contrasena: CANARIO },
          detail: CANARIO,
          stack: CANARIO,
        },
        400,
      ),
    );
    expect(cuerpo).toEqual({ codigo: "solicitud_invalida" });
  });

  it("conserva `motivo` solo en contrasena_invalida", () => {
    expect(
      ejecutar(new HttpException({ codigo: "contrasena_invalida", motivo: "comun" }, 400)).cuerpo,
    ).toEqual({ codigo: "contrasena_invalida", motivo: "comun" });
  });

  it("registra solo clase y codigo", () => {
    const { registrar } = ejecutar(new HttpException({ codigo: "csrf_invalido" }, 403));
    expect(registrar).toHaveBeenCalledTimes(1);
    const evento = registrar.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(evento).sort()).toEqual(["clase", "codigo"]);
    expect(evento.codigo).toBe("csrf_invalido");
  });
});

describe("HttpException de Nest sin codigo (p. ej. ForbiddenException por defecto)", () => {
  it("no devuelve el mensaje de Nest: cuerpo con un `codigo` de texto y nada más", () => {
    const { cuerpo, estado } = ejecutar(new HttpException(`mensaje con ${CANARIO}`, 403));
    expect(estado).toBe(403);
    expect(typeof cuerpo?.codigo).toBe("string");
    expect(Object.keys(cuerpo!)).toEqual(["codigo"]);
    expect(JSON.stringify(cuerpo)).not.toContain(CANARIO);
  });
});

describe("ContrasenaInvalidaError", () => {
  it.each([["longitud"], ["comun"]] as const)("motivo %s -> 400 contrasena_invalida", (motivo) => {
    const { estado, cuerpo } = ejecutar(new ContrasenaInvalidaError(motivo));
    expect(estado).toBe(400);
    expect(cuerpo).toEqual({ codigo: "contrasena_invalida", motivo });
  });
});

describe("errores inesperados -> 500 error_interno sin fugas", () => {
  const casos: Array<[string, unknown]> = [
    ["Error con canario en el mensaje", new Error(`falló con ${CANARIO}`)],
    ["Error con canario en cause", new Error("x", { cause: new Error(CANARIO) })],
    [
      "error tipo pg con detail",
      Object.assign(new Error("duplicate key"), { code: "23505", detail: `Key (hash)=(${CANARIO})` }),
    ],
    ["cadena lanzada", `texto ${CANARIO}`],
    ["objeto lanzado", { contrasena: CANARIO }],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(casos)("%s", (_n, excepcion) => {
    const { estado, cuerpo, registrar } = ejecutar(excepcion);
    expect(estado).toBe(500);
    expect(cuerpo).toEqual({ codigo: "error_interno" });
    expect(JSON.stringify(cuerpo)).not.toContain(CANARIO);
    expect(registrar).toHaveBeenCalledTimes(1);
    const evento = registrar.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(evento).sort()).toEqual(["clase", "codigo"]);
    expect(inspect(registrar.mock.calls, { depth: 10 })).not.toContain(CANARIO);
  });

  it("la clase registrada es el nombre de la clase del error", () => {
    class ErrorRaro extends Error {}
    const { registrar } = ejecutar(new ErrorRaro("x"));
    expect(registrar.mock.calls[0]![0]).toMatchObject({ clase: "ErrorRaro", codigo: "error_interno" });
  });

  it("sin `registrar` tampoco filtra nada a stdout/stderr", () => {
    const escrituras: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      escrituras.push(String(c));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      escrituras.push(String(c));
      return true;
    });
    try {
      const { res, host } = anfitrion();
      new FiltroErrores().catch(new Error(`falló con ${CANARIO}`), host);
      expect(res.status).toHaveBeenCalledWith(500);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(escrituras.join("")).not.toContain(CANARIO);
  });
});
