import { describe, expect, it } from "vitest";
import {
  clienteCrearSchema,
  clienteEditarSchema,
  filtrosClientesSchema,
  perfilFiscalSchema,
} from "./esquemas.js";

// Spec 007a (D1, D2, D7; CA-1, CA-4, CA-6). Contrato fijado por estas pruebas (plan: Contratos shared; los
// nombres de los esquemas siguen el patrón de planes: <entidad><Accion>Schema):
//  - perfilFiscalSchema: PerfilFiscal = {regimen: rg|rmt|rer|nrus|null, zona: general|amazonia,
//    ventasExoneradas: boolean, ventasMixtas: boolean, monedaHabitual: PEN|USD}.
//  - clienteCrearSchema: CrearClienteInput = {ruc (validarRuc), razonSocial? (1-200), responsableId? (uuid), perfil?}.
//  - clienteEditarSchema: EditarClienteInput = {razonSocial?, perfil?}; el RUC es inmutable y se descarta.
//  - filtrosClientesSchema: FiltrosClientes desde la query string: responsable (uuid|'ninguno'),
//    credencial (EstadoCredencial), archivados ('1' -> true), q (<= 100).
// Claves desconocidas descartadas (z.object): tenantId, id, archivadoAt, etc. no viajan por el cuerpo.
const RUC = "20100070970";
const U = "01920000-0000-7000-8000-0000000000a1";
const perfil = {
  regimen: "rmt",
  zona: "amazonia",
  ventasExoneradas: true,
  ventasMixtas: false,
  monedaHabitual: "USD",
};
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

describe("perfilFiscalSchema", () => {
  it("acepta un perfil válido y lo devuelve igual", () => {
    expect(datos(perfilFiscalSchema, perfil)).toEqual(perfil);
  });

  it.each(["rg", "rmt", "rer", "nrus", null])(
    "acepta el régimen %s",
    (regimen) => {
      expect(ok(perfilFiscalSchema, { ...perfil, regimen })).toBe(true);
    },
  );

  it.each([
    ["regimen", "mype"],
    ["regimen", "RG"],
    ["regimen", ""],
    ["regimen", 1],
    ["zona", "selva"],
    ["zona", null],
    ["zona", "General"],
    ["monedaHabitual", "EUR"],
    ["monedaHabitual", "pen"],
    ["monedaHabitual", null],
    ["ventasExoneradas", "true"],
    ["ventasExoneradas", 1],
    ["ventasExoneradas", null],
    ["ventasMixtas", "false"],
    ["ventasMixtas", 0],
  ])("rechaza %s = %j (fuera del catálogo)", (campo, valor) => {
    expect(ok(perfilFiscalSchema, { ...perfil, [campo]: valor })).toBe(false);
  });

  it("descarta las claves desconocidas", () => {
    const d = datos(perfilFiscalSchema, {
      ...perfil,
      archivadoAt: "2026-01-01",
      tenantId: U,
    });
    expect(d).toEqual(perfil);
  });
});

describe("clienteCrearSchema", () => {
  it("acepta solo el RUC (razón social, responsable y perfil son opcionales)", () => {
    const d = datos(clienteCrearSchema, { ruc: RUC });
    expect(d.ruc).toBe(RUC);
    expect(d.razonSocial ?? undefined).toBeUndefined();
    expect(d.responsableId ?? undefined).toBeUndefined();
  });

  it("acepta el cuerpo completo", () => {
    const d = datos(clienteCrearSchema, {
      ruc: RUC,
      razonSocial: "Mi Estudio SAC",
      responsableId: U,
      perfil,
    });
    expect(d).toMatchObject({
      ruc: RUC,
      razonSocial: "Mi Estudio SAC",
      responsableId: U,
      perfil,
    });
  });

  it.each([
    ["dígito verificador errado", "20100070971"],
    ["prefijo 11", "11111111113"],
    ["prefijo 30", "30111111118"],
    ["10 dígitos", "2010007097"],
    ["12 dígitos", "201000709700"],
    ["letras", "2010007097A"],
    ["espacios", " 20100070970"],
    ["vacío", ""],
  ])("rechaza el RUC con %s", (_c, ruc) => {
    expect(ok(clienteCrearSchema, { ruc })).toBe(false);
  });

  it.each([[20100070970], [null], [undefined], [{}]])(
    "rechaza un RUC que no es string (%j)",
    (ruc) => {
      expect(ok(clienteCrearSchema, { ruc })).toBe(false);
    },
  );

  it("exige el RUC", () => {
    expect(ok(clienteCrearSchema, {})).toBe(false);
    expect(ok(clienteCrearSchema, { razonSocial: "Sin RUC SAC" })).toBe(false);
  });

  it("razonSocial: 1 a 200 caracteres", () => {
    expect(ok(clienteCrearSchema, { ruc: RUC, razonSocial: "a" })).toBe(true);
    expect(
      ok(clienteCrearSchema, { ruc: RUC, razonSocial: "a".repeat(200) }),
    ).toBe(true);
    expect(
      ok(clienteCrearSchema, { ruc: RUC, razonSocial: "a".repeat(201) }),
    ).toBe(false);
    expect(ok(clienteCrearSchema, { ruc: RUC, razonSocial: "" })).toBe(false);
    expect(ok(clienteCrearSchema, { ruc: RUC, razonSocial: 5 })).toBe(false);
  });

  it("responsableId debe ser uuid", () => {
    expect(ok(clienteCrearSchema, { ruc: RUC, responsableId: "no-uuid" })).toBe(
      false,
    );
    expect(ok(clienteCrearSchema, { ruc: RUC, responsableId: "" })).toBe(false);
    expect(ok(clienteCrearSchema, { ruc: RUC, responsableId: 7 })).toBe(false);
  });

  it("rechaza un perfil con valores fuera del catálogo (CA-4)", () => {
    expect(
      ok(clienteCrearSchema, {
        ruc: RUC,
        perfil: { ...perfil, regimen: "otro" },
      }),
    ).toBe(false);
    expect(
      ok(clienteCrearSchema, {
        ruc: RUC,
        perfil: { ...perfil, zona: "costa" },
      }),
    ).toBe(false);
    expect(
      ok(clienteCrearSchema, {
        ruc: RUC,
        perfil: { ...perfil, monedaHabitual: "EUR" },
      }),
    ).toBe(false);
  });

  it("descarta las claves desconocidas (tenantId, id, archivadoAt, estados de SUNAT)", () => {
    const d = datos(clienteCrearSchema, {
      ruc: RUC,
      tenantId: U,
      id: U,
      archivadoAt: "2026-01-01T00:00:00Z",
      estadoContribuyente: "ACTIVO",
      condicionContribuyente: "HABIDO",
    });
    expect(Object.keys(d)).toEqual(["ruc"]);
  });
});

