// Spec 014 · T1 (rojo). Clave normalizada de comprobante (D-1, CA-8, frontera con 013).
// Contrato fijado por estas pruebas (plan 014, Contratos: Dominio), en packages/domain/src/compras/clave.ts,
// exportado por compras/index.ts:
//   claveComprobante(comprobante: IdComprobante, proveedor: DocProveedor): string
// Misma normalización que los duplicados de 012: serie en mayúsculas ASCII, número sin ceros a la izquierda
// ("000" queda "0"), documento del proveedor (tipo y número) en mayúsculas ASCII; el tipo de comprobante
// cuenta. La cadena es opaca (solo se compara por igualdad): estas pruebas no fijan su formato. No lanza.
import { describe, expect, it } from "vitest";
import { prevalidar } from "../prevalidacion/index";
import { CABECERA, filaReemplazo } from "../../tests/ayudas/filas-reemplazo";
import { claveComprobante } from "./index";

const PROV = { tipo: "6", numero: "20100070970" };
const COMP = { tipo: "01", serie: "F001", numero: "123" };
const clave = (c: Partial<typeof COMP> = {}, p: Partial<typeof PROV> = {}) =>
  claveComprobante({ ...COMP, ...c }, { ...PROV, ...p });

describe("claveComprobante: normalización", () => {
  it("devuelve una cadena y es determinista", () => {
    expect(typeof clave()).toBe("string");
    expect(clave()).toBe(clave());
  });

  it("la serie en minúsculas es la misma clave que en mayúsculas", () => {
    expect(clave({ serie: "f001" })).toBe(clave({ serie: "F001" }));
  });

  it("los ceros a la izquierda del número no cuentan", () => {
    expect(clave({ numero: "0000123" })).toBe(clave({ numero: "123" }));
  });

  it("«000» y «0» son la misma clave y no quedan en cadena vacía", () => {
    expect(clave({ numero: "000" })).toBe(clave({ numero: "0" }));
    expect(clave({ numero: "000" })).not.toBe(clave({ numero: "1" }));
  });

  it("los ceros intermedios o finales sí cuentan", () => {
    expect(clave({ numero: "1023" })).not.toBe(clave({ numero: "123" }));
    expect(clave({ numero: "1230" })).not.toBe(clave({ numero: "123" }));
  });

  it("el número del documento del proveedor va en mayúsculas ASCII", () => {
    expect(clave({}, { tipo: "4", numero: "ab123456" })).toBe(clave({}, { tipo: "4", numero: "AB123456" }));
  });

  it("solo a-z se pasa a mayúsculas: una minúscula no ASCII no se pliega", () => {
    expect(clave({ serie: "ñ001" })).not.toBe(clave({ serie: "Ñ001" }));
  });
});

describe("claveComprobante: lo que distingue un comprobante de otro", () => {
  it.each([
    ["tipo de comprobante", { tipo: "03" }, {}],
    ["serie", { serie: "F002" }, {}],
    ["número", { numero: "124" }, {}],
    ["tipo de documento del proveedor", {}, { tipo: "1" }],
    ["número de documento del proveedor", {}, { numero: "20100070971" }],
  ] as const)("cambiar el %s da otra clave", (_nombre, c, p) => {
    expect(clave({ ...c }, { ...p })).not.toBe(clave());
  });

  it("no hay colisión por concatenación entre serie y número", () => {
    expect(clave({ serie: "F1", numero: "2" })).not.toBe(clave({ serie: "F", numero: "12" }));
    expect(clave({ serie: "F001", numero: "1" }, { tipo: "6", numero: "2010" })).not.toBe(
      clave({ serie: "F001", numero: "12" }, { tipo: "6", numero: "010" }),
    );
  });
});

describe("claveComprobante coincide con los duplicados de 012", () => {
  /** 012 marca DUPLICADO en las dos copias si y solo si tienen la misma clave. */
  const duplicanEn012 = (a: [typeof COMP, typeof PROV], b: [typeof COMP, typeof PROV]): boolean => {
    const r = prevalidar(
      [
        filaReemplazo(undefined, { id: "a", comprobante: a[0], proveedor: a[1] }),
        filaReemplazo(undefined, { id: "b", comprobante: b[0], proveedor: b[1] }),
      ],
      { cabecera: CABECERA },
    );
    return r.errores.some((e) => e.codigo === "DUPLICADO");
  };
  const mismaClave = (a: [typeof COMP, typeof PROV], b: [typeof COMP, typeof PROV]): boolean =>
    claveComprobante(...a) === claveComprobante(...b);

  const pares: [string, [typeof COMP, typeof PROV], [typeof COMP, typeof PROV]][] = [
    ["idénticos", [COMP, PROV], [COMP, PROV]],
    ["serie en minúsculas", [COMP, PROV], [{ ...COMP, serie: "f001" }, PROV]],
    ["ceros a la izquierda", [COMP, PROV], [{ ...COMP, numero: "000123" }, PROV]],
    ["documento en minúsculas", [COMP, { tipo: "4", numero: "AB123456" }], [COMP, { tipo: "4", numero: "ab123456" }]],
    ["otro número", [COMP, PROV], [{ ...COMP, numero: "124" }, PROV]],
    ["otro tipo de comprobante", [COMP, PROV], [{ ...COMP, tipo: "03" }, PROV]],
    ["otro proveedor", [COMP, PROV], [COMP, { ...PROV, numero: "20100070971" }]],
    ["otro tipo de documento", [COMP, PROV], [COMP, { ...PROV, tipo: "1" }]],
  ];

  it.each(pares)("%s: misma decisión que 012", (_n, a, b) => {
    expect(mismaClave(a, b)).toBe(duplicanEn012(a, b));
  });
});
