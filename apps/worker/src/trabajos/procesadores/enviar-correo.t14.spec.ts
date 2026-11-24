// Spec 028, T14: ramas de `notificacion.enviar` sin BD, con el repositorio de correo simulado en los nombres que el procesador usa de verdad
// (`tomarEnvioParaEnviar`, `leerDestinatario`, `leerAvisosEnvio`, `leerResumen`, `crearTokenBaja`, `cerrarEnvio`): revalidación (R-3, R-12),
// contenido, enlaces de `/ir` (D-3), token de baja, reintentos del transporte (CA-9) y que ningún error ni log repita datos ajenos (R-6).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { CorreoNoEnviadoError, CorreoMemoria, type Correo } from "@contapp/correo";
import { ErrorDatos } from "@contapp/sunat";
import { enviarCorreo } from "./enviar-correo.js";

const T = "0190a000-0000-7000-8000-0000000000e1";
const ENVIO = "0190a000-0000-7000-8000-0000000000f1";
const USUARIO = "0190a000-0000-7000-8000-0000000000a2";
const C1 = "0190a000-0000-7000-8000-0000000000c1";
const C2 = "0190a000-0000-7000-8000-0000000000c2";
const ORIGEN = "https://app.contapp.test";
const AHORA = new Date("2026-11-24T15:00:00.000Z");
const reloj = { ahora: () => AHORA };

const db = {
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f({ query: vi.fn() }),
} as never;

const ctx = (parametros: unknown = { envioId: ENVIO }) =>
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

const envio = (extra: Record<string, unknown> = {}) => ({
  id: ENVIO,
  usuarioId: USUARIO,
  tipo: "buzon_critico",
  origen: "aviso",
  intentos: 1,
  diaLima: null,
  corteDesde: null,
  ...extra,
});
const tomado = (extra: Record<string, unknown> = {}, e: Record<string, unknown> = {}) => ({
  envio: envio(e),
  preferencia: true,
  todosClientes: false,
  plan: { vigente: true, avisos: true, resumen: true },
  ...extra,
});
const aviso = (extra: Record<string, unknown> = {}) => ({
  notificacionId: "0190a000-0000-7000-8000-0000000000b1",
  tipo: "buzon_critico",
  clienteId: C1,
  razonSocial: "Alfa SAC",
  categoria: "coactiva",
  recurso: null,
  porcentaje: null,
  fecha: new Date("2026-11-24T10:00:00.000Z"),
  ...extra,
});
const cliente = (extra: Record<string, unknown> = {}) => ({
  clienteId: C1,
  razonSocial: "Alfa SAC",
  nuevos: 2,
  criticosNuevos: 1,
  pendientesAtender: 3,
  compras: "abierto",
  ventas: null,
  ...extra,
});

const registros: unknown[] = [];
const logger = {
  info: (e: unknown) => registros.push(e),
  warn: (e: unknown) => registros.push(e),
  error: (e: unknown) => registros.push(e),
} as never;

const correr = (correo: Correo, o: Record<string, unknown> = {}, parametros?: unknown) =>
  enviarCorreo({ db, correo, appOrigin: `${ORIGEN}/`, logger, reloj, ...o })(ctx(parametros));

beforeEach(() => {
  registros.length = 0;
  for (const f of Object.values(h)) f.mockReset();
  h.tomar.mockResolvedValue(tomado());
  h.destinatario.mockResolvedValue({
    usuarioId: USUARIO,
    email: "  contador@estudio.test ",
    rol: "contador",
    estudioNombre: "Estudio Uno",
  });
  h.avisos.mockResolvedValue([aviso()]);
  h.resumen.mockResolvedValue([]);
  h.token.mockResolvedValue(undefined);
  h.cerrar.mockResolvedValue(undefined);
});

