// Spec 012b (T4, rojo): las migraciones 0039 y 0040 y su diario (plan «Archivos»: 012b usa 0039 y 0040; nunca se edita una
// migracion aplicada). Unitarias: leen los archivos, no usan Postgres. Hasta T10 fallan porque las migraciones no existen.
// Reglas de seguridad de 016: nada de grants amplios al worker; toda funcion con dueno contapp_migrator y search_path fijo.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const carpeta = resolve(__dirname, "../../migrations");
const MIGRACIONES = [
  "0039_venta_periodo_exclusion",
  "0040_archivo_generado",
] as const;
const leer = (tag: string) =>
  existsSync(`${carpeta}/${tag}.sql`)
    ? readFileSync(`${carpeta}/${tag}.sql`, "utf8")
    : "";
const sinComentarios = (s: string) => s.replace(/--.*$/gm, "");

describe("diario y archivos de migracion", () => {
  const diario = JSON.parse(
    readFileSync(`${carpeta}/meta/_journal.json`, "utf8"),
  ) as { entries: { idx: number; tag: string; breakpoints: boolean }[] };

  it.each(MIGRACIONES)(
    "existe %s.sql y esta en el diario con su indice",
    (tag) => {
      expect(
        existsSync(`${carpeta}/${tag}.sql`),
        `falta ${tag}.sql (T10)`,
      ).toBe(true);
      const e = diario.entries.find((x) => x.tag === tag);
      expect(e, `${tag} no esta en el diario`).toBeDefined();
      expect(e?.idx).toBe(Number(tag.slice(0, 4)));
      expect(e?.breakpoints).toBe(true);
    },
  );

  it("0039 y 0040 siguen a la 0038 sin huecos ni repetidos, en orden", () => {
    const tags = diario.entries.map((x) => x.tag);
    expect(tags.indexOf("0039_venta_periodo_exclusion")).toBe(
      tags.indexOf("0038_compra_worker_sin_update") + 1,
    );
    expect(tags.indexOf("0040_archivo_generado")).toBe(
      tags.indexOf("0039_venta_periodo_exclusion") + 1,
    );
    expect(new Set(tags).size).toBe(tags.length);
    expect(diario.entries.map((x) => x.idx)).toEqual(
      diario.entries.map((_, i) => i),
    );
  });
});

describe("contenido de seguridad de las migraciones", () => {
  it.each(MIGRACIONES)(
    "%s: ningun GRANT amplio ni a PUBLIC; ninguna tabla queda sin RLS FORCE",
    (tag) => {
      const sql = sinComentarios(leer(tag));
      expect(sql, `falta ${tag}.sql`).not.toBe("");
      expect(sql).not.toMatch(/GRANT\s+ALL/i);
      expect(sql).not.toMatch(/\bTO\s+PUBLIC\b/i);
      expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
      expect(sql).not.toMatch(
        /GRANT\s+(?:[A-Z, ]*\b)?(UPDATE|DELETE|TRUNCATE)\s+ON\s+(?:TABLE\s+)?(?:public\.)?\w+\s+TO[^;]*contapp_worker/i,
      );
      const tablas = [
        ...sql.matchAll(
          /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?(?:public"?\.)?"?(\w+)"?/gi,
        ),
      ].map((m) => m[1]);
      for (const t of tablas) {
        expect(sql, `${t}: ENABLE`).toMatch(
          new RegExp(
            `ALTER TABLE\\s+(?:public\\.)?"?${t}"?\\s+ENABLE ROW LEVEL SECURITY`,
            "i",
          ),
        );
        expect(sql, `${t}: FORCE`).toMatch(
          new RegExp(
            `ALTER TABLE\\s+(?:public\\.)?"?${t}"?\\s+FORCE ROW LEVEL SECURITY`,
            "i",
          ),
        );
        expect(sql, `${t}: dueno`).toMatch(
          new RegExp(
            `ALTER TABLE\\s+(?:public\\.)?"?${t}"?\\s+OWNER TO\\s+contapp_migrator`,
            "i",
          ),
        );
      }
    },
  );

  it.each(MIGRACIONES)(
    "%s: toda funcion fija search_path, es de contapp_migrator y no se deja ejecutable por PUBLIC",
    (tag) => {
      const sql = sinComentarios(leer(tag));
      const funciones = [
        ...sql.matchAll(
          /CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\$\$/gi,
        ),
      ];
      expect(sql, `falta ${tag}.sql`).not.toBe("");
      expect(
        funciones.length,
        `${tag} debe crear al menos una funcion de trigger`,
      ).toBeGreaterThan(0);
      for (const m of funciones) {
        expect(m[0], `${m[1]}: search_path fijo`).toMatch(
          /SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp/i,
        );
        expect(sql, `${m[1]}: dueno`).toMatch(
          new RegExp(
            `ALTER FUNCTION\\s+(?:public\\.)?${m[1]}\\([^)]*\\)\\s+OWNER TO\\s+contapp_migrator`,
            "i",
          ),
        );
        expect(sql, `${m[1]}: sin EXECUTE a PUBLIC`).toMatch(
          new RegExp(
            `REVOKE ALL ON FUNCTION\\s+(?:public\\.)?${m[1]}\\([^)]*\\)\\s+FROM\\s+PUBLIC`,
            "i",
          ),
        );
      }
    },
  );

  it("0039 declara venta_periodo, venta_exclusion y el trigger periodo_worker_acotado en compra_periodo y venta_periodo; 0040 declara archivo_generado", () => {
    const a = sinComentarios(leer("0039_venta_periodo_exclusion"));
    const crea = (t: string) =>
      new RegExp(
        `CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?(?:public"?\\.)?"?${t}"?`,
        "i",
      );
    expect(a).toMatch(crea("venta_periodo"));
    expect(a).toMatch(crea("venta_exclusion"));
    expect(
      a.match(/CREATE TRIGGER\s+periodo_worker_acotado/gi) ?? [],
    ).toHaveLength(2);
    expect(a).toMatch(
      /GRANT SELECT ON[^;]*venta_salto_justificado[^;]*TO contapp_worker/i,
    );
    const b = sinComentarios(leer("0040_archivo_generado"));
    expect(b).toMatch(crea("archivo_generado"));
    expect(b).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*archivo_generado/i);
  });
});
