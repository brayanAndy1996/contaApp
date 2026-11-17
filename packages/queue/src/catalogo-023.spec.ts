import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claveDedupe, definicionDe, registrarTipo, rolesPermitidos, TipoInvalidoError } from "./index.js";

// Spec 023 (D-5, D-6, P-1; plan 023, Contratos: Cola; T2). Forma exacta de los dos tipos nuevos:
//  - `sol.buzon.revisar`: cola `sol`, canal `sol`, credencial `sol`, permiso `buzon.ver`, idempotente; parámetros `{}` ESTRICTOS.
//    La clave de dedupe es (tipo, cliente): dos revisar del mismo cliente comparten clave, sea cual sea su origen.
//  - `sol.buzon.abrir`: cola `sol`, canal `sol`, credencial `sol`, permiso `buzon.marcar_leido`, idempotente; parámetros `{mensajeId: uuid}`
//    ESTRICTOS. Dedupe por mensaje: el mismo mensaje del mismo cliente comparte clave; otro mensaje, no.
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia. Se registran con cualquier NODE_ENV.
//  - `buzon.programar` NO es un tipo de `job_registro` (es de sistema, D10 de 008): `definicionDe` no lo conoce.
const REVISAR = "sol.buzon.revisar";
const ABRIR = "sol.buzon.abrir";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catálogo 023: sol.buzon.revisar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(REVISAR)).toMatchObject({
      tipo: REVISAR,
      cola: "sol",
      canal: "sol",
      credencial: "sol",
      permiso: "buzon.ver",
      idempotente: true,
    });
  });

  it("el permiso lo tienen los roles con acceso al buzón, incluida Lectura", () => {
    const roles = rolesPermitidos(definicionDe(REVISAR).permiso);
    expect(roles).not.toBeNull();
    expect(roles!.length).toBeGreaterThan(0);
    expect(roles).toContain("lectura");
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(REVISAR)).toMatchObject({ cola: "sol", canal: "sol", credencial: "sol", permiso: "buzon.ver", idempotente: true });
  });

  it.each(["cola", "canal", "credencial", "permiso", "permiso a null", "idempotente"])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(REVISAR);
    const cambios = {
      cola: { cola: "sire" },
      canal: { canal: "sire" },
      credencial: { credencial: "sire_api" },
      permiso: { permiso: "clientes.ver" },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
    expect(definicionDe(REVISAR)).toMatchObject({ cola: "sol", canal: "sol", credencial: "sol", permiso: "buzon.ver", idempotente: true });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(REVISAR))).not.toThrow();
  });
});

describe("catálogo 023: parámetros de sol.buzon.revisar = {} estricto", () => {
  const ok = (v: unknown) => definicionDe(REVISAR).parametros.safeParse(v).success;

  it("acepta el objeto vacío y devuelve {}", () => {
    const r = definicionDe(REVISAR).parametros.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
  });

  it.each([
    ["mensajeId", { mensajeId: randomUUID() }],
    ["clave", { clave: "CANARIO" }],
    ["claveSol", { claveSol: "CANARIO", usuarioSol: "CANARIO" }],
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["ruc", { ruc: "20100070970" }],
    ["origen", { origen: "programado" }],
    ["constructor", { constructor: 1 }],
  ])("rechaza la clave extra %s (no hay dónde llevar un secreto ni un cliente)", (_c, extra) => {
    expect(ok(extra)).toBe(false);
  });

  it.each([null, undefined, "texto", 1, [], [{}], true])("rechaza %j", (malo) => {
    expect(ok(malo)).toBe(false);
  });
});

describe("catálogo 023: sol.buzon.abrir", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(ABRIR)).toMatchObject({
      tipo: ABRIR,
      cola: "sol",
      canal: "sol",
      credencial: "sol",
      permiso: "buzon.marcar_leido",
      idempotente: true,
    });
  });

  it("el rol Lectura no tiene el permiso (P-1: recibe 403); los de gestión sí", () => {
    const roles = rolesPermitidos(definicionDe(ABRIR).permiso);
    expect(roles).not.toBeNull();
    expect(roles!.length).toBeGreaterThan(0);
    expect(roles).not.toContain("lectura");
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(ABRIR)).toMatchObject({ cola: "sol", canal: "sol", credencial: "sol", permiso: "buzon.marcar_leido", idempotente: true });
  });

  it.each(["cola", "canal", "credencial", "permiso", "permiso a null", "idempotente"])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(ABRIR);
    const cambios = {
      cola: { cola: "xml" },
      canal: { canal: "ninguno" },
      credencial: { credencial: null },
      permiso: { permiso: "buzon.ver" },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
    expect(definicionDe(ABRIR)).toMatchObject({ cola: "sol", canal: "sol", credencial: "sol", permiso: "buzon.marcar_leido", idempotente: true });
  });
});