describe("enviarCorreo: revalidación y errores del repositorio", () => {
  it("un error del repositorio que no es P0002 sube tal cual para que 008 reintente", async () => {
    const boom = Object.assign(new Error("caída"), { codigo: "08006" });
    h.tomar.mockRejectedValue(boom);
    const correo = new CorreoMemoria();
    await expect(correr(correo)).rejects.toBe(boom);
    expect(correo.enviados).toHaveLength(0);
  });

  it("un P0002 (ajeno, inexistente o ya cerrado) es ErrorDatos: no se reintenta", async () => {
    h.tomar.mockRejectedValue(Object.assign(new Error("CANARIO"), { codigo: "P0002" }));
    const err = await correr(new CorreoMemoria()).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ErrorDatos);
    expect(`${(err as Error).message}`).not.toContain("CANARIO");
  });

  it("un rechazo sin objeto (null) también sube sin convertirse", async () => {
    h.tomar.mockRejectedValue(null);
    await expect(correr(new CorreoMemoria())).rejects.toBeNull();
  });

  it.each([
    ["la membresía ya no está activa", () => h.destinatario.mockResolvedValue(null), "membresia_inactiva"],
    [
      "el correo vigente está vacío",
      () => h.destinatario.mockResolvedValue({ usuarioId: USUARIO, email: "   ", rol: "contador", estudioNombre: "E" }),
      "sin_correo",
    ],
    ["el usuario apagó el tipo", () => h.tomar.mockResolvedValue(tomado({ preferencia: false })), "preferencia_apagada"],
    [
      "el plan ya no está vigente",
      () => h.tomar.mockResolvedValue(tomado({ plan: { vigente: false, avisos: true, resumen: true } })),
      "sin_plan",
    ],
    [
      "el plan no incluye avisos por correo",
      () => h.tomar.mockResolvedValue(tomado({ plan: { vigente: true, avisos: false, resumen: true } })),
      "sin_plan",
    ],
    [
      "el plan no incluye el resumen (envío de resumen)",
      () =>
        h.tomar.mockResolvedValue(
          tomado({ plan: { vigente: true, avisos: true, resumen: false } }, { origen: "resumen", tipo: "resumen", diaLima: "2026-11-24" }),
        ),
      "sin_plan",
    ],
    ["no queda ningún aviso visible", () => h.avisos.mockResolvedValue([]), "sin_contenido"],
  ])("omite cuando %s: cierra omitido con «%s», sin token ni envío", async (_n, preparar, motivo) => {
    preparar();
    const correo = new CorreoMemoria();
    const r = await correr(correo);
    expect(r).toEqual({ estado: "omitido", motivo });
    expect(h.cerrar).toHaveBeenCalledTimes(1);
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), ENVIO, { estado: "omitido", motivo });
    expect(h.token).not.toHaveBeenCalled();
    expect(correo.enviados).toHaveLength(0);
  });

  it("un aviso de un tipo que no es de aviso es ErrorDatos y no envía", async () => {
    h.tomar.mockResolvedValue(tomado({}, { tipo: "desconocido" }));
    const correo = new CorreoMemoria();
    await expect(correr(correo)).rejects.toBeInstanceOf(ErrorDatos);
    expect(correo.enviados).toHaveLength(0);
  });
});

