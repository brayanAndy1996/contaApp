import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CryptoError,
  IntegridadError,
  KekDesconocidaError,
  KeyProviderError,
  MockKeyProvider as MockWrapper,
  SecretoInvalidoError,
  SobreInvalidoError,
  cifrarCredencial,
  crearKeyWrapper,
  type KeyWrapper,
  type Sobre,
} from "./index";
import {
  MockKeyProvider as MockCompleto,
  Secreto,
  crearKeyUnwrapper,
  descifrarSobre,
} from "./descifrado";
import {
  CANARIO_CLAVE,
  CANARIO_USUARIO,
  TENANT_B,
  VALOR_SIRE,
  VALOR_SOL,
  borrarDir,
  crearDirTemporal,
  ctxSire,
  ctxSol,
  esperarFalla,
  huellasDeFuga,
  voltearBit,
} from "./soporte-pruebas";

// CA-9 (sin fugas, RNF-004): ni el canario, ni la DEK, ni el material de llave aparecen en logs,
// message/stack/cause, JSON.stringify/util.inspect de errores, sobres y Secreto.
const ENV_MOCK = { KEY_PROVIDER: "mock" };
const FIXTURE_PRIVADA = resolve(
  __dirname,
  "..",
  "fixtures",
  "mock-kek",
  "SOLO-PRUEBAS-kek-mock-private.pem",
);

const deks: Buffer[] = [];
const logs: string[] = [];
let prohibidos: string[] = [];
let dir: string;
let sobre: Sobre;
let sobreSire: Sobre;

/** Wrapper del mock real que además anota cada DEK recibida. */
function wrapperQueAnotaDeks(): KeyWrapper {
  const real = crearKeyWrapper(ENV_MOCK);
  return {
    kekId: real.kekId,
    verificar: () => real.verificar(),
    wrap: (dek) => {
      deks.push(Buffer.from(dek));
      return real.wrap(dek);
    },
  };
}

function representaciones(valor: unknown): string[] {
  const textos: string[] = [];
  const intentar = (f: () => string | undefined) => {
    try {
      const r = f();
      if (typeof r === "string") textos.push(r);
    } catch {
      /* una forma que no se puede serializar no filtra nada */
    }
  };
  intentar(() => JSON.stringify(valor));
  intentar(() => inspect(valor, { depth: null, showHidden: true }));
  intentar(() => inspect(valor));
  intentar(() => String(valor));
  intentar(() => `${valor as string}`);
  if (valor instanceof Error) {
    textos.push(valor.message, String(valor.stack ?? ""));
    intentar(() => inspect(valor.cause, { depth: null, showHidden: true }));
    intentar(() => JSON.stringify(Object.getOwnPropertyNames(valor)));
    intentar(() =>
      JSON.stringify(valor, Object.getOwnPropertyNames(valor) as string[]),
    );
  }
  return textos;
}

function afirmarLimpio(valor: unknown, etiqueta: string) {
  for (const texto of representaciones(valor)) {
    for (const p of prohibidos) {
      expect(texto.includes(p), `${etiqueta} filtra material sensible`).toBe(
        false,
      );
    }
  }
}

function afirmarErrorLimpio(error: Error, etiqueta: string) {
  afirmarLimpio(error, etiqueta);
  if (error instanceof CryptoError) {
    // contrato: mensaje fijo, sin valores ni cause externo
    expect(error.cause, `${etiqueta}: cause`).toBeUndefined();
  }
}

beforeAll(async () => {
  dir = await crearDirTemporal();
  for (const metodo of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, metodo).mockImplementation((...args: unknown[]) => {
      logs.push(
        args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "),
      );
    });
  }
  vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    logs.push(String(c));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    logs.push(String(c));
    return true;
  }) as never);

  sobre = await cifrarCredencial(wrapperQueAnotaDeks(), ctxSol(), VALOR_SOL);
  sobreSire = await cifrarCredencial(
    wrapperQueAnotaDeks(),
    ctxSire(),
    VALOR_SIRE,
  );

  const pem = readFileSync(FIXTURE_PRIVADA, "utf8");
  const lineas = pem
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !l.startsWith("-----"));
  const cuerpo = lineas.join("");
  prohibidos = [
    ...[
      CANARIO_USUARIO,
      CANARIO_CLAVE,
      VALOR_SIRE.clientId,
      VALOR_SIRE.clientSecret,
    ].flatMap((c) => huellasDeFuga(c)),
    ...deks.flatMap((d) => huellasDeFuga(d)),
    ...lineas.slice(1, 4),
    cuerpo.slice(100, 180),
    ...huellasDeFuga(Buffer.from(cuerpo, "base64").subarray(30, 60)),
  ];
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (dir) await borrarDir(dir);
});

