// Spec 026 · T19 (tester): pruebas de las correcciones de la ronda adversarial 2 sobre la BD real (0065 y 0066). En rojo por el defecto.
//   H-026-2-5: el motivo «sin controles» también excluye U+2028 (LINE SEPARATOR) y U+2029 (PARAGRAPH SEPARATOR), que no son \p{Cc}:
//              - `prorrata_mes_manual_guardar` y `prorrata_mes_manual_eliminar` los rechazan con 22023 (el error fijo de motivo inválido)
//                y sin escribir una versión ni auditar;
//              - el CHECK `prorrata_mes_manual_motivo_valido` los rechaza con 23514 en la tabla (la BD protege aunque la función cambie).
// Controles en verde incluidos (motivo ordinario, salto de línea ya rechazado) para que el rojo sea por el defecto. Las funciones de 0066
// que se prueban aquí no cambian de firma; si T20 corrige con la migración 0068 debe conservar dueño, search_path, SQLSTATE y mensajes fijos.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import {
  codigoDe,
  EscenarioProrrata,
  llamar,
  SQL,
  type ClientePrueba,
  type Llamada,
} from "./prorrata-soporte";

let admin: Pool;
let ep: EscenarioProrrata;
let backend: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ep = new EscenarioProrrata(admin);
  X = (await ep.estudio()).id;
  ux = await ep.usuarioDe(X);
  backend = crearDb("contapp_backend", 4);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(
    [backend?.close(), ep?.cerrar()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

const comoX = () => ({ tenantId: X, userId: ux });
const guardar = (
  c: ClientePrueba,
  periodo: string,
  version: number,
  motivo: string,
): Promise<Llamada> =>
  llamar(backend, comoX(), SQL.guardarManual, [
    c.id,
    periodo,
    "1000.00",
    "0.00",
    "200.00",
    motivo,
    version,
  ]);
const eliminar = (
  c: ClientePrueba,
  periodo: string,
  version: number,
  motivo: string,
): Promise<Llamada> =>
  llamar(backend, comoX(), SQL.eliminarManual, [
    c.id,
    periodo,
    motivo,
    version,
  ]);

async function auditorias(clienteId: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int as n from auditoria where cliente_id = $1 and accion like 'prorrata.mes_manual%'`,
    [clienteId],
  );
  return r.rows[0].n as number;
}

const SEPARADORES = [
  ["U+2028 LINE SEPARATOR en medio", "Libro de ventas\u2028físico"],
  ["U+2029 PARAGRAPH SEPARATOR en medio", "Libro de ventas\u2029físico"],
  ["U+2028 entre dos letras", "a\u2028b"],
  ["U+2029 repetido", "uno\u2029dos\u2029tres"],
] as const;

describe("H-026-2-5 · prorrata_mes_manual_guardar rechaza los separadores de línea Unicode en el motivo", () => {
  it("control: un motivo ordinario se guarda y un salto de línea ya se rechazaba (22023)", async () => {
    const c = await ep.cliente(X);
    expect(
      codigoDe(
        await guardar(
          c,
          "202601",
          0,
          "Libro físico: ventas de la ñapa, mes 01",
        ),
      ),
    ).toBe("ok");
    const d = await ep.cliente(X);
    expect(codigoDe(await guardar(d, "202601", 0, "uno\ndos"))).toBe("22023");
  });

  it.each(SEPARADORES)(
    "%s: 22023, sin versión ni auditoría",
    async (_n, motivo) => {
      const c = await ep.cliente(X);
      const r = await guardar(c, "202601", 0, motivo);
      expect(codigoDe(r), "SQLSTATE de guardar").toBe("22023");
      expect(await ep.manuales(c.id)).toHaveLength(0);
      expect(await auditorias(c.id)).toBe(0);
    },
  );

  it("el rechazo no cambia el motivo de una versión ya guardada (la versión sigue en 1)", async () => {
    const c = await ep.cliente(X);
    expect(codigoDe(await guardar(c, "202601", 0, "motivo bueno"))).toBe("ok");
    expect(codigoDe(await guardar(c, "202601", 1, "motivo\u2028malo"))).toBe(
      "22023",
    );
    const m = await ep.manuales(c.id);
    expect(m.map((f) => [f.version, f.motivo])).toEqual([[1, "motivo bueno"]]);
  });
});

describe("H-026-2-5 · prorrata_mes_manual_eliminar rechaza los separadores de línea Unicode en el motivo", () => {
  it.each(SEPARADORES.slice(0, 2))(
    "%s: 22023 y el mes sigue vivo en su versión 1",
    async (_n, motivo) => {
      const c = await ep.cliente(X);
      expect(codigoDe(await guardar(c, "202601", 0, "alta"))).toBe("ok");
      const antes = await auditorias(c.id);
      const r = await eliminar(c, "202601", 1, motivo);
      expect(codigoDe(r), "SQLSTATE de eliminar").toBe("22023");
      expect(
        (await ep.manuales(c.id)).map((f) => [f.version, f.accion]),
      ).toEqual([[1, "guardado"]]);
      expect(await auditorias(c.id)).toBe(antes);
    },
  );

  it("control: un motivo ordinario elimina", async () => {
    const c = await ep.cliente(X);
    expect(codigoDe(await guardar(c, "202601", 0, "alta"))).toBe("ok");
    expect(codigoDe(await eliminar(c, "202601", 1, "Se retira el mes"))).toBe(
      "ok",
    );
  });
});

describe("H-026-2-5 · el CHECK de la tabla también los rechaza (la BD protege aunque la función cambie)", () => {
  async function insertar(motivo: string): Promise<string> {
    const c = await ep.cliente(X);
    try {
      await ep.manual(X, c, { periodo: "202601", version: 1, motivo });
      return "ok";
    } catch (e) {
      return String((e as { code?: string }).code ?? "error");
    }
  }

  it("control: motivo ordinario ok; salto de línea y bidi ya daban 23514", async () => {
    expect(await insertar("Libro físico: ventas")).toBe("ok");
    expect(await insertar("uno\ndos")).toBe("23514");
    expect(await insertar("uno‮dos")).toBe("23514");
  });

  it.each(SEPARADORES)("%s: 23514", async (_n, motivo) => {
    expect(await insertar(motivo)).toBe("23514");
  });
});
