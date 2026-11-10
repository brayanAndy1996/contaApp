import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TipoInvalidoError,
  definicionDe,
  registrarTipo,
  rolesPermitidos,
} from "./index.js";

// Spec 016 (D-7, P-7; plan: Cola y worker; T6). Forma exacta del tipo nuevo `xml.obtener`:
//  - cola `xml`, canal `ninguno`, credencial `null` (mientras solo exista el mock; el proveedor real fija las suyas),
//    permiso `sire.clasificar`, idempotente.
//  - parámetros `{ periodo, compraIds }` estrictos: `periodo` AAAAMM con mes 01-12; `compraIds` = de 1 a 100 uuid,
//    únicos y en orden ascendente (forma canónica: el dedupe de 008 trata igual el mismo lote). Cualquier otra clave
//    se rechaza (no hay dónde llevar un XML, un secreto ni un cliente en el payload). Se registra con cualquier NODE_ENV.
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia.
const TIPO = "xml.obtener";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** `n` uuid v4 distintos, en orden ascendente (la forma canónica del lote). */
const uuids = (n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) => `0190a000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  );

describe("catálogo 016: xml.obtener", () => {
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

  it("el permiso existe y lo tienen roles (no es público)", () => {
    const roles = rolesPermitidos(definicionDe(TIPO).permiso);
    expect(roles).not.toBeNull();
    expect(roles!.length).toBeGreaterThan(0);
  });

  it.each(["production", "development", "test", ""])(
    "queda registrado con NODE_ENV=%j",
    async (valor) => {
      vi.stubEnv("NODE_ENV", valor);
      vi.resetModules();
      const m = await import("./index.js");
      expect(m.definicionDe(TIPO)).toMatchObject({
        cola: "xml",
        canal: "ninguno",
        credencial: null,
        permiso: "sire.clasificar",
        idempotente: true,
      });
    },
  );

  it.each([
    "cola",
    "canal",
    "credencial",
    "permiso",
    "permiso a null",
    "idempotente",
  ])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(TIPO);
    const cambios = {
      cola: { cola: "sire" },
      canal: { canal: "sol" },
      credencial: { credencial: "sol" },
      permiso: { permiso: "clientes.ver" },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(
      TipoInvalidoError,
    );
    expect(definicionDe(TIPO)).toMatchObject({
      cola: "xml",
      canal: "ninguno",
      credencial: null,
      permiso: "sire.clasificar",
      idempotente: true,
    });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });
});

describe("catálogo 016: parámetros { periodo, compraIds }", () => {
  const ok = (v: unknown) => definicionDe(TIPO).parametros.safeParse(v).success;

  it("devuelve los valores tal cual (periodo como cadena, ids en su orden)", () => {
    const ids = uuids(3);
    const r = definicionDe(TIPO).parametros.safeParse({
      periodo: "202610",
      compraIds: ids,
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ periodo: "202610", compraIds: ids });
  });

  it.each([1, 2, 50, 99, 100])("acepta un lote de %i compras", (n) => {
    expect(ok({ periodo: "202610", compraIds: uuids(n) })).toBe(true);
  });

  it("rechaza un lote vacío y uno de 101", () => {
    expect(ok({ periodo: "202610", compraIds: [] })).toBe(false);
    expect(ok({ periodo: "202610", compraIds: uuids(101) })).toBe(false);
  });

  it.each([
    ["con guion", "2026-10"],
    ["de 5 dígitos", "20261"],
    ["de 7 dígitos", "2026101"],
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["con espacios", " 202610"],
    ["con ruta", "../../1"],
    ["vacío", ""],
    ["número", 202610],
    ["null", null],
  ])("rechaza el periodo %s", (_c, periodo) => {
    expect(ok({ periodo, compraIds: uuids(1) })).toBe(false);
  });

  it.each([
    ["texto que no es uuid", ["no-es-un-uuid"]],
    ["uuid con ruta", ["../../etc/passwd"]],
    ["vacío", [""]],
    ["número", [1]],
    ["null", [null]],
    ["objeto", [{}]],
    ["uuid con sufijo", [`${uuids(1)[0]}x`]],
    ["no es una lista", uuids(1)[0]],
    ["null en lugar de lista", null],
  ])("rechaza compraIds con %s", (_c, compraIds) => {
    expect(ok({ periodo: "202610", compraIds })).toBe(false);
  });

  it("rechaza ids repetidos", () => {
    const [a, b] = uuids(2) as [string, string];
    expect(ok({ periodo: "202610", compraIds: [a, a] })).toBe(false);
    expect(ok({ periodo: "202610", compraIds: [a, b, a] })).toBe(false);
  });

  it("rechaza ids que no están en orden ascendente (forma canónica del lote)", () => {
    const [a, b] = uuids(2) as [string, string];
    expect(ok({ periodo: "202610", compraIds: [a, b] })).toBe(true);
    expect(ok({ periodo: "202610", compraIds: [b, a] })).toBe(false);
  });

  it("exige periodo y compraIds", () => {
    expect(ok({ compraIds: uuids(1) })).toBe(false);
    expect(ok({ periodo: "202610" })).toBe(false);
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, "texto", [], 1]) expect(ok(malo)).toBe(false);
  });

  it("es estricto: rechaza cualquier otra clave (no hay dónde llevar un XML, un secreto ni un cliente)", () => {
    for (const extra of [
      { xml: "<Invoice/>" },
      { clave: "CANARIO" },
      { claveSol: "CANARIO", clientSecret: "CANARIO" },
      { clienteId: "x" },
      { tenantId: "x" },
      { token: "CANARIO" },
      { libro: "compras" },
      { constructor: 1 },
    ]) {
      expect(ok({ periodo: "202610", compraIds: uuids(1), ...extra })).toBe(false);
    }
  });
});

describe("catálogo 016: no toca a los tipos previos", () => {
  it.each([
    ["cliente.consultar_ruc", "xml", "ninguno", null, "clientes.crear"],
    ["credencial.verificar_sol", "sol", "sol", null, "credenciales.editar"],
    ["credencial.verificar_sire", "sire", "sire", null, "credenciales.editar"],
    ["sire.propuesta.descargar", "sire", "sire", "sire_api", "sire.descargar"],
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({
      cola,
      canal,
      credencial,
      permiso,
      idempotente: true,
    });
  });
});