describe("clienteEditarSchema", () => {
  it("acepta razón social y perfil", () => {
    expect(
      datos(clienteEditarSchema, { razonSocial: "Nueva SAC", perfil }),
    ).toMatchObject({
      razonSocial: "Nueva SAC",
      perfil,
    });
  });

  it("el RUC es inmutable: se descarta, igual que el responsable, el tenant y el archivado", () => {
    const d = datos(clienteEditarSchema, {
      razonSocial: "Nueva SAC",
      ruc: "20600000013",
      responsableId: U,
      tenantId: U,
      archivadoAt: null,
    });
    expect(d).toEqual({ razonSocial: "Nueva SAC" });
  });

  it("rechaza razón social vacía o de más de 200 caracteres", () => {
    expect(ok(clienteEditarSchema, { razonSocial: "" })).toBe(false);
    expect(ok(clienteEditarSchema, { razonSocial: "a".repeat(201) })).toBe(
      false,
    );
    expect(ok(clienteEditarSchema, { razonSocial: "a".repeat(200) })).toBe(
      true,
    );
  });

  it("rechaza un perfil fuera del catálogo (CA-4)", () => {
    expect(
      ok(clienteEditarSchema, { perfil: { ...perfil, regimen: "otro" } }),
    ).toBe(false);
    expect(
      ok(clienteEditarSchema, { perfil: { ...perfil, monedaHabitual: "EUR" } }),
    ).toBe(false);
    expect(
      ok(clienteEditarSchema, { perfil: { ...perfil, zona: "costa" } }),
    ).toBe(false);
  });
});

describe("filtrosClientesSchema", () => {
  it("acepta la query vacía", () => {
    expect(ok(filtrosClientesSchema, {})).toBe(true);
  });

  it("responsable: uuid o 'ninguno'", () => {
    expect(datos(filtrosClientesSchema, { responsable: U }).responsable).toBe(
      U,
    );
    expect(
      datos(filtrosClientesSchema, { responsable: "ninguno" }).responsable,
    ).toBe("ninguno");
    expect(ok(filtrosClientesSchema, { responsable: "nadie" })).toBe(false);
    expect(ok(filtrosClientesSchema, { responsable: "" })).toBe(false);
    expect(ok(filtrosClientesSchema, { responsable: "NINGUNO" })).toBe(false);
  });

  it.each(["no_configurada", "configurada", "verificada", "invalida"])(
    "credencial = %s",
    (credencial) => {
      expect(datos(filtrosClientesSchema, { credencial }).credencial).toBe(
        credencial,
      );
    },
  );

  it("rechaza una credencial fuera del catálogo", () => {
    expect(ok(filtrosClientesSchema, { credencial: "vencida" })).toBe(false);
    expect(ok(filtrosClientesSchema, { credencial: "" })).toBe(false);
  });

  it("archivados=1 (query string) pasa a true", () => {
    expect(datos(filtrosClientesSchema, { archivados: "1" }).archivados).toBe(
      true,
    );
  });

  it("archivados ausente no activa el filtro", () => {
    expect(datos(filtrosClientesSchema, {}).archivados ?? false).toBe(false);
  });

  it("q: hasta 100 caracteres", () => {
    expect(datos(filtrosClientesSchema, { q: "a".repeat(100) }).q).toBe(
      "a".repeat(100),
    );
    expect(ok(filtrosClientesSchema, { q: "a".repeat(101) })).toBe(false);
  });

  it("q conserva comodines y comillas tal cual (el escape es del repositorio)", () => {
    expect(datos(filtrosClientesSchema, { q: "50%_\\'\"" }).q).toBe(
      "50%_\\'\"",
    );
  });

  it("combina todos los filtros y descarta claves desconocidas", () => {
    const d = datos(filtrosClientesSchema, {
      responsable: U,
      credencial: "invalida",
      archivados: "1",
      q: "sac",
      tenantId: U,
      orden: "desc",
    });
    expect(d).toEqual({
      responsable: U,
      credencial: "invalida",
      archivados: true,
      q: "sac",
    });
  });
});
