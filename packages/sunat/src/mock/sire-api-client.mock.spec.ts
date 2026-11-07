import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clasificarError } from "../errores.js";
import type { SireApiClient, TokenSire } from "../puertos.js";
import { MockSireApiClient } from "./sire-api-client.mock.js";

// CA-5 (spec 009, D7): propuesta SIRE desde fixtures o conjunto genérico, `fallar`, centinelas y
// entrada inválida. Las pruebas de fixtures reales usan `fixtures/sire/` (directorio por defecto).
const RUC = "20700000002";
const CANARIO = "CANARIO-TOKEN-xyz";
const TOKEN: TokenSire = { token: CANARIO, expiraEn: new Date("2026-10-27T16:00:00Z") };
const pedir = (ruc: string, periodo: string, libro: "compras" | "ventas" = "compras") => ({
  ruc,
  periodo,
  libro,
});

const dirTemporal = mkdtempSync(join(tmpdir(), "sire-mock-"));
afterAll(() => rmSync(dirTemporal, { recursive: true, force: true }));

describe("MockSireApiClient con los fixtures del repo", () => {
  it("implementa el puerto y la propuesta de ventas trae las boletas 290 y 292, sin la 291", async () => {
    const puerto: SireApiClient = new MockSireApiClient();
    const p = await puerto.descargarPropuesta(TOKEN, pedir(RUC, "202610", "ventas"));
    expect(p.libro).toBe("ventas");
    expect(p.periodo).toBe("202610");
    // T1 (013): el fixture de ventas trae más filas (serie, NC, USD...); aquí importan solo las boletas 290 y 292.
    const claves = p.filas.map((f) => `${f.serie}-${f.numero}`);
    expect(claves).toEqual(expect.arrayContaining(["B001-290", "B001-292"]));
    expect(claves).not.toContain("B001-291");
  });

  it("la propuesta de compras trae las filas de los casos de CA-2", async () => {
    const p = await new MockSireApiClient().descargarPropuesta(TOKEN, pedir(RUC, "202610"));
    // 013: `PropuestaSire` es una unión por `libro`; se estrecha a compras antes de leer `rucContraparte`.
    if (p.libro !== "compras") throw new Error("se esperaba la propuesta de compras");
    expect(p.filas.map((f) => `${f.rucContraparte}-${f.serie}-${f.numero}`).sort()).toEqual([
      "20700000011-F001-1040",
      "20700000045-F001-2056",
      "20700000053-F001-3064",
      "20700000061-F001-4062",
      "20700000070-F001-5070",
    ]);
  });

  it("sin fixture para el RUC devuelve el conjunto genérico con el periodo pedido", async () => {
    const mock = new MockSireApiClient();
    const p = await mock.descargarPropuesta(TOKEN, pedir("20100000001", "202611", "ventas"));
    expect(p.libro).toBe("ventas");
    expect(p.periodo).toBe("202611");
    expect(p.filas.length).toBeGreaterThan(0);
    for (const fila of p.filas) expect(fila.fechaEmision).toMatch(/^2026-11-\d{2}$/);
    // determinista
    expect(await mock.descargarPropuesta(TOKEN, pedir("20100000001", "202611", "ventas"))).toEqual(p);
  });

  it("el genérico no pasa del fin de mes (febrero)", async () => {
    const dir = mkdtempSync(join(dirTemporal, "feb-"));
    writeFileSync(
      join(dir, "generico-compras.json"),
      JSON.stringify({
        libro: "compras",
        periodo: "202610",
        filas: [{ fechaEmision: "2026-10-31", total: "1.00" }],
      }),
    );
    const p = await new MockSireApiClient({ dirFixtures: dir }).descargarPropuesta(
      TOKEN,
      pedir("20100000001", "202602"),
    );
    expect(p.filas[0]?.fechaEmision).toBe("2026-02-28");
  });

  it("mutar la respuesta no altera la siguiente", async () => {
    const mock = new MockSireApiClient();
    const a = await mock.descargarPropuesta(TOKEN, pedir(RUC, "202610", "ventas"));
    const longitud = a.filas.length; // T1 (013): el fixture de ventas ya no tiene solo dos filas.
    a.filas.length = 0;
    const b = await mock.descargarPropuesta(TOKEN, pedir(RUC, "202610", "ventas"));
    expect(b.filas).toHaveLength(longitud);
  });
});

