import { afterEach, describe, expect, it, vi } from "vitest";
import { generaVerificador, verificaPassword } from "../scram";
import { migrar, passwordDeDatabaseUrl, sincronizarPassword } from "./migrar";
import {
  SQL_REPARAR_AJUSTES,
  SQL_REPARAR_ATRIBUTOS,
  type AtributosRol,
  type FilaAjuste,
} from "./reparar-rol";

// Valores de prueba generados para esta suite; no son credenciales reales.
const PASSWORD = "Pw-de-prueba/9:Zq";
const OTRA_PASSWORD = "otra-clave-de-prueba";
const ITER = { iteraciones: 4096 };

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

interface Opciones {
  atr?: AtributosRol | null;
  ajustes?: FilaAjuste[];
  /** undefined = el rol no existe en pg_authid. */
  rolpassword?: string | null;
  /** Falla el ROLLBACK (la conexión ya está caída, por ejemplo). */
  fallaRollback?: boolean;
}

/** Cliente falso: guarda en orden todo lo enviado y simula un servidor con el rol de login. */
function clienteFalso(o: Opciones = {}) {
  const atr = o.atr === undefined ? ATR_OK : o.atr;
  const ajustes = o.ajustes ?? AJ_OK;
  const eventos: string[] = [];
  const parametros: unknown[][] = [];
  return {
    eventos,
    parametros,
    query: (async (text: string, values?: unknown[]) => {
      eventos.push(text);
      parametros.push(values ?? []);
      if (text.includes("from pg_roles where rolname")) {
        return { rowCount: atr ? 1 : 0, rows: atr ? [atr] : [] };
      }
      if (text.includes("from pg_db_role_setting")) {
        return { rowCount: ajustes.length, rows: ajustes };
      }
      if (text.includes("from pg_authid")) {
        return o.rolpassword === undefined
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ rolpassword: o.rolpassword }] };
      }
      if (text.startsWith("select format(")) {
        const [rol, verificador] = values as [string, string];
        return {
          rowCount: 1,
          rows: [
            { sentencia: `ALTER ROLE "${rol}" PASSWORD '${verificador}'` },
          ],
        };
      }
      if (text === "ROLLBACK" && o.fallaRollback) {
        throw new Error("conexion caida");
      }
      return { rowCount: 0, rows: [] };
    }) as never,
  };
}

/** Todo lo que el cliente recibió (texto y parámetros) como un solo texto. */
const todoLoEnviado = (c: ReturnType<typeof clienteFalso>) =>
  JSON.stringify([c.eventos, c.parametros]);

describe("passwordDeDatabaseUrl", () => {
  it("falla si DATABASE_URL falta o está vacía", () => {
    expect(() => passwordDeDatabaseUrl(undefined)).toThrow(
      "falta DATABASE_URL",
    );
    expect(() => passwordDeDatabaseUrl("")).toThrow("falta DATABASE_URL");
  });

  it("falla con mensaje fijo si no es una URL, sin repetir su contenido", () => {
    const texto = `no es url ${PASSWORD}`;
    expect(() => passwordDeDatabaseUrl(texto)).toThrow(
      "DATABASE_URL no es una URL valida",
    );
    try {
      passwordDeDatabaseUrl(texto);
    } catch (e) {
      expect((e as Error).message).not.toContain(PASSWORD);
    }
  });

  it("exige el usuario contapp_app y no revela la contraseña al rechazar otro", () => {
    const url = `postgresql://postgres:${encodeURIComponent(PASSWORD)}@localhost:5432/contapp`;
    expect(() => passwordDeDatabaseUrl(url)).toThrow(
      "DATABASE_URL debe conectar con el rol contapp_app",
    );
    try {
      passwordDeDatabaseUrl(url);
    } catch (e) {
      expect((e as Error).message).not.toContain(PASSWORD);
    }
  });

  it("exige contraseña", () => {
    expect(() =>
      passwordDeDatabaseUrl("postgresql://contapp_app@localhost:5432/contapp"),
    ).toThrow("DATABASE_URL no tiene contrasena");
    expect(() =>
      passwordDeDatabaseUrl("postgresql://contapp_app:@localhost:5432/contapp"),
    ).toThrow("DATABASE_URL no tiene contrasena");
  });

  it("devuelve la contraseña decodificada (caracteres reservados codificados)", () => {
    const url = `postgresql://contapp_app:${encodeURIComponent(PASSWORD)}@localhost:5432/contapp`;
    expect(passwordDeDatabaseUrl(url)).toBe(PASSWORD);
    expect(
      passwordDeDatabaseUrl("postgresql://contapp%5Fapp:p%40ss%2Fw%3Ard@h/db"),
    ).toBe("p@ss/w:rd");
  });
});

