import { describe, expect, it } from "vitest";
import { CABECERA, entradasDe } from "../../../test/soporte-importacion.js";
import { leerXlsx } from "./lector-xlsx.js";
import { generarPlantilla } from "./plantilla.js";

describe("generarPlantilla (D7)", () => {
  it("se genera en memoria sin parámetros: no depende de ningún estudio", () => {
    expect(generarPlantilla.length).toBe(0);
    const datos = generarPlantilla();
    expect(datos).toBeInstanceOf(Uint8Array);
    expect(datos.length).toBeGreaterThan(0);
  });

  it("trae la cabecera completa en la primera hoja y una hoja «Instrucciones»", () => {
    const partes = entradasDe(generarPlantilla());
    const todo = Object.values(partes).join("\n");
    for (const columna of CABECERA) expect(todo, columna).toContain(columna);
    expect(partes["xl/workbook.xml"]).toContain("Instrucciones");
    // la primera hoja es la de datos, no la de instrucciones
    expect(partes["xl/workbook.xml"]?.indexOf("Instrucciones")).toBeGreaterThan(
      partes["xl/workbook.xml"]!.search(/<sheet /),
    );
  });

  it("las instrucciones indican que el responsable se identifica por su correo (P1 a)", () => {
    const todo = Object.values(entradasDe(generarPlantilla()))
      .join("\n")
      .toLowerCase();
    expect(todo).toContain("correo");
  });

  it("no trae filas de datos ni fórmulas: subirla intacta no crea nada", () => {
    const partes = entradasDe(generarPlantilla());
    expect(
      Object.values(partes).some((x) => x.includes("<f>") || x.includes("<f ")),
    ).toBe(false);
    expect(leerXlsx(generarPlantilla()).filas).toEqual([]);
  });

  it("es determinista y no contiene RUC ni correos de ningún estudio", () => {
    const todo = Object.values(entradasDe(generarPlantilla())).join("\n");
    expect(todo).not.toMatch(/\b(10|15|16|17|20)\d{9}\b/);
    expect(todo).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});
