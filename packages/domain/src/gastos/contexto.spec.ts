// Spec 027 · T1 (rojo). Contexto de la R-GP (R-2, D-5; CA-6; plan, Contratos: domain `contexto.ts`): `crearDiccionarioEfectivo` y
// `validarContextoGastos`. Supuesto de contrato de T1: `globales` y `propias` son {palabra, categoria, excepciones, activa} y
// `desactivadas` son las palabras globales que el estudio desactivó.
import { beforeEach, describe, expect, it } from "vitest";
import { congelar, contextoGastos, diccionarioSemilla, SEMILLA_GLOBAL } from "../../tests/ayudas/gastos";
import type { PalabraPlana } from "../../tests/ayudas/gastos";
import { crearDiccionarioEfectivo, validarContextoGastos } from "../index";

/** Un `toThrow()` pasaría con un `TypeError` por export ausente: se exige primero que existan (rojo explícito). */
beforeEach(() => {
  expect(typeof crearDiccionarioEfectivo, "crearDiccionarioEfectivo no está exportada por @contapp/domain").toBe("function");
  expect(typeof validarContextoGastos, "validarContextoGastos no está exportada por @contapp/domain").toBe("function");
});

const propia = (palabra: string, categoria = "entretenimiento", extra: Partial<PalabraPlana> = {}): PalabraPlana => ({
  palabra,
  categoria,
  excepciones: [],
  activa: true,
  ...extra,
});
const global = (palabra: string, categoria: string, extra: Partial<PalabraPlana> = {}): PalabraPlana => ({
  palabra,
  categoria,
  excepciones: [],
  activa: true,
  ...extra,
});
const coincide = (d: ReturnType<typeof crearDiccionarioEfectivo>, glosa: string) => d.coincidenciasPorItem([glosa]).map((c) => c.palabra);

