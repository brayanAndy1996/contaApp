// Spec 004 (T5, rojo): AuthRepo y AuthRepoError sin BD (tx falsa). El comportamiento de las funciones SQL
// está en tests/aislamiento/auth-funciones.spec.ts. Contrato (T9): `crearAuthRepo(tx)` devuelve un AuthRepo
// cuyos métodos ejecutan SQL estático `select * from auth.<función>(...)` con parámetros posicionales,
// mapean las columnas de salida del plan a camelCase, devuelven null con cero filas y reducen todo error
// de pg a AuthRepoError con solo el SQLSTATE.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthRepoError } from "./errores";
import { crearAuthRepo, type AuthRepo, type TxConsulta } from "./repositorio";

const U = "01920000-0000-7000-8000-0000000001a1";
const S = "01920000-0000-7000-8000-0000000009a1";
const T = "01920000-0000-7000-8000-0000000000a1";
const K = Buffer.alloc(32, 3);
const T1 = Buffer.alloc(32, 1);
const T2 = Buffer.alloc(32, 2);
const T3 = Buffer.alloc(32, 4);
const F = new Date("2026-10-26T12:00:00.000Z");
const PHC = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
const PHC_VIEJO = "$argon2id$v=19$m=8192,t=2,p=1$c2FsdA$dmllam8"; // el verificado (0010, O-1)
const CORREO = "titular@ejemplo.test";
type ErrorAuth = Error & { codigo: string };

function txFalso(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { repo: crearAuthRepo(tx), llamadas };
}

interface Caso {
  metodo: string;
  funcion: string;
  llamar: (r: AuthRepo) => Promise<unknown>;
  valores: unknown[];
  filas: unknown[];
  esperado: unknown;
}

