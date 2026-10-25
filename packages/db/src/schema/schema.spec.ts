import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as esquema from "./index";

// Pruebas sin BD sobre la declaración del esquema (getTableConfig). Fijan CA-7 (todo UNIQUE de
// negocio incluye tenant_id) y que tenant_id sea NOT NULL en cada tabla de negocio, y recorren los
// callbacks perezosos de las claves foráneas (fk.reference()).

const tablas = Object.values(esquema).filter((x) =>
  is(x, PgTable),
) as PgTable[];
const configs = tablas.map((t) => getTableConfig(t));
const config = (nombre: string) => {
  const c = configs.find((x) => x.name === nombre);
  if (!c) throw new Error(`tabla ${nombre} no exportada`);
  return c;
};
const nombresColumnas = (cols: ReadonlyArray<{ name: string }>) =>
  cols.map((c) => c.name);
const conTenant = configs.filter((c) =>
  c.columns.some((col) => col.name === "tenant_id"),
);
const dialecto = new PgDialect();

describe("esquema: inventario", () => {
  it("exporta las cuatro tablas del esquema", () => {
    expect(configs.map((c) => c.name).sort()).toEqual([
      "cliente",
      "membresia",
      "tenant",
      "usuario",
    ]);
    expect(getTableName(esquema.cliente)).toBe("cliente");
  });

  it("las tablas de negocio (con tenant_id) son membresia y cliente; tenant y usuario son de plataforma", () => {
    expect(conTenant.map((c) => c.name).sort()).toEqual([
      "cliente",
      "membresia",
    ]);
    for (const nombre of ["tenant", "usuario"]) {
      expect(nombresColumnas(config(nombre).columns)).not.toContain(
        "tenant_id",
      );
    }
  });

  it("toda tabla tiene PK uuid con default uuid_v7() y marcas de tiempo NOT NULL", () => {
    for (const c of configs) {
      const pk = c.columns.find((col) => col.name === "id");
      expect(pk?.primary, c.name).toBe(true);
      expect(pk?.getSQLType(), c.name).toBe("uuid");
      expect(pk?.hasDefault, c.name).toBe(true);
      for (const marca of ["created_at", "updated_at"]) {
        const col = c.columns.find((x) => x.name === marca);
        expect(col?.notNull, `${c.name}.${marca}`).toBe(true);
        expect(col?.hasDefault, `${c.name}.${marca}`).toBe(true);
      }
    }
  });
});

describe("esquema: tenant_id (CA-7)", () => {
  it.each(conTenant.map((c) => [c.name, c] as const))(
    "%s: tenant_id es uuid NOT NULL con default tomado del contexto",
    (_n, c) => {
      const col = c.columns.find((x) => x.name === "tenant_id");
      expect(col?.notNull).toBe(true);
      expect(col?.getSQLType()).toBe("uuid");
      expect(col?.hasDefault).toBe(true);
      const defecto = dialecto.sqlToQuery(col?.default as never).sql;
      expect(defecto).toContain("app.tenant_id");
      expect(defecto).toContain("nullif");
    },
  );

  it.each(conTenant.map((c) => [c.name, c] as const))(
    "%s: cada UNIQUE de negocio incluye tenant_id",
    (_n, c) => {
      expect(c.uniqueConstraints.length).toBeGreaterThan(0);
      for (const u of c.uniqueConstraints) {
        expect(nombresColumnas(u.columns), u.name).toContain("tenant_id");
      }
      // Ningún índice único adicional (CREATE UNIQUE INDEX) puede saltarse tenant_id.
      for (const i of c.indexes.filter((x) => x.config.unique)) {
        const cols = i.config.columns.map((x) => (x as { name: string }).name);
        expect(cols, i.config.name).toContain("tenant_id");
      }
      // Ninguna columna de negocio es UNIQUE por sí sola (excepto la PK).
      for (const col of c.columns.filter((x) => !x.primary)) {
        expect(col.isUnique, `${c.name}.${col.name}`).toBe(false);
      }
    },
  );

  it("cliente: UNIQUE (tenant_id, ruc) permite el mismo RUC en dos estudios", () => {
    const u = config("cliente").uniqueConstraints.find(
      (x) => x.name === "cliente_tenant_ruc_unique",
    );
    expect(nombresColumnas(u?.columns ?? [])).toEqual(["tenant_id", "ruc"]);
  });

  it("membresia: UNIQUE (tenant_id, usuario_id)", () => {
    const u = config("membresia").uniqueConstraints.find(
      (x) => x.name === "membresia_tenant_usuario_unique",
    );
    expect(nombresColumnas(u?.columns ?? [])).toEqual([
      "tenant_id",
      "usuario_id",
    ]);
  });

  it("cliente: UNIQUE (tenant_id, id) para FK compuestas de otras specs", () => {
    const u = config("cliente").uniqueConstraints.find(
      (x) => x.name === "cliente_tenant_id_unique",
    );
    expect(nombresColumnas(u?.columns ?? [])).toEqual(["tenant_id", "id"]);
  });

  it("usuario: el email es único globalmente (tabla de plataforma, sin tenant_id)", () => {
    const email = config("usuario").columns.find((c) => c.name === "email");
    expect(email?.isUnique).toBe(true);
    expect(email?.uniqueName).toBe("usuario_email_unique");
  });
});

describe("esquema: claves foráneas (fk.reference())", () => {
  const destinos = (nombre: string) =>
    config(nombre).foreignKeys.map((fk) => {
      const r = fk.reference();
      return {
        desde: nombresColumnas(r.columns),
        hacia: getTableName(r.foreignTable),
        columnasDestino: nombresColumnas(r.foreignColumns),
      };
    });

  it("membresia referencia tenant(id) y usuario(id)", () => {
    expect(destinos("membresia")).toEqual(
      expect.arrayContaining([
        { desde: ["tenant_id"], hacia: "tenant", columnasDestino: ["id"] },
        { desde: ["usuario_id"], hacia: "usuario", columnasDestino: ["id"] },
      ]),
    );
    expect(destinos("membresia")).toHaveLength(2);
  });

  it("cliente referencia tenant(id)", () => {
    expect(destinos("cliente")).toEqual([
      { desde: ["tenant_id"], hacia: "tenant", columnasDestino: ["id"] },
    ]);
  });

  it("las tablas de plataforma no tienen claves foráneas", () => {
    expect(config("tenant").foreignKeys).toHaveLength(0);
    expect(config("usuario").foreignKeys).toHaveLength(0);
  });

  it("toda tabla con tenant_id tiene una FK de tenant_id a tenant", () => {
    for (const c of conTenant) {
      expect(destinos(c.name), c.name).toContainEqual({
        desde: ["tenant_id"],
        hacia: "tenant",
        columnasDestino: ["id"],
      });
    }
  });
});

describe("esquema: RUC de 11 dígitos", () => {
  it("cliente.ruc es char(11) NOT NULL", () => {
    const ruc = config("cliente").columns.find((c) => c.name === "ruc");
    expect(ruc?.notNull).toBe(true);
    expect(ruc?.getSQLType()).toBe("char(11)");
  });

  it("cliente tiene el CHECK cliente_ruc_11_digitos con la expresión ^[0-9]{11}$", () => {
    const check = config("cliente").checks.find(
      (c) => c.name === "cliente_ruc_11_digitos",
    );
    expect(check).toBeDefined();
    const { sql } = dialecto.sqlToQuery(check!.value);
    expect(sql).toContain("ruc");
    expect(sql).toContain("^[0-9]{11}$");
  });
});