describe("sincronizarPassword", () => {
  it("'sin cambios' si el verificador SCRAM guardado ya corresponde a la contraseña", async () => {
    const c = clienteFalso({ rolpassword: generaVerificador(PASSWORD, ITER) });
    expect(await sincronizarPassword(c, PASSWORD)).toBe("sin cambios");
    // Solo se leyó pg_authid: ningún ALTER ROLE ni format().
    expect(c.eventos).toHaveLength(1);
    expect(c.eventos[0]).toContain("from pg_authid");
  });

  it.each([
    ["rolpassword null", null],
    ["verificador md5 (formato antiguo)", "md5" + "0".repeat(32)],
    ["SCRAM de otra contraseña", generaVerificador(OTRA_PASSWORD, ITER)],
    ["texto SCRAM mal formado", "SCRAM-SHA-256$no-es-un-verificador"],
  ])(
    "'actualizada' con verificador SCRAM válido si hay %s",
    async (_n, actual) => {
      const c = clienteFalso({ rolpassword: actual });
      expect(await sincronizarPassword(c, PASSWORD)).toBe("actualizada");

      // El verificador viaja como parámetro de format(), el ALTER ROLE se ejecuta al final.
      const iFormat = c.eventos.findIndex((t) =>
        t.startsWith("select format("),
      );
      expect(iFormat).toBeGreaterThan(0);
      const [rol, verificador] = c.parametros[iFormat] as [string, string];
      expect(rol).toBe("contapp_app");
      expect(verificador.startsWith("SCRAM-SHA-256$")).toBe(true);
      expect(verificaPassword(verificador, PASSWORD)).toBe(true);
      const ultima = c.eventos.at(-1)!;
      expect(ultima).toBe(`ALTER ROLE "contapp_app" PASSWORD '${verificador}'`);
      expect(c.eventos).toHaveLength(iFormat + 2);

      // La contraseña en claro no sale del proceso: ni en texto ni en parámetros.
      expect(todoLoEnviado(c)).not.toContain(PASSWORD);
    },
  );

  it("falla con mensaje fijo si el rol no existe", async () => {
    const c = clienteFalso({ rolpassword: undefined });
    await expect(sincronizarPassword(c, PASSWORD)).rejects.toThrow(
      "no existe el rol contapp_app",
    );
    expect(c.eventos).toHaveLength(1);
  });

  describe("con verificador de formato inválido", () => {
    afterEach(() => {
      vi.doUnmock("../scram");
      vi.resetModules();
    });

    it("no envía ALTER ROLE y falla con mensaje fijo sin la contraseña", async () => {
      vi.resetModules();
      vi.doMock("../scram", async (original) => ({
        ...(await original<typeof import("../scram")>()),
        generaVerificador: () => "verificador-malo",
      }));
      const modulo = await import("./migrar.js");
      const c = clienteFalso({ rolpassword: null });
      const e = await modulo
        .sincronizarPassword(c, PASSWORD)
        .catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe(
        "verificador SCRAM con formato invalido",
      );
      expect((e as Error).message).not.toContain(PASSWORD);
      expect(c.eventos.some((t) => t.startsWith("select format("))).toBe(false);
    });
  });
});