describe("crearDiccionarioEfectivo · global activo − desactivadas + propias activas", () => {
  it("una global activa coincide", () => {
    const d = crearDiccionarioEfectivo({ globales: [global("polo", "calzado-ropa")], desactivadas: [], propias: [] });
    expect(coincide(d, "POLO AZUL")).toEqual(["polo"]);
  });

  it("una global inactiva (la apagó el super-admin) no coincide", () => {
    const d = crearDiccionarioEfectivo({ globales: [global("polo", "calzado-ropa", { activa: false })], desactivadas: [], propias: [] });
    expect(coincide(d, "POLO AZUL")).toEqual([]);
  });

  it("una global desactivada por el estudio no coincide; las demás sí (CA-7)", () => {
    const d = crearDiccionarioEfectivo({
      globales: [global("polo", "calzado-ropa"), global("blusa", "calzado-ropa")],
      desactivadas: ["polo"],
      propias: [],
    });
    expect(coincide(d, "POLO Y BLUSA")).toEqual(["blusa"]);
  });

  it("una propia activa suma (CA-7: «audifono» del estudio A)", () => {
    const d = crearDiccionarioEfectivo({ globales: [], desactivadas: [], propias: [propia("audifono")] });
    expect(coincide(d, "AUDÍFONOS BLUETOOTH")).toEqual(["audifono"]);
  });

  it("una propia inactiva no coincide", () => {
    const d = crearDiccionarioEfectivo({ globales: [], desactivadas: [], propias: [propia("audifono", "entretenimiento", { activa: false })] });
    expect(coincide(d, "AUDIFONOS")).toEqual([]);
  });

  it("una propia con la misma palabra que una global la reemplaza (categoría y excepciones)", () => {
    const d = crearDiccionarioEfectivo({
      globales: [global("polo", "calzado-ropa", { excepciones: ["a tierra"] })],
      desactivadas: [],
      propias: [propia("polo", "utiles-escolares", { excepciones: ["escolar"] })],
    });
    expect(d.coincidenciasPorItem(["polo azul"])).toEqual([{ item: 0, palabra: "polo", categoria: "utiles-escolares" }]);
    // La excepción de la global ya no rige; la de la propia sí.
    expect(coincide(d, "polo a tierra")).toEqual(["polo"]);
    expect(coincide(d, "polo escolar")).toEqual([]);
  });

  it("una propia inactiva con la misma palabra que una global no la reemplaza: rige la global", () => {
    const d = crearDiccionarioEfectivo({
      globales: [global("polo", "calzado-ropa")],
      desactivadas: [],
      propias: [propia("polo", "utiles-escolares", { activa: false })],
    });
    expect(d.coincidenciasPorItem(["polo azul"])).toEqual([{ item: 0, palabra: "polo", categoria: "calzado-ropa" }]);
  });

  it("una global desactivada y recreada como propia: rige la propia", () => {
    const d = crearDiccionarioEfectivo({
      globales: [global("polo", "calzado-ropa")],
      desactivadas: ["polo"],
      propias: [propia("polo", "entretenimiento")],
    });
    expect(d.coincidenciasPorItem(["polo azul"])).toEqual([{ item: 0, palabra: "polo", categoria: "entretenimiento" }]);
  });

  it("la semilla completa funciona y las excepciones de la semilla rigen (CA-4)", () => {
    const d = diccionarioSemilla();
    expect(coincide(d, "ZAPATILLAS URBANAS T-42")).toEqual(["zapatilla"]);
    expect(coincide(d, "zapatilla de seguridad")).toEqual([]);
    expect(coincide(d, "polo a tierra")).toEqual([]);
  });

  it("el orden de globales, desactivadas y propias no cambia el resultado (R-2)", () => {
    const propias = [propia("audifono"), propia("tablet", "entretenimiento"), propia("juego", "juguetes")];
    const a = crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: ["polo", "blusa"], propias });
    const b = crearDiccionarioEfectivo({
      globales: [...SEMILLA_GLOBAL].reverse(),
      desactivadas: ["blusa", "polo"],
      propias: [...propias].reverse(),
    });
    const glosas = ["AUDIFONOS Y TABLET", "polo y blusa y perfume", "zapatilla juego"];
    expect(b.coincidenciasPorItem(glosas)).toEqual(a.coincidenciasPorItem(glosas));
  });

  it("no muta lo recibido (entrada congelada)", () => {
    const entrada = congelar({ globales: [...SEMILLA_GLOBAL], desactivadas: ["polo"], propias: [propia("audifono")] });
    expect(() => crearDiccionarioEfectivo(entrada)).not.toThrow();
  });

  it("una palabra propia inválida (con espacios o de 2 letras) lanza", () => {
    expect(() => crearDiccionarioEfectivo({ globales: [], desactivadas: [], propias: [propia("dos palabras")] })).toThrow();
    expect(() => crearDiccionarioEfectivo({ globales: [], desactivadas: [], propias: [propia("ab")] })).toThrow();
  });
});

