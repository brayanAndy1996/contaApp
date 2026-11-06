// Spec 012 · T14: casos de las rutas nuevas de la corrección de la ronda 1 (D19, D20, H-012-1 a
// H-012-30). Las variantes adversariales están en ronda1a/ronda1b; aquí, el caso feliz y el de
// error de cada comportamiento nuevo. Solo API pública.
import { describe, expect, it } from "vitest";
import {
  EntradaPrevalidacionInvalidaError,
  EntradaReglasInvalidaError,
  RegistroFormatos,
  generarTxt,
  prevalidar,
  seleccionarFormato,
} from "../index";
import type { CampoTxt, FilaReemplazo } from "../index";
import { CABECERA, ctxBase, filaReemplazo } from "../../tests/ayudas/filas-reemplazo";

const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}) =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Parameters<typeof prevalidar>[1]);

const PROVISIONAL = seleccionarFormato("compras", "202610");

/** Registro «oficial» derivado del provisional con un campo cambiado. */
function registroCon(cambiar: (c: CampoTxt) => CampoTxt): RegistroFormatos {
  const campos = PROVISIONAL.campos.map((c) => {
    const base: CampoTxt = { nombre: c.nombre, obligatorio: c.obligatorio, longitudMax: c.longitudMax, tipo: c.tipo };
    const patron = c.patron;
    return cambiar(patron === undefined ? base : { ...base, patron });
  });
  return RegistroFormatos.desde([{ ...PROVISIONAL, version: "t14", oficial: true, campos }]);
}

const comp = (numero: string) => ({ tipo: "01", serie: "F001", numero });

describe("evaluarReglas aislado por fila (D19)", () => {
  it("si el lote falla por una fila, las demás conservan sus avisos, ordenados por id, y la fila no pierde errores", () => {
    const registro = registroCon((c) => (c.nombre === "serie" ? { nombre: "serie", obligatorio: true, longitudMax: 4, tipo: c.tipo } : c));
    const filas = [
      filaReemplazo({ biDg: "770.00" }, { id: "b", comprobante: comp("2") }),
      filaReemplazo({ biDg: "770.00" }, { id: "c", comprobante: { tipo: "01", serie: "F-01", numero: "3" } }),
      filaReemplazo({ biDg: "770.00" }, { id: "a", comprobante: comp("1") }),
    ];
    const sin = prev(filas, { registro });
    const con = prev(filas, { registro, reglas: ctxBase() });
    expect(con.errores).toEqual(sin.errores);
    expect(con.avisos.map((a) => `${a.filaId}:${a.codigo}`)).toEqual(["a:R-ISC", "b:R-ISC"]);
  });

  it("un contexto de reglas malformado lanza EntradaReglasInvalidaError aunque ninguna fila llegue a las reglas", () => {
    const conRucMalo = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070971" } });
    expect(prev([conRucMalo], { reglas: ctxBase() }).apto).toBe(false);
    expect(() => prev([conRucMalo], { reglas: { ...ctxBase(), diccionario: {} } })).toThrow(EntradaReglasInvalidaError);
  });

  it("`reglas: null` lanza EntradaPrevalidacionInvalidaError; `reglas: undefined` es «sin reglas»", () => {
    expect(() => prev([filaReemplazo()], { reglas: null })).toThrow(EntradaPrevalidacionInvalidaError);
    expect(prev([filaReemplazo()], { reglas: undefined }).apto).toBe(true);
  });
});

