import { describe, expect, it } from "vitest";
import {
  ajustesEnOrden,
  atributosEnOrden,
  repararRolLogin,
  SQL_REPARAR_AJUSTES,
  SQL_REPARAR_ATRIBUTOS,
  type AtributosRol,
  type FilaAjuste,
} from "./reparar-rol";

const ATR_OK: AtributosRol = {
  rolsuper: false,
  rolinherit: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolcanlogin: true,
  rolreplication: false,
  rolbypassrls: false,
  rolconnlimit: -1,
  rolvaliduntil: null,
};
const AJ_OK: FilaAjuste[] = [{ setdatabase: 0, setconfig: ["lc_messages=C"] }];

function clienteFalso(atr: AtributosRol | null, ajustes: FilaAjuste[]) {
  const enviadas: string[] = [];
  return {
    enviadas,
    query: (async (text: string) => {
      if (text.includes("from pg_roles where rolname")) {
        return { rowCount: atr ? 1 : 0, rows: atr ? [atr] : [] };
      }
      if (text.includes("from pg_db_role_setting"))
        return { rowCount: ajustes.length, rows: ajustes };
      enviadas.push(text);
      return { rowCount: 0, rows: [] };
    }) as never,
  };
}

describe("ajustesEnOrden / atributosEnOrden", () => {
  it("acepta exactamente la configuración de 0000_roles", () => {
    expect(ajustesEnOrden(AJ_OK)).toBe(true);
    expect(atributosEnOrden(ATR_OK)).toBe(true);
    expect(atributosEnOrden({ ...ATR_OK, rolvaliduntil: "infinity" })).toBe(
      true,
    );
  });

  it("detecta ajustes alterados (role, row_security, IN DATABASE, ausentes) y atributos distintos", () => {
    expect(
      ajustesEnOrden([
        {
          setdatabase: 0,
          setconfig: ["lc_messages=C", "role=contapp_platform"],
        },
      ]),
    ).toBe(false);
    expect(
      ajustesEnOrden([
        ...AJ_OK,
        { setdatabase: 16384, setconfig: ["row_security=off"] },
      ]),
    ).toBe(false);
    expect(ajustesEnOrden([])).toBe(false);
    expect(
      ajustesEnOrden([{ setdatabase: 16384, setconfig: ["lc_messages=C"] }]),
    ).toBe(false);
    expect(atributosEnOrden({ ...ATR_OK, rolconnlimit: 0 })).toBe(false);
    expect(
      atributosEnOrden({ ...ATR_OK, rolvaliduntil: "2026-01-01 00:00:00+00" }),
    ).toBe(false);
    expect(atributosEnOrden({ ...ATR_OK, rolinherit: true })).toBe(false);
  });
});

describe("repararRolLogin", () => {
  it("no altera nada si la configuración está en orden (idempotente)", async () => {
    const c = clienteFalso(ATR_OK, AJ_OK);
    expect(await repararRolLogin(c)).toEqual({
      ajustes: "sin cambios",
      atributos: "sin cambios",
    });
    expect(c.enviadas).toEqual([]);
  });

  it("repara ajustes y atributos alterados con sentencias fijas", async () => {
    const c = clienteFalso({ ...ATR_OK, rolconnlimit: 0 }, [
      { setdatabase: 0, setconfig: ["lc_messages=C", "statement_timeout=1"] },
    ]);
    expect(await repararRolLogin(c)).toEqual({
      ajustes: "reparados",
      atributos: "reparados",
    });
    expect(c.enviadas).toEqual([SQL_REPARAR_ATRIBUTOS, SQL_REPARAR_AJUSTES]);
    expect(SQL_REPARAR_AJUSTES).toContain("IN DATABASE %I RESET ALL");
  });

  it("falla con mensaje fijo si el rol no existe", async () => {
    await expect(repararRolLogin(clienteFalso(null, []))).rejects.toThrow(
      /no existe el rol contapp_app/,
    );
  });
});