const casos: Caso[] = [
  {
    metodo: "limiteConsumir (true)",
    funcion: "limite_consumir",
    llamar: (r) => r.limiteConsumir("login_ip", "203.0.113.7"),
    valores: ["login_ip", "203.0.113.7"],
    filas: [{ limite_consumir: true }],
    esperado: true,
  },
  {
    metodo: "limiteConsumir (false)",
    funcion: "limite_consumir",
    llamar: (r) => r.limiteConsumir("recup_correo", "k"),
    valores: ["recup_correo", "k"],
    filas: [{ limite_consumir: false }],
    esperado: false,
  },
  {
    metodo: "loginPreparar (con hash)",
    funcion: "login_preparar",
    llamar: (r) => r.loginPreparar(CORREO, K),
    valores: [CORREO, K],
    filas: [{ permitido: true, usuario_id: U, hash: PHC, alcanza_bloqueo: false }],
    esperado: { permitido: true, usuarioId: U, hash: PHC, alcanzaBloqueo: false },
  },
  {
    metodo: "loginPreparar (bloqueado)",
    funcion: "login_preparar",
    llamar: (r) => r.loginPreparar(CORREO, K),
    valores: [CORREO, K],
    filas: [{ permitido: false, usuario_id: null, hash: null, alcanza_bloqueo: false }],
    esperado: { permitido: false, usuarioId: null, hash: null, alcanzaBloqueo: false },
  },
  {
    metodo: "loginExito",
    funcion: "login_exito",
    llamar: (r) =>
      r.loginExito({
        clave: K,
        usuarioId: U,
        hashVerificado: PHC_VIEJO,
        tokenHash: T1,
        tenantActivo: T,
        hashNuevo: PHC,
        tokenAnteriorHash: T2,
      }),
    valores: [K, U, PHC_VIEJO, T1, T, PHC, T2],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "loginExito (sin estudio ni cookie previa)",
    funcion: "login_exito",
    llamar: (r) =>
      r.loginExito({
        clave: K,
        usuarioId: U,
        hashVerificado: PHC,
        tokenHash: T1,
        tenantActivo: null,
        hashNuevo: null,
        tokenAnteriorHash: null,
      }),
    valores: [K, U, PHC, T1, null, null, null],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "loginExito (cero filas: sin membresía o credencial cambiada, O-1)",
    funcion: "login_exito",
    llamar: (r) =>
      r.loginExito({
        clave: K,
        usuarioId: U,
        hashVerificado: PHC_VIEJO,
        tokenHash: T1,
        tenantActivo: T,
        hashNuevo: null,
        tokenAnteriorHash: null,
      }),
    valores: [K, U, PHC_VIEJO, T1, T, null, null],
    filas: [],
    esperado: null,
  },
  {
    metodo: "sesionValidar (vigente)",
    funcion: "sesion_validar",
    llamar: (r) => r.sesionValidar(T1),
    valores: [T1],
    filas: [{ sesion_id: S, usuario_id: U, tenant_activo: T, estudio_revocado: false, expira_absoluta: F }],
    esperado: { sesionId: S, usuarioId: U, tenantActivo: T, estudioRevocado: false, expiraAbsoluta: F },
  },
  {
    metodo: "sesionValidar (estudio revocado)",
    funcion: "sesion_validar",
    llamar: (r) => r.sesionValidar(T1),
    valores: [T1],
    filas: [{ sesion_id: S, usuario_id: U, tenant_activo: null, estudio_revocado: true, expira_absoluta: F }],
    esperado: { sesionId: S, usuarioId: U, tenantActivo: null, estudioRevocado: true, expiraAbsoluta: F },
  },
  {
    metodo: "sesionValidar (cero filas)",
    funcion: "sesion_validar",
    llamar: (r) => r.sesionValidar(T1),
    valores: [T1],
    filas: [],
    esperado: null,
  },
  {
    metodo: "sesionRotar",
    funcion: "sesion_rotar",
    llamar: (r) => r.sesionRotar(T1, T2, T),
    valores: [T1, T2, T],
    filas: [{ sesion_id: S, expira_absoluta: F }],
    esperado: { sesionId: S, expiraAbsoluta: F },
  },
  {
    metodo: "sesionRotar (cero filas)",
    funcion: "sesion_rotar",
    llamar: (r) => r.sesionRotar(T1, T2, T),
    valores: [T1, T2, T],
    filas: [],
    esperado: null,
  },
  {
    metodo: "sesionRevocar",
    funcion: "sesion_revocar",
    llamar: (r) => r.sesionRevocar(T1),
    valores: [T1],
    filas: [{ sesion_revocar: null }],
    esperado: undefined,
  },
  {
    metodo: "sesionesCerrarTodas",
    funcion: "sesiones_cerrar_todas",
    llamar: (r) => r.sesionesCerrarTodas(T1),
    valores: [T1],
    filas: [{ sesiones_cerrar_todas: 3 }],
    esperado: 3,
  },
  {
    metodo: "ultimoEstudio",
    funcion: "ultimo_estudio",
    llamar: (r) => r.ultimoEstudio(T1),
    valores: [T1],
    filas: [{ ultimo_estudio: T }],
    esperado: T,
  },
  {
    metodo: "ultimoEstudio (NULL)",
    funcion: "ultimo_estudio",
    llamar: (r) => r.ultimoEstudio(T1),
    valores: [T1],
    filas: [{ ultimo_estudio: null }],
    esperado: null,
  },
  {
    metodo: "recuperacionCrear (true)",
    funcion: "recuperacion_crear",
    llamar: (r) => r.recuperacionCrear(CORREO, T1),
    valores: [CORREO, T1],
    filas: [{ recuperacion_crear: true }],
    esperado: true,
  },
  {
    metodo: "recuperacionCrear (false)",
    funcion: "recuperacion_crear",
    llamar: (r) => r.recuperacionCrear(CORREO, T1),
    valores: [CORREO, T1],
    filas: [{ recuperacion_crear: false }],
    esperado: false,
  },
  {
    metodo: "limiteConsumir (restab_ip)",
    funcion: "limite_consumir",
    llamar: (r) => r.limiteConsumir("restab_ip", "203.0.113.9"),
    valores: ["restab_ip", "203.0.113.9"],
    filas: [{ limite_consumir: true }],
    esperado: true,
  },
  {
    metodo: "recuperacionVigente (true)",
    funcion: "recuperacion_vigente",
    llamar: (r) => r.recuperacionVigente(T1),
    valores: [T1],
    filas: [{ recuperacion_vigente: true }],
    esperado: true,
  },
  {
    metodo: "recuperacionVigente (false)",
    funcion: "recuperacion_vigente",
    llamar: (r) => r.recuperacionVigente(T2),
    valores: [T2],
    filas: [{ recuperacion_vigente: false }],
    esperado: false,
  },
  {
    metodo: "recuperacionConsumir",
    funcion: "recuperacion_consumir",
    llamar: (r) => r.recuperacionConsumir(T1, PHC),
    valores: [T1, PHC],
    filas: [{ usuario_id: U, correo: CORREO }],
    esperado: { usuarioId: U, correo: CORREO },
  },
  {
    metodo: "recuperacionConsumir (cero filas)",
    funcion: "recuperacion_consumir",
    llamar: (r) => r.recuperacionConsumir(T1, PHC),
    valores: [T1, PHC],
    filas: [],
    esperado: null,
  },
  {
    metodo: "contrasenaCambiar",
    funcion: "contrasena_cambiar",
    llamar: (r) => r.contrasenaCambiar(T1, PHC, T3),
    valores: [T1, PHC, T3],
    filas: [{ contrasena_cambiar: CORREO }],
    esperado: CORREO,
  },
  {
    metodo: "contrasenaCambiar (cero filas)",
    funcion: "contrasena_cambiar",
    llamar: (r) => r.contrasenaCambiar(T1, PHC, T3),
    valores: [T1, PHC, T3],
    filas: [],
    esperado: null,
  },
];

