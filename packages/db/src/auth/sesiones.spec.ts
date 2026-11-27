// Spec 029 (T1, rojo): SesionesRepo y las ampliaciones de AuthRepo (factor, dispositivo, red) sin BD (tx falsa). El comportamiento de las
// funciones SQL esta en tests/aislamiento/auth-sesiones.spec.ts y auth-totp-*.spec.ts.
// Contrato (lo implementa T5): `crearSesionesRepo(tx)` en `./sesiones.ts` (listar, revocar, revocarOtras) y, en `crearAuthRepo`,
// `loginExito` con `factor?`, `dispositivo?`, `ipRed?` (10 parametros posicionales; por omision 'sin_factor', null, null) y
// `sesionValidar`/`sesionConsultar` con el campo `factor`.
// Rojo por: `./sesiones` no existe y AuthRepo aun no pasa/mapea el factor.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthRepoError } from "./errores";
import { crearAuthRepo, type TxConsulta } from "./repositorio";
import { crearSesionesRepo } from "./sesiones";

const U = "01920000-0000-7000-8000-0000000001a1";
const S = "01920000-0000-7000-8000-0000000009a1";
const S2 = "01920000-0000-7000-8000-0000000009a2";
const T = "01920000-0000-7000-8000-0000000000a1";
const K = Buffer.alloc(32, 3);
const T1 = Buffer.alloc(32, 1);
const T2 = Buffer.alloc(32, 2);
const F = new Date("2026-11-25T12:00:00.000Z");
const F2 = new Date("2026-11-25T11:00:00.000Z");
const PHC = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

function tx(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const t = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { t, llamadas };
}

