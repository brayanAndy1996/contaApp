import { describe, expect, it } from "vitest";
import { PERMISOS, type Permiso } from "../acceso/index.js";
import {
  CODIGOS_ERROR_SEGURIDAD,
  FACTORES_SESION,
  codigoRecuperacionSchema,
  codigoTotpSchema,
  codigosRecuperacionRespuestaSchema,
  confirmarTotpSchema,
  desactivarTotpSchema,
  enrolarTotpRespuestaSchema,
  enrolarTotpSchema,
  errorSeguridadSchema,
  estadoFactorSchema,
  factorExigido,
  loginSegundoFactorRespuestaSchema,
  regenerarRecuperacionSchema,
  sesionCuentaSchema,
  sesionesCuentaRespuestaSchema,
  verificarSegundoFactorSchema,
} from "./seguridad.js";
import { CASOS_FACTOR_EXIGIDO } from "./factor-exigido.casos.js";

// Spec 029 (plan: Contratos: Shared). Contrato de `packages/shared/src/auth/seguridad.ts`:
//   codigoTotpSchema                  string ^\d{6}$
//   codigoRecuperacionSchema          string ^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$ (base32, 60 bits)
//   enrolarTotpSchema                 { contrasena: string }
//   confirmarTotpSchema               { codigo: codigoTotp }
//   desactivarTotpSchema              { contrasena: string, codigo: codigoTotp }
//   regenerarRecuperacionSchema       { contrasena: string, codigo: codigoTotp }
//   verificarSegundoFactorSchema      { codigo } | { codigoRecuperacion } (exactamente uno; sin claves extra)
//   enrolarTotpRespuestaSchema        { uri: «otpauth://totp/…» }
//   codigosRecuperacionRespuestaSchema{ codigosRecuperacion: 10 × codigoRecuperacion }
//   FACTORES_SESION                   ["pendiente", "verificado", "sin_factor"]
//   estadoFactorSchema                { factor, totpActivo: boolean, factorExigido: boolean } (se suma a GET /auth/sesion)
//   loginSegundoFactorRespuestaSchema { segundoFactor: true, estudioActivo: null }
//   sesionCuentaSchema                { id: uuid, creadaEn: ISO, ultimoUso: ISO, dispositivo: string ≤ 60, ip: string | null, actual: boolean }
//                                     (estricto: sin hash ni token); sesionesCuentaRespuestaSchema = array de ellas
//   CODIGOS_ERROR_SEGURIDAD           ["codigo_invalido", "segundo_factor_requerido", "totp_exigido"]; errorSeguridadSchema = { codigo } estricto
//   factorExigido({ plataforma, rolSistema, permisos }): boolean   // U1–U2, tabla común CASOS_FACTOR_EXIGIDO
const UUID = "7b9f0a52-3c1e-4d6a-9a43-5f0c2b7e8d11";
const ISO = "2026-11-25T15:00:00.000Z";
const CODIGO_REC = "ABCD-EFGH-2345";

describe("codigoTotpSchema", () => {
  it.each([["000000"], ["123456"], ["081804"], ["999999"]])(
    "acepta %s",
    (v) => {
      expect(codigoTotpSchema.safeParse(v).success).toBe(true);
    },
  );

  it.each([
    [""],
    ["12345"],
    ["1234567"],
    [" 123456"],
    ["123456 "],
    ["123456\n"],
    ["12345a"],
    ["12 456"],
    ["١٢٣٤٥٦"],
    ["+12345"],
    ["1e5000"],
  ])("rechaza %j", (v) => {
    expect(codigoTotpSchema.safeParse(v).success).toBe(false);
  });

  it.each([[123456], [null], [undefined], [["123456"]]])(
    "rechaza un valor que no es cadena (%j)",
    (v) => {
      expect(codigoTotpSchema.safeParse(v).success).toBe(false);
    },
  );
});

