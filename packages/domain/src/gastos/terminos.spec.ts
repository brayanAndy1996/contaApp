// Spec 027 · T1 (rojo). `proponerTerminos(glosas, diccionario) → string[≤ 10]` (R-7, CA-9; plan, Contratos: domain `terminos.ts`):
// tokens normalizados sin punto final, sin números, unidades, palabras vacías ni términos ya activos; en orden de primera aparición.
import { describe, expect, it } from "vitest";
import { diccionarioSemilla } from "../../tests/ayudas/gastos";
import { DiccionarioGlosas, proponerTerminos } from "../index";

const vacio = (): DiccionarioGlosas => DiccionarioGlosas.desde([]);

describe("proponerTerminos · CA-9", () => {
  it("«AUDIFONOS BLUETOOTH JBL X2 UND 2.00» → audifonos, bluetooth, jbl (no «x2», «und» ni «2.00»)", () => {
    expect(proponerTerminos(["AUDIFONOS BLUETOOTH JBL X2 UND 2.00"], diccionarioSemilla())).toEqual(["audifonos", "bluetooth", "jbl"]);
  });

  it("sin tildes ni mayúsculas", () => {
    expect(proponerTerminos(["AUDÍFONOS Inalámbricos"], vacio())).toEqual(["audifonos", "inalambricos"]);
  });

  it("sin el punto final del token", () => {
    expect(proponerTerminos(["AUDIFONOS. JBL."], vacio())).toEqual(["audifonos", "jbl"]);
  });

  it("sin números puros ni decimales", () => {
    expect(proponerTerminos(["cable 2024 15.50 100 usb"], vacio())).toEqual(["cable", "usb"]);
  });

  it("sin unidades (und, pza)", () => {
    expect(proponerTerminos(["cable usb und pza"], vacio())).toEqual(["cable", "usb"]);
  });

  it("sin palabras vacías (de, para, con)", () => {
    expect(proponerTerminos(["cable para laptop con funda de neopreno"], vacio())).toEqual(["cable", "laptop", "funda", "neopreno"]);
  });

  it("solo tokens de 3 a 40 caracteres", () => {
    const largo = "a".repeat(41);
    const justo = "b".repeat(40);
    expect(proponerTerminos([`ab ${largo} ${justo} xyz`], vacio())).toEqual([justo, "xyz"]);
  });
});

describe("proponerTerminos · términos ya activos en el diccionario efectivo", () => {
  it("omite lo que el diccionario ya coincide (incluido el plural)", () => {
    expect(proponerTerminos(["ZAPATILLAS URBANAS"], diccionarioSemilla())).toEqual(["urbanas"]);
  });

  it("omite la abreviatura con punto que el diccionario coincide", () => {
    expect(proponerTerminos(["zapat. deportivas"], diccionarioSemilla())).toEqual(["deportivas"]);
  });

  it("un diccionario sin esa palabra la propone", () => {
    expect(proponerTerminos(["ZAPATILLAS URBANAS"], vacio())).toEqual(["zapatillas", "urbanas"]);
  });
});

describe("proponerTerminos · orden, duplicados y tope", () => {
  it("orden de primera aparición entre glosas y sin repetir", () => {
    expect(proponerTerminos(["cable usb", "adaptador usb", "cable largo"], vacio())).toEqual(["cable", "usb", "adaptador", "largo"]);
  });

  it("el tope es 10 términos: los 10 primeros", () => {
    const palabras = ["alfa", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "iota", "kappa", "lambda", "sigma", "omega"];
    expect(proponerTerminos([palabras.join(" ")], vacio())).toEqual(palabras.slice(0, 10));
  });

  it("el tope también rige entre varias glosas", () => {
    const glosas = Array.from({ length: 15 }, (_, i) => `termino${String.fromCharCode(97 + i)}`);
    expect(proponerTerminos(glosas, vacio())).toEqual(glosas.slice(0, 10));
  });

  it("sin glosas o con glosas sin términos devuelve un arreglo vacío", () => {
    expect(proponerTerminos([], vacio())).toEqual([]);
    expect(proponerTerminos(["", "   ", "12 34.5 und"], vacio())).toEqual([]);
  });

  it("no muta la entrada", () => {
    const glosas = Object.freeze(["AUDIFONOS JBL"]);
    expect(() => proponerTerminos(glosas, vacio())).not.toThrow();
    expect(glosas).toEqual(["AUDIFONOS JBL"]);
  });

  it("una glosa con texto hostil (marcas, <script>, 1 MB) no lanza y solo devuelve términos válidos", () => {
    const r = proponerTerminos(["<script>alert(1)</script>", "x".repeat(1_000_000), "audifonos"], vacio());
    expect(r.length).toBeLessThanOrEqual(10);
    for (const t of r) expect(t).toMatch(/^[a-z0-9]{3,40}$/);
    expect(r).toContain("audifonos");
  });
});