describe("MockSireApiClient fallas", () => {
  it("fallar('401') -> credencial; 'timeout' y '5xx' -> transitorio; 'datos' -> datos", async () => {
    const mock = new MockSireApiClient();
    const esperado = {
      "401": "credencial",
      timeout: "transitorio",
      "5xx": "transitorio",
      datos: "datos",
    } as const;
    for (const [modo, clase] of Object.entries(esperado)) {
      mock.fallar(modo as keyof typeof esperado);
      const e = await mock.descargarPropuesta(TOKEN, pedir(RUC, "202610")).catch((x: unknown) => x);
      expect(clasificarError(e).clase).toBe(clase);
    }
  });

  it("con `veces: 1` falla una vez y luego funciona; fallar(null) restablece", async () => {
    const mock = new MockSireApiClient();
    mock.fallar("timeout", { veces: 1 });
    await expect(mock.descargarPropuesta(TOKEN, pedir(RUC, "202610"))).rejects.toThrow();
    await expect(mock.descargarPropuesta(TOKEN, pedir(RUC, "202610"))).resolves.toBeDefined();
    mock.fallar("401");
    mock.fallar(null);
    await expect(mock.descargarPropuesta(TOKEN, pedir(RUC, "202610"))).resolves.toBeDefined();
  });

  it("centinelas por último dígito del RUC: 7 transitorio, 8 datos, 9 credencial", async () => {
    const mock = new MockSireApiClient();
    const clase = async (ruc: string) =>
      clasificarError(
        await mock.descargarPropuesta(TOKEN, pedir(ruc, "202610")).catch((x: unknown) => x),
      ).clase;
    expect(await clase("20100000007")).toBe("transitorio");
    expect(await clase("20100000008")).toBe("datos");
    expect(await clase("20100000009")).toBe("credencial");
  });

  it("un token vacío es ErrorCredencial", async () => {
    const e = await new MockSireApiClient()
      .descargarPropuesta({ ...TOKEN, token: "" }, pedir(RUC, "202610"))
      .catch((x: unknown) => x);
    expect(clasificarError(e).clase).toBe("credencial");
  });
});

describe("MockSireApiClient entrada inválida", () => {
  const invalidas: Array<[string, string, string]> = [
    ["RUC corto", "2070000000", "202610"],
    ["RUC con letras", "2070000000A", "202610"],
    ["RUC con ruta", "../../etc/passwd", "202610"],
    ["periodo con guion", RUC, "2026-10"],
    ["periodo mes 13", RUC, "202613"],
    ["periodo mes 00", RUC, "202600"],
    ["periodo con ruta", RUC, "../../1"],
    ["periodo vacío", RUC, ""],
  ];

  it.each(invalidas)("%s -> ErrorDatos sin tocar el disco", async (_n, ruc, periodo) => {
    // directorio inexistente: si tocara el disco con una clave válida daría igualmente ErrorDatos,
    // por eso se comprueba además que la llamada no queda en el registro (se rechazó antes).
    const mock = new MockSireApiClient({ dirFixtures: join(dirTemporal, "no-existe") });
    const e = await mock.descargarPropuesta(TOKEN, pedir(ruc, periodo)).catch((x: unknown) => x);
    expect(clasificarError(e)).toEqual({ clase: "datos", motivo: "datos_invalidos" });
    expect(mock.registro()).toHaveLength(0);
  });

  it("libro fuera de catálogo -> ErrorDatos", async () => {
    const e = await new MockSireApiClient()
      .descargarPropuesta(TOKEN, { ruc: RUC, periodo: "202610", libro: "otro" as never })
      .catch((x: unknown) => x);
    expect(clasificarError(e).clase).toBe("datos");
  });

  it("un archivo que no es JSON o sin `filas` es ErrorDatos, sin filtrar su contenido", async () => {
    const dir = mkdtempSync(join(dirTemporal, "malo-"));
    writeFileSync(join(dir, `${RUC}-compras-202610.json`), "CANARIO-CONTENIDO {no json");
    const e = await new MockSireApiClient({ dirFixtures: dir })
      .descargarPropuesta(TOKEN, pedir(RUC, "202610"))
      .catch((x: unknown) => x);
    expect(clasificarError(e).clase).toBe("datos");
    expect(JSON.stringify(e) + String((e as Error).stack)).not.toContain("CANARIO");
  });
});

