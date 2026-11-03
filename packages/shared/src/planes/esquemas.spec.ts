import { describe, expect, it } from "vitest";
import {
  planCrearSchema,
  planEditarSchema,
  registroConfirmarConSesionSchema,
  registroConfirmarSchema,
  registroConsultarSchema,
  registroSolicitudSchema,
  suscripcionAsignarSchema,
} from "./esquemas.js";

// Esquemas de 006 (plan: Contratos shared). Contrato fijado por estas pruebas:
//  - planCrearSchema: cuerpo de POST /plataforma/planes (activo opcional, por defecto true).
//  - planEditarSchema: cuerpo de PUT /plataforma/planes/:planId (reemplazo completo: activo obligatorio).
//  - suscripcionAsignarSchema: { planId (uuid), rucsExtraContratados (entero >= 0) }.
//  - registroSolicitudSchema / registroConsultarSchema / registroConfirmarSchema /
//    registroConfirmarConSesionSchema: cuerpos de los 4 POST /registro*.
//  - precios: cadena decimal ^\d{1,12}(\.\d{1,2})?$ (nunca number). Claves desconocidas descartadas.
const base = {
  codigo: "estudio",
  nombre: "Estudio",
  precioMensual: "249.00",
  precioAnual: "2490",
  maxRucs: 100,
  maxUsuarios: 5,
  precioRucExtra: "4",
  maxRucsExtra: 20,
  frecuenciaBuzonMin: 720,
  features: {},
  activo: true,
};
const con = (o: Record<string, unknown>) => ({ ...base, ...o });
/** Copia de `o` sin la clave `k`. */
const sin = (o: Record<string, unknown>, k: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([c]) => c !== k));
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;
const datos = (
  schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
  v: unknown,
) => {
  const r = schema.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

describe.each([
  ["planCrearSchema", planCrearSchema],
  ["planEditarSchema", planEditarSchema],
])("%s", (_nombre, schema) => {
  it("acepta un plan valido y conserva los precios como cadena", () => {
    const d = datos(schema, base);
    expect(d).toMatchObject({
      codigo: "estudio",
      precioMensual: "249.00",
      precioAnual: "2490",
      precioRucExtra: "4",
      maxRucs: 100,
      maxUsuarios: 5,
      maxRucsExtra: 20,
      frecuenciaBuzonMin: 720,
      activo: true,
    });
    expect(typeof d.precioMensual).toBe("string");
  });

  it("acepta precioAnual nulo y maxUsuarios nulo (ilimitado, D1)", () => {
    expect(ok(schema, con({ precioAnual: null }))).toBe(true);
    expect(ok(schema, con({ maxUsuarios: null }))).toBe(true);
  });

  it("acepta los 5 planes sembrados de 01 §3", () => {
    const sembrados = [
      { codigo: "prueba", nombre: "Prueba", precioMensual: "0", precioAnual: null, maxRucs: 5, maxUsuarios: 1, precioRucExtra: "0", maxRucsExtra: 0, frecuenciaBuzonMin: 1440 },
      { codigo: "independiente", nombre: "Independiente", precioMensual: "99", precioAnual: "990", maxRucs: 30, maxUsuarios: 2, precioRucExtra: "4", maxRucsExtra: 6, frecuenciaBuzonMin: 1440 },
      { codigo: "estudio_pro", nombre: "Estudio Pro", precioMensual: "599", precioAnual: "5990", maxRucs: 300, maxUsuarios: 15, precioRucExtra: "4", maxRucsExtra: 60, frecuenciaBuzonMin: 240 },
      { codigo: "corporativo", nombre: "Corporativo", precioMensual: "1200", precioAnual: null, maxRucs: 600, maxUsuarios: null, precioRucExtra: "4", maxRucsExtra: 120, frecuenciaBuzonMin: 60 },
    ];
    for (const p of sembrados) {
      expect(ok(schema, { ...base, ...p }), p.codigo).toBe(true);
    }
  });

  describe("precios (decimal como cadena, 2 decimales, sin notacion cientifica)", () => {
    it.each(["0", "0.5", "12", "12.3", "12.34", "999999999999.99", "99"])(
      "precioMensual %j se acepta",
      (v) => {
        expect(ok(schema, con({ precioMensual: v }))).toBe(true);
      },
    );

    it.each([
      ["-1", "negativo"],
      ["-0.01", "negativo con decimales"],
      ["1.234", "mas de 2 decimales"],
      ["0.001", "mas de 2 decimales (milesimas)"],
      ["1e3", "notacion cientifica"],
      ["1E3", "notacion cientifica mayuscula"],
      ["1e-2", "notacion cientifica negativa"],
      ["0x10", "hexadecimal"],
      ["", "vacio"],
      [" 5", "espacio inicial"],
      ["5 ", "espacio final"],
      ["5.", "punto sin decimales"],
      [".5", "sin parte entera"],
      ["1,5", "coma decimal"],
      ["NaN", "NaN"],
      ["Infinity", "Infinity"],
      ["1234567890123", "13 digitos enteros"],
      ["1234567890123.00", "13 digitos enteros con decimales"],
    ])("precioMensual %j se rechaza (%s)", (v) => {
      expect(ok(schema, con({ precioMensual: v }))).toBe(false);
    });

    it.each([5, 0, 99.5, Number.POSITIVE_INFINITY, Number.NaN])(
      "un number (%s) nunca es precio valido: el dinero va como cadena",
      (v) => {
        expect(ok(schema, con({ precioMensual: v }))).toBe(false);
        expect(ok(schema, con({ precioAnual: v }))).toBe(false);
        expect(ok(schema, con({ precioRucExtra: v }))).toBe(false);
      },
    );

    it.each(["precioAnual", "precioRucExtra"] as const)(
      "%s aplica las mismas reglas",
      (campo) => {
        expect(ok(schema, con({ [campo]: "10.50" }))).toBe(true);
        expect(ok(schema, con({ [campo]: "10.505" }))).toBe(false);
        expect(ok(schema, con({ [campo]: "-1" }))).toBe(false);
        expect(ok(schema, con({ [campo]: "1e2" }))).toBe(false);
      },
    );

    it("precioMensual es obligatorio y no admite nulo", () => {
      expect(ok(schema, sin(base, "precioMensual"))).toBe(false);
      expect(ok(schema, con({ precioMensual: null }))).toBe(false);
    });
  });

  describe("limites enteros (CA-1)", () => {
    it.each([0, -1, 1.5, Number.NaN, "5", null])(
      "maxRucs %j se rechaza (limite en 0, negativo, decimal o no numerico)",
      (v) => {
        expect(ok(schema, con({ maxRucs: v, maxRucsExtra: 0 }))).toBe(false);
      },
    );

    it("maxRucs = 1 es el minimo valido", () => {
      expect(ok(schema, con({ maxRucs: 1, maxRucsExtra: 0 }))).toBe(true);
    });

    it.each([0, -1, 1.5, "5"])("maxUsuarios %j se rechaza", (v) => {
      expect(ok(schema, con({ maxUsuarios: v }))).toBe(false);
    });

    it("maxUsuarios = 1 es valido y null significa sin limite", () => {
      expect(ok(schema, con({ maxUsuarios: 1 }))).toBe(true);
      expect(datos(schema, con({ maxUsuarios: null })).maxUsuarios).toBeNull();
    });

    it.each([0, -1, 1.5, "5", null])(
      "frecuenciaBuzonMin %j se rechaza",
      (v) => {
        expect(ok(schema, con({ frecuenciaBuzonMin: v }))).toBe(false);
      },
    );

    it("frecuenciaBuzonMin = 1 es valido", () => {
      expect(ok(schema, con({ frecuenciaBuzonMin: 1 }))).toBe(true);
    });

    it.each([-1, 1.5, "2", null])("maxRucsExtra %j se rechaza", (v) => {
      expect(ok(schema, con({ maxRucsExtra: v }))).toBe(false);
    });
  });

  describe("tope de adicionales: maxRucsExtra * 5 <= maxRucs (20 %)", () => {
    it.each([
      [100, 20, true],
      [100, 21, false],
      [100, 0, true],
      [5, 1, true],
      [5, 2, false],
      [4, 1, false],
      [30, 6, true],
      [30, 7, false],
      [600, 120, true],
      [600, 121, false],
    ] as const)("maxRucs=%i maxRucsExtra=%i -> %s", (maxRucs, maxRucsExtra, valido) => {
      expect(ok(schema, con({ maxRucs, maxRucsExtra }))).toBe(valido);
    });

    it("el error senala el campo maxRucsExtra", () => {
      const r = (
        schema as unknown as {
          safeParse: (v: unknown) => {
            success: boolean;
            error?: { issues: { path: (string | number)[] }[] };
          };
        }
      ).safeParse(con({ maxRucs: 100, maxRucsExtra: 21 }));
      expect(r.success).toBe(false);
      expect(
        r.error?.issues.some((i) => i.path.includes("maxRucsExtra")),
      ).toBe(true);
    });
  });

  describe("codigo y nombre", () => {
    it("rechaza codigo y nombre vacios o ausentes", () => {
      expect(ok(schema, con({ codigo: "" }))).toBe(false);
      expect(ok(schema, con({ nombre: "" }))).toBe(false);
      expect(ok(schema, sin(base, "codigo"))).toBe(false);
      expect(ok(schema, sin(base, "nombre"))).toBe(false);
    });

    it("rechaza codigo y nombre que no son cadena", () => {
      expect(ok(schema, con({ codigo: 5 }))).toBe(false);
      expect(ok(schema, con({ nombre: { a: 1 } }))).toBe(false);
    });
  });

  describe("features (objeto JSON de hasta 4 kB)", () => {
    it("acepta un objeto vacio y uno anidado pequeno", () => {
      expect(ok(schema, con({ features: {} }))).toBe(true);
      expect(
        ok(schema, con({ features: { sire: true, buzon: { min: 60 }, lista: [1, 2] } })),
      ).toBe(true);
    });

    it.each([
      ["arreglo", []],
      ["cadena", "x"],
      ["numero", 5],
      ["nulo", null],
      ["booleano", true],
    ])("rechaza features que es %s", (_n, v) => {
      expect(ok(schema, con({ features: v }))).toBe(false);
    });

    it("rechaza un features grande (mas de 4 kB serializado)", () => {
      expect(ok(schema, con({ features: { nota: "a".repeat(5_000) } }))).toBe(
        false,
      );
      const muchas: Record<string, number> = {};
      for (let i = 0; i < 600; i++) muchas[`clave_${i}`] = i;
      expect(ok(schema, con({ features: muchas }))).toBe(false);
    });

    it("acepta un features de unos 3 kB", () => {
      expect(ok(schema, con({ features: { nota: "a".repeat(3_000) } }))).toBe(
        true,
      );
    });
  });

  describe("claves desconocidas descartadas", () => {
    it("no deja pasar id, tenantId, createdAt ni claves arbitrarias", () => {
      const d = datos(
        schema,
        con({
          id: "0190a000-0000-7000-8000-0000000000aa",
          tenantId: "0190a000-0000-7000-8000-0000000000bb",
          createdAt: "2026-01-01",
          admin: true,
          __proto__: { x: 1 },
        }),
      );
      expect(Object.keys(d).sort()).toEqual(
        [
          "activo",
          "codigo",
          "features",
          "frecuenciaBuzonMin",
          "maxRucs",
          "maxRucsExtra",
          "maxUsuarios",
          "nombre",
          "precioAnual",
          "precioMensual",
          "precioRucExtra",
        ].sort(),
      );
    });
  });

  it("rechaza lo que no es un objeto", () => {
    for (const v of [null, undefined, "plan", 5, []]) {
      expect(ok(schema, v)).toBe(false);
    }
  });
});

describe("activo en crear y editar (PUT = reemplazo completo)", () => {
  it("planCrearSchema: activo es opcional y vale true por defecto", () => {
    expect(datos(planCrearSchema, sin(base, "activo")).activo).toBe(true);
    expect(datos(planCrearSchema, con({ activo: false })).activo).toBe(false);
  });

  it("planEditarSchema: activo es obligatorio y booleano", () => {
    expect(ok(planEditarSchema, sin(base, "activo"))).toBe(false);
    expect(ok(planEditarSchema, con({ activo: "si" }))).toBe(false);
    expect(ok(planEditarSchema, con({ activo: false }))).toBe(true);
  });
});

describe("suscripcionAsignarSchema", () => {
  const PLAN = "0190a000-0000-7000-8000-0000000000aa";

  it("acepta { planId, rucsExtraContratados } y descarta tenantId y claves extra", () => {
    const d = datos(suscripcionAsignarSchema, {
      planId: PLAN,
      rucsExtraContratados: 3,
      tenantId: "0190a000-0000-7000-8000-0000000000bb",
      estado: "activa",
    });
    expect(d).toEqual({ planId: PLAN, rucsExtraContratados: 3 });
  });

  it("rucsExtraContratados = 0 es valido", () => {
    expect(
      ok(suscripcionAsignarSchema, { planId: PLAN, rucsExtraContratados: 0 }),
    ).toBe(true);
  });

  it.each([-1, 1.5, "2", null, Number.NaN])(
    "rucsExtraContratados %j se rechaza",
    (v) => {
      expect(
        ok(suscripcionAsignarSchema, { planId: PLAN, rucsExtraContratados: v }),
      ).toBe(false);
    },
  );

  it.each(["", "no-es-uuid", 5, null, undefined])("planId %j se rechaza", (v) => {
    expect(
      ok(suscripcionAsignarSchema, { planId: v, rucsExtraContratados: 0 }),
    ).toBe(false);
  });
});

describe("registroSolicitudSchema (POST /registro)", () => {
  const val = {
    estudio: "Estudio Contable San Juan",
    ruc: "20123456789",
    nombre: "Ana Torres",
    correo: "ana@estudio.pe",
  };

  it("acepta los cuatro campos", () => {
    expect(datos(registroSolicitudSchema, val)).toEqual(val);
  });

  it("el RUC del estudio es opcional", () => {
    expect(ok(registroSolicitudSchema, sin(val, "ruc"))).toBe(true);
  });

  it.each(["2012345678", "201234567890", "2012345678a", "20 123456789", "", "abcdefghijk", "２０１２３４５６７８９"])(
    "RUC %j se rechaza (deben ser 11 digitos ASCII)",
    (ruc) => {
      expect(ok(registroSolicitudSchema, { ...val, ruc })).toBe(false);
    },
  );

  it("descarta plan, rol, tenantId y cualquier clave extra (CA-11: nada de eso viaja por el cuerpo)", () => {
    const d = datos(registroSolicitudSchema, {
      ...val,
      plan: "corporativo",
      rol: "dueno",
      tenantId: "0190a000-0000-7000-8000-0000000000bb",
      planId: "0190a000-0000-7000-8000-0000000000aa",
    });
    expect(Object.keys(d).sort()).toEqual(
      ["correo", "estudio", "nombre", "ruc"].sort(),
    );
  });

  it("rechaza estudio, nombre o correo ausentes, vacios o que no son cadena", () => {
    for (const campo of ["estudio", "nombre", "correo"] as const) {
      expect(ok(registroSolicitudSchema, { ...val, [campo]: "" })).toBe(false);
      expect(ok(registroSolicitudSchema, { ...val, [campo]: 5 })).toBe(false);
      expect(ok(registroSolicitudSchema, sin(val, campo))).toBe(false);
    }
  });

  it("rechaza longitudes enormes (estudio y nombre hasta 200, correo hasta 320)", () => {
    expect(ok(registroSolicitudSchema, { ...val, estudio: "a".repeat(200) })).toBe(true);
    expect(ok(registroSolicitudSchema, { ...val, estudio: "a".repeat(201) })).toBe(false);
    expect(ok(registroSolicitudSchema, { ...val, nombre: "a".repeat(200) })).toBe(true);
    expect(ok(registroSolicitudSchema, { ...val, nombre: "a".repeat(201) })).toBe(false);
    expect(ok(registroSolicitudSchema, { ...val, correo: `${"a".repeat(321)}@x.pe` })).toBe(false);
  });
});

describe("esquemas de token del registro", () => {
  it("registroConsultarSchema y registroConfirmarConSesionSchema: solo { token }", () => {
    for (const schema of [registroConsultarSchema, registroConfirmarConSesionSchema]) {
      expect(datos(schema, { token: "abc", correo: "otro@x.pe", tenantId: "x" })).toEqual({
        token: "abc",
      });
      expect(ok(schema, {})).toBe(false);
      expect(ok(schema, { token: 5 })).toBe(false);
    }
  });

  it("registroConfirmarSchema: { token, contrasena } y descarta lo demas", () => {
    expect(
      datos(registroConfirmarSchema, { token: "abc", contrasena: "canario-no-real", rol: "dueno" }),
    ).toEqual({ token: "abc", contrasena: "canario-no-real" });
    expect(ok(registroConfirmarSchema, { token: "abc" })).toBe(false);
    expect(ok(registroConfirmarSchema, { contrasena: "x" })).toBe(false);
    expect(ok(registroConfirmarSchema, { token: "abc", contrasena: 5 })).toBe(false);
  });
});
