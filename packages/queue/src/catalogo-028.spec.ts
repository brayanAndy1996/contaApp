import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cola from "./index.js";
import { claveDedupe, definicionDe, registrarTipo, rolesPermitidos, TipoInvalidoError } from "./index.js";

// Spec 028 · T2 (rojo). Forma exacta del tipo nuevo (R-1, R-9, U-16; plan 028, Contratos: Cola):
//  - `notificacion.enviar`: cola `notificaciones`, canal `ninguno`, credencial `null`, permiso `null` (no lo pide ningún rol: lo encola solo la BD
//    desde `encolar_correo_avisos` y `crear_correo_resumenes`; no lleva solicitante, así que no genera `trabajo_terminado`), idempotente (U-16: al menos una vez).
//    Se exporta como `NOTIFICACION_ENVIAR` desde `@contapp/queue`.
//  - parámetros `{envioId: uuid}` ESTRICTOS: el trabajo lleva un id y nada más (ni correo, ni asunto, ni usuario, ni tenant, ni token). Acepta cualquier versión
//    de uuid en minúsculas o mayúsculas; rechaza lo que no sea uuid.
//  - Dedupe de 008 por (tipo, cliente, parámetros): dos encolados del mismo envío comparten trabajo; otro envío, no. El trabajo no tiene cliente
//    (se usa el uuid nulo `00000000-0000-0000-0000-000000000000`; la prueba solo exige que la clave dependa del `envioId`).
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia. Se registra con cualquier NODE_ENV.
//  - Los tipos previos (007b–027) no cambian.
const TIPO = "notificacion.enviar";
const SIN_CLIENTE = "00000000-0000-0000-0000-000000000000";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catálogo 028: notificacion.enviar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(TIPO)).toMatchObject({
      tipo: TIPO,
      cola: "notificaciones",
      canal: "ninguno",
      credencial: null,
      permiso: null,
      idempotente: true,
    });
  });

  it("se exporta como NOTIFICACION_ENVIAR y es la misma definición registrada", () => {
    const d = (cola as Record<string, unknown>).NOTIFICACION_ENVIAR as { tipo: string; cola: string } | undefined;
    expect(d).toBeDefined();
    expect(d!.tipo).toBe(TIPO);
    expect(d!.cola).toBe("notificaciones");
  });

  it("no exige permiso: ningún rol lo pide por la API", () => {
    expect(definicionDe(TIPO).permiso).toBeNull();
    expect(rolesPermitidos(definicionDe(TIPO).permiso)).toBeNull();
  });

  it("la cola `notificaciones` ya existe entre las colas de 008", () => {
    expect(cola.COLAS).toContain("notificaciones");
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(TIPO)).toMatchObject({ cola: "notificaciones", canal: "ninguno", credencial: null, permiso: null, idempotente: true });
  });

  it.each(["cola", "canal", "credencial", "permiso", "idempotente"])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(TIPO);
    const cambios = {
      cola: { cola: "xml" },
      canal: { canal: "sire" },
      credencial: { credencial: "sol" },
      permiso: { permiso: "buzon.ver" },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
    expect(definicionDe(TIPO)).toMatchObject({ cola: "notificaciones", canal: "ninguno", credencial: null, permiso: null, idempotente: true });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });
});

describe("catálogo 028: parámetros = {envioId} estricto", () => {
  const ok = (v: unknown) => definicionDe(TIPO).parametros.safeParse(v).success;

  it("acepta un uuid v7 y lo devuelve tal cual", () => {
    const envioId = "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10";
    const r = definicionDe(TIPO).parametros.safeParse({ envioId });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ envioId });
  });
  it("acepta un uuid v4 aleatorio", () => {
    expect(ok({ envioId: randomUUID() })).toBe(true);
  });

  it.each([
    ["sin guiones", "0192f0a07b1c7a3e8c112f9d5b6a7c10"],
    ["corto", "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c1"],
    ["largo", "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c100"],
    ["no hex", "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7cZZ"],
    ["con espacio", " 0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10"],
    ["con salto de línea", "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10\n"],
    ["vacío", ""],
    ["número", 1],
    ["null", null],
    ["lista", [randomUUID()]],
    ["objeto", {}],
    ["texto", "envio"],
  ])("rechaza el envioId %s", (_c, envioId) => {
    expect(ok({ envioId })).toBe(false);
  });

  it("exige envioId y un objeto", () => {
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, randomUUID(), 1, [], [{ envioId: randomUUID() }], true]) expect(ok(malo)).toBe(false);
  });

  it.each([
    ["tenantId", { tenantId: randomUUID() }],
    ["usuarioId", { usuarioId: randomUUID() }],
    ["para", { para: "ana@estudio.pe" }],
    ["asunto", { asunto: "Coactiva" }],
    ["texto", { texto: "contenido" }],
    ["token", { token: "CANARIO-TOKEN" }],
    ["tipo", { tipo: "resumen" }],
    ["avisos", { avisos: [randomUUID()] }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok({ envioId: randomUUID(), ...extra })).toBe(false);
  });
});

describe("catálogo 028: deduplicación por envío (008 D8)", () => {
  const clave = (p: unknown) => claveDedupe(TIPO, SIN_CLIENTE, p).toString("hex");
  const A = "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10";
  const B = "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c11";

  it("dos encolados del mismo envío comparten clave", () => {
    const p1 = definicionDe(TIPO).parametros.parse({ envioId: A });
    const p2 = definicionDe(TIPO).parametros.parse({ envioId: A });
    expect(clave(p1)).toBe(clave(p2));
  });
  it("otro envío tiene otra clave", () => {
    expect(clave({ envioId: A })).not.toBe(clave({ envioId: B }));
  });
  it("no comparte clave con otro tipo", () => {
    expect(clave({ envioId: A })).not.toBe(claveDedupe("sol.buzon.revisar", SIN_CLIENTE, { envioId: A }).toString("hex"));
  });
});

describe("catálogo 028: no toca a los tipos previos", () => {
  it.each([
    ["cliente.consultar_ruc", "xml", "ninguno", null, "clientes.crear"],
    ["credencial.verificar_sol", "sol", "sol", null, "credenciales.editar"],
    ["credencial.verificar_sire", "sire", "sire", null, "credenciales.editar"],
    ["sire.propuesta.descargar", "sire", "sire", "sire_api", "sire.descargar"],
    ["xml.obtener", "xml", "ninguno", null, "sire.clasificar"],
    ["sol.buzon.revisar", "sol", "sol", "sol", "buzon.ver"],
    ["sol.buzon.abrir", "sol", "sol", "sol", "buzon.marcar_leido"],
    ["reglas.historial.importar", "sire", "sire", "sire_api", "reglas.gestionar"],
    ["sol.declaraciones.descargar", "sol", "sol", "sol", "prorrata.gestionar"],
    ["compras.reevaluar", "xml", "ninguno", null, "sire.clasificar"],
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({ cola, canal, credencial, permiso, idempotente: true });
  });
});