describe("codigoRecuperacionSchema", () => {
  it.each([[CODIGO_REC], ["AAAA-BBBB-CCCC"], ["2222-7777-ZZZZ"]])(
    "acepta %s",
    (v) => {
      expect(codigoRecuperacionSchema.safeParse(v).success).toBe(true);
    },
  );

  it.each([
    [""],
    ["ABCDEFGH2345"],
    ["ABCD-EFGH-234"],
    ["ABCD-EFGH-23456"],
    ["abcd-efgh-2345"],
    ["ABCD-EFGH-2341"], // 1 no es base32
    ["ABCD-EFGH-2340"], // 0 no es base32
    ["ABCD-EFGH-2348"], // 8 no es base32
    ["ABCD-EFGH-2349"],
    ["ABCD_EFGH_2345"],
    [" ABCD-EFGH-2345"],
    ["ABCD-EFGH-2345\n"],
    ["ABCD-EFGH-2345-ABCD"],
  ])("rechaza %j", (v) => {
    expect(codigoRecuperacionSchema.safeParse(v).success).toBe(false);
  });
});

describe("cuerpos de petición", () => {
  it("enrolarTotpSchema pide la contraseña actual como cadena", () => {
    expect(enrolarTotpSchema.safeParse({ contrasena: "x" }).success).toBe(true);
    expect(enrolarTotpSchema.safeParse({}).success).toBe(false);
    expect(enrolarTotpSchema.safeParse({ contrasena: 123 }).success).toBe(
      false,
    );
  });

  it("confirmarTotpSchema pide un código TOTP de 6 dígitos", () => {
    expect(confirmarTotpSchema.safeParse({ codigo: "123456" }).success).toBe(
      true,
    );
    expect(confirmarTotpSchema.safeParse({ codigo: "12345" }).success).toBe(
      false,
    );
    expect(confirmarTotpSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["desactivarTotpSchema", desactivarTotpSchema],
    ["regenerarRecuperacionSchema", regenerarRecuperacionSchema],
  ])("%s pide contraseña y código TOTP, ambos", (_n, esquema) => {
    expect(
      esquema.safeParse({ contrasena: "x", codigo: "123456" }).success,
    ).toBe(true);
    expect(esquema.safeParse({ contrasena: "x" }).success).toBe(false);
    expect(esquema.safeParse({ codigo: "123456" }).success).toBe(false);
    expect(
      esquema.safeParse({ contrasena: "x", codigo: "abcdef" }).success,
    ).toBe(false);
  });

  describe("verificarSegundoFactorSchema (exactamente uno)", () => {
    it("acepta un código TOTP", () => {
      expect(
        verificarSegundoFactorSchema.safeParse({ codigo: "123456" }).success,
      ).toBe(true);
    });
    it("acepta un código de recuperación", () => {
      expect(
        verificarSegundoFactorSchema.safeParse({
          codigoRecuperacion: CODIGO_REC,
        }).success,
      ).toBe(true);
    });
    it("rechaza ambos a la vez, ninguno y claves extra", () => {
      expect(
        verificarSegundoFactorSchema.safeParse({
          codigo: "123456",
          codigoRecuperacion: CODIGO_REC,
        }).success,
      ).toBe(false);
      expect(verificarSegundoFactorSchema.safeParse({}).success).toBe(false);
      expect(
        verificarSegundoFactorSchema.safeParse({ codigo: "123456", otro: 1 })
          .success,
      ).toBe(false);
    });
    it("rechaza formatos inválidos de cada variante", () => {
      expect(
        verificarSegundoFactorSchema.safeParse({ codigo: "12345" }).success,
      ).toBe(false);
      expect(
        verificarSegundoFactorSchema.safeParse({
          codigoRecuperacion: "abcd-efgh-2345",
        }).success,
      ).toBe(false);
    });
  });
});

describe("respuestas", () => {
  it("enrolarTotpRespuestaSchema: solo un URI otpauth://totp/", () => {
    const uri =
      "otpauth://totp/ContApp:ana%40estudio.pe?secret=GEZDGNBVGY3TQOJQ&issuer=ContApp";
    expect(enrolarTotpRespuestaSchema.safeParse({ uri }).success).toBe(true);
    expect(
      enrolarTotpRespuestaSchema.safeParse({ uri: "https://evil.pe" }).success,
    ).toBe(false);
    expect(enrolarTotpRespuestaSchema.safeParse({}).success).toBe(false);
  });

  it("codigosRecuperacionRespuestaSchema: exactamente 10 códigos válidos", () => {
    const diez = Array.from(
      { length: 10 },
      (_, i) => `AAAA-BBBB-CC${String.fromCharCode(65 + i)}${(i % 6) + 2}`,
    );
    expect(
      codigosRecuperacionRespuestaSchema.safeParse({
        codigosRecuperacion: diez,
      }).success,
    ).toBe(true);
    expect(
      codigosRecuperacionRespuestaSchema.safeParse({
        codigosRecuperacion: diez.slice(0, 9),
      }).success,
    ).toBe(false);
    expect(
      codigosRecuperacionRespuestaSchema.safeParse({
        codigosRecuperacion: [...diez, CODIGO_REC],
      }).success,
    ).toBe(false);
    expect(
      codigosRecuperacionRespuestaSchema.safeParse({
        codigosRecuperacion: [...diez.slice(0, 9), "malo"],
      }).success,
    ).toBe(false);
  });

  it("FACTORES_SESION y estadoFactorSchema (se suma a GET /auth/sesion)", () => {
    expect([...FACTORES_SESION]).toEqual([
      "pendiente",
      "verificado",
      "sin_factor",
    ]);
    expect(
      estadoFactorSchema.safeParse({
        factor: "verificado",
        totpActivo: true,
        factorExigido: false,
      }).success,
    ).toBe(true);
    expect(
      estadoFactorSchema.safeParse({
        factor: "sin_factor",
        totpActivo: false,
        factorExigido: true,
      }).success,
    ).toBe(true);
    expect(
      estadoFactorSchema.safeParse({
        factor: "otro",
        totpActivo: true,
        factorExigido: false,
      }).success,
    ).toBe(false);
    expect(
      estadoFactorSchema.safeParse({
        factor: "verificado",
        totpActivo: "si",
        factorExigido: false,
      }).success,
    ).toBe(false);
  });

  it("loginSegundoFactorRespuestaSchema: { segundoFactor: true, estudioActivo: null }", () => {
    expect(
      loginSegundoFactorRespuestaSchema.safeParse({
        segundoFactor: true,
        estudioActivo: null,
      }).success,
    ).toBe(true);
    expect(
      loginSegundoFactorRespuestaSchema.safeParse({
        segundoFactor: false,
        estudioActivo: null,
      }).success,
    ).toBe(false);
    expect(
      loginSegundoFactorRespuestaSchema.safeParse({
        segundoFactor: true,
        estudioActivo: UUID,
      }).success,
    ).toBe(false);
  });

  describe("sesionCuentaSchema (CA-5: sin hashes ni tokens)", () => {
    const valida = {
      id: UUID,
      creadaEn: ISO,
      ultimoUso: ISO,
      dispositivo: "Chrome en Windows",
      ip: "203.0.113.0/24",
      actual: true,
    };

    it("acepta una sesión completa y una sin IP", () => {
      expect(sesionCuentaSchema.safeParse(valida).success).toBe(true);
      expect(
        sesionCuentaSchema.safeParse({ ...valida, ip: null, actual: false })
          .success,
      ).toBe(true);
    });

    it("rechaza id que no es uuid, fechas inválidas, dispositivo de más de 60 y tipos erróneos", () => {
      expect(sesionCuentaSchema.safeParse({ ...valida, id: "1" }).success).toBe(
        false,
      );
      expect(
        sesionCuentaSchema.safeParse({ ...valida, creadaEn: "ayer" }).success,
      ).toBe(false);
      expect(
        sesionCuentaSchema.safeParse({ ...valida, dispositivo: "x".repeat(61) })
          .success,
      ).toBe(false);
      expect(
        sesionCuentaSchema.safeParse({ ...valida, actual: "si" }).success,
      ).toBe(false);
    });

    it("es estricta: una respuesta con token o hash no pasa", () => {
      expect(
        sesionCuentaSchema.safeParse({ ...valida, tokenHash: "abc" }).success,
      ).toBe(false);
      expect(
        sesionCuentaSchema.safeParse({ ...valida, token: "abc" }).success,
      ).toBe(false);
    });

    it("la lista es un arreglo de sesiones (puede estar vacío)", () => {
      expect(sesionesCuentaRespuestaSchema.safeParse([]).success).toBe(true);
      expect(
        sesionesCuentaRespuestaSchema.safeParse([
          valida,
          {
            ...valida,
            id: "7b9f0a52-3c1e-4d6a-9a43-5f0c2b7e8d12",
            actual: false,
          },
        ]).success,
      ).toBe(true);
      expect(
        sesionesCuentaRespuestaSchema.safeParse([{ ...valida, id: 5 }]).success,
      ).toBe(false);
    });
  });
});

describe("códigos de error", () => {
  it("son los tres nuevos de 029 (demasiados_intentos y credenciales_invalidas ya existen en 004)", () => {
    expect([...CODIGOS_ERROR_SEGURIDAD].sort()).toEqual([
      "codigo_invalido",
      "segundo_factor_requerido",
      "totp_exigido",
    ]);
  });

  it("el cuerpo es solo { codigo }", () => {
    for (const codigo of CODIGOS_ERROR_SEGURIDAD) {
      expect(errorSeguridadSchema.safeParse({ codigo }).success).toBe(true);
    }
    expect(errorSeguridadSchema.safeParse({ codigo: "otro" }).success).toBe(
      false,
    );
    expect(
      errorSeguridadSchema.safeParse({
        codigo: "codigo_invalido",
        detalle: "x",
      }).success,
    ).toBe(false);
  });
});

describe("factorExigido (U1–U2) sobre la tabla común CASOS_FACTOR_EXIGIDO", () => {
  it("la tabla cubre U1 y U2: super-admin, Dueño, Administrador, cada permiso de U2 y roles sin ellos", () => {
    const hay = (f: (c: (typeof CASOS_FACTOR_EXIGIDO)[number]) => boolean) =>
      CASOS_FACTOR_EXIGIDO.some(f);
    expect(hay((c) => c.plataforma)).toBe(true);
    expect(hay((c) => c.rolSistema === "dueno" && c.exigido)).toBe(true);
    expect(hay((c) => c.rolSistema === "admin" && c.exigido)).toBe(true);
    for (const p of [
      "usuarios.gestionar",
      "roles.gestionar",
      "plan.gestionar",
      "credenciales.editar",
    ] as const) {
      expect(
        hay(
          (c) =>
            c.rolSistema === null &&
            !c.plataforma &&
            c.permisos.includes(p) &&
            c.exigido,
        ),
      ).toBe(true);
    }
    for (const r of ["contador", "asistente", "lectura"] as const) {
      expect(
        hay((c) => c.rolSistema === r && !c.plataforma && !c.exigido),
      ).toBe(true);
    }
    expect(
      hay(
        (c) =>
          c.rolSistema === null &&
          !c.plataforma &&
          c.permisos.length === 0 &&
          !c.exigido,
      ),
    ).toBe(true);
    expect(hay((c) => !c.exigido)).toBe(true);
    expect(hay((c) => c.exigido)).toBe(true);
  });

  it("los nombres de los casos son únicos y los permisos pertenecen al catálogo de 005", () => {
    const nombres = CASOS_FACTOR_EXIGIDO.map((c) => c.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
    const catalogo = new Set<string>(PERMISOS);
    for (const c of CASOS_FACTOR_EXIGIDO)
      for (const p of c.permisos) expect(catalogo.has(p)).toBe(true);
  });

  it.each(CASOS_FACTOR_EXIGIDO.map((c) => [c.nombre, c] as const))(
    "%s",
    (_n, c) => {
      expect(
        factorExigido({
          plataforma: c.plataforma,
          rolSistema: c.rolSistema,
          permisos: c.permisos,
        }),
      ).toBe(c.exigido);
    },
  );

  it("un rol propio con cada permiso del catálogo por separado: solo los cuatro de U2 lo exigen", () => {
    const sensibles = new Set<Permiso>([
      "usuarios.gestionar",
      "roles.gestionar",
      "plan.gestionar",
      "credenciales.editar",
    ]);
    for (const p of PERMISOS) {
      expect(
        factorExigido({ plataforma: false, rolSistema: null, permisos: [p] }),
      ).toBe(sensibles.has(p));
    }
  });

  it("los permisos no se alteran ni se muta el arreglo recibido", () => {
    const permisos: readonly Permiso[] = Object.freeze([
      "clientes.ver",
      "credenciales.editar",
    ] as Permiso[]);
    expect(
      factorExigido({ plataforma: false, rolSistema: null, permisos }),
    ).toBe(true);
    expect(permisos).toEqual(["clientes.ver", "credenciales.editar"]);
  });
});
