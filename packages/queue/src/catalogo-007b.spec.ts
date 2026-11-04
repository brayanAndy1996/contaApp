import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TipoInvalidoError,
  definicionDe,
  registrarTipo,
  rolesPermitidos,
} from "./index.js";

// Spec 007b (D1, D6; plan: Contratos Catálogo). Forma exacta de los tres tipos nuevos:
//  - cliente.consultar_ruc: cola xml, canal ninguno, credencial null, permiso clientes.crear.
//  - credencial.verificar_sol: cola sol, canal sol, credencial null, permiso credenciales.editar.
//  - credencial.verificar_sire: cola sire, canal sire, credencial null, permiso credenciales.editar.
//  - Los tres idempotentes y con parámetros `{}` estrictos (rechazan cualquier clave; no hay campo para
//    llevar un secreto en el payload). Se registran con cualquier NODE_ENV (no solo en pruebas).
//  - `credencial: null` es deliberado: el despachador cancela con `credencial_invalida` todo tipo cuyo
//    sobre esté inválido, y verificar debe poder correr justo en ese estado.
//  - registrarTipo rechaza (TipoInvalidoError) cambiar cola, canal, credencial, permiso o idempotencia.
const TIPOS = [
  {
    tipo: "cliente.consultar_ruc",
    cola: "xml",
    canal: "ninguno",
    permiso: "clientes.crear",
  },
  {
    tipo: "credencial.verificar_sol",
    cola: "sol",
    canal: "sol",
    permiso: "credenciales.editar",
  },
  {
    tipo: "credencial.verificar_sire",
    cola: "sire",
    canal: "sire",
    permiso: "credenciales.editar",
  },
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(TIPOS)("catálogo 007b: $tipo", (esperado) => {
  it("tiene la forma exacta del plan", () => {
    const d = definicionDe(esperado.tipo);
    expect(d).toMatchObject({
      tipo: esperado.tipo,
      cola: esperado.cola,
      canal: esperado.canal,
      credencial: null,
      permiso: esperado.permiso,
      idempotente: true,
    });
  });

  it("los parámetros son `{}` estrictos", () => {
    const { parametros } = definicionDe(esperado.tipo);
    expect(parametros.safeParse({}).success).toBe(true);
    for (const malo of [
      { clave: "CANARIO" },
      { clienteId: "x" },
      { claveSol: "CANARIO", clientSecret: "CANARIO" },
      { constructor: 1 },
      null,
      undefined,
      "texto",
      [],
      1,
    ]) {
      expect(parametros.safeParse(malo).success).toBe(false);
    }
  });

  it("el permiso existe y lo tienen los roles esperados (no es público)", () => {
    const roles = rolesPermitidos(definicionDe(esperado.tipo).permiso);
    expect(roles).not.toBeNull();
    expect(roles!.length).toBeGreaterThan(0);
  });

  it.each(["production", "development", ""])(
    "queda registrado con NODE_ENV=%j",
    async (valor) => {
      vi.stubEnv("NODE_ENV", valor);
      vi.resetModules();
      const m = await import("./index.js");
      expect(m.definicionDe(esperado.tipo).tipo).toBe(esperado.tipo);
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
    const d = definicionDe(esperado.tipo);
    const cambios = {
      cola: { cola: d.cola === "archivos" ? "sol" : "archivos" },
      canal: { canal: d.canal === "ninguno" ? "sol" : "ninguno" },
      credencial: { credencial: "sol" },
      permiso: {
        permiso:
          d.permiso === "clientes.ver" ? "clientes.crear" : "clientes.ver",
      },
      "permiso a null": { permiso: null },
      idempotente: { idempotente: false },
    } as Record<string, object>;
    expect(() => registrarTipo({ ...d, ...cambios[que] } as typeof d)).toThrow(
      TipoInvalidoError,
    );
    // y la definición registrada sigue intacta
    expect(definicionDe(esperado.tipo)).toMatchObject({
      cola: esperado.cola,
      canal: esperado.canal,
      credencial: null,
      permiso: esperado.permiso,
      idempotente: true,
    });
  });

  it("volver a registrar la misma forma no falla", () => {
    expect(() => registrarTipo(definicionDe(esperado.tipo))).not.toThrow();
  });
});

describe("catálogo 007b: los tres tipos son distintos", () => {
  it("no comparten cola y canal entre los dos de verificación", () => {
    const sol = definicionDe("credencial.verificar_sol");
    const sire = definicionDe("credencial.verificar_sire");
    expect(sol.cola).not.toBe(sire.cola);
    expect(sol.canal).not.toBe(sire.canal);
  });
});
