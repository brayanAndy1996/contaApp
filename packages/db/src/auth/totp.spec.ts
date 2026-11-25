// Spec 029 (T1, rojo): TotpRepo sin BD (tx falsa). El comportamiento de las funciones SQL esta en tests/aislamiento/auth-totp-*.spec.ts.
// Contrato (lo implementa T5 en `./totp.ts`): `crearTotpRepo(tx)` devuelve un TotpRepo cuyos metodos ejecutan SQL estatico
// `select * from auth.<funcion>(...)` con parametros posicionales en el orden del contrato (tests/aislamiento/auth-totp-soporte.ts), mapean
// las columnas a camelCase, devuelven null con cero filas y reducen todo error de pg a AuthRepoError con solo el SQLSTATE.
// Rojo por: `./totp` no existe.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthRepoError } from "./errores";
import type { TxConsulta } from "./repositorio";
import { crearTotpRepo, type TotpRepo } from "./totp";

const U = "01920000-0000-7000-8000-0000000001a1";
const S = "01920000-0000-7000-8000-0000000009a1";
const T = "01920000-0000-7000-8000-0000000000a1";
const T1 = Buffer.alloc(32, 1);
const T2 = Buffer.alloc(32, 2);
const H = Buffer.alloc(32, 7);
const DIEZ = Array.from({ length: 10 }, (_, i) => Buffer.alloc(32, 100 + i));
const CIFRADO = Buffer.from("cifrado-sintetico");
const F = new Date("2026-11-25T12:00:00.000Z");
const PASO = 59_000_001n;
type ErrorAuth = Error & { codigo: string };

function txFalso(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { repo: crearTotpRepo(tx), llamadas };
}

interface Caso {
  metodo: string;
  funcion: string;
  llamar: (r: TotpRepo) => Promise<unknown>;
  valores: unknown[];
  filas: unknown[];
  esperado: unknown;
}

