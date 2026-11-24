import { describe, expect, it } from "vitest";
import { ErrorDatos } from "../errores.js";
import type { CredencialSol } from "../puertos.js";
import { MockSolPortal } from "./sol-portal.mock.js";

// Spec 026 · T19 (tester; H-026-2-2, en rojo). El mock (adaptador por omisión, `SOL_PORTAL=mock`) debe validar el PDT 621 igual que la BD
// (0066/0067: `prorrata_declaraciones_registrar` rechaza con 22023 toda la obtención) para que un defecto sea `ErrorDatos` del periodo y no
// llegue al trabajo (D-2, D-3). Defectos que la BD rechaza y el mock aceptaba:
//   - número de orden 0 («0», «00», «000000000000000»);
//   - el mismo número de orden escrito con ceros a la izquierda («01» y «1», «007» y «7») en un periodo: es la misma presentación;
//   - fecha de presentación anterior al año 1900.
// Observable (no el mecanismo): `inyectar` lanza `ErrorDatos` O la llamada del periodo defectuoso lanza `ErrorDatos`. Nunca devuelve la
// presentación defectuosa. Los demás periodos del mismo RUC siguen respondiendo si se aceptó la inyección.
const RUC = "20100000001";
const CRED: CredencialSol = { ruc: RUC, usuarioSol: "USUARIO-sol", claveSol: "CLAVE-sol" };

interface Decl {
  periodo: string;
  numeroOrden: string;
  fechaPresentacion: string;
  tipo: "original" | "rectificatoria";
  ventasGravadasBase: string;
  ventasGravadasIgv: string;
  exportaciones: string;
  noGravadas: string;
  igvAdquisicionesDg: string;
  igvAdquisicionesDgng: string;
  prorrataUsada: string | null;
}
const decl = (periodo: string, o: Partial<Decl> = {}): Decl => ({
  periodo,
  numeroOrden: "7654321",
  fechaPresentacion: "2026-11-10",
  tipo: "original",
  ventasGravadasBase: "100000.00",
  ventasGravadasIgv: "18000.00",
  exportaciones: "0.00",
  noGravadas: "20000.00",
  igvAdquisicionesDg: "9000.00",
  igvAdquisicionesDgng: "3600.00",
  prorrataUsada: null,
  ...o,
});

type Inyectable = { inyectar: (ruc: string, caso: unknown) => void };

/** Resultado de intentar usar `lista` como el PDT de 202608: error de la inyección, error de la llamada o lo que devolvió. */
async function intentar(lista: Decl[]): Promise<{ donde: "inyectar" | "obtener" | "devolvio"; error?: unknown; devuelto?: Decl[] }> {
  const mock = new MockSolPortal();
  try {
    (mock as unknown as Inyectable).inyectar(RUC, { periodos: { "202608": lista } });
  } catch (error) {
    return { donde: "inyectar", error };
  }
  try {
    const devuelto = (await mock.obtenerDeclaraciones621(CRED, { periodo: "202608" })) as unknown as Decl[];
    return { donde: "devolvio", devuelto };
  } catch (error) {
    return { donde: "obtener", error };
  }
}

function esperarErrorDatos(r: Awaited<ReturnType<typeof intentar>>): void {
  expect(r.donde, `el mock devolvió ${JSON.stringify(r.devuelto)}`).not.toBe("devolvio");
  expect(r.error).toBeInstanceOf(ErrorDatos);
  // Mensaje fijo: sin RUC, sin montos ni datos de la presentación.
  const texto = `${(r.error as Error).message} ${String(r.error)}`;
  expect(texto).not.toContain(RUC);
  expect(texto).not.toContain("100000.00");
}

describe("H-026-2-2 · el mock rechaza como ErrorDatos lo que la BD rechaza", () => {
  it.each([["0"], ["00"], ["000000000000000"]])("número de orden %s", async (numeroOrden) => {
    esperarErrorDatos(await intentar([decl("202608", { numeroOrden })]));
  });

  it("número de orden 0 junto a otra presentación válida del mismo periodo", async () => {
    esperarErrorDatos(
      await intentar([decl("202608", { numeroOrden: "5" }), decl("202608", { numeroOrden: "0", tipo: "rectificatoria" })]),
    );
  });

  it.each([
    ["«01» y «1»", "01", "1"],
    ["«007» y «7»", "007", "7"],
    ["«0010» y «10»", "0010", "10"],
  ])("el mismo número de orden escrito %s (con montos distintos) duplica la presentación", async (_n, a, b) => {
    esperarErrorDatos(
      await intentar([decl("202608", { numeroOrden: a }), decl("202608", { numeroOrden: b, ventasGravadasBase: "1.00" })]),
    );
  });

  it.each([["1899-12-31"], ["1000-01-01"], ["1800-06-15"]])("fecha de presentación %s (año < 1900)", async (fechaPresentacion) => {
    esperarErrorDatos(await intentar([decl("202608", { fechaPresentacion })]));
  });

  describe("controles: lo que la BD acepta, el mock lo sigue aceptando", () => {
    it("números de orden distintos como número («9» y «10»; «01» solo) y fecha desde 1900-01-01", async () => {
      const r = await intentar([
        decl("202608", { numeroOrden: "9", fechaPresentacion: "1900-01-01" }),
        decl("202608", { numeroOrden: "10", tipo: "rectificatoria" }),
      ]);
      expect(r.donde).toBe("devolvio");
      expect(r.devuelto?.map((d) => d.numeroOrden)).toEqual(["9", "10"]);
    });

    it("«01» y «10» no se confunden: son 1 y 10", async () => {
      const r = await intentar([decl("202608", { numeroOrden: "01" }), decl("202608", { numeroOrden: "10", tipo: "rectificatoria" })]);
      expect(r.donde).toBe("devolvio");
      expect(r.devuelto).toHaveLength(2);
    });
  });
});