describe("AuthRepo: una función TS por función SQL auth.*", () => {
  it.each(casos)("$metodo: llama a auth.$funcion con los parámetros en orden y mapea el resultado", async (c) => {
    const { repo, llamadas } = txFalso(c.filas);
    expect(await c.llamar(repo)).toEqual(c.esperado);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(new RegExp(`auth\\.${c.funcion}\\s*\\(`));
    expect(llamadas[0]!.valores).toEqual(c.valores);
  });

  it.each(casos)("$metodo: el SQL es estático (ningún valor se interpola en el texto)", async (c) => {
    const { repo, llamadas } = txFalso(c.filas);
    await c.llamar(repo);
    const texto = llamadas[0]!.texto;
    for (const v of c.valores) {
      if (typeof v === "string" && v.length > 0) expect(texto).not.toContain(v);
    }
    expect(texto).toMatch(/\$1/);
  });
});

describe("AuthRepo: errores de pg se reducen a AuthRepoError con solo el SQLSTATE (CA-10)", () => {
  const CANARIO = "CANARIO-DETALLE-9f3a";
  const errorPg = () =>
    Object.assign(new Error(`permiso denegado ${CANARIO}`), {
      code: "42501",
      detail: `Key (hash)=(${CANARIO})`,
      where: CANARIO,
      constraint: CANARIO,
      table: CANARIO,
      column: CANARIO,
    });

  function repoQueFalla(error: unknown) {
    return crearAuthRepo({
      query: async () => {
        throw error;
      },
    } as unknown as TxConsulta);
  }

  it.each(casos.filter((c, i, a) => a.findIndex((x) => x.funcion === c.funcion) === i))(
    "$metodo: relanza AuthRepoError con codigo y sin rastro del error original",
    async (c) => {
      const e = (await c.llamar(repoQueFalla(errorPg())).catch((x: unknown) => x)) as ErrorAuth;
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e).toBeInstanceOf(Error);
      expect(e.codigo).toBe("42501");
      for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) {
        expect(e, campo).not.toHaveProperty(campo);
      }
      const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
      expect(volcado).not.toContain(CANARIO);
    },
  );

  it("un error sin SQLSTATE válido da codigo 'desconocido'", async () => {
    for (const malo of [new Error("x"), { code: "abc" }, { code: 42501 }, { code: "42501x" }, null, "texto"]) {
      const e = (await repoQueFalla(malo)
        .limiteConsumir("login_ip", "s")
        .catch((x: unknown) => x)) as ErrorAuth;
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e.codigo).toBe("desconocido");
    }
  });
});

describe("AuthRepoError.desde", () => {
  it("conserva el SQLSTATE, nombra la clase y no filtra campos de pg", () => {
    const e = AuthRepoError.desde({ code: "23514", detail: "CANARIO", message: "CANARIO" });
    expect(e).toBeInstanceOf(AuthRepoError);
    expect(e.name).toBe("AuthRepoError");
    expect(e.codigo).toBe("23514");
    expect(e.message).not.toContain("CANARIO");
    expect(Object.keys(e).sort()).toEqual(["codigo"]);
  });

  it.each([undefined, null, "42501", 42501, {}, { code: "" }, { code: "abcde" }, { code: "4250" }, { code: "425012" }])(
    "una entrada sin SQLSTATE válido (%j) da 'desconocido'",
    (entrada) => {
      expect(AuthRepoError.desde(entrada).codigo).toBe("desconocido");
    },
  );
});
