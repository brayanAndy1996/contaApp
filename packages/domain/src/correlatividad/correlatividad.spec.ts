// Spec 013 (T3, rojo): analizarCorrelatividad(filas, justificados) (D7, D8; CA-6, CA-7; plan, Contratos: Dominio).
// Contrato que fija la prueba (T9, `packages/domain/src/correlatividad/index.ts`):
//   filas:        { tipo, serie, numero: string }[]                                  (numero tal cual: "290", "00291", "ABC")
//   justificados: { tipo, serie, desde: number, hasta: number, comentario: string }[]  (enteros de 1 a 8 dígitos)
//   resultado:    { series: Serie[] }   — sin ninguna otra clave y, en particular, sin bandera de bloqueo (D7, P-6)
//   Serie:        { tipo, serie, estado: "completa" | "con_faltantes" | "no_evaluable",
//                   faltantes: { desde: number, hasta: number, estado: "pendiente" | "justificado" | "parcial", comentario? }[],
//                   noEvaluables: number }  — `noEvaluables` es la CANTIDAD de filas de la serie con número no evaluable
//   - las series salen ordenadas por tipo y luego por serie (comparación de texto); una por (tipo, serie);
//   - número evaluable = 1 a 8 dígitos ASCII sin contar los ceros a la izquierda (D21, T18: "00291" y "0000000291" = 291); cualquier otro es no evaluable;
//   - faltantes = huecos entre el menor y el mayor número presente (sin expandir: un rango = una entrada), ordenados;
//   - una serie sin ningún número evaluable es `no_evaluable` (sin faltantes); si tiene evaluables se analizan y los demás
//     solo suman a `noEvaluables`;
//   - el faltante cubierto por completo por justificaciones vigentes de su (tipo, serie) es `justificado` (con el comentario
//     cuando lo cubre una sola justificación); cubierto en parte es `parcial` y conserva el rango completo del hueco;
//   - la serie sigue en `con_faltantes` mientras haya huecos, también si todos están justificados;
//   - función pura: no muta las entradas (se prueban congeladas).
import { describe, expect, it } from "vitest";
import { analizarCorrelatividad } from "./index";

type Fila = { tipo: string; serie: string; numero: string };
type Justificado = { tipo: string; serie: string; desde: number; hasta: number; comentario: string };

const f = (tipo: string, serie: string, ...numeros: (string | number)[]): Fila[] =>
  numeros.map((n) => ({ tipo, serie, numero: String(n) }));
const j = (tipo: string, serie: string, desde: number, hasta: number, comentario = "Anulada en caja"): Justificado => ({
  tipo,
  serie,
  desde,
  hasta,
  comentario,
});
const una = (filas: Fila[], justificados: Justificado[] = []) => {
  const r = analizarCorrelatividad(filas, justificados);
  expect(r.series).toHaveLength(1);
  return r.series[0]!;
};

