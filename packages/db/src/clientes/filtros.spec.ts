// Spec 007a (D7, CA-6, plan: Decisiones): los filtros del listado generan SQL estático con parámetros.
// Sin BD: tx falsa que captura la consulta de `listarClientesFiltrado(tx, alcance, filtros)` (repositorio.ts).
// El comportamiento contra la BD real (filas, combinaciones, alcance) está en tests/aislamiento y en T3.
// Contrato fijado: el texto del usuario (q, uuid de responsable) nunca va dentro del SQL; `q` se compara con
// ILIKE ... ESCAPE y los comodines %, _ y \ del usuario llegan escapados como parámetro.
import { describe, expect, it } from "vitest";
import { listarClientesFiltrado } from "./repositorio";

const U = "01920000-0000-7000-8000-0000000000a1";
const OTRO = "01920000-0000-7000-8000-0000000000b2";

async function capturar(
  alcance: Parameters<typeof listarClientesFiltrado>[1],
  filtros: Parameters<typeof listarClientesFiltrado>[2],
) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Parameters<typeof listarClientesFiltrado>[0];
  const r = await listarClientesFiltrado(tx, alcance, filtros);
  return { r, llamadas };
}
const global = { tipo: "global" } as const;
const unaConsulta = async (
  a: typeof global | { tipo: "asignado"; usuarioId: string },
  f: Parameters<typeof listarClientesFiltrado>[2],
) => {
  const { r, llamadas } = await capturar(a, f);
  expect(r).toEqual([]);
  expect(llamadas.length).toBe(1);
  return llamadas[0]!;
};

describe("listarClientesFiltrado: parámetros, no texto", () => {
  it("sin filtros: una consulta sobre cliente, solo activos, ordenada por razón social e id", async () => {
    const { texto } = await unaConsulta(global, {});
    expect(texto).toMatch(/from\s+cliente/i);
    expect(texto).toMatch(/archivado_at\s+is\s+null/i);
    expect(texto).toMatch(/order\s+by[\s\S]*razon_social[\s\S]*\bid\b/i);
  });

  it("archivados=1 no filtra por archivado_at", async () => {
    const { texto } = await unaConsulta(global, { archivados: true });
    expect(texto).not.toMatch(/archivado_at\s+is\s+null/i);
  });

  it.each([
    ["comilla simple", "x' OR '1'='1"],
    ["punto y coma", "x'; DROP TABLE cliente; --"],
    ["comillas dobles", 'x" OR "1"="1'],
    ["comodines", "50%_\\"],
    ["palabra reservada", "SELECT"],
  ])("q con %s no aparece en el SQL y viaja como parámetro", async (_c, q) => {
    const { texto, valores } = await unaConsulta(global, { q });
    expect(texto).not.toContain(q);
    expect(texto).not.toContain("DROP TABLE");
    expect(texto).not.toMatch(/OR\s+'1'/);
    expect(
      valores.some(
        (v) => typeof v === "string" && v.includes(q.replace(/[\\%_]/g, "")),
      ),
    ).toBe(true);
  });

  it("q se busca con ILIKE ... ESCAPE", async () => {
    const { texto } = await unaConsulta(global, { q: "sac" });
    expect(texto).toMatch(/ilike/i);
    expect(texto).toMatch(/escape/i);
  });

  it("escapa %, _ y \\ del usuario antes de armar el patrón", async () => {
    const { valores } = await unaConsulta(global, { q: "50%_\\" });
    const patrones = valores.filter(
      (v): v is string => typeof v === "string" && v.includes("50"),
    );
    expect(patrones.length).toBeGreaterThan(0);
    for (const p of patrones) {
      expect(p).toContain("50\\%\\_\\\\");
      // los comodines del usuario ya no son comodines: tras quitar los escapados no queda ninguno suelto
      expect(p.replace(/\\[%_\\]/g, "")).not.toMatch(/[%_\\]50|50[_\\]/);
    }
  });

  it("q de RUC compara por prefijo: el patrón del RUC no lleva comodín inicial", async () => {
    const { valores } = await unaConsulta(global, { q: "20100" });
    expect(valores).toContain("20100%");
  });

  it("q de razón social busca por fragmento: patrón con comodines a ambos lados", async () => {
    const { valores } = await unaConsulta(global, { q: "sac" });
    expect(valores).toContain("%sac%");
  });

  it("responsable por uuid viaja como parámetro", async () => {
    const { texto, valores } = await unaConsulta(global, { responsable: U });
    expect(texto).not.toContain(U);
    expect(valores).toContain(U);
    expect(texto).toMatch(/asignacion/i);
    expect(texto).toMatch(/responsable/i);
  });

  it("responsable=ninguno: no exige uuid y filtra los sin responsable (not exists)", async () => {
    const { texto, valores } = await unaConsulta(global, {
      responsable: "ninguno",
    });
    expect(valores).not.toContain("ninguno");
    expect(texto).not.toContain("ninguno");
    expect(texto).toMatch(/not\s+exists|is\s+null/i);
    expect(texto).toMatch(/responsable/i);
  });

  it("credencial: se lee de credencial.estado, por tipo, con el estado como parámetro", async () => {
    const { texto, valores } = await unaConsulta(global, {
      credencial: "invalida",
    });
    expect(texto).toMatch(/credencial/i);
    expect(texto).toMatch(/estado/i);
    expect(valores).toContain("invalida");
    expect(texto).not.toMatch(/'invalida'/);
    // solo estado: nunca columnas cifradas
    expect(texto).not.toMatch(/sobre|dek|cifrad|ciphertext|iv\b/i);
  });

  it("credencial=no_configurada: tipo sin fila (no exige que la fila exista)", async () => {
    const { texto, valores } = await unaConsulta(global, {
      credencial: "no_configurada",
    });
    expect(texto).toMatch(/not\s+exists|is\s+null|left\s+join/i);
    expect(valores.length).toBeGreaterThan(0);
  });

  it("la consulta del listado no selecciona columnas de secretos", async () => {
    const { texto } = await unaConsulta(global, {});
    expect(texto).not.toMatch(
      /sobre|dek_envuelta|ciphertext|client_secret|clave_sol/i,
    );
  });
});

