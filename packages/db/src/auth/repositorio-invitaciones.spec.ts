// Spec 005 (T2, rojo): las tres funciones de invitación en AuthRepo, sin BD (tx falsa). El comportamiento de
// las funciones SQL está en tests/aislamiento/acceso-funciones.spec.ts. Contrato (T7): `crearAuthRepo(tx)` suma
//   invitacionVigente(tokenHash)                           -> { estudioNombre, correo, rol, cuentaExiste } | null
//   invitacionAceptarNueva(tokenHash, nombre, hash)        -> 'aceptada' | 'cuenta_existe' | 'invalida'
//   invitacionAceptarExistente(tokenHash, tokenHashSesion) -> { tenantId, estudioNombre } | null
// con el mismo patrón de 004: SQL estático `select * from auth.<función>(...)`, parámetros posicionales, cero filas
// -> null (excepto la aceptación nueva, que siempre devuelve un texto) y todo error de pg -> AuthRepoError con solo el SQLSTATE.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthRepoError } from "./errores";
import { crearAuthRepo, type AuthRepo, type TxConsulta } from "./repositorio";

const T = "01920000-0000-7000-8000-0000000000a1";
const TOKEN = Buffer.alloc(32, 5);
const SESION = Buffer.alloc(32, 6);
const PHC = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
const CORREO = "invitada@ejemplo.test";

type R = AuthRepo & {
  invitacionVigente(h: Buffer): Promise<unknown>;
  invitacionAceptarNueva(h: Buffer, nombre: string, hash: string): Promise<unknown>;
  invitacionAceptarExistente(h: Buffer, s: Buffer): Promise<unknown>;
};

function txFalso(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { repo: crearAuthRepo(tx) as R, llamadas };
}

interface Caso {
  metodo: string;
  funcion: string;
  llamar: (r: R) => Promise<unknown>;
  valores: unknown[];
  filas: unknown[];
  esperado: unknown;
}

const casos: Caso[] = [
  {
    metodo: "invitacionVigente (con cuenta)",
    funcion: "invitacion_vigente",
    llamar: (r) => r.invitacionVigente(TOKEN),
    valores: [TOKEN],
    filas: [{ estudio_nombre: "Estudio Uno", correo: CORREO, rol: "asistente", cuenta_existe: true }],
    esperado: { estudioNombre: "Estudio Uno", correo: CORREO, rol: "asistente", cuentaExiste: true },
  },
  {
    metodo: "invitacionVigente (sin cuenta)",
    funcion: "invitacion_vigente",
    llamar: (r) => r.invitacionVigente(TOKEN),
    valores: [TOKEN],
    filas: [{ estudio_nombre: "Estudio Uno", correo: CORREO, rol: "lectura", cuenta_existe: false }],
    esperado: { estudioNombre: "Estudio Uno", correo: CORREO, rol: "lectura", cuentaExiste: false },
  },
  {
    metodo: "invitacionVigente (cero filas)",
    funcion: "invitacion_vigente",
    llamar: (r) => r.invitacionVigente(TOKEN),
    valores: [TOKEN],
    filas: [],
    esperado: null,
  },
  ...(["aceptada", "cuenta_existe", "invalida"] as const).map(
    (v): Caso => ({
      metodo: `invitacionAceptarNueva (${v})`,
      funcion: "invitacion_aceptar_nueva",
      llamar: (r) => r.invitacionAceptarNueva(TOKEN, "Persona Nueva", PHC),
      valores: [TOKEN, "Persona Nueva", PHC],
      filas: [{ invitacion_aceptar_nueva: v }],
      esperado: v,
    }),
  ),
  {
    metodo: "invitacionAceptarExistente",
    funcion: "invitacion_aceptar_existente",
    llamar: (r) => r.invitacionAceptarExistente(TOKEN, SESION),
    valores: [TOKEN, SESION],
    filas: [{ tenant_id: T, estudio_nombre: "Estudio Uno" }],
    esperado: { tenantId: T, estudioNombre: "Estudio Uno" },
  },
  {
    metodo: "invitacionAceptarExistente (cero filas)",
    funcion: "invitacion_aceptar_existente",
    llamar: (r) => r.invitacionAceptarExistente(TOKEN, SESION),
    valores: [TOKEN, SESION],
    filas: [],
    esperado: null,
  },
];

describe("AuthRepo (005): funciones de invitación", () => {
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

  it("el AuthRepo sigue exponiendo las funciones de 004 (no se pierde ninguna)", () => {
    const { repo } = txFalso([]);
    for (const m of [
      "limiteConsumir",
      "loginPreparar",
      "loginExito",
      "sesionValidar",
      "sesionRotar",
      "sesionRevocar",
      "sesionesCerrarTodas",
      "ultimoEstudio",
      "recuperacionCrear",
      "recuperacionVigente",
      "recuperacionConsumir",
      "contrasenaCambiar",
    ]) {
      expect(typeof (repo as unknown as Record<string, unknown>)[m], m).toBe("function");
    }
  });
});

describe("AuthRepo (005): errores de pg de las funciones de invitación -> AuthRepoError con solo el SQLSTATE", () => {
  const CANARIO = "CANARIO-INVITACION-7c1e";
  const errorPg = () =>
    Object.assign(new Error(`violación ${CANARIO}`), {
      code: "23505",
      detail: `Key (token_hash)=(${CANARIO})`,
      where: CANARIO,
      constraint: CANARIO,
      table: CANARIO,
      column: CANARIO,
    });
  const repoQueFalla = () =>
    crearAuthRepo({
      query: async () => {
        throw errorPg();
      },
    } as unknown as TxConsulta) as R;

  it.each(casos.filter((c, i, a) => a.findIndex((x) => x.funcion === c.funcion) === i))(
    "$metodo: relanza AuthRepoError con codigo y sin rastro del error original",
    async (c) => {
      const e = (await c.llamar(repoQueFalla()).catch((x: unknown) => x)) as Error & { codigo: string };
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e.codigo).toBe("23505");
      for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) {
        expect(e, campo).not.toHaveProperty(campo);
      }
      const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
      expect(volcado).not.toContain(CANARIO);
    },
  );
});