describe("CA-9 la preparación del escenario es válida", () => {
  it("se capturaron DEKs y se armó la lista de material prohibido", () => {
    expect(deks.length).toBeGreaterThanOrEqual(2);
    for (const d of deks) expect(d).toHaveLength(32);
    expect(prohibidos.length).toBeGreaterThan(20);
  });
});

describe("CA-9 errores del lado de cifrado", () => {
  it("secreto inválido con canario en el valor rechazado", async () => {
    const e1 = await esperarFalla(
      () =>
        cifrarCredencial(wrapperQueAnotaDeks(), ctxSol(), {
          usuario: CANARIO_USUARIO + "x".repeat(300),
          clave: CANARIO_CLAVE,
        }),
      SecretoInvalidoError,
    );
    afirmarLimpio(e1, "SecretoInvalidoError (largo)");
    const e2 = await esperarFalla(
      () =>
        cifrarCredencial(wrapperQueAnotaDeks(), ctxSol(), {
          usuario: CANARIO_USUARIO + "\uD800",
          clave: CANARIO_CLAVE,
        }),
      SecretoInvalidoError,
    );
    expect(e2.message).not.toContain(CANARIO_USUARIO);
    const e3 = await esperarFalla(
      () =>
        cifrarCredencial(wrapperQueAnotaDeks(), ctxSol(), {
          usuario: CANARIO_USUARIO,
          clave: "",
        }),
      SecretoInvalidoError,
    );
    expect(e3.message).not.toContain(CANARIO_USUARIO);
  });

  it.each(["error", "corrupta", "timeout"] as const)(
    "KeyProvider caído (%s) con canario en el secreto",
    async (falla) => {
      const e = await esperarFalla(
        () =>
          cifrarCredencial(
            new MockWrapper({ falla, plazoMs: 50 }),
            ctxSol(),
            VALOR_SOL,
          ),
        KeyProviderError,
      );
      afirmarErrorLimpio(e, `KeyProviderError(${falla})`);
    },
  );

  it("archivo de llave corrupto (la privada del fixture truncada) no vuelca material de llave", async () => {
    const pem = readFileSync(FIXTURE_PRIVADA, "utf8");
    const truncada = join(dir, "truncada.pem");
    await writeFile(truncada, pem.slice(0, Math.floor(pem.length / 2)));
    const e = await esperarFalla(
      () =>
        crearKeyUnwrapper({
          KEY_PROVIDER: "local",
          KEK_ID: "k1",
          KEK_PRIVATE_KEY_PATH: truncada,
        }).verificar(),
      KeyProviderError,
    );
    afirmarErrorLimpio(e, "KeyProviderError(llave corrupta)");
  });
});

