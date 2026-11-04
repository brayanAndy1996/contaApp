// Unitarias de los procesadores de verificación (007b, T9): ramas que la integración no recorre (credencial borrada
// entre la lectura y el descifrado, fallos que no son de credencial, versión perdida, secretos destruidos).
import { ErrorCredencial, ErrorTransitorio } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  filas: [] as Array<{ id: string; tipo: string }>,
  versiones: {} as Record<string, string | null>,
  invalida: vi.fn(async () => true),
  verificada: vi.fn(async () => true),
}));
vi.mock("@contapp/db", () => ({
  estadoCredenciales: async () => h.filas,
  versionCredencial: async (_tx: unknown, _c: string, tipo: string) =>
    h.versiones[tipo] ?? null,
  marcarCredencialInvalida: h.invalida,
  marcarCredencialVerificada: h.verificada,
}));

import { CredencialNoEncontradaError } from "../../credenciales/errores.js";
import { verificarSire, verificarSol } from "./verificar-credencial.js";

const trabajo = {
  id: "j",
  tenantId: "t",
  clienteId: "c",
  ruc: "20123456789",
  tipo: "x",
  parametros: {},
  intentos: 0,
  creadoPor: null,
};
const ctx = { trabajo, conToken: async () => undefined as never };
const db = {
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f({}),
} as never;

function secreto(valor: unknown) {
  const destruir = vi.fn();
  return {
    destruir,
    usar: <T>(f: (v: unknown) => T) => f(valor),
  };
}

function servicio(porId: Record<string, unknown>) {
  const secretos: Array<ReturnType<typeof secreto>> = [];
  return {
    secretos,
    descifrarCredencial: vi.fn(async (_c: unknown, id: string) => {
      const v = porId[id];
      if (v === undefined) throw new CredencialNoEncontradaError();
      const s = secreto(v);
      secretos.push(s);
      return s;
    }),
  };
}

function preparar(tipos: Array<"sol" | "sire_api">) {
  h.filas = tipos.map((t) => ({ id: `id-${t}`, tipo: t }));
  h.versiones = Object.fromEntries(tipos.map((t) => [t, `v-${t}`]));
  h.invalida.mockClear();
  h.verificada.mockClear();
}

const SOL = { usuario: "u", clave: "k" };
const SIRE = { clientId: "i", clientSecret: "s" };