describe("MockSireApiClient fixtures dañados o ausentes", () => {
  const pedirEn = (dir: string, periodo = "202610", ruc = RUC) =>
    new MockSireApiClient({ dirFixtures: dir })
      .descargarPropuesta(TOKEN, pedir(ruc, periodo))
      .catch((x: unknown) => x);
  const dirCon = (archivos: Record<string, string>): string => {
    const dir = mkdtempSync(join(dirTemporal, "caso-"));
    for (const [nombre, contenido] of Object.entries(archivos)) {
      writeFileSync(join(dir, nombre), contenido);
    }
    return dir;
  };

  it("un periodo que no es texto es ErrorDatos y no queda en el registro", async () => {
    const mock = new MockSireApiClient();
    const e = await mock
      .descargarPropuesta(TOKEN, { ruc: RUC, periodo: 202610 as never, libro: "compras" })
      .catch((x: unknown) => x);
    expect(clasificarError(e).clase).toBe("datos");
    expect(mock.registro()).toHaveLength(0);
  });

  it("sin archivo propio ni genérico es ErrorDatos", async () => {
    expect(clasificarError(await pedirEn(dirCon({}))).clase).toBe("datos");
  });

  it("un JSON sin arreglo `filas` (objeto vacío o null) es ErrorDatos", async () => {
    for (const contenido of ["{}", "null", '{"filas":"no"}']) {
      const dir = dirCon({ [`${RUC}-compras-202610.json`]: contenido });
      expect(clasificarError(await pedirEn(dir)).clase).toBe("datos");
    }
  });

  it("un archivo por encima del tope de tamaño es ErrorDatos", async () => {
    const dir = dirCon({ [`${RUC}-compras-202610.json`]: " ".repeat(1_048_577) });
    expect(clasificarError(await pedirEn(dir)).clase).toBe("datos");
  });

  it("en el genérico, una fecha sin día numérico cae al día 1 del periodo pedido", async () => {
    const fila = { tipo: "01", serie: "F001", numero: "1", fechaEmision: "2026-10-xx" };
    const dir = dirCon({
      "generico-compras.json": JSON.stringify({ filas: [fila] }),
    });
    const p = await new MockSireApiClient({ dirFixtures: dir }).descargarPropuesta(
      TOKEN,
      pedir(RUC, "202602"),
    );
    expect(p.filas[0]?.fechaEmision).toBe("2026-02-01");
  });
});

describe("MockSireApiClient no conserva el token", () => {
  it("el registro y las llamadas no contienen el token", async () => {
    const mock = new MockSireApiClient();
    await mock.descargarPropuesta(TOKEN, pedir(RUC, "202610"));
    await mock.descargarPropuesta(TOKEN, pedir("20100000001", "202610", "ventas"));
    expect(mock.llamadas).toBe(2);
    expect(mock.llamadasDe(RUC)).toBe(1);
    expect(JSON.stringify(mock.registro())).not.toContain(CANARIO);
    expect(JSON.stringify(mock)).not.toContain(CANARIO);
  });
});