describe("analizarCorrelatividad · el salto (CA-6)", () => {
  it("B001-290 y B001-292: falta la 291", () => {
    expect(una(f("03", "B001", 290, 292))).toEqual({
      tipo: "03",
      serie: "B001",
      estado: "con_faltantes",
      faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
      noEvaluables: 0,
    });
  });

  it("serie completa: «completa» y sin faltantes", () => {
    expect(una(f("01", "F001", 10, 11, 12))).toEqual({
      tipo: "01",
      serie: "F001",
      estado: "completa",
      faltantes: [],
      noEvaluables: 0,
    });
  });

  it("varios saltos salen como rangos, en orden", () => {
    const s = una(f("03", "B003", 400, 401, 405, 410, 411, 420));
    expect(s.estado).toBe("con_faltantes");
    expect(s.faltantes).toEqual([
      { desde: 402, hasta: 404, estado: "pendiente" },
      { desde: 406, hasta: 409, estado: "pendiente" },
      { desde: 412, hasta: 419, estado: "pendiente" },
    ]);
  });

  it("el orden de llegada de las filas no importa", () => {
    expect(una(f("03", "B001", 292, 290)).faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    expect(una(f("03", "B001", 405, 400, 401)).faltantes).toEqual([{ desde: 402, hasta: 404, estado: "pendiente" }]);
  });

  it("los números con ceros a la izquierda cuentan por su valor", () => {
    const s = una(f("03", "B001", "00290", "0292"));
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    expect(s.noEvaluables).toBe(0);
  });

  it("números consecutivos repetidos (duplicados, que trata 012) no inventan faltantes ni los duplican", () => {
    expect(una(f("03", "B001", 290, 290, 292, 292)).faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    expect(una(f("03", "B001", 5, 5, 5))).toMatchObject({ estado: "completa", faltantes: [] });
  });
});

describe("analizarCorrelatividad · solo dentro del periodo (D7, P-5)", () => {
  it("una serie que empieza en 10 no tiene faltantes anteriores", () => {
    expect(una(f("01", "F001", 10, 11, 12))).toMatchObject({ estado: "completa", faltantes: [] });
    expect(una(f("01", "F001", 500, 501))).toMatchObject({ estado: "completa", faltantes: [] });
  });

  it("solo se revisa entre el menor y el mayor número presente", () => {
    const s = una(f("03", "B001", 1000, 1003));
    expect(s.faltantes).toEqual([{ desde: 1001, hasta: 1002, estado: "pendiente" }]);
  });

  it("un solo número no genera faltantes", () => {
    expect(una(f("07", "F001", 1))).toEqual({
      tipo: "07",
      serie: "F001",
      estado: "completa",
      faltantes: [],
      noEvaluables: 0,
    });
    expect(una(f("03", "B001", 99999999))).toMatchObject({ estado: "completa", faltantes: [] });
  });

  it("sin filas no hay series", () => {
    expect(analizarCorrelatividad([], [])).toEqual({ series: [] });
  });
});

describe("analizarCorrelatividad · tipos y series por separado (CA-6)", () => {
  it("cada (tipo, serie) se evalúa por su cuenta, aunque compartan números", () => {
    const r = analizarCorrelatividad(
      [
        ...f("03", "B001", 290, 292),
        ...f("01", "F001", 10, 11, 12),
        ...f("07", "F001", 1),
        ...f("01", "F002", 1, 2),
        ...f("03", "B003", 400, 401, 405),
      ],
      [],
    );
    expect(r.series.map((s) => `${s.tipo} ${s.serie} ${s.estado}`)).toEqual([
      "01 F001 completa",
      "01 F002 completa",
      "03 B001 con_faltantes",
      "03 B003 con_faltantes",
      "07 F001 completa",
    ]);
    expect(r.series[2]!.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    expect(r.series[3]!.faltantes).toEqual([{ desde: 402, hasta: 404, estado: "pendiente" }]);
  });

  it("el número de una serie no «rellena» el hueco de otra serie ni de otro tipo", () => {
    const r = analizarCorrelatividad([...f("03", "B001", 290, 292), ...f("03", "B002", 291), ...f("01", "B001", 291)], []);
    const b001 = r.series.find((s) => s.tipo === "03" && s.serie === "B001")!;
    expect(b001.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
  });

  it("las series salen ordenadas por tipo y luego por serie, sin importar el orden de entrada", () => {
    const r = analizarCorrelatividad([...f("07", "F001", 1), ...f("03", "B002", 1), ...f("01", "F002", 1), ...f("03", "B001", 1), ...f("01", "F001", 1)], []);
    expect(r.series.map((s) => `${s.tipo}-${s.serie}`)).toEqual(["01-F001", "01-F002", "03-B001", "03-B002", "07-F001"]);
  });
});

describe("analizarCorrelatividad · rangos enormes sin expandir (CA-6)", () => {
  it("1 y 99 999 999: un solo faltante 2 a 99 999 998, sin recorrer los números del hueco (tiempo acotado)", () => {
    // packages/domain no usa `process` (lint): la memoria no se mide; recorrer ~100 millones de números tarda segundos.
    const t0 = Date.now();
    const s = una(f("03", "B001", 1, 99999999));
    expect(Date.now() - t0).toBeLessThan(250);
    expect(s.faltantes).toEqual([{ desde: 2, hasta: 99999998, estado: "pendiente" }]);
  });

  it("justificar o cubrir en parte ese rango tampoco lo expande", () => {
    const t0 = Date.now();
    const todo = una(f("03", "B001", 1, 99999999), [j("03", "B001", 2, 99999998)]);
    const parte = una(f("03", "B001", 1, 99999999), [j("03", "B001", 2, 50000000)]);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(todo.faltantes).toEqual([{ desde: 2, hasta: 99999998, estado: "justificado", comentario: "Anulada en caja" }]);
    expect(parte.faltantes).toEqual([{ desde: 2, hasta: 99999998, estado: "parcial" }]);
  });

  it("20 000 filas de una misma serie con un hueco al medio se analizan al instante", () => {
    const filas = f("03", "B001", ...Array.from({ length: 20000 }, (_, i) => (i < 10000 ? i + 1 : i + 2)));
    const t0 = Date.now();
    const s = una(filas);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.faltantes).toEqual([{ desde: 10001, hasta: 10001, estado: "pendiente" }]);
  });
});

describe("analizarCorrelatividad · números no evaluables (CA-6)", () => {
  it("un número con letras, vacío o de más de 8 dígitos es «no evaluable», sin lanzar", () => {
    // T18 (D21): se quitó "000000001" de la lista; con los ceros a la izquierda ignorados es la 1 (ver correcciones-t18.spec.ts).
    for (const malo of ["ABC", "12A", "", "123456789", "100000000", "1.5", "-3", " 12", "１２"]) {
      const s = una(f("03", "B001", malo));
      expect(s, `número «${malo}»`).toEqual({ tipo: "03", serie: "B001", estado: "no_evaluable", faltantes: [], noEvaluables: 1 });
    }
  });

  it("8 dígitos sí se evalúa (99 999 999 es el máximo)", () => {
    expect(una(f("03", "B001", "99999999", "99999997")).faltantes).toEqual([{ desde: 99999998, hasta: 99999998, estado: "pendiente" }]);
  });

  it("una serie con todos sus números no evaluables es «no_evaluable» y los cuenta", () => {
    expect(una(f("03", "B001", "A1", "B2", "C3"))).toEqual({
      tipo: "03",
      serie: "B001",
      estado: "no_evaluable",
      faltantes: [],
      noEvaluables: 3,
    });
  });

  it("mezclada con números evaluables: se analizan los evaluables y los demás solo se cuentan", () => {
    const s = una(f("03", "B001", 290, "ABC", 292, "123456789"));
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    expect(s.noEvaluables).toBe(2);
  });

  it("una serie no evaluable no contagia a las demás", () => {
    const r = analizarCorrelatividad([...f("03", "B001", "ABC"), ...f("03", "B002", 1, 3)], []);
    expect(r.series.map((s) => `${s.serie} ${s.estado}`)).toEqual(["B001 no_evaluable", "B002 con_faltantes"]);
  });
});

describe("analizarCorrelatividad · justificar (HU-12, D8, CA-7)", () => {
  const filas = f("03", "B001", 290, 292);

  it("justificación total: el faltante queda «justificado» con su comentario", () => {
    const s = una(filas, [j("03", "B001", 291, 291, "Boleta anulada en caja")]);
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "justificado", comentario: "Boleta anulada en caja" }]);
  });

  it("la serie sigue en «con_faltantes» aunque todos sus huecos estén justificados (no pasa a «completa»)", () => {
    expect(una(filas, [j("03", "B001", 291, 291)]).estado).toBe("con_faltantes");
  });

  it("justificación parcial: el hueco queda «parcial» y conserva el rango completo (lo no cubierto sigue alertando)", () => {
    const s = una(f("03", "B001", 290, 296), [j("03", "B001", 291, 292)]);
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 295, estado: "parcial" }]);
  });

  it("dos justificaciones que juntas cubren el hueco lo dejan «justificado»", () => {
    const s = una(f("03", "B001", 290, 296), [j("03", "B001", 291, 293, "a"), j("03", "B001", 294, 295, "b")]);
    expect(s.faltantes).toHaveLength(1);
    expect(s.faltantes[0]).toMatchObject({ desde: 291, hasta: 295, estado: "justificado" });
  });

  it("dos justificaciones con un número sin cubrir en medio dejan el hueco «parcial»", () => {
    const s = una(f("03", "B001", 290, 296), [j("03", "B001", 291, 292), j("03", "B001", 294, 295)]);
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 295, estado: "parcial" }]);
  });

  it("una justificación que cubre más que el hueco sirve (el exceso se ignora)", () => {
    const s = una(filas, [j("03", "B001", 280, 300)]);
    expect(s.faltantes[0]).toMatchObject({ desde: 291, hasta: 291, estado: "justificado" });
  });

  it("justificación fuera de rango (no toca ningún hueco): se ignora, el hueco sigue pendiente y no lanza", () => {
    const s = una(filas, [j("03", "B001", 300, 310), j("03", "B001", 1, 5)]);
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
  });

  it("una justificación no crea huecos: sobre una serie completa no cambia nada", () => {
    expect(una(f("03", "B001", 290, 291, 292), [j("03", "B001", 291, 291)])).toMatchObject({ estado: "completa", faltantes: [] });
  });

  it("solo valen las justificaciones de su (tipo, serie)", () => {
    const s = una(filas, [j("03", "B002", 291, 291), j("01", "B001", 291, 291)]);
    expect(s.faltantes).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
  });

  it("cada hueco se justifica por separado: uno justificado y otro pendiente", () => {
    const s = una(f("03", "B003", 400, 401, 405, 408), [j("03", "B003", 402, 404, "Serie de prueba")]);
    expect(s.faltantes).toEqual([
      { desde: 402, hasta: 404, estado: "justificado", comentario: "Serie de prueba" },
      { desde: 406, hasta: 407, estado: "pendiente" },
    ]);
  });

  it("una justificación con rango invertido (desde > hasta) no hace lanzar y no justifica nada", () => {
    expect(() => analizarCorrelatividad(filas, [j("03", "B001", 5, 4)])).not.toThrow();
    expect(una(filas, [j("03", "B001", 5, 4)]).faltantes[0]).toMatchObject({ estado: "pendiente" });
  });
});