const casos: Caso[] = [
  {
    metodo: "leer (activo y pendiente)",
    funcion: "totp_leer",
    llamar: (r) => r.leer(U),
    valores: [U],
    filas: [
      {
        activo_cifrado: CIFRADO,
        activo_version: 2,
        pendiente_cifrado: H,
        pendiente_version: 3,
        pendiente_expira: F,
        ultimo_paso: "59000000",
        activado_en: F,
      },
    ],
    esperado: {
      activoCifrado: CIFRADO,
      activoVersion: 2,
      pendienteCifrado: H,
      pendienteVersion: 3,
      pendienteExpira: F,
      ultimoPaso: 59_000_000n,
      activadoEn: F,
    },
  },
  {
    metodo: "leer (solo pendiente)",
    funcion: "totp_leer",
    llamar: (r) => r.leer(U),
    valores: [U],
    filas: [
      { activo_cifrado: null, activo_version: null, pendiente_cifrado: H, pendiente_version: 1, pendiente_expira: F, ultimo_paso: "0", activado_en: null },
    ],
    esperado: {
      activoCifrado: null,
      activoVersion: null,
      pendienteCifrado: H,
      pendienteVersion: 1,
      pendienteExpira: F,
      ultimoPaso: 0n,
      activadoEn: null,
    },
  },
  { metodo: "leer (cero filas)", funcion: "totp_leer", llamar: (r) => r.leer(U), valores: [U], filas: [], esperado: null },
  {
    metodo: "enrolarIniciar",
    funcion: "totp_enrolar_iniciar",
    llamar: (r) => r.enrolarIniciar(U, CIFRADO, 2),
    valores: [U, CIFRADO, 2],
    filas: [{ totp_enrolar_iniciar: F }],
    esperado: F,
  },
  {
    metodo: "intentoReservar (permitido)",
    funcion: "totp_intento_reservar",
    llamar: (r) => r.intentoReservar(T1),
    valores: [T1],
    filas: [{ permitido: true, usuario_id: U }],
    esperado: { permitido: true, usuarioId: U },
  },
  {
    metodo: "intentoReservar (bloqueado)",
    funcion: "totp_intento_reservar",
    llamar: (r) => r.intentoReservar(T1),
    valores: [T1],
    filas: [{ permitido: false, usuario_id: U }],
    esperado: { permitido: false, usuarioId: U },
  },
  { metodo: "intentoReservar (sesion no vigente)", funcion: "totp_intento_reservar", llamar: (r) => r.intentoReservar(T1), valores: [T1], filas: [], esperado: null },
  {
    metodo: "verificarExito",
    funcion: "totp_verificar_exito",
    llamar: (r) => r.verificarExito({ tokenHash: T1, paso: PASO, tokenHashNuevo: T2, tenantNuevo: T }),
    valores: [T1, PASO.toString(), T2, T],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "verificarExito (sin estudio)",
    funcion: "totp_verificar_exito",
    llamar: (r) => r.verificarExito({ tokenHash: T1, paso: PASO, tokenHashNuevo: T2, tenantNuevo: null }),
    valores: [T1, PASO.toString(), T2, null],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "verificarExito (replay: cero filas)",
    funcion: "totp_verificar_exito",
    llamar: (r) => r.verificarExito({ tokenHash: T1, paso: PASO, tokenHashNuevo: T2, tenantNuevo: T }),
    valores: [T1, PASO.toString(), T2, T],
    filas: [],
    esperado: null,
  },
  {
    metodo: "recuperacionUsar",
    funcion: "totp_recuperacion_usar",
    llamar: (r) => r.recuperacionUsar({ tokenHash: T1, hash: H, tokenHashNuevo: T2, tenantNuevo: T }),
    valores: [T1, H, T2, T],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "recuperacionUsar (cero filas)",
    funcion: "totp_recuperacion_usar",
    llamar: (r) => r.recuperacionUsar({ tokenHash: T1, hash: H, tokenHashNuevo: T2, tenantNuevo: null }),
    valores: [T1, H, T2, null],
    filas: [],
    esperado: null,
  },
  {
    metodo: "confirmar",
    funcion: "totp_confirmar",
    llamar: (r) => r.confirmar({ tokenHash: T1, paso: PASO, hashes: DIEZ, tokenHashNuevo: T2 }),
    valores: [T1, PASO.toString(), DIEZ, T2],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "confirmar (cero filas)",
    funcion: "totp_confirmar",
    llamar: (r) => r.confirmar({ tokenHash: T1, paso: PASO, hashes: DIEZ, tokenHashNuevo: T2 }),
    valores: [T1, PASO.toString(), DIEZ, T2],
    filas: [],
    esperado: null,
  },
  {
    metodo: "desactivar (desactivado)",
    funcion: "totp_desactivar",
    llamar: (r) => r.desactivar(T1, PASO),
    valores: [T1, PASO.toString()],
    filas: [{ totp_desactivar: "desactivado" }],
    esperado: "desactivado",
  },
  {
    metodo: "desactivar (exigido)",
    funcion: "totp_desactivar",
    llamar: (r) => r.desactivar(T1, PASO),
    valores: [T1, PASO.toString()],
    filas: [{ totp_desactivar: "exigido" }],
    esperado: "exigido",
  },
  {
    metodo: "desactivar (invalido)",
    funcion: "totp_desactivar",
    llamar: (r) => r.desactivar(T1, PASO),
    valores: [T1, PASO.toString()],
    filas: [{ totp_desactivar: "invalido" }],
    esperado: "invalido",
  },
  {
    metodo: "recuperacionRegenerar (true)",
    funcion: "totp_recuperacion_regenerar",
    llamar: (r) => r.recuperacionRegenerar(T1, PASO, DIEZ),
    valores: [T1, PASO.toString(), DIEZ],
    filas: [{ totp_recuperacion_regenerar: true }],
    esperado: true,
  },
  {
    metodo: "recuperacionRegenerar (false)",
    funcion: "totp_recuperacion_regenerar",
    llamar: (r) => r.recuperacionRegenerar(T1, PASO, DIEZ),
    valores: [T1, PASO.toString(), DIEZ],
    filas: [{ totp_recuperacion_regenerar: false }],
    esperado: false,
  },
];

