import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claveDedupe, definicionDe, registrarTipo, rolesPermitidos, TipoInvalidoError } from "./index.js";

// Spec 025 (D-1, D-2, D-10; plan 025, Contratos: Cola; T2). Forma exacta del tipo nuevo:
//  - `reglas.historial.importar`: cola `sire`, canal `sire`, credencial `sire_api`, permiso `reglas.gestionar`; parámetros
//    `{importacionId: uuid}` ESTRICTOS. Los periodos y el cliente salen de la fila de la importación, no del payload.
//  - No cambia los tipos previos. `registrarTipo` rechaza cambiar cola, canal, credencial o permiso. Se registra con cualquier NODE_ENV.
const TIPO = "reglas.historial.importar";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catálogo 025: reglas.historial.importar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(TIPO)).toMatchObject({
      tipo: TIPO,
      cola: "sire",
      canal: "sire",
      credencial: "sire_api",
      permiso: "reglas.gestionar",
    });
  });

  it("el permiso lo tienen Dueño, Administrador y Contador; Asistente y Lectura no (CA-8)", () => {
    const roles = rolesPermitidos(definicionDe(TIPO).permiso);
    expect(roles).not.toBeNull();
    expect(roles).toEqual(expect.arrayContaining(["dueno", "admin", "contador"]));
    expect(roles).not.toContain("asistente");
    expect(roles).not.toContain("lectura");
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(TIPO)).toMatchObject({ cola: "sire", canal: "sire", credencial: "sire_api", permiso: "reglas.gestionar" });
  });

  it("se exporta como constante del paquete (REGLAS_HISTORIAL_IMPORTAR) con el mismo tipo", async () => {
    const m = (await import("./index.js")) as Record<string, unknown>;
    expect((m.REGLAS_HISTORIAL_IMPORTAR as { tipo?: string } | undefined)?.tipo).toBe(TIPO);
  });

  it.each(["cola", "canal", "credencial", "credencial a null", "permiso", "permiso a null"])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(TIPO);
    const cambios = {
      cola: { cola: "xml" },
      canal: { canal: "sol" },
      credencial: { credencial: "sol" },
      "credencial a null": { credencial: null },
      permiso: { permiso: "sire.descargar" },
      "permiso a null": { permiso: null },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
    expect(definicionDe(TIPO)).toMatchObject({ cola: "sire", canal: "sire", credencial: "sire_api", permiso: "reglas.gestionar" });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });
});

describe("catálogo 025: parámetros de reglas.historial.importar = {importacionId} estricto", () => {
  const ok = (v: unknown) => definicionDe(TIPO).parametros.safeParse(v).success;

  it("acepta un uuid y lo devuelve tal cual", () => {
    const importacionId = randomUUID();
    const r = definicionDe(TIPO).parametros.safeParse({ importacionId });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ importacionId });
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
  ])("rechaza importacionId %s", (_c, importacionId) => {
    expect(ok({ importacionId })).toBe(false);
  });

  it("exige importacionId", () => {
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, "texto", [], 1]) expect(ok(malo)).toBe(false);
  });

  it.each([
    ["periodos", { periodos: ["202610"] }],
    ["periodo", { periodo: "202610" }],
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["ruc", { ruc: "20100070970" }],
    ["clave", { clave: "CANARIO" }],
    ["token", { token: "CANARIO" }],
    ["candidatas", { candidatas: [{ docNumero: "20100070970" }] }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s (el payload no amplía nada: los periodos y el cliente salen de la importación)", (_c, extra) => {
    expect(ok({ importacionId: randomUUID(), ...extra })).toBe(false);
  });
});

describe("catálogo 025: deduplicación (008 D8)", () => {
  const cliente = randomUUID();
  const otro = randomUUID();
  const clave = (c: string, p: unknown) => claveDedupe(TIPO, c, p).toString("hex");

  it("la misma importación del mismo cliente comparte clave; otra importación, no", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(clave(cliente, { importacionId: a })).toBe(clave(cliente, { importacionId: a }));
    expect(clave(cliente, { importacionId: a })).not.toBe(clave(cliente, { importacionId: b }));
  });
  it("la misma importación en otro cliente tiene otra clave", () => {
    const a = randomUUID();
    expect(clave(cliente, { importacionId: a })).not.toBe(clave(otro, { importacionId: a }));
  });
  it("no comparte clave con la descarga de la propuesta del mismo cliente", () => {
    expect(clave(cliente, { importacionId: randomUUID() })).not.toBe(claveDedupe("sire.propuesta.descargar", cliente, { periodo: "202610", libro: "compras" }).toString("hex"));
  });
});

describe("catálogo 025: no toca a los tipos previos", () => {
  it.each([
    ["cliente.consultar_ruc", "xml", "ninguno", null, "clientes.crear"],
    ["credencial.verificar_sol", "sol", "sol", null, "credenciales.editar"],
    ["credencial.verificar_sire", "sire", "sire", null, "credenciales.editar"],
    ["sire.propuesta.descargar", "sire", "sire", "sire_api", "sire.descargar"],
    ["xml.obtener", "xml", "ninguno", null, "sire.clasificar"],
    ["sol.buzon.revisar", "sol", "sol", "sol", "buzon.ver"],
    ["sol.buzon.abrir", "sol", "sol", "sol", "buzon.marcar_leido"],
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({ cola, canal, credencial, permiso, idempotente: true });
  });
});