describe("listarClientesFiltrado: se combina con filtroAlcance", () => {
  it("alcance global no agrega restricción de asignación del usuario", async () => {
    const { valores } = await unaConsulta(global, { q: "sac" });
    expect(valores).not.toContain(OTRO);
  });

  it("alcance asignado: el usuario viaja como parámetro dentro de la consulta", async () => {
    const { texto, valores } = await unaConsulta(
      { tipo: "asignado", usuarioId: OTRO },
      {},
    );
    expect(texto).not.toContain(OTRO);
    expect(valores).toContain(OTRO);
    expect(texto).toMatch(/asignacion/i);
  });

  it("alcance asignado más todos los filtros: una sola consulta, todo parametrizado, sin texto del usuario", async () => {
    const q = "x' OR 1=1 --";
    const { texto, valores } = await unaConsulta(
      { tipo: "asignado", usuarioId: OTRO },
      { responsable: U, credencial: "verificada", archivados: true, q },
    );
    for (const dato of [OTRO, U, q, "verificada"])
      expect(texto).not.toContain(dato);
    expect(valores).toEqual(expect.arrayContaining([OTRO, U, "verificada"]));
    // los marcadores son $n y los valores cubren todos los usados
    const maxMarcador = Math.max(
      ...[...texto.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
    );
    expect(maxMarcador).toBeLessThanOrEqual(valores.length);
  });

  it("los filtros se combinan con AND: no hay OR a nivel de la cláusula where del usuario", async () => {
    const { texto } = await unaConsulta(
      { tipo: "asignado", usuarioId: OTRO },
      { responsable: U, credencial: "valida" as never },
    );
    const where = texto
      .split(/\bwhere\b/i)
      .slice(1)
      .join(" where ");
    expect(where).toMatch(/\band\b/i);
  });
});