describe("verificarSol", () => {
  it("éxito: llama al puerto, marca verificada con la versión leída y destruye el secreto", async () => {
    preparar(["sol"]);
    const sv = servicio({ "id-sol": SOL });
    const solAuth = { verificar: vi.fn(async () => undefined) };
    const r = await verificarSol({ db, servicio: sv as never, solAuth })(ctx);
    expect(r).toEqual({ ok: true });
    expect(solAuth.verificar).toHaveBeenCalledWith({
      ruc: trabajo.ruc,
      usuarioSol: "u",
      claveSol: "k",
    });
    expect(h.verificada).toHaveBeenCalledWith({}, "c", "sol", "v-sol");
    expect(sv.secretos[0]!.destruir).toHaveBeenCalledOnce();
  });

  it("ErrorCredencial: marca inválida con la versión, destruye el secreto y relanza", async () => {
    preparar(["sol"]);
    const sv = servicio({ "id-sol": SOL });
    const solAuth = {
      verificar: async () => {
        throw new ErrorCredencial();
      },
    };
    await expect(
      verificarSol({ db, servicio: sv as never, solAuth })(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(h.invalida).toHaveBeenCalledWith(
      {},
      "c",
      "sol",
      "credencial_invalida",
      undefined,
      "v-sol",
    );
    expect(h.verificada).not.toHaveBeenCalled();
    expect(sv.secretos[0]!.destruir).toHaveBeenCalledOnce();
  });

  it("error transitorio: no cambia el estado y se relanza", async () => {
    preparar(["sol"]);
    const solAuth = {
      verificar: async () => {
        throw new ErrorTransitorio();
      },
    };
    await expect(
      verificarSol({
        db,
        servicio: servicio({ "id-sol": SOL }) as never,
        solAuth,
      })(ctx),
    ).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(h.invalida).not.toHaveBeenCalled();
    expect(h.verificada).not.toHaveBeenCalled();
  });

  it("sin credencial (o sin versión): ErrorCredencial sin descifrar ni llamar al puerto", async () => {
    preparar([]);
    const sv = servicio({});
    const solAuth = { verificar: vi.fn() };
    await expect(
      verificarSol({ db, servicio: sv as never, solAuth })(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    h.filas = [{ id: "id-sol", tipo: "sol" }];
    h.versiones = {};
    await expect(
      verificarSol({ db, servicio: sv as never, solAuth })(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(sv.descifrarCredencial).not.toHaveBeenCalled();
    expect(solAuth.verificar).not.toHaveBeenCalled();
  });

  it("borrada entre la lectura y el descifrado: ErrorCredencial sin llamar al puerto", async () => {
    preparar(["sol"]);
    const solAuth = { verificar: vi.fn() };
    await expect(
      verificarSol({ db, servicio: servicio({}) as never, solAuth })(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(solAuth.verificar).not.toHaveBeenCalled();
  });

  it("un fallo del descifrado que no es «no encontrada» sube tal cual", async () => {
    preparar(["sol"]);
    const falla = new Error("bd");
    const sv = {
      descifrarCredencial: async () => {
        throw falla;
      },
    };
    await expect(
      verificarSol({
        db,
        servicio: sv as never,
        solAuth: { verificar: vi.fn() },
      })(ctx),
    ).rejects.toBe(falla);
  });
});

describe("verificarSire", () => {
  it("éxito: usa SireAuth con ambas credenciales, marca solo sire_api y destruye los dos secretos", async () => {
    preparar(["sol", "sire_api"]);
    const sv = servicio({ "id-sol": SOL, "id-sire_api": SIRE });
    const sireAuth = { obtenerToken: vi.fn(async () => ({}) as never) };
    await verificarSire({ db, servicio: sv as never, sireAuth })(ctx);
    expect(sireAuth.obtenerToken).toHaveBeenCalledWith({
      clientId: "i",
      clientSecret: "s",
      usuarioSol: "u",
      claveSol: "k",
      ruc: trabajo.ruc,
    });
    expect(h.verificada).toHaveBeenCalledWith(
      {},
      "c",
      "sire_api",
      "v-sire_api",
    );
    expect(sv.secretos).toHaveLength(2);
    for (const s of sv.secretos) expect(s.destruir).toHaveBeenCalledOnce();
  });

  it("ErrorCredencial: marca inválida solo sire_api", async () => {
    preparar(["sol", "sire_api"]);
    const sireAuth = {
      obtenerToken: async () => {
        throw new ErrorCredencial();
      },
    };
    await expect(
      verificarSire({
        db,
        servicio: servicio({ "id-sol": SOL, "id-sire_api": SIRE }) as never,
        sireAuth,
      })(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(h.invalida).toHaveBeenCalledWith(
      {},
      "c",
      "sire_api",
      "credencial_invalida",
      undefined,
      "v-sire_api",
    );
  });

  it.each([["sol"], ["sire_api"]] as const)(
    "falta %s: ErrorCredencial sin llamar al puerto ni marcar nada",
    async (falta) => {
      preparar(falta === "sol" ? ["sire_api"] : ["sol"]);
      const sireAuth = { obtenerToken: vi.fn() };
      await expect(
        verificarSire({
          db,
          servicio: servicio({}) as never,
          sireAuth,
        })(ctx),
      ).rejects.toBeInstanceOf(ErrorCredencial);
      expect(sireAuth.obtenerToken).not.toHaveBeenCalled();
      expect(h.invalida).not.toHaveBeenCalled();
    },
  );

  it("la SOL se borra tras descifrar la SIRE: ErrorCredencial y se destruye la SIRE ya descifrada", async () => {
    preparar(["sol", "sire_api"]);
    const sv = servicio({ "id-sire_api": SIRE });
    const sireAuth = { obtenerToken: vi.fn() };
    await expect(
      verificarSire({ db, servicio: sv as never, sireAuth })(ctx),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(sireAuth.obtenerToken).not.toHaveBeenCalled();
    expect(sv.secretos[0]!.destruir).toHaveBeenCalledOnce();
  });
});
