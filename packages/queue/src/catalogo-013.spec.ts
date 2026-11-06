import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TipoInvalidoError,
  definicionDe,
  registrarTipo,
  rolesPermitidos,
} from "./index.js";

// Spec 013 (D2; plan: Cola; CA-1, CA-2). Forma exacta del tipo nuevo `sire.propuesta.descargar`:
//  - cola `sire`, canal `sire`, credencial `sire_api`, permiso `sire.descargar`, idempotente.
//  - parámetros `{ periodo, libro }` estrictos: `periodo` AAAAMM con mes 01-12 y sin futuro (no posterior al
//    mes en curso; el mes en curso sí vale), `libro` = compras | ventas. Cualquier otra clave se rechaza (no
//    hay campo para llevar un secreto en el payload). Se registra con cualquier NODE_ENV.
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia (014 no lo toca).
const TIPO = "sire.propuesta.descargar";
// Mediados de noviembre de 2026 (lejos de un cambio de mes en cualquier huso).
const AHORA = new Date("2026-11-15T17:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now: AHORA, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catálogo 013: sire.propuesta.descargar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(TIPO)).toMatchObject({
      tipo: TIPO,
      cola: "sire",
      canal: "sire",
      credencial: "sire_api",
      permiso: "sire.descargar",
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
        cola: "sire",
        canal: "sire",
        credencial: "sire_api",
        permiso: "sire.descargar",
        idempotente: true,
      });
    },
  );

  it.each([
    "cola",
    "canal",
    "credencial",
    "credencial a null",
    "permiso",
    "permiso a null",
    "idempotente",
  ])("registrarTipo rechaza cambiar %s", (que) => {
    const d = definicionDe(TIPO);
    const cambios = {
      cola: { cola: d.cola === "archivos" ? "sol" : "archivos" },
      canal: { canal: d.canal === "ninguno" ? "sol" : "ninguno" },
      credencial: { credencial: "sol" },
      "credencial a null": { credencial: null },
      permiso: { permiso: "clientes.ver" },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(
      TipoInvalidoError,
    );
    expect(definicionDe(TIPO)).toMatchObject({
      cola: "sire",
      canal: "sire",
      credencial: "sire_api",
      permiso: "sire.descargar",
      idempotente: true,
    });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });
});

describe("catálogo 013: parámetros { periodo, libro }", () => {
  const ok = (v: unknown) => definicionDe(TIPO).parametros.safeParse(v).success;

  it.each(["compras", "ventas"])("acepta el libro %s con un periodo pasado", (libro) => {
    expect(ok({ periodo: "202610", libro })).toBe(true);
  });

  it("devuelve los valores tal cual (periodo como cadena)", () => {
    const r = definicionDe(TIPO).parametros.safeParse({ periodo: "202610", libro: "ventas" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ periodo: "202610", libro: "ventas" });
  });

  it.each(["202601", "202512", "202011", "202610", "202611"])(
    "acepta el periodo %s (hasta el mes en curso)",
    (periodo) => {
      expect(ok({ periodo, libro: "ventas" })).toBe(true);
    },
  );

  it.each([
    ["el mes siguiente", "202612"],
    ["el año siguiente", "202701"],
    ["un periodo lejano", "209901"],
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["con guion", "2026-10"],
    ["de 5 dígitos", "20261"],
    ["de 7 dígitos", "2026101"],
    ["con espacios", " 202610"],
    ["con espacio final", "202610 "],
    ["con letras", "2026AB"],
    ["vacío", ""],
    ["con ruta", "../../1"],
    ["con dígitos de ancho completo", "２０２６１０"],
    ["número", 202610],
    ["null", null],
    ["objeto", {}],
  ])("rechaza el periodo %s", (_c, periodo) => {
    expect(ok({ periodo, libro: "ventas" })).toBe(false);
  });

  it("el futuro se mide con la fecha actual, no con una constante", () => {
    vi.setSystemTime(new Date("2027-03-15T17:00:00Z"));
    expect(ok({ periodo: "202612", libro: "ventas" })).toBe(true);
    expect(ok({ periodo: "202703", libro: "ventas" })).toBe(true);
    expect(ok({ periodo: "202704", libro: "ventas" })).toBe(false);
  });

  it.each([
    ["otro libro", "otro"],
    ["mayúsculas", "VENTAS"],
    ["con espacio", "ventas "],
    ["vacío", ""],
    ["singular", "venta"],
    ["número", 1],
    ["null", null],
    ["arreglo", ["ventas"]],
    ["clave heredada", "constructor"],
  ])("rechaza el libro %s", (_c, libro) => {
    expect(ok({ periodo: "202610", libro })).toBe(false);
  });

  it("exige periodo y libro", () => {
    expect(ok({ libro: "ventas" })).toBe(false);
    expect(ok({ periodo: "202610" })).toBe(false);
    expect(ok({})).toBe(false);
    for (const malo of [null, undefined, "texto", [], 1]) expect(ok(malo)).toBe(false);
  });

  it("es estricto: rechaza cualquier otra clave (no hay dónde llevar un secreto ni un cliente)", () => {
    for (const extra of [
      { clave: "CANARIO" },
      { claveSol: "CANARIO", clientSecret: "CANARIO" },
      { clienteId: "x" },
      { tenantId: "x" },
      { token: "CANARIO" },
      { constructor: 1 },
    ]) {
      expect(ok({ periodo: "202610", libro: "ventas", ...extra })).toBe(false);
    }
  });
});

describe("catálogo 013: no toca a los tipos previos", () => {
  it.each([
    ["cliente.consultar_ruc", "xml", "ninguno", null, "clientes.crear"],
    ["credencial.verificar_sol", "sol", "sol", null, "credenciales.editar"],
    ["credencial.verificar_sire", "sire", "sire", null, "credenciales.editar"],
  ])("%s conserva su forma", (tipo, cola, canal, credencial, permiso) => {
    expect(definicionDe(tipo)).toMatchObject({ cola, canal, credencial, permiso, idempotente: true });
  });
});