describe("catálogo 023: parámetros de sol.buzon.abrir = {mensajeId} estricto", () => {
  const ok = (v: unknown) => definicionDe(ABRIR).parametros.safeParse(v).success;

  it("acepta un uuid y lo devuelve tal cual", () => {
    const mensajeId = randomUUID();
    const r = definicionDe(ABRIR).parametros.safeParse({ mensajeId });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ mensajeId });
  });

  it.each([
    ["texto que no es uuid", "no-es-un-uuid"],
    ["vacío", ""],
    ["ruta", "../../etc/passwd"],
    ["uuid con sufijo", `${randomUUID()}x`],
    ["uuid con espacios", ` ${randomUUID()}`],
    ["número", 1],
    ["null", null],
    ["lista", [randomUUID()]],
    ["objeto", {}],
  ])("rechaza mensajeId %s", (_c, mensajeId) => {
    expect(ok({ mensajeId })).toBe(false);
  });

  it("exige mensajeId", () => {
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, "texto", [], 1]) expect(ok(malo)).toBe(false);
  });

  it.each([
    ["idSunat", { idSunat: "9988776655" }],
    ["clave", { clave: "CANARIO" }],
    ["claveSol", { claveSol: "CANARIO", usuarioSol: "CANARIO" }],
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["contenido", { contenido: "x" }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok({ mensajeId: randomUUID(), ...extra })).toBe(false);
  });
});

describe("catálogo 023: deduplicación (008 D8)", () => {
  const cliente = randomUUID();
  const otro = randomUUID();
  const clave = (tipo: string, c: string, p: unknown) => claveDedupe(tipo, c, p).toString("hex");

  it("dos revisar del mismo cliente tienen la misma clave, sin importar quién los pida", () => {
    const p1 = definicionDe(REVISAR).parametros.parse({});
    const p2 = definicionDe(REVISAR).parametros.parse({});
    expect(clave(REVISAR, cliente, p1)).toBe(clave(REVISAR, cliente, p2));
  });

  it("revisar de otro cliente tiene otra clave", () => {
    expect(clave(REVISAR, cliente, {})).not.toBe(clave(REVISAR, otro, {}));
  });

  it("revisar y abrir del mismo cliente no comparten clave", () => {
    const mensajeId = randomUUID();
    expect(clave(REVISAR, cliente, {})).not.toBe(clave(ABRIR, cliente, { mensajeId }));
  });

  it("dos abrir del mismo mensaje comparten clave; otro mensaje, no", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(clave(ABRIR, cliente, { mensajeId: a })).toBe(clave(ABRIR, cliente, { mensajeId: a }));
    expect(clave(ABRIR, cliente, { mensajeId: a })).not.toBe(clave(ABRIR, cliente, { mensajeId: b }));
  });
});

describe("catálogo 023: buzon.programar no es un tipo de job_registro", () => {
  it("definicionDe no lo conoce (vive en payloadSistemaSchema, D10 de 008)", () => {
    expect(() => definicionDe("buzon.programar")).toThrow();
  });
});

describe("catálogo 023: no toca a los tipos previos", () => {
  it.each([
    ["cliente.consultar_ruc", "xml", "ninguno", null, "clientes.crear"],
    ["credencial.verificar_sol", "sol", "sol", null, "credenciales.editar"],
    ["credencial.verificar_sire", "sire", "sire", null, "credenciales.editar"],
    ["sire.propuesta.descargar", "sire", "sire", "sire_api", "sire.descargar"],
    ["xml.obtener", "xml", "ninguno", null, "sire.clasificar"],
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({ cola, canal, credencial, permiso, idempotente: true });
  });
});