describe("SesionesRepo.listar (CA-5)", () => {
  it("llama a auth.sesiones_listar con el token y mapea a camelCase sin tocar los valores", async () => {
    const { t, llamadas } = tx([
      { id: S, creada_en: F2, ultimo_uso: F, dispositivo: "Chrome en Windows", ip_red: "203.0.113.0/24", actual: true },
      { id: S2, creada_en: F2, ultimo_uso: F2, dispositivo: null, ip_red: null, actual: false },
    ]);
    const r = await crearSesionesRepo(t).listar(T1);
    expect(r).toEqual([
      { id: S, creadaEn: F2, ultimoUso: F, dispositivo: "Chrome en Windows", ipRed: "203.0.113.0/24", actual: true },
      { id: S2, creadaEn: F2, ultimoUso: F2, dispositivo: null, ipRed: null, actual: false },
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/auth\.sesiones_listar\s*\(/);
    expect(llamadas[0]!.valores).toEqual([T1]);
  });

  it("sin filas devuelve una lista vacia; el resultado nunca lleva hashes ni tokens", async () => {
    expect(await crearSesionesRepo(tx([]).t).listar(T1)).toEqual([]);
    const { t } = tx([{ id: S, creada_en: F, ultimo_uso: F, dispositivo: null, ip_red: null, actual: true, token_hash: T1 }]);
    const [fila] = await crearSesionesRepo(t).listar(T1);
    expect(Object.keys(fila!).sort()).toEqual(["actual", "creadaEn", "dispositivo", "id", "ipRed", "ultimoUso"]);
  });
});

describe("SesionesRepo.revocar y revocarOtras", () => {
  it("revocar llama a auth.sesion_revocar_id (token, id) y no devuelve nada", async () => {
    const { t, llamadas } = tx([{ sesion_revocar_id: null }]);
    expect(await crearSesionesRepo(t).revocar(T1, S)).toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(/auth\.sesion_revocar_id\s*\(/);
    expect(llamadas[0]!.valores).toEqual([T1, S]);
  });

  it("revocarOtras llama a auth.sesiones_revocar_otras y devuelve la cuenta como number", async () => {
    const { t, llamadas } = tx([{ sesiones_revocar_otras: 3 }]);
    expect(await crearSesionesRepo(t).revocarOtras(T1)).toBe(3);
    expect(llamadas[0]!.texto).toMatch(/auth\.sesiones_revocar_otras\s*\(/);
    expect(llamadas[0]!.valores).toEqual([T1]);
  });

  it("el SQL es estatico: ningun valor se interpola", async () => {
    const a = tx([{ sesion_revocar_id: null }]);
    await crearSesionesRepo(a.t).revocar(T1, S);
    expect(a.llamadas[0]!.texto).not.toContain(S);
    expect(a.llamadas[0]!.texto).toMatch(/\$1/);
    expect(a.llamadas[0]!.texto).toMatch(/\$2/);
  });
});

describe("SesionesRepo: errores de pg se reducen a AuthRepoError con solo el SQLSTATE (CA-6)", () => {
  const CANARIO = "CANARIO-SESION-029";
  const falla = () =>
    crearSesionesRepo({
      query: async () => {
        throw Object.assign(new Error(CANARIO), { code: "42501", detail: CANARIO, where: CANARIO });
      },
    } as unknown as TxConsulta);

  it.each([
    ["listar", (r: ReturnType<typeof falla>) => r.listar(T1)],
    ["revocar", (r: ReturnType<typeof falla>) => r.revocar(T1, S)],
    ["revocarOtras", (r: ReturnType<typeof falla>) => r.revocarOtras(T1)],
  ])("%s: AuthRepoError con el SQLSTATE y sin el texto original", async (_n, f) => {
    const e = (await f(falla()).catch((x: unknown) => x)) as AuthRepoError;
    expect(e).toBeInstanceOf(AuthRepoError);
    expect(e.codigo).toBe("42501");
    expect(`${e.message}${e.stack}${JSON.stringify(e)}${inspect(e, { depth: 6, showHidden: true })}`).not.toContain(CANARIO);
  });
});

describe("AuthRepo.loginExito con factor, dispositivo y red (CA-2, U6)", () => {
  const base = { clave: K, usuarioId: U, hashVerificado: PHC, tokenHash: T1, tenantActivo: null, hashNuevo: null, tokenAnteriorHash: null };

  it("pasa los 10 parametros en el orden del contrato: los 7 de 0013, factor, dispositivo y red", async () => {
    const { t, llamadas } = tx([{ sesion_id: S, expira_absoluta: F }]);
    const r = await crearAuthRepo(t).loginExito({ ...base, tenantActivo: T, tokenAnteriorHash: T2, factor: "pendiente", dispositivo: "Firefox en Linux", ipRed: "203.0.113.0/24" });
    expect(r).toEqual({ sesionId: S, expiraAbsoluta: F });
    expect(llamadas[0]!.texto).toMatch(/auth\.login_exito\s*\(/);
    expect(llamadas[0]!.valores).toEqual([K, U, PHC, T1, T, null, T2, "pendiente", "Firefox en Linux", "203.0.113.0/24"]);
  });

  it("sin los campos nuevos usa 'sin_factor', null y null (las llamadas de 004 no cambian de significado)", async () => {
    const { t, llamadas } = tx([{ sesion_id: S, expira_absoluta: F }]);
    await crearAuthRepo(t).loginExito(base);
    expect(llamadas[0]!.valores).toEqual([K, U, PHC, T1, null, null, null, "sin_factor", null, null]);
  });
});

describe("AuthRepo.sesionValidar / sesionConsultar devuelven el factor (D2)", () => {
  it.each(["sesionValidar", "sesionConsultar"] as const)("%s mapea `factor` junto a lo de 004", async (metodo) => {
    for (const factor of ["pendiente", "verificado", "sin_factor"] as const) {
      const { t } = tx([{ sesion_id: S, usuario_id: U, tenant_activo: null, estudio_revocado: false, expira_absoluta: F, factor }]);
      expect(await crearAuthRepo(t)[metodo](T1)).toEqual({
        sesionId: S,
        usuarioId: U,
        tenantActivo: null,
        estudioRevocado: false,
        expiraAbsoluta: F,
        factor,
      });
    }
  });

  it.each(["sesionValidar", "sesionConsultar"] as const)("%s: un factor desconocido de la BD falla cerrado (no se deja pasar como verificado)", async (metodo) => {
    const { t } = tx([{ sesion_id: S, usuario_id: U, tenant_activo: null, estudio_revocado: false, expira_absoluta: F, factor: "otro" }]);
    const r = await crearAuthRepo(t)[metodo](T1).then(
      (v) => v,
      (e: unknown) => e,
    );
    const ok = r instanceof Error || (r as { factor?: string } | null)?.factor === "sin_factor";
    expect(ok, "debe lanzar o degradar a sin_factor, nunca devolver 'otro' ni 'verificado'").toBe(true);
  });
});