describe("CA-9 errores del lado de descifrado", () => {
  const unwrapper = () => crearKeyUnwrapper(ENV_MOCK);

  it("integridad por tag, ciphertext, nonce, DEK y AAD alterados", async () => {
    const variantes: Array<[string, Sobre, Parameters<typeof ctxSol>[0]]> = [
      ["tag", { ...sobre, tag: voltearBit(sobre.tag, 0, 0) }, {}],
      [
        "ciphertext",
        { ...sobre, ciphertext: voltearBit(sobre.ciphertext, 0, 0) },
        {},
      ],
      ["nonce", { ...sobre, nonce: voltearBit(sobre.nonce, 0, 0) }, {}],
      [
        "dekEnvuelta",
        { ...sobre, dekEnvuelta: voltearBit(sobre.dekEnvuelta, 3, 1) },
        {},
      ],
      ["aad (tenant)", sobre, { tenantId: TENANT_B }],
    ];
    for (const [nombre, s, ctx] of variantes) {
      const e = await esperarFalla(
        () => descifrarSobre(unwrapper(), ctxSol(ctx), s),
        IntegridadError,
      );
      afirmarErrorLimpio(e, `IntegridadError(${nombre})`);
    }
  });

  it("sobre inválido (nonce de 5 B) y kekId desconocido", async () => {
    const e1 = await esperarFalla(
      () =>
        descifrarSobre(unwrapper(), ctxSol(), {
          ...sobre,
          nonce: Buffer.alloc(5),
        }),
      SobreInvalidoError,
    );
    afirmarErrorLimpio(e1, "SobreInvalidoError");
    const e2 = await esperarFalla(
      () => descifrarSobre(unwrapper(), ctxSol(), { ...sobre, kekId: "k9" }),
      KekDesconocidaError,
    );
    afirmarErrorLimpio(e2, "KekDesconocidaError");
  });

  it("proveedor caído al descifrar", async () => {
    const e = await esperarFalla(
      () =>
        descifrarSobre(
          new MockCompleto({ falla: "error", plazoMs: 50 }),
          ctxSol(),
          sobre,
        ),
      KeyProviderError,
    );
    afirmarErrorLimpio(e, "KeyProviderError(descifrar)");
  });
});

describe("CA-9 sobres y Secreto", () => {
  it("el sobre serializado e inspeccionado no contiene canario, DEK ni material de llave", () => {
    afirmarLimpio(sobre, "Sobre sol");
    afirmarLimpio(sobreSire, "Sobre sire_api");
  });

  it("Secreto: JSON.stringify, inspect, String y plantilla salen redactados", async () => {
    const secreto = await descifrarSobre(
      crearKeyUnwrapper(ENV_MOCK),
      ctxSol(),
      sobre,
    );
    expect(secreto).toBeInstanceOf(Secreto);
    expect(secreto.toJSON()).toBe("[REDACTADO]");
    expect(JSON.stringify(secreto)).toBe('"[REDACTADO]"');
    expect(JSON.stringify({ credencial: secreto, otro: [secreto] })).toBe(
      '{"credencial":"[REDACTADO]","otro":["[REDACTADO]"]}',
    );
    expect(inspect(secreto)).toContain("REDACTADO");
    expect(String(secreto)).toContain("REDACTADO");
    expect(`${secreto as unknown as string}`).toContain("REDACTADO");
    afirmarLimpio(secreto, "Secreto");
    afirmarLimpio({ dentro: { secreto } }, "objeto con Secreto");
  });

  it("Secreto.usar entrega el valor exacto y destruir() no rompe ni deja rastro serializable", async () => {
    const secreto = await descifrarSobre(
      crearKeyUnwrapper(ENV_MOCK),
      ctxSire(),
      sobreSire,
    );
    expect(secreto.usar((v) => v.clientId)).toBe(VALOR_SIRE.clientId);
    expect(secreto.usar((v) => v.clientSecret)).toBe(VALOR_SIRE.clientSecret);
    secreto.destruir();
    afirmarLimpio(secreto, "Secreto destruido");
  });
});

describe("CA-9 logs", () => {
  it("ningún log capturado durante cifrar, descifrar y errores contiene canario, DEK ni material de llave", async () => {
    // Un ciclo completo adicional bajo captura, incluyendo un fallo.
    const s = await cifrarCredencial(
      wrapperQueAnotaDeks(),
      ctxSol(),
      VALOR_SOL,
    );
    const secreto = await descifrarSobre(
      crearKeyUnwrapper(ENV_MOCK),
      ctxSol(),
      s,
    );
    secreto.usar((v) => v.usuario.length);
    await esperarFalla(
      () =>
        descifrarSobre(crearKeyUnwrapper(ENV_MOCK), ctxSol(), {
          ...s,
          tag: voltearBit(s.tag, 0, 0),
        }),
      IntegridadError,
    );
    const todo = logs.join("\n");
    for (const p of prohibidos) {
      expect(todo.includes(p), "los logs filtran material sensible").toBe(
        false,
      );
    }
    // las DEK capturadas en este ciclo también
    for (const d of deks) {
      for (const f of huellasDeFuga(d)) {
        expect(todo.includes(f), "los logs filtran una DEK").toBe(false);
      }
    }
  });
});
