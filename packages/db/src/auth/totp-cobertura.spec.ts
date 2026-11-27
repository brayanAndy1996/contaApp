// Spec 029 (T10a, CA-6): bordes de TotpRepo sin BD (tx falsa): paso fuera de rango, resultado de desactivar fuera de la lista (falla cerrado),
// cero filas y metodos sin resultado.
import { describe, expect, it } from "vitest";
import { AuthRepoError } from "./errores";
import type { TxConsulta } from "./repositorio";
import { crearTotpRepo } from "./totp";

const T1 = Buffer.alloc(32, 1);
const T2 = Buffer.alloc(32, 2);
const H = Buffer.alloc(32, 7);
const DIEZ = Array.from({ length: 10 }, (_, i) => Buffer.alloc(32, 100 + i));
const BIGINT_MAX = 9_223_372_036_854_775_807n;

function repoCon(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { repo: crearTotpRepo(tx), llamadas };
}

describe("TotpRepo: el paso TOTP fuera del rango de bigint se rechaza antes de consultar", () => {
  const llamadores: Array<[string, (r: ReturnType<typeof crearTotpRepo>, p: bigint) => Promise<unknown>]> = [
    ["verificarExito", (r, p) => r.verificarExito({ tokenHash: T1, paso: p, tokenHashNuevo: T2, tenantNuevo: null })],
    // Ajuste de 029 (T16, 0081): confirmar lleva el pendiente cifrado evaluado.
    ["confirmar", (r, p) => r.confirmar({ tokenHash: T1, paso: p, hashes: DIEZ, tokenHashNuevo: T2, pendienteCifrado: H })],
    ["desactivar", (r, p) => r.desactivar(T1, p)],
    ["recuperacionRegenerar", (r, p) => r.recuperacionRegenerar(T1, p, DIEZ)],
  ];

  it.each(llamadores)("%s: un paso negativo o mayor que el maximo da AuthRepoError 22023 y no llega a la BD", async (_n, llamar) => {
    for (const malo of [-1n, BIGINT_MAX + 1n]) {
      const { repo, llamadas } = repoCon([]);
      const e = (await llamar(repo, malo).catch((x: unknown) => x)) as AuthRepoError & { codigo: string };
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e.codigo).toBe("22023");
      expect(llamadas).toEqual([]);
    }
  });

  it.each(llamadores)("%s: un paso que no es bigint (number, texto) tambien se rechaza sin consultar", async (_n, llamar) => {
    for (const malo of [5, "5", null, undefined] as unknown as bigint[]) {
      const { repo, llamadas } = repoCon([]);
      const e = (await llamar(repo, malo).catch((x: unknown) => x)) as AuthRepoError & { codigo: string };
      expect(e).toBeInstanceOf(AuthRepoError);
      expect(e.codigo).toBe("22023");
      expect(llamadas).toEqual([]);
    }
  });

  it("los extremos validos (0 y el maximo) viajan como texto decimal", async () => {
    for (const ok of [0n, BIGINT_MAX]) {
      const { repo, llamadas } = repoCon([{ totp_desactivar: "desactivado" }]);
      await repo.desactivar(T1, ok);
      expect(llamadas[0]!.valores).toEqual([T1, ok.toString()]);
    }
  });
});

describe("TotpRepo.desactivar: falla cerrado", () => {
  it.each(["desactivado", "exigido", "invalido"])("devuelve %s tal cual lo entrega la BD", async (r) => {
    expect(await repoCon([{ totp_desactivar: r }]).repo.desactivar(T1, 1n)).toBe(r);
  });

  it.each([
    ["sin filas", []],
    ["columna ausente", [{}]],
    ["null", [{ totp_desactivar: null }]],
    ["texto fuera de la lista", [{ totp_desactivar: "ok" }]],
    ["booleano", [{ totp_desactivar: true }]],
    ["numero", [{ totp_desactivar: 1 }]],
  ])("%s: nunca se trata como 'desactivado', da 'invalido'", async (_n, filas) => {
    expect(await repoCon(filas).repo.desactivar(T1, 1n)).toBe("invalido");
  });
});

describe("TotpRepo.recuperacionRegenerar y leer: bordes", () => {
  it("sin filas, recuperacionRegenerar es false y solo un true estricto cuenta como exito", async () => {
    expect(await repoCon([]).repo.recuperacionRegenerar(T1, 1n, DIEZ)).toBe(false);
    expect(await repoCon([{ totp_recuperacion_regenerar: "t" }]).repo.recuperacionRegenerar(T1, 1n, DIEZ)).toBe(false);
    expect(await repoCon([{ totp_recuperacion_regenerar: true }]).repo.recuperacionRegenerar(T1, 1n, DIEZ)).toBe(true);
  });

  it("leer sin filas devuelve null", async () => {
    expect(await repoCon([]).repo.leer("01920000-0000-7000-8000-0000000001a1")).toBeNull();
  });

  it("leer con solo TOTP pendiente: versiones y cifrados activos quedan en null, la version llega como number", async () => {
    const F = new Date("2026-11-25T12:00:00.000Z");
    const r = await repoCon([
      { activo_cifrado: null, activo_version: null, pendiente_cifrado: H, pendiente_version: "4", pendiente_expira: F, ultimo_paso: "0", activado_en: null },
    ]).repo.leer("01920000-0000-7000-8000-0000000001a1");
    expect(r).toEqual({
      activoCifrado: null,
      activoVersion: null,
      pendienteCifrado: H,
      pendienteVersion: 4,
      pendienteExpira: F,
      ultimoPaso: 0n,
      activadoEn: null,
    });
  });

  it("leer con columnas ausentes (undefined) las normaliza a null", async () => {
    const r = await repoCon([{ activo_version: null, pendiente_version: null, ultimo_paso: "7" }]).repo.leer("01920000-0000-7000-8000-0000000001a1");
    expect(r).toMatchObject({ activoCifrado: null, pendienteCifrado: null, pendienteExpira: null, activadoEn: null, ultimoPaso: 7n });
  });
});

describe("TotpRepo.intentoAcierto e intentoReservar", () => {
  it("intentoAcierto llama a auth.totp_intento_acierto con el hash del token y no devuelve nada", async () => {
    const { repo, llamadas } = repoCon([{}]);
    expect(await repo.intentoAcierto(T1)).toBeUndefined();
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/auth\.\w*intento\w*acierto\w*\s*\(/);
    expect(llamadas[0]!.valores).toEqual([T1]);
  });

  it("intentoReservar sin filas devuelve null; con fila, permitido solo si es true estricto", async () => {
    expect(await repoCon([]).repo.intentoReservar(T1)).toBeNull();
    expect(await repoCon([{ permitido: "t", usuario_id: "u" }]).repo.intentoReservar(T1)).toEqual({ permitido: false, usuarioId: "u" });
    expect(await repoCon([{ permitido: true, usuario_id: "u" }]).repo.intentoReservar(T1)).toEqual({ permitido: true, usuarioId: "u" });
  });
});
