import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { asignacion, invitacion, membresia } from "./acceso";

// Spec 005 (T2, rojo): declaración Drizzle de `membresia.desactivadaEn`, `asignacion` e `invitacion` (CA-13, D6, D7,
// D9, D21). Sin BD; los privilegios, la RLS y el trigger los prueban tests/aislamiento/acceso*.spec.ts.
// Contrato (T7): `schema/acceso.ts` exporta `membresia`, `asignacion` e `invitacion`, y `schema/index.ts` las reexporta.
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;
const nombres = (cols: ReadonlyArray<{ name: string }>) => cols.map((c) => c.name);
const destinos = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).foreignKeys.map((fk) => {
    const r = fk.reference();
    return { desde: nombres(r.columns), hacia: getTableName(r.foreignTable), columnasDestino: nombres(r.foreignColumns) };
  });

describe("membresia (005)", () => {
  const c = getTableConfig(membresia);

  it("desactivada_en es timestamptz NULL", () => {
    const col = c.columns.find((x) => x.name === "desactivada_en");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toContain("timestamp with time zone");
  });

  it("el CHECK de rol admite exactamente dueno, admin, contador, asistente y lectura", () => {
    const check = c.checks.find((k) => sqlDe(k.value).includes("rol"));
    expect(check).toBeDefined();
    const texto = sqlDe(check!.value);
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura"]) expect(texto).toContain(`'${rol}'`);
    expect(texto.match(/'[a-z]+'/g)).toHaveLength(5);
  });
});

describe("asignacion (D6)", () => {
  const c = getTableConfig(asignacion);

  it("tabla `asignacion` con las columnas del plan", () => {
    expect(c.name).toBe("asignacion");
    expect(nombres(c.columns).sort()).toEqual(
      ["cliente_id", "created_at", "id", "tenant_id", "tipo", "updated_at", "usuario_id"].sort(),
    );
    for (const n of ["tenant_id", "cliente_id", "usuario_id", "tipo"]) {
      expect(c.columns.find((x) => x.name === n)?.notNull, n).toBe(true);
    }
    expect(sqlDe(c.columns.find((x) => x.name === "tenant_id")?.default)).toContain("app.tenant_id");
  });

  it("UNIQUE (tenant_id, cliente_id, usuario_id)", () => {
    expect(c.uniqueConstraints.map((u) => nombres(u.columns))).toContainEqual(["tenant_id", "cliente_id", "usuario_id"]);
  });

  it("indice unico parcial (tenant_id, cliente_id) WHERE tipo = 'responsable'", () => {
    const i = c.indexes.find((x) => x.config.unique && x.config.where);
    expect(i, "indice unico parcial del responsable").toBeDefined();
    expect(i!.config.columns.map((x) => (x as { name: string }).name)).toEqual(["tenant_id", "cliente_id"]);
    const donde = sqlDe(i!.config.where);
    expect(donde).toContain("tipo");
    expect(donde).toContain("responsable");
  });

  it("indice (tenant_id, usuario_id) para el filtro de alcance", () => {
    const i = c.indexes.find((x) => !x.config.unique && x.config.columns.map((k) => (k as { name: string }).name).join() === "tenant_id,usuario_id");
    expect(i).toBeDefined();
  });

  it("CHECK de tipo: responsable o colaborador", () => {
    const check = c.checks.find((k) => sqlDe(k.value).includes("tipo"));
    expect(check).toBeDefined();
    const texto = sqlDe(check!.value);
    expect(texto).toContain("'responsable'");
    expect(texto).toContain("'colaborador'");
  });

  it("FK compuestas con tenant_id hacia cliente(tenant_id, id) y membresia(tenant_id, usuario_id)", () => {
    expect(destinos(asignacion)).toEqual(
      expect.arrayContaining([
        { desde: ["tenant_id", "cliente_id"], hacia: "cliente", columnasDestino: ["tenant_id", "id"] },
        { desde: ["tenant_id", "usuario_id"], hacia: "membresia", columnasDestino: ["tenant_id", "usuario_id"] },
      ]),
    );
  });
});

describe("invitacion (D7)", () => {
  const c = getTableConfig(invitacion);

  it("tabla `invitacion` con las columnas del plan y ninguna de token en claro", () => {
    expect(c.name).toBe("invitacion");
    expect(nombres(c.columns).sort()).toEqual(
      [
        "aceptada_en",
        "aceptada_por",
        "correo",
        "creada_en",
        "id",
        "invitado_por",
        "revocada_en",
        "rol",
        "tenant_id",
        "token_hash",
        "vence_en",
      ].sort(),
    );
    const th = c.columns.find((x) => x.name === "token_hash");
    expect(th?.getSQLType()).toBe("bytea");
    expect(th?.notNull).toBe(true);
    expect(th?.isUnique).toBe(true);
  });

  it("aceptada_en, aceptada_por y revocada_en admiten NULL; el resto es NOT NULL", () => {
    for (const n of ["aceptada_en", "aceptada_por", "revocada_en"]) {
      expect(c.columns.find((x) => x.name === n)?.notNull, n).toBe(false);
    }
    for (const n of ["tenant_id", "correo", "rol", "invitado_por", "token_hash", "creada_en", "vence_en"]) {
      expect(c.columns.find((x) => x.name === n)?.notNull, n).toBe(true);
    }
  });

  it("CHECK de rol (los 5 roles), de correo (misma normalizacion que usuario.email) y de token_hash de 32 B", () => {
    const textos = c.checks.map((k) => sqlDe(k.value));
    const delRol = textos.find((t) => t.includes("rol"));
    expect(delRol).toBeDefined();
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura"]) expect(delRol).toContain(`'${rol}'`);
    const delCorreo = textos.find((t) => t.includes("correo"));
    expect(delCorreo).toBeDefined();
    expect(delCorreo).toContain("btrim");
    expect(delCorreo).toContain("lower");
    expect(delCorreo).toContain("NFC");
    const delHash = textos.find((t) => t.includes("token_hash"));
    expect(delHash).toBeDefined();
    expect(delHash).toContain("32");
  });

  it("indice unico parcial (tenant_id, correo) mientras no este aceptada ni revocada", () => {
    const i = c.indexes.find((x) => x.config.unique && x.config.where);
    expect(i, "indice unico parcial").toBeDefined();
    expect(i!.config.columns.map((x) => (x as { name: string }).name)).toEqual(["tenant_id", "correo"]);
    const donde = sqlDe(i!.config.where);
    expect(donde).toContain("aceptada_en");
    expect(donde).toContain("revocada_en");
  });

  it("FK compuesta (tenant_id, invitado_por) -> membresia(tenant_id, usuario_id) y aceptada_por -> usuario(id)", () => {
    expect(destinos(invitacion)).toEqual(
      expect.arrayContaining([
        { desde: ["tenant_id", "invitado_por"], hacia: "membresia", columnasDestino: ["tenant_id", "usuario_id"] },
        { desde: ["aceptada_por"], hacia: "usuario", columnasDestino: ["id"] },
      ]),
    );
  });
});