describe("TotpRepo: una funcion TS por funcion SQL auth.totp_*", () => {
  it.each(casos)("$metodo: llama a auth.$funcion con los parametros en orden y mapea el resultado", async (c) => {
    const { repo, llamadas } = txFalso(c.filas);
    expect(await c.llamar(repo)).toEqual(c.esperado);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(new RegExp(`auth\\.${c.funcion}\\s*\\(`));
    expect(llamadas[0]!.valores).toEqual(c.valores);
  });

  it.each(casos)("$metodo: el SQL es estatico (ningun valor se interpola en el texto)", async (c) => {
    const { repo, llamadas } = txFalso(c.filas);
    await c.llamar(repo);
    const texto = llamadas[0]!.texto;
    for (const v of c.valores) {
      if (typeof v === "string" && v.length > 0) expect(texto).not.toContain(v);
    }
    expect(texto).toMatch(/\$1/);
  });

  it("ningun metodo envia un `number` o `bigint` como paso: va como texto decimal (el paso es un bigint de PostgreSQL)", async () => {
    for (const c of casos.filter((x) => /verificarExito|confirmar|desactivar|Regenerar/.test(x.metodo))) {
      const { repo, llamadas } = txFalso(c.filas);
      await c.llamar(repo);
      expect(llamadas[0]!.valores.some((v) => typeof v === "bigint" || typeof v === "number"), c.metodo).toBe(false);
    }
  });
});

describe("TotpRepo: el repositorio nunca descifra ni transforma el secreto", () => {
  it("leer devuelve los mismos Buffer que entrego la BD (el descifrado es del backend, D1)", async () => {
    const { repo } = txFalso([
      { activo_cifrado: CIFRADO, activo_version: 1, pendiente_cifrado: null, pendiente_version: null, pendiente_expira: null, ultimo_paso: "1", activado_en: F },
    ]);
    const r = (await repo.leer(U))!;
    expect(r.activoCifrado).toBe(CIFRADO);
  });
});

describe("TotpRepo: errores de pg se reducen a AuthRepoError con solo el SQLSTATE (CA-6)", () => {
  const CANARIO = "CANARIO-DETALLE-029-9f3a";
  const errorPg = () =>
    Object.assign(new Error(`violacion ${CANARIO}`), {
      code: "23505",
      detail: `Key (hash)=(\\x${CANARIO})`,
      where: CANARIO,
      constraint: CANARIO,
      table: CANARIO,
      column: CANARIO,
    });
  const repoQueFalla = (error: unknown) =>
    crearTotpRepo({
      query: async () => {
        throw error;
      },
    } as unknown as TxConsulta);

  it.each(casos.filter((c, i, a) => a.findIndex((x) => x.funcion === c.funcion) === i))(
    "$metodo: relanza AuthRepoError con codigo y sin rastro del error original",
    async (c) => {
      const e = (await c.llamar(repoQueFalla(errorPg())).catch((x: unknown) => x)) as ErrorAuth;
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e.codigo).toBe("23505");
      for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) expect(e, campo).not.toHaveProperty(campo);
      const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
      expect(volcado).not.toContain(CANARIO);
    },
  );

  it("un error sin SQLSTATE valido da codigo 'desconocido'", async () => {
    for (const malo of [new Error("x"), { code: "abc" }, null, "texto"]) {
      const e = (await repoQueFalla(malo).leer(U).catch((x: unknown) => x)) as ErrorAuth;
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e.codigo).toBe("desconocido");
    }
  });
});
