import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { asignacion, invitacion, membresia } from "./acceso";
import * as esquema from "./acceso";

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

  // Spec 030 (D2): el CHECK de rol admite los 5 de sistema y 'propio'.
  it("el CHECK de rol admite exactamente dueno, admin, contador, asistente, lectura y propio", () => {
    const check = c.checks.find((k) => /\brol\b/.test(sqlDe(k.value)) && sqlDe(k.value).includes("'dueno'"));
    expect(check).toBeDefined();
    const texto = sqlDe(check!.value);
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura", "propio"]) expect(texto).toContain(`'${rol}'`);
    expect(texto.match(/'[a-z]+'/g)).toHaveLength(6);
  });

  it("rol_id es uuid NULL, con CHECK ((rol = 'propio') = (rol_id IS NOT NULL)) y FK compuesta (tenant_id, rol_id) hacia rol(tenant_id, id)", () => {
    const col = c.columns.find((x) => x.name === "rol_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toBe("uuid");
    const check = c.checks.map((k) => sqlDe(k.value)).find((t) => t.includes("rol_id"));
    expect(check, "CHECK de coherencia rol / rol_id").toBeDefined();
    expect(check).toContain("'propio'");
    expect(destinos(membresia)).toContainEqual({ desde: ["tenant_id", "rol_id"], hacia: "rol", columnasDestino: ["tenant_id", "id"] });
  });
});

// Spec 030 (T1, rojo hasta que T6 declare `rol` y `rolPermiso` en schema/acceso.ts): D1 de la spec 030.
describe("rol y rol_permiso (030)", () => {
  const cfg = (t: unknown) => getTableConfig(t as Parameters<typeof getTableConfig>[0]);

  it("`rol` y `rolPermiso` se exportan de schema/acceso.ts y del indice del esquema", async () => {
    expect(esquema.rol).toBeDefined();
    expect(esquema.rolPermiso).toBeDefined();
    const indice = (await import("./index")) as Record<string, unknown>;
    expect(indice.rol).toBeDefined();
    expect(indice.rolPermiso).toBeDefined();
  });

  it("rol: columnas del plan, todas NOT NULL, tenant_id con el valor por defecto de app.tenant_id y nombre_clave generada", () => {
    const c = cfg(esquema.rol);
    expect(c.name).toBe("rol");
    expect(nombres(c.columns).sort()).toEqual(["actualizado_en", "alcance", "creado_en", "id", "nombre", "nombre_clave", "tenant_id"].sort());
    for (const col of c.columns) expect(col.notNull, col.name).toBe(true);
    expect(sqlDe(c.columns.find((x) => x.name === "tenant_id")?.default)).toContain("app.tenant_id");
    expect((c.columns.find((x) => x.name === "nombre_clave") as { generated?: unknown } | undefined)?.generated).toBeDefined();
  });

  it("rol: UNIQUE (tenant_id, nombre_clave) y UNIQUE (tenant_id, id); FK a tenant", () => {
    const c = cfg(esquema.rol);
    const unicos = [...c.uniqueConstraints.map((u) => nombres(u.columns)), ...c.indexes.filter((i) => i.config.unique).map((i) => i.config.columns.map((k) => (k as { name: string }).name))];
    expect(unicos).toContainEqual(["tenant_id", "nombre_clave"]);
    expect(unicos).toContainEqual(["tenant_id", "id"]);
    expect(destinos(esquema.rol as never)).toContainEqual({ desde: ["tenant_id"], hacia: "tenant", columnasDestino: ["id"] });
  });

  it("rol: CHECK de alcance (global | asignado), de nombre (1..40 sin controles) y de nombre_clave fuera de los nombres de sistema", () => {
    const textos = cfg(esquema.rol).checks.map((k) => sqlDe(k.value));
    const alcance = textos.find((t) => t.includes("alcance"));
    expect(alcance).toContain("'global'");
    expect(alcance).toContain("'asignado'");
    expect(textos.some((t) => /40/.test(t) && t.includes("nombre")), "nombre 1..40").toBe(true);
    const sistema = textos.find((t) => t.includes("nombre_clave"));
    expect(sistema, "nombre_clave no es un nombre de sistema").toBeDefined();
    for (const n of ["dueno", "administrador", "contador", "asistente", "lectura"]) expect(sistema).toContain(n);
  });

  it("rol_permiso: PK (rol_id, permiso), FK compuesta (tenant_id, rol_id) con ON DELETE CASCADE y CHECK del catalogo sin plan.gestionar", () => {
    const c = cfg(esquema.rolPermiso);
    expect(c.name).toBe("rol_permiso");
    expect(nombres(c.columns).sort()).toEqual(["permiso", "rol_id", "tenant_id"]);
    const pk = c.primaryKeys.map((k) => nombres(k.columns));
    expect(pk).toContainEqual(["rol_id", "permiso"]);
    expect(destinos(esquema.rolPermiso as never)).toContainEqual({ desde: ["tenant_id", "rol_id"], hacia: "rol", columnasDestino: ["tenant_id", "id"] });
    const fk = c.foreignKeys.find((f) => getTableName(f.reference().foreignTable) === "rol");
    expect(fk?.onDelete).toBe("cascade");
    const check = c.checks.map((k) => sqlDe(k.value)).find((t) => t.includes("permiso"));
    expect(check).toBeDefined();
    expect(check).toContain("'clientes.ver'");
    expect(check).toContain("'auditoria.ver'");
    expect(check).not.toContain("plan.gestionar");
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
        "rol_id",
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

  it("aceptada_en, aceptada_por, revocada_en y rol_id (030) admiten NULL; el resto es NOT NULL", () => {
    for (const n of ["aceptada_en", "aceptada_por", "revocada_en", "rol_id"]) {
      expect(c.columns.find((x) => x.name === n)?.notNull, n).toBe(false);
    }
    for (const n of ["tenant_id", "correo", "rol", "invitado_por", "token_hash", "creada_en", "vence_en"]) {
      expect(c.columns.find((x) => x.name === n)?.notNull, n).toBe(true);
    }
  });

  it("CHECK de rol (los 5 roles y 'propio'), de coherencia rol / rol_id, de correo (misma normalizacion que usuario.email) y de token_hash de 32 B", () => {
    const textos = c.checks.map((k) => sqlDe(k.value));
    const delRol = textos.find((t) => /\brol\b/.test(t) && t.includes("'dueno'"));
    expect(delRol).toBeDefined();
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura", "propio"]) expect(delRol).toContain(`'${rol}'`);
    const coherencia = textos.find((t) => t.includes("rol_id"));
    expect(coherencia, "CHECK ((rol = 'propio') = (rol_id IS NOT NULL))").toContain("'propio'");
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

  it("FK compuesta (tenant_id, invitado_por) -> membresia(tenant_id, usuario_id), aceptada_por -> usuario(id) y (tenant_id, rol_id) -> rol(tenant_id, id)", () => {
    expect(destinos(invitacion)).toEqual(
      expect.arrayContaining([
        { desde: ["tenant_id", "invitado_por"], hacia: "membresia", columnasDestino: ["tenant_id", "usuario_id"] },
        { desde: ["aceptada_por"], hacia: "usuario", columnasDestino: ["id"] },
        { desde: ["tenant_id", "rol_id"], hacia: "rol", columnasDestino: ["tenant_id", "id"] },
      ]),
    );
  });
});