describe("campos no textuales contra el formato (H-012-23)", () => {
  it("el periodo de la cabecera se valida una vez, con filaId null", () => {
    const registro = registroCon((c) => (c.nombre === "periodo" ? { ...c, longitudMax: 4 } : c));
    const r = prev([filaReemplazo(undefined, { id: "a", comprobante: comp("1") }), filaReemplazo(undefined, { id: "b", comprobante: comp("2") })], {
      registro,
    });
    expect(r.errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`)).toEqual(["null:LONGITUD:periodo"]);
    expect(prev([filaReemplazo()]).errores).toEqual([]);
  });

  it("una fecha inválida y un TC de USD inválido o ausente no suman un error de estructura a su error propio", () => {
    const registro = registroCon((c) => (c.nombre === "fechaEmision" || c.nombre === "tipoCambio" ? { ...c, longitudMax: 1 } : c));
    const r = prev(
      [
        filaReemplazo(undefined, { id: "a", comprobante: comp("1"), fechaEmision: "2026-02-30" }),
        filaReemplazo(undefined, { id: "b", comprobante: comp("2"), moneda: "USD", tipoCambio: "abc" }),
        filaReemplazo(undefined, { id: "c", comprobante: comp("3"), moneda: "USD", tipoCambio: null }),
      ],
      { registro },
    );
    expect(r.errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`)).toEqual([
      "a:FECHA_INVALIDA:fechaEmision",
      "b:LONGITUD:fechaEmision",
      "b:TC_INVALIDO:tipoCambio",
      "c:LONGITUD:fechaEmision",
      "c:USD_SIN_TC:tipoCambio",
    ]);
  });

  it("fecha y TC válidos se validan tal como se serializan; un TC obligatorio en PEN es CAMPO_OBLIGATORIO", () => {
    const registro = registroCon((c) => {
      if (c.nombre === "fechaEmision") return { ...c, longitudMax: 9 };
      if (c.nombre === "tipoCambio") return { ...c, obligatorio: true, patron: /^[0-9]\.[0-9]{3}$/ };
      return c;
    });
    const r = prev(
      [
        filaReemplazo(undefined, { id: "a", comprobante: comp("1") }),
        filaReemplazo(undefined, { id: "b", comprobante: comp("2"), moneda: "USD", tipoCambio: "3.5" }),
        filaReemplazo(undefined, { id: "c", comprobante: comp("3"), moneda: "USD", tipoCambio: "13.5" }),
      ],
      { registro },
    );
    expect(r.errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`)).toEqual([
      "a:CAMPO_OBLIGATORIO:tipoCambio",
      "a:LONGITUD:fechaEmision",
      "b:LONGITUD:fechaEmision",
      "c:LONGITUD:fechaEmision",
      "c:PATRON:tipoCambio",
    ]);
  });
});

describe("explicación de DUPLICADO acotada (H-012-2)", () => {
  const copias = (n: number) =>
    Array.from({ length: n }, (_, i) => filaReemplazo(undefined, { id: `d${String(i).padStart(2, "0")}` }));

  it("con 21 copias nombra las otras 20 sin «más»; con 22 nombra 20 y cuenta la que falta", () => {
    const veintiuna = prev(copias(21)).errores.filter((e) => e.codigo === "DUPLICADO");
    expect(veintiuna[0]?.explicacion).toBe(
      `El comprobante se repite en las filas ${Array.from({ length: 20 }, (_, i) => `d${String(i + 1).padStart(2, "0")}`).join(", ")}`,
    );
    const veintidos = prev(copias(22)).errores.filter((e) => e.codigo === "DUPLICADO");
    expect(veintidos).toHaveLength(22);
    expect(veintidos[0]?.explicacion.endsWith("d20 y 1 más")).toBe(true);
    expect(veintidos[21]?.explicacion.endsWith("d19 y 1 más")).toBe(true);
    expect(veintidos[21]?.explicacion).toContain("d00, d01");
  });

  it("dos copias siguen nombrando a la otra, sin «más»", () => {
    const r = prev([filaReemplazo(undefined, { id: "a" }), filaReemplazo(undefined, { id: "b" })]);
    expect(r.errores.map((e) => e.explicacion)).toEqual([
      "El comprobante se repite en las filas b",
      "El comprobante se repite en las filas a",
    ]);
  });
});

describe("IGV sin base o de signo contrario (H-012-1, D18)", () => {
  it("IGV 0.00 con base distinta de cero no es error; IGV −0.01 con base 0.01 sí", () => {
    expect(prev([filaReemplazo({ biDg: "770.00" })]).errores).toEqual([]);
    const r = prev([filaReemplazo({ biDg: "0.01", igvDg: "-0.01" })]);
    expect(r.errores.map((e) => `${e.codigo}:${e.destino}`)).toEqual(["IGV:DG"]);
  });

  it("el TXT de una fila válida no cambia por validar los campos no textuales", () => {
    const r = generarTxt([filaReemplazo()], CABECERA, { permitirProvisional: true });
    expect(r.lineas).toBe(1);
  });
});
