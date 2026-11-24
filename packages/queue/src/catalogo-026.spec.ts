import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claveDedupe, definicionDe, registrarTipo, rolesPermitidos, TipoInvalidoError } from "./index.js";

// Spec 026 (D-3, D-5; plan 026, Contratos: Cola; T2). Forma exacta del tipo nuevo:
//  - `sol.declaraciones.descargar`: cola `sol`, canal `sol`, credencial `sol`, permiso `prorrata.gestionar`, idempotente;
//    parámetros `{periodo: AAAAMM}` ESTRICTOS. El cliente sale del trabajo y la ventana de 12 meses se deriva del periodo en el worker.
//    Dedupe por (tipo, cliente, parámetros): dos pedidos del mismo cliente y periodo comparten trabajo (CA-7); otro periodo u otro cliente, no.
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia. Se registra con cualquier NODE_ENV.
//  - Los tipos previos (011–025) no cambian.
const TIPO = "sol.declaraciones.descargar";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catálogo 026: sol.declaraciones.descargar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(TIPO)).toMatchObject({
      tipo: TIPO,
      cola: "sol",
      canal: "sol",
      credencial: "sol",
      permiso: "prorrata.gestionar",
      idempotente: true,
    });
  });

  it("lo piden Dueño, Administrador y Contador; no Asistente ni Lectura (U-11)", () => {
    const roles = rolesPermitidos(definicionDe(TIPO).permiso);
    expect(roles).not.toBeNull();
    expect([...roles!].sort()).toEqual(["admin", "contador", "dueno"]);
    expect(roles).not.toContain("asistente");
    expect(roles).not.toContain("lectura");
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(TIPO)).toMatchObject({ cola: "sol", canal: "sol", credencial: "sol", permiso: "prorrata.gestionar", idempotente: true });
  });

  it.each(["cola", "canal", "credencial", "permiso", "permiso a null", "idempotente"])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(TIPO);
    const cambios = {
      cola: { cola: "sire" },
      canal: { canal: "sire" },
      credencial: { credencial: "sire_api" },
      permiso: { permiso: "prorrata.ver" },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
    expect(definicionDe(TIPO)).toMatchObject({ cola: "sol", canal: "sol", credencial: "sol", permiso: "prorrata.gestionar", idempotente: true });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });

  it("comparte cola y canal con el buzón: el bloqueo por RUC de 008 los serializa", () => {
    const buzon = definicionDe("sol.buzon.revisar");
    expect(definicionDe(TIPO).canal).toBe(buzon.canal);
    expect(definicionDe(TIPO).cola).toBe(buzon.cola);
    expect(definicionDe(TIPO).credencial).toBe(buzon.credencial);
  });
});

describe("catálogo 026: parámetros = {periodo} estricto", () => {
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

  it("exige periodo", () => {
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, "202610", 202610, [], [{ periodo: "202610" }], true]) expect(ok(malo)).toBe(false);
  });

  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["ruc", { ruc: "20100070970" }],
    ["clave", { clave: "CANARIO" }],
    ["claveSol", { claveSol: "CANARIO", usuarioSol: "CANARIO" }],
    ["periodos", { periodos: ["202610", "202609"] }],
    ["ventana", { ventana: 12 }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s (no hay dónde llevar un secreto, un cliente ni una ventana distinta)", (_c, extra) => {
    expect(ok({ periodo: "202610", ...extra })).toBe(false);
  });
});

describe("catálogo 026: deduplicación (008 D8; CA-7)", () => {
  const cliente = randomUUID();
  const otro = randomUUID();
  const clave = (tipo: string, c: string, p: unknown) => claveDedupe(tipo, c, p).toString("hex");

  it("dos pedidos del mismo cliente y periodo comparten clave, sin importar quién los pida", () => {
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
  it("no comparte clave con la revisión del buzón del mismo cliente", () => {
    expect(clave(TIPO, cliente, { periodo: "202610" })).not.toBe(clave("sol.buzon.revisar", cliente, {}));
  });
});

describe("catálogo 026: no toca a los tipos previos", () => {
  it.each([
    ["cliente.consultar_ruc", "xml", "ninguno", null, "clientes.crear"],
    ["credencial.verificar_sol", "sol", "sol", null, "credenciales.editar"],
    ["credencial.verificar_sire", "sire", "sire", null, "credenciales.editar"],
    ["sire.propuesta.descargar", "sire", "sire", "sire_api", "sire.descargar"],
    ["xml.obtener", "xml", "ninguno", null, "sire.clasificar"],
    ["sol.buzon.revisar", "sol", "sol", "sol", "buzon.ver"],
    ["sol.buzon.abrir", "sol", "sol", "sol", "buzon.marcar_leido"],
    ["reglas.historial.importar", "sire", "sire", "sire_api", "reglas.gestionar"],
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({ cola, canal, credencial, permiso, idempotente: true });
  });
});