describe("validarContextoGastos · CA-6", () => {
  const valido = (): Record<string, unknown> => ({ ...contextoGastos() });

  it("un contexto bien formado pasa y conserva el umbral y el CIIU del cliente", () => {
    const v = validarContextoGastos(valido());
    expect(v.umbral).toBe(3);
    expect(v.ciiuCliente).toBe("4752");
  });

  it("acepta un contexto congelado y con CIIU nulos", () => {
    const c = congelar(contextoGastos({ ciiuCliente: null, ciiuProveedores: [{ proveedor: { tipo: "6", numero: "20700000070" }, ciiu: null }] }));
    expect(() => validarContextoGastos(c)).not.toThrow();
  });

  it.each([[1], [3], [20]])("umbral %i es válido", (umbral) => {
    expect(() => validarContextoGastos({ ...valido(), umbral })).not.toThrow();
  });

  it.each([[0], [21], [-1], [3.5], ["3"], [null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])("umbral %j se rechaza", (umbral) => {
    expect(() => validarContextoGastos({ ...valido(), umbral })).toThrow();
  });

  it("una clave extra en la raíz se rechaza", () => {
    expect(() => validarContextoGastos({ ...valido(), extra: 1 })).toThrow();
  });

  it("una clave requerida ausente se rechaza", () => {
    for (const k of ["diccionario", "umbral", "ciiuCliente", "ciiuProveedores", "categoriasCliente", "historial"]) {
      const c = valido();
      delete c[k];
      expect(() => validarContextoGastos(c), `sin ${k}`).toThrow();
    }
  });

  it("un `__proto__` propio se rechaza (en la raíz y en un objeto anidado)", () => {
    const raiz = valido();
    Object.defineProperty(raiz, "__proto__", { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expect(() => validarContextoGastos(raiz)).toThrow();

    const cat: Record<string, unknown> = { permitidas: [], quitadas: [] };
    Object.defineProperty(cat, "__proto__", { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expect(() => validarContextoGastos({ ...valido(), categoriasCliente: cat })).toThrow();
  });

  it("un número donde va una cadena se rechaza (CIIU y documentos)", () => {
    expect(() => validarContextoGastos({ ...valido(), ciiuCliente: 4752 })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), ciiuProveedores: [{ proveedor: { tipo: "6", numero: 20700000070 }, ciiu: "4771" }] })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), ciiuProveedores: [{ proveedor: { tipo: "6", numero: "20700000070" }, ciiu: 4771 }] })).toThrow();
  });

  it("un CIIU que no es de 4 dígitos se rechaza", () => {
    expect(() => validarContextoGastos({ ...valido(), ciiuCliente: "47a" })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), ciiuCliente: "475" })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), ciiuProveedores: [{ proveedor: { tipo: "6", numero: "20700000070" }, ciiu: "47711" }] })).toThrow();
  });

  it.each([[1.5], [-1], ["2"], [null], [Number.NaN]])("un conteo del historial %j (no entero o negativo) se rechaza", (n) => {
    const proveedor = { tipo: "6", numero: "20700000070" };
    for (const campo of ["aceptadas6", "excluidas6", "excluidas12"]) {
      const fila = { proveedor, aceptadas6: 0, excluidas6: 0, excluidas12: 0, [campo]: n };
      expect(() => validarContextoGastos({ ...valido(), historial: [fila] }), campo).toThrow();
    }
  });

  it("claves extra en una fila de historial, de CIIU o de categorías se rechazan", () => {
    const proveedor = { tipo: "6", numero: "20700000070" };
    expect(() => validarContextoGastos({ ...valido(), historial: [{ proveedor, aceptadas6: 0, excluidas6: 0, excluidas12: 0, extra: 1 }] })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), ciiuProveedores: [{ proveedor, ciiu: null, extra: 1 }] })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), categoriasCliente: { permitidas: [], quitadas: [], extra: [] } })).toThrow();
  });

  it("un diccionario que no es un DiccionarioGlosas real se rechaza", () => {
    expect(() => validarContextoGastos({ ...valido(), diccionario: {} })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), diccionario: { coincidenciasPorItem: () => [] } })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), diccionario: null })).toThrow();
  });

  it("arreglos que no son arreglos y raíces que no son objetos se rechazan", () => {
    expect(() => validarContextoGastos({ ...valido(), historial: {} })).toThrow();
    expect(() => validarContextoGastos({ ...valido(), ciiuProveedores: "x" })).toThrow();
    for (const raiz of [null, undefined, 1, "x", []]) expect(() => validarContextoGastos(raiz)).toThrow();
  });

  it("no muta la entrada", () => {
    const c = congelar(contextoGastos());
    const antes = JSON.stringify({ ...c, diccionario: null });
    validarContextoGastos(c);
    expect(JSON.stringify({ ...c, diccionario: null })).toBe(antes);
  });
});
