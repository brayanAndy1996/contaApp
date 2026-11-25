// Spec 028, T24a (rojo, D-T24-1): `enviarCorreo` con un `CorreoConsola` real (sin BD, repositorio simulado como en `enviar-correo.t14.spec.ts`):
// el token de baja (el del `List-Unsubscribe` que llega al transporte) no debe salir en stdout, ni en la URL de la API ni en el enlace
// `/baja?t=` del cuerpo de texto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tomar: vi.fn(),
  destinatario: vi.fn(),
  avisos: vi.fn(),
  resumen: vi.fn(),
  token: vi.fn(),
  cerrar: vi.fn(),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  tomarEnvioParaEnviar: h.tomar,
  leerDestinatario: h.destinatario,
  leerAvisosEnvio: h.avisos,
  leerResumen: h.resumen,
  crearTokenBaja: h.token,
  cerrarEnvio: h.cerrar,
}));

import {
  CorreoConsola,
  type Correo,
  type MensajeCorreo,
} from "@contapp/correo";
import { enviarCorreo } from "./enviar-correo.js";

const T = "0190a000-0000-7000-8000-0000000000e1";
const ENVIO = "0190a000-0000-7000-8000-0000000000f1";
const USUARIO = "0190a000-0000-7000-8000-0000000000a2";
const C1 = "0190a000-0000-7000-8000-0000000000c1";
const AHORA = new Date("2026-11-24T15:00:00.000Z");

const db = {
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) =>
    f({ query: vi.fn() }),
} as never;

const ctx = () =>
  ({
    trabajo: {
      id: "0190a000-0000-7000-8000-0000000000a1",
      tenantId: T,
      clienteId: null,
      ruc: null,
      tipo: "notificacion.enviar",
      parametros: { envioId: ENVIO },
      intentos: 1,
      creadoPor: null,
    },
    conToken: () => {
      throw new Error("sin token");
    },
  }) as never;

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.tomar.mockResolvedValue({
    envio: {
      id: ENVIO,
      usuarioId: USUARIO,
      tipo: "buzon_critico",
      origen: "aviso",
      intentos: 1,
      diaLima: null,
      corteDesde: null,
    },
    preferencia: true,
    todosClientes: false,
    plan: { vigente: true, avisos: true, resumen: true },
  });
  h.destinatario.mockResolvedValue({
    usuarioId: USUARIO,
    email: "contador@estudio.test",
    rol: "contador",
    estudioNombre: "Estudio Uno",
  });
  h.avisos.mockResolvedValue([
    {
      notificacionId: "0190a000-0000-7000-8000-0000000000b1",
      tipo: "buzon_critico",
      clienteId: C1,
      razonSocial: "Alfa SAC",
      categoria: "coactiva",
      recurso: null,
      porcentaje: null,
      fecha: new Date("2026-11-24T10:00:00.000Z"),
    },
  ]);
  h.resumen.mockResolvedValue([]);
  h.token.mockResolvedValue(undefined);
  h.cerrar.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enviarCorreo con CorreoConsola real (D-T24-1)", () => {
  it("el token de baja no aparece en stdout (ni en /api/correo/baja ni en /baja?t= del texto)", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const vistos: MensajeCorreo[] = [];
    const consola = new CorreoConsola();
    // Intermediario que solo observa el mensaje que llega al transporte y lo entrega a la consola real.
    const correo: Correo = {
      enviar: async (m) => {
        vistos.push(m);
        await consola.enviar(m);
      },
    };

    const r = await enviarCorreo({
      db,
      correo,
      appOrigin: "https://app.contapp.test",
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never,
      reloj: { ahora: () => AHORA },
    })(ctx());

    expect(r).toEqual({ estado: "enviado", avisos: 1 });
    expect(vistos).toHaveLength(1);
    const token = new URL(vistos[0]!.baja!.url).searchParams.get("t");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Precondición: el cuerpo de texto sí lleva el token en el enlace de la página (otra URL distinta de baja.url).
    expect(vistos[0]!.texto).toContain(`/baja?t=${token}`);

    const salida = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(salida).toContain("[correo:consola]");
    expect(salida).toContain("[baja]");
    expect(salida).not.toContain(token!);
    expect(salida).not.toContain("?t=");
  });
});
