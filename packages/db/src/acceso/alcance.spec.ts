// Spec 005 (T2, rojo): filtroAlcance (D5), el único filtro de visibilidad de clientes para 005 y las specs siguientes.
// Sin BD: se renderiza el SQL con el dialecto de drizzle. El comportamiento contra la BD real (15 de 120, otro estudio,
// asignaciones ajenas) está en tests/aislamiento/acceso-repos.spec.ts.
// Contrato (T7): filtroAlcance(columnaClienteId, a): SQL — global -> `true`; asignado -> EXISTS (asignacion del usuario para
// esa columna), con el usuario como PARÁMETRO (nunca interpolado).
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { cliente } from "../schema/clientes";
import { filtroAlcance, type Alcance } from "./alcance";

const dialecto = new PgDialect();
const renderizar = (a: Alcance) => dialecto.sqlToQuery(filtroAlcance(cliente.id, a));
const U = "01920000-0000-7000-8000-00000000c0a1";

describe("filtroAlcance", () => {
  it("global no filtra: la condición es `true` y no lleva parámetros", () => {
    const q = renderizar({ tipo: "global" });
    expect(q.sql.replace(/[()\s]/g, "").toLowerCase()).toBe("true");
    expect(q.params).toEqual([]);
  });

  it("asignado usa EXISTS sobre `asignacion` ligado a la columna recibida y al usuario como parámetro", () => {
    const q = renderizar({ tipo: "asignado", usuarioId: U });
    const sql = q.sql.toLowerCase();
    expect(sql).toContain("exists");
    expect(sql).toContain("asignacion");
    expect(sql).toContain("cliente_id");
    expect(sql).toContain("usuario_id");
    expect(q.sql).toContain('"cliente"."id"'); // la columna que le pasó el listado
    expect(q.params).toEqual([U]);
    expect(q.sql).not.toContain(U);
  });

  it("asignado no mira el tipo: el responsable y el colaborador ven el cliente (RF-024)", () => {
    expect(renderizar({ tipo: "asignado", usuarioId: U }).sql.toLowerCase()).not.toContain("responsable");
  });

  it("dos usuarios dan el mismo texto SQL y solo cambia el parámetro (SQL estático)", () => {
    const a = renderizar({ tipo: "asignado", usuarioId: U });
    const b = renderizar({ tipo: "asignado", usuarioId: "01920000-0000-7000-8000-00000000c0a2" });
    expect(a.sql).toBe(b.sql);
    expect(a.params).not.toEqual(b.params);
  });
});
