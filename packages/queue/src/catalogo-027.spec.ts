import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claveDedupe, definicionDe, registrarTipo, rolesPermitidos, TipoInvalidoError } from "./index.js";

// Spec 027 (R-12, R-8; plan 027, Contratos: Cola; T2). Forma exacta del tipo nuevo:
//  - `compras.reevaluar`: cola `xml`, canal `ninguno`, credencial `null`, permiso `sire.clasificar`, idempotente;
//    parámetros `{periodo: AAAAMM}` ESTRICTOS (mes 01-12). El cliente sale del trabajo y las compras, del periodo en el worker: no hay dónde llevar
//    un cliente, un secreto ni una lista de compras. Dedupe de 008 por (tipo, cliente, parámetros): dos «Volver a evaluar» del mismo cliente y
//    periodo comparten trabajo (CA-12); otro periodo u otro cliente, no.
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia. Se registra con cualquier NODE_ENV.
//  - Los tipos previos (007b–026) no cambian.
const TIPO = "compras.reevaluar";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catálogo 027: compras.reevaluar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(TIPO)).toMatchObject({
      tipo: TIPO,
      cola: "xml",
      canal: "ninguno",
      credencial: null,
      permiso: "sire.clasificar",
      idempotente: true,
    });
  });

  it("lo piden los mismos roles que re-evalúan desde la grilla (xml.obtener, sire.clasificar)", () => {
    const roles = rolesPermitidos(definicionDe(TIPO).permiso);
    expect(roles).not.toBeNull();
    expect(roles!.length).toBeGreaterThan(0);
    expect([...roles!].sort()).toEqual([...rolesPermitidos(definicionDe("xml.obtener").permiso)!].sort());
    expect(roles).not.toContain("lectura");
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(TIPO)).toMatchObject({ cola: "xml", canal: "ninguno", credencial: null, permiso: "sire.clasificar", idempotente: true });
  });

  it.each(["cola", "canal", "credencial", "permiso", "permiso a null", "idempotente"])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(TIPO);
    const cambios = {
      cola: { cola: "sire" },
      canal: { canal: "sire" },
      credencial: { credencial: "sol" },
      permiso: { permiso: "sire.descargar" },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
    expect(definicionDe(TIPO)).toMatchObject({ cola: "xml", canal: "ninguno", credencial: null, permiso: "sire.clasificar", idempotente: true });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });

  it("comparte cola, canal y credencial con xml.obtener: no necesita el bloqueo por RUC de SUNAT", () => {
    const xml = definicionDe("xml.obtener");
    expect(definicionDe(TIPO).cola).toBe(xml.cola);
    expect(definicionDe(TIPO).canal).toBe(xml.canal);
    expect(definicionDe(TIPO).credencial).toBe(xml.credencial);
  });
});

describe("catálogo 027: parámetros = {periodo} estricto", () => {
  const ok = (v: unknown) => definicionDe(TIPO).parametros.safeParse(v).success;

  it.each(["202601", "202610", "202612"])("acepta el periodo %s y lo devuelve tal cual", (periodo) => {
    const r = definicionDe(TIPO).parametros.safeParse({ periodo });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ periodo });
  });

  it.each([
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["con guion", "2026-10"],
    ["corto", "20261"],
    ["largo", "2026101"],
    ["vacío", ""],
    ["con espacio", " 202610"],
    ["con salto de línea", "202610\n"],
    ["número", 202610],
    ["null", null],
    ["lista", ["202610"]],
    ["objeto", {}],
    ["texto", "octubre"],
  ])("rechaza el periodo %s", (_c, periodo) => {
    expect(ok({ periodo })).toBe(false);
  });

  it("exige periodo y un objeto", () => {
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, "202610", 202610, [], [{ periodo: "202610" }], true]) expect(ok(malo)).toBe(false);
  });

  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["compraIds", { compraIds: [randomUUID()] }],
    ["umbral", { umbral: 3 }],
    ["ruc", { ruc: "20100070970" }],
    ["diccionario", { diccionario: ["zapato"] }],
    ["periodos", { periodos: ["202610", "202609"] }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok({ periodo: "202610", ...extra })).toBe(false);
  });
});

describe("catálogo 027: deduplicación (008 D8; CA-12)", () => {
  const cliente = randomUUID();
  const otro = randomUUID();
  const clave = (tipo: string, c: string, p: unknown) => claveDedupe(tipo, c, p).toString("hex");

  it("dos pedidos del mismo cliente y periodo comparten clave", () => {
    const p1 = definicionDe(TIPO).parametros.parse({ periodo: "202610" });
    const p2 = definicionDe(TIPO).parametros.parse({ periodo: "202610" });
    expect(clave(TIPO, cliente, p1)).toBe(clave(TIPO, cliente, p2));
  });
  it("otro periodo del mismo cliente tiene otra clave", () => {
    expect(clave(TIPO, cliente, { periodo: "202610" })).not.toBe(clave(TIPO, cliente, { periodo: "202609" }));
  });
  it("el mismo periodo de otro cliente tiene otra clave", () => {
    expect(clave(TIPO, cliente, { periodo: "202610" })).not.toBe(clave(TIPO, otro, { periodo: "202610" }));
  });
  it("no comparte clave con otro tipo del mismo cliente y periodo", () => {
    expect(clave(TIPO, cliente, { periodo: "202610" })).not.toBe(clave("sol.declaraciones.descargar", cliente, { periodo: "202610" }));
  });
});

describe("catálogo 027: no toca a los tipos previos", () => {
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
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({ cola, canal, credencial, permiso, idempotente: true });
  });
});