describe("migrar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const aplicarOk = (c: ReturnType<typeof clienteFalso>) =>
    vi.fn(async () => {
      c.eventos.push("aplicar");
    });

  it("aplica, y en una transacción repara el rol y sincroniza la contraseña; devuelve 3 líneas sin imprimir", async () => {
    const c = clienteFalso({ rolpassword: generaVerificador(PASSWORD, ITER) });
    const aplicar = aplicarOk(c);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const lineas = await migrar(c, PASSWORD, aplicar);

    expect(lineas).toEqual([
      "migrar: ajustes de contapp_app sin cambios",
      "migrar: atributos de contapp_app sin cambios",
      "migrar: contrasena de contapp_app sin cambios",
    ]);
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    const ev = c.eventos;
    const iAplicar = ev.indexOf("aplicar");
    const iBegin = ev.indexOf("BEGIN");
    const iReparar = ev.findIndex((t) =>
      t.includes("from pg_roles where rolname"),
    );
    const iPassword = ev.findIndex((t) => t.includes("from pg_authid"));
    const iCommit = ev.indexOf("COMMIT");
    expect(iAplicar).toBe(0);
    expect(iBegin).toBe(1);
    expect(iBegin).toBeLessThan(iReparar);
    expect(iReparar).toBeLessThan(iPassword);
    expect(iPassword).toBeLessThan(iCommit);
    expect(iCommit).toBe(ev.length - 1);
    expect(ev).not.toContain("ROLLBACK");
    expect(todoLoEnviado(c)).not.toContain(PASSWORD);
  });

  it("reporta 'reparados' y 'actualizada' cuando hubo que corregir el rol", async () => {
    const c = clienteFalso({
      atr: { ...ATR_OK, rolconnlimit: 0 },
      ajustes: [
        { setdatabase: 0, setconfig: ["lc_messages=C", "row_security=off"] },
      ],
      rolpassword: null,
    });
    const lineas = await migrar(c, PASSWORD, aplicarOk(c));
    expect(lineas).toEqual([
      "migrar: ajustes de contapp_app reparados",
      "migrar: atributos de contapp_app reparados",
      "migrar: contrasena de contapp_app actualizada",
    ]);
    expect(c.eventos).toContain(SQL_REPARAR_ATRIBUTOS);
    expect(c.eventos).toContain(SQL_REPARAR_AJUSTES);
    expect(c.eventos.at(-1)).toBe("COMMIT");
    expect(todoLoEnviado(c)).not.toContain(PASSWORD);
    expect(lineas.join("\n")).not.toContain(PASSWORD);
  });

  it("si la reparación falla: ROLLBACK, sin COMMIT, y relanza el error sin la contraseña", async () => {
    const c = clienteFalso({
      atr: null,
      rolpassword: generaVerificador(PASSWORD, ITER),
    });
    const e = await migrar(c, PASSWORD, aplicarOk(c)).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/no existe el rol contapp_app/);
    expect((e as Error).message).not.toContain(PASSWORD);
    expect(c.eventos).toContain("BEGIN");
    expect(c.eventos.at(-1)).toBe("ROLLBACK");
    expect(c.eventos).not.toContain("COMMIT");
    expect(c.eventos.some((t) => t.includes("from pg_authid"))).toBe(false);
  });

  it("si la sincronización de la contraseña falla: ROLLBACK, sin COMMIT, y relanza", async () => {
    const c = clienteFalso({ rolpassword: undefined });
    const e = await migrar(c, PASSWORD, aplicarOk(c)).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/no existe el rol contapp_app/);
    expect(c.eventos.indexOf("BEGIN")).toBeLessThan(
      c.eventos.indexOf("ROLLBACK"),
    );
    expect(c.eventos.at(-1)).toBe("ROLLBACK");
    expect(c.eventos).not.toContain("COMMIT");
    expect(todoLoEnviado(c)).not.toContain(PASSWORD);
  });

  it("si el propio ROLLBACK falla, relanza el error original (no el del ROLLBACK)", async () => {
    const c = clienteFalso({ atr: null, fallaRollback: true });
    const e = await migrar(c, PASSWORD, aplicarOk(c)).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/no existe el rol contapp_app/);
    expect((e as Error).message).not.toMatch(/conexion caida/);
  });

  it("si aplicar lanza: no se abre transacción, no se toca el rol y se relanza", async () => {
    const c = clienteFalso();
    const fallo = new Error("fallo al aplicar migraciones");
    const aplicar = vi.fn(async () => {
      throw fallo;
    });
    await expect(migrar(c, PASSWORD, aplicar)).rejects.toBe(fallo);
    expect(c.eventos).toEqual([]);
  });

  it("sin tercer argumento usa el aplicador real (la firma admite 2 argumentos)", () => {
    // No se ejecuta (necesitaría una base de datos real): solo se fija la aridad del contrato.
    expect(migrar.length).toBeLessThanOrEqual(2);
    expect(typeof migrar).toBe("function");
  });
});