describe("analizarCorrelatividad · no muta y no bloquea", () => {
  const congelar = <T>(x: T): T => {
    if (typeof x === "object" && x !== null) {
      for (const v of Object.values(x)) congelar(v);
      Object.freeze(x);
    }
    return x;
  };

  it("no muta las entradas (congeladas) ni el orden de las filas", () => {
    const filas = congelar([...f("03", "B001", 292, 290), ...f("01", "F001", 12, 10)]);
    const justificados = congelar([j("03", "B001", 291, 291)]);
    const copiaFilas = JSON.stringify(filas);
    const copiaJust = JSON.stringify(justificados);
    expect(() => analizarCorrelatividad(filas, justificados)).not.toThrow();
    expect(JSON.stringify(filas)).toBe(copiaFilas);
    expect(JSON.stringify(justificados)).toBe(copiaJust);
  });

  it("es determinista: el mismo resultado en cada llamada y sin compartir objetos entre llamadas", () => {
    const filas = f("03", "B001", 290, 292);
    const a = analizarCorrelatividad(filas, []);
    const b = analizarCorrelatividad(filas, []);
    expect(a).toEqual(b);
    expect(a.series[0]!.faltantes).not.toBe(b.series[0]!.faltantes);
  });

  it("sin bandera de bloqueo: el resultado solo tiene `series` y ninguna clave habla de bloqueo (R-NUM es una alerta)", () => {
    const r = analizarCorrelatividad([...f("03", "B001", 290, 292), ...f("03", "B002", "ABC")], [j("03", "B001", 291, 291)]);
    expect(Object.keys(r)).toEqual(["series"]);
    expect(JSON.stringify(r)).not.toMatch(/bloque|bloquea|impide|critico|error/i);
    for (const s of r.series) {
      expect(Object.keys(s).sort()).toEqual(["estado", "faltantes", "noEvaluables", "serie", "tipo"]);
      for (const x of s.faltantes) expect(Object.keys(x).sort()).toEqual(expect.arrayContaining(["desde", "estado", "hasta"]));
    }
  });

  it("`desde` y `hasta` de los faltantes son enteros y desde <= hasta", () => {
    const s = una(f("03", "B001", 1, 4, 5, 9, 99999999));
    for (const x of s.faltantes) {
      expect(Number.isSafeInteger(x.desde)).toBe(true);
      expect(Number.isSafeInteger(x.hasta)).toBe(true);
      expect(x.desde).toBeLessThanOrEqual(x.hasta);
    }
    expect(s.faltantes.map((x) => [x.desde, x.hasta])).toEqual([
      [2, 3],
      [6, 8],
      [10, 99999998],
    ]);
  });
});
