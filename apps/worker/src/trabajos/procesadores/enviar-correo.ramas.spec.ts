// Spec 028, T5 (rojo): ramas de `notificacion.enviar` sin BD: parámetros revalidados antes de abrir ninguna transacción (CA-6: no repite
// lo recibido) y envío ajeno o inexistente (`P0002`). El resto del contrato (revalidación, contenido, token, reintentos) lo prueban las
// de integración (`enviar-correo.int.spec.ts`). Contrato de nombres del repositorio: T4 (`tomarEnvio`).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ tomar: vi.fn() }));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  tomarEnvio: h.tomar,
}));

import { CorreoMemoria } from "@contapp/correo";
import { enviarCorreo } from "./enviar-correo.js";

const T = "0190a000-0000-7000-8000-0000000000e1";
const ENVIO = "0190a000-0000-7000-8000-0000000000f1";
const abiertas = vi.fn();
const db = {
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => {
    abiertas();
    return f({ query: vi.fn(async () => ({ rows: [] })) });
  },
} as never;

const ctx = (parametros: unknown) =>
  ({
    trabajo: {
      id: "0190a000-0000-7000-8000-0000000000a1",
      tenantId: T,
      clienteId: null,
      ruc: null,
      tipo: "notificacion.enviar",
      parametros,
      intentos: 1,
      creadoPor: null,
    },
    conToken: () => {
      throw new Error("sin token");
    },
  }) as never;

beforeEach(() => {
  abiertas.mockReset();
  h.tomar.mockReset();
});

describe("enviarCorreo: ramas", () => {
  it.each([
    ["sin envioId", {}],
    ["envioId que no es uuid", { envioId: "CANARIO-no-uuid" }],
    ["claves extra (un correo, un tenant, un token)", { envioId: ENVIO, para: "CANARIO@correo.test" }],
    ["parámetros que no son un objeto", "CANARIO"],
    ["nulos", null],
  ])("%s: lanza sin abrir ninguna transacción, sin enviar y sin repetir lo recibido", async (_n, parametros) => {
    const correo = new CorreoMemoria();
    const err = await enviarCorreo({ db, correo, appOrigin: "https://app.contapp.test" })(ctx(parametros)).then(
      () => undefined,
      (x: unknown) => x as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(`${err!.name} ${err!.message}`).not.toContain("CANARIO");
    expect(abiertas).not.toHaveBeenCalled();
    expect(h.tomar).not.toHaveBeenCalled();
    expect(correo.enviados).toHaveLength(0);
  });

  it("un envío ajeno o inexistente (P0002) sube como error del trabajo, sin enviar nada y sin filtrar el mensaje", async () => {
    h.tomar.mockRejectedValue(Object.assign(new Error("CANARIO-detalle"), { codigo: "P0002" }));
    const correo = new CorreoMemoria();
    const eventos: unknown[] = [];
    const log = { info: (e: unknown) => eventos.push(e), warn: (e: unknown) => eventos.push(e), error: (e: unknown) => eventos.push(e) } as never;
    const err = await enviarCorreo({ db, correo, appOrigin: "https://app.contapp.test", logger: log })(ctx({ envioId: ENVIO })).then(
      () => undefined,
      (x: unknown) => x as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(correo.enviados).toHaveLength(0);
    expect(JSON.stringify(eventos)).not.toContain("CANARIO");
    expect(`${err!.name} ${err!.message}`).not.toContain("CANARIO");
  });
});