describe("enviarCorreo: avisos", () => {
  it("envía el aviso al correo vigente (sin espacios), con idMensaje, enlaces `/ir` y baja con el mismo token, y cierra enviado con el instante del armado", async () => {
    const correo = new CorreoMemoria();
    const r = await correr(correo);
    expect(r).toEqual({ estado: "enviado", avisos: 1 });
    expect(correo.enviados).toHaveLength(1);
    const m = correo.enviados[0]!;
    expect(m.para).toBe("contador@estudio.test");
    expect(m.idMensaje).toBe(ENVIO);
    const token = new URL(m.baja!.url).searchParams.get("t")!;
    expect(m.baja!.url).toBe(`${ORIGEN}/api/correo/baja?t=${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(m.texto).toContain(`${ORIGEN}/baja?t=${token}`);
    expect(m.texto).toContain(`${ORIGEN}/ir?estudio=${T}&pantalla=buzon_cliente&cliente=${C1}`);
    expect(h.token).toHaveBeenCalledWith(
      expect.anything(),
      ENVIO,
      createHash("sha256").update(token, "utf8").digest(),
    );
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), ENVIO, { estado: "enviado", corteHasta: AHORA });
  });

  it("buzón crítico con varios clientes va a la bandeja del estudio; con uno, a la del cliente", async () => {
    h.avisos.mockResolvedValue([aviso(), aviso({ clienteId: C2, razonSocial: "Beta SAC" })]);
    const correo = new CorreoMemoria();
    await correr(correo);
    expect(correo.enviados[0]!.texto).toContain("pantalla=buzon_estudio");
    expect(correo.enviados[0]!.texto).not.toContain("cliente=");
  });

  it("credencial inválida: con cliente va a sus credenciales; sin cliente, a la bandeja del estudio", async () => {
    h.tomar.mockResolvedValue(tomado({}, { tipo: "credencial_invalida" }));
    h.avisos.mockResolvedValue([aviso({ tipo: "credencial_invalida", categoria: null })]);
    const a = new CorreoMemoria();
    await correr(a);
    expect(a.enviados[0]!.texto).toContain(`pantalla=credenciales_cliente&cliente=${C1}`);
    h.avisos.mockResolvedValue([aviso({ tipo: "credencial_invalida", categoria: null, clienteId: null, razonSocial: null })]);
    const b = new CorreoMemoria();
    await correr(b);
    expect(b.enviados[0]!.texto).toContain("pantalla=buzon_estudio");
  });

  it("plan_limite va a «uso del plan»; un recurso desconocido sale «recursos» y el porcentaje se conserva", async () => {
    h.tomar.mockResolvedValue(tomado({}, { tipo: "plan_limite" }));
    h.avisos.mockResolvedValue([
      aviso({ tipo: "plan_limite", clienteId: null, razonSocial: null, categoria: null, recurso: "rucs", porcentaje: 90 }),
      aviso({ tipo: "plan_limite", clienteId: null, razonSocial: null, categoria: null, recurso: "extras", porcentaje: 100 }),
    ]);
    const correo = new CorreoMemoria();
    await correr(correo);
    const t = correo.enviados[0]!.texto;
    expect(t).toContain("pantalla=uso_plan");
    expect(t).toContain("RUC");
    expect(t).toContain("recursos");
  });

  it("una categoría desconocida sale «Otro», nunca el código crudo", async () => {
    h.avisos.mockResolvedValue([aviso({ categoria: "categoria_nueva_del_futuro" })]);
    const correo = new CorreoMemoria();
    await correr(correo);
    expect(correo.enviados[0]!.texto).toContain("Otro");
    expect(correo.enviados[0]!.texto).not.toContain("categoria_nueva_del_futuro");
  });

  it("origen sin barra final y reloj por omisión: también arma y envía", async () => {
    const correo = new CorreoMemoria();
    const r = await enviarCorreo({ db, correo, appOrigin: ORIGEN })(ctx());
    expect(r).toEqual({ estado: "enviado", avisos: 1 });
    const corte = h.cerrar.mock.calls[0]![2].corteHasta as Date;
    expect(Math.abs(corte.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("envío de pendientes: arma el correo de «avisos pendientes» con los diferidos por tipo", async () => {
    h.tomar.mockResolvedValue(tomado({}, { origen: "pendientes", tipo: "buzon_critico" }));
    h.avisos.mockResolvedValue([aviso(), aviso({ tipo: "plan_limite", clienteId: null, razonSocial: null, categoria: null, recurso: "usuarios", porcentaje: 90 }), aviso()]);
    const correo = new CorreoMemoria();
    const r = await correr(correo);
    expect(r).toEqual({ estado: "enviado", avisos: 3 });
    expect(correo.enviados).toHaveLength(1);
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), ENVIO, { estado: "enviado", corteHasta: AHORA });
  });
});

describe("enviarCorreo: resumen", () => {
  const resumenEnvio = (extra: Record<string, unknown> = {}) =>
    tomado({}, { origen: "resumen", tipo: "resumen", diaLima: "2026-11-24", ...extra });

  it("con novedades envía el resumen: lee desde el corte del anterior, el periodo anterior de Lima y «todos» según la preferencia", async () => {
    const corte = new Date("2026-11-23T12:00:00.000Z");
    h.tomar.mockResolvedValue({ ...resumenEnvio({ corteDesde: corte }), todosClientes: true });
    h.resumen.mockResolvedValue([cliente(), cliente({ clienteId: C2, razonSocial: "Beta SAC", nuevos: 0, compras: null })]);
    const correo = new CorreoMemoria();
    const r = await correr(correo);
    expect(r).toEqual({ estado: "enviado", clientes: 2 });
    expect(h.resumen).toHaveBeenCalledWith(expect.anything(), {
      usuarioId: USUARIO,
      desde: corte,
      periodo: "202610",
      todos: true,
    });
    expect(correo.enviados[0]!.texto).toContain(`pantalla=buzon_estudio`);
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), ENVIO, { estado: "enviado", corteHasta: AHORA });
  });

  it("sin corte previo lee desde 24 h antes y, sin día en el envío, usa el día de Lima de ahora", async () => {
    h.tomar.mockResolvedValue(resumenEnvio({ diaLima: null }));
    h.resumen.mockResolvedValue([cliente()]);
    const correo = new CorreoMemoria();
    await correr(correo);
    expect(h.resumen.mock.calls[0]![1].desde).toEqual(new Date(AHORA.getTime() - 86_400_000));
    expect(correo.enviados[0]!.asunto).toMatch(/24/);
  });

  it("sin novedades se omite como «sin_novedades» y mueve el corte a este instante", async () => {
    h.tomar.mockResolvedValue(resumenEnvio());
    h.resumen.mockResolvedValue([cliente({ nuevos: 0, criticosNuevos: 0, compras: null, ventas: null })]);
    h.avisos.mockResolvedValue([]);
    const correo = new CorreoMemoria();
    const r = await correr(correo);
    expect(r).toEqual({ estado: "omitido", motivo: "sin_novedades" });
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), ENVIO, {
      estado: "omitido",
      motivo: "sin_novedades",
      corteHasta: AHORA,
    });
    expect(h.token).not.toHaveBeenCalled();
    expect(correo.enviados).toHaveLength(0);
  });
});

describe("enviarCorreo: transporte (CA-9, R-6)", () => {
  const roto = (): Correo => ({
    enviar: async () => {
      throw new Error("SMTP_URL=smtp://usuario:CANARIO-CLAVE@host contador@estudio.test");
    },
  });

  it("antes del último intento lanza CorreoNoEnviadoError sin repetir el error del transporte y no cierra el envío", async () => {
    h.tomar.mockResolvedValue(tomado({}, { intentos: 2 }));
    const err = await correr(roto()).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(CorreoNoEnviadoError);
    expect(`${(err as Error).name} ${(err as Error).message}`).not.toContain("CANARIO");
    expect(h.cerrar).not.toHaveBeenCalled();
    expect(JSON.stringify(registros)).not.toMatch(/CANARIO|contador@estudio/);
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ evento: "correo_envio_reintento", codigo: "transporte", intentos: 2 });
  });

  it("en el último intento cierra fallido por transporte y devuelve el resultado sin lanzar", async () => {
    h.tomar.mockResolvedValue(tomado({}, { intentos: 3 }));
    const r = await correr(roto());
    expect(r).toEqual({ estado: "fallido", motivo: "transporte" });
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), ENVIO, { estado: "fallido", motivo: "transporte" });
    expect(JSON.stringify(registros)).not.toMatch(/CANARIO|contador@estudio/);
    expect(registros[0]).toMatchObject({ evento: "correo_envio_fallido", codigo: "transporte" });
  });

  it("`intentosMax` se puede cambiar", async () => {
    h.tomar.mockResolvedValue(tomado({}, { intentos: 1 }));
    const r = await correr(roto(), { intentosMax: 1 });
    expect(r).toEqual({ estado: "fallido", motivo: "transporte" });
  });

  it("sin logger propio usa el de consola y no filtra el error", async () => {
    const aviso_ = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log_ = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info_ = vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.tomar.mockResolvedValue(tomado({}, { intentos: 1 }));
    await enviarCorreo({ db, correo: roto(), appOrigin: ORIGEN, reloj })(ctx()).catch(() => undefined);
    const salida = JSON.stringify([aviso_.mock.calls, log_.mock.calls, info_.mock.calls]);
    expect(salida).not.toMatch(/CANARIO|contador@estudio/);
    aviso_.mockRestore();
    log_.mockRestore();
    info_.mockRestore();
  });
});
