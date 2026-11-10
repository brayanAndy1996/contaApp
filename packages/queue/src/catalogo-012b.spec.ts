import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TipoInvalidoError,
  claveDedupe,
  definicionDe,
  registrarTipo,
  rolesPermitidos,
} from "./index.js";

// Spec 012b (D2, D6; plan: Cola y worker; T5). Forma exacta del tipo nuevo `archivo.generar`:
//  - cola `archivos`, canal `ninguno`, credencial `null` (el trabajo no usa credenciales, D10), permiso
//    `sire.aprobar_generar`, idempotente. Se registra con cualquier NODE_ENV.
//  - parámetros `{ periodo, libro, estadoVisto, huella }` estrictos: `periodo` AAAAMM con mes 01-12; `libro` compras|ventas;
//    `estadoVisto` abierto|revisado (nunca `generado`); `huella` = 64 hexadecimales en minúscula (sha256Hex del canon).
//    Cualquier otra clave se rechaza: nada de `permitirProvisional`, `registro`, `clienteId` ni `nodeEnv` en el payload.
//  - dos clics con el mismo previo comparten clave de deduplicación de 008 (mismos parámetros); otra huella, otra clave.
//  - `registrarTipo` rechaza cambiar cola, canal, credencial, permiso o idempotencia.
const TIPO = "archivo.generar";
const HUELLA = "a1".repeat(32);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const valido = { periodo: "202610", libro: "compras", estadoVisto: "abierto", huella: HUELLA };

describe("catálogo 012b: archivo.generar", () => {
  it("tiene la forma exacta del plan", () => {
    expect(definicionDe(TIPO)).toMatchObject({
      tipo: TIPO,
      cola: "archivos",
      canal: "ninguno",
      credencial: null,
      permiso: "sire.aprobar_generar",
      idempotente: true,
    });
  });

  it("el permiso existe y lo tienen roles (no es público)", () => {
    const roles = rolesPermitidos(definicionDe(TIPO).permiso);
    expect(roles).not.toBeNull();
    expect(roles!.length).toBeGreaterThan(0);
  });

  it.each(["production", "development", "test", ""])("queda registrado con NODE_ENV=%j", async (valor) => {
    vi.stubEnv("NODE_ENV", valor);
    vi.resetModules();
    const m = await import("./index.js");
    expect(m.definicionDe(TIPO)).toMatchObject({
      cola: "archivos",
      canal: "ninguno",
      credencial: null,
      permiso: "sire.aprobar_generar",
      idempotente: true,
    });
  });

  it.each(["cola", "canal", "credencial", "permiso", "permiso a null", "idempotente"])(
    "registrarTipo rechaza cambiar %s",
    (que) => {
      const d = definicionDe(TIPO);
      const cambios = {
        cola: { cola: "sire" },
        canal: { canal: "sol" },
        credencial: { credencial: "sol" },
        permiso: { permiso: "clientes.ver" },
        "permiso a null": { permiso: null },
        idempotente: { idempotente: false },
      } as Record<string, object>;
      expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(TipoInvalidoError);
      expect(definicionDe(TIPO)).toMatchObject({
        cola: "archivos",
        canal: "ninguno",
        credencial: null,
        permiso: "sire.aprobar_generar",
        idempotente: true,
      });
    },
  );

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(TIPO))).not.toThrow();
  });
});

describe("catálogo 012b: parámetros { periodo, libro, estadoVisto, huella }", () => {
  const ok = (v: unknown) => definicionDe(TIPO).parametros.safeParse(v).success;

  it("devuelve los valores tal cual", () => {
    const r = definicionDe(TIPO).parametros.safeParse(valido);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(valido);
  });

  it.each(["compras", "ventas"])("acepta el libro %s", (libro) => {
    expect(ok({ ...valido, libro })).toBe(true);
  });

  it.each(["abierto", "revisado"])("acepta estadoVisto %s", (estadoVisto) => {
    expect(ok({ ...valido, estadoVisto })).toBe(true);
  });

  it.each([
    ["generado", "generado"],
    ["en mayúsculas", "ABIERTO"],
    ["vacío", ""],
    ["null", null],
    ["número", 1],
  ])("rechaza estadoVisto %s", (_c, estadoVisto) => {
    expect(ok({ ...valido, estadoVisto })).toBe(false);
  });

  it.each([
    ["otro libro", "rcv"],
    ["en mayúsculas", "COMPRAS"],
    ["vacío", ""],
    ["null", null],
    ["con ruta", "../ventas"],
  ])("rechaza el libro %s", (_c, libro) => {
    expect(ok({ ...valido, libro })).toBe(false);
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
    expect(ok({ ...valido, periodo })).toBe(false);
  });

  it.each([
    ["de 63 caracteres", "a".repeat(63)],
    ["de 65 caracteres", "a".repeat(65)],
    ["con mayúsculas", "A".repeat(64)],
    ["no hexadecimal", "g".repeat(64)],
    ["con espacios", ` ${"a".repeat(63)}`],
    ["con sufijo", `${"a".repeat(64)}x`],
    ["vacía", ""],
    ["número", 1],
    ["null", null],
    ["objeto", {}],
  ])("rechaza una huella %s", (_c, huella) => {
    expect(ok({ ...valido, huella })).toBe(false);
  });

  it("exige las cuatro claves", () => {
    for (const falta of ["periodo", "libro", "estadoVisto", "huella"]) {
      const sin = { ...valido } as Record<string, unknown>;
      delete sin[falta];
      expect(ok(sin), `sin ${falta}`).toBe(false);
    }
    for (const malo of [null, undefined, "texto", [], 1, {}]) expect(ok(malo)).toBe(false);
  });

  it("es estricto: rechaza cualquier otra clave (el entorno y el formato los decide el servidor)", () => {
    for (const extra of [
      { permitirProvisional: true },
      { registro: {} },
      { nodeEnv: "development" },
      { clienteId: "x" },
      { tenantId: "x" },
      { usuarioId: "x" },
      { formato: "RCE" },
      { provisional: true },
      { clave: "CANARIO", token: "CANARIO" },
      { constructor: 1 },
    ]) {
      expect(ok({ ...valido, ...extra })).toBe(false);
    }
  });
});

describe("catálogo 012b: deduplicación (D6)", () => {
  const CLIENTE = "0190a000-0000-4000-8000-000000000001";
  const clave = (p: unknown) => claveDedupe(TIPO, CLIENTE, p).toString("hex");

  it("dos clics con el mismo previo dan la misma clave, sin importar el orden de las claves", () => {
    const reordenado = { huella: HUELLA, estadoVisto: "abierto", libro: "compras", periodo: "202610" };
    expect(clave(valido)).toBe(clave(reordenado));
  });

  it.each([
    ["otra huella", { huella: "b2".repeat(32) }],
    ["otro estadoVisto", { estadoVisto: "revisado" }],
    ["otro libro", { libro: "ventas" }],
    ["otro periodo", { periodo: "202611" }],
  ])("%s da otra clave (otro previo = otro trabajo)", (_c, cambio) => {
    expect(clave({ ...valido, ...cambio })).not.toBe(clave(valido));
  });
});

describe("catálogo 012b: no toca a los tipos previos", () => {
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
