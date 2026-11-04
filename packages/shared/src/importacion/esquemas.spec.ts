import { describe, expect, it } from "vitest";
import {
  MOTIVOS_FILA_IMPORTACION,
  informeImportacionSchema,
  vistaPreviaSchema,
} from "./esquemas.js";

// Spec 007b (D7, D8, D9; CA-1, CA-8). Contrato fijado por estas pruebas (plan: Contratos HTTP; zod y DTOs de
// importación en packages/shared/src/importacion/esquemas.ts, exportados por el índice de shared):
//  - MOTIVOS_FILA_IMPORTACION = ruc_invalido, duplicado_en_archivo, duplicado, responsable_inexistente,
//    responsable_no_asignable, credencial_incompleta, celda_peligrosa, cupo_rucs (lista cerrada del plan).
//  - vistaPreviaSchema: {filas[{n, ruc, estado: "valida"|"error", motivos[], tieneSol, tieneSire,
//    archivado?}], validas, conError, cupoLibre, excedentes}. `n` entero >= 1 (número de fila del archivo);
//    `motivos` solo admite valores de MOTIVOS_FILA_IMPORTACION; `archivado?: boolean` acompaña al motivo
//    `duplicado` cuando el existente está archivado (sugerencia de reactivar, D9). Contadores enteros >= 0.
//  - informeImportacionSchema: {creadas, noImportadas[{n, ruc, motivo, archivado?}], consultasEncoladas,
//    consultasOmitidas}; `motivo` también de MOTIVOS_FILA_IMPORTACION.
//  - Ningún campo admite el valor de una clave: las claves desconocidas (clave, claveSol, clientSecret, usuarioSol,
//    clientId...) se descartan al parsear, y los campos que podrían alojar texto libre (motivos, estado, tiene*)
//    son enumeraciones o booleanos.
const CANARIO = "CANARIO-CLAVE-no-debe-viajar";
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

const fila = {
  n: 2,
  ruc: "20100070970",
  estado: "valida",
  motivos: [],
  tieneSol: true,
  tieneSire: false,
};
const previa = {
  filas: [
    fila,
    {
      n: 3,
      ruc: "20100070971",
      estado: "error",
      motivos: ["ruc_invalido"],
      tieneSol: false,
      tieneSire: false,
    },
  ],
  validas: 1,
  conError: 1,
  cupoLibre: 5,
  excedentes: 0,
};
const informe = {
  creadas: 3,
  noImportadas: [
    { n: 5, ruc: "20100070970", motivo: "duplicado", archivado: true },
    { n: 9, ruc: "20100070989", motivo: "cupo_rucs" },
  ],
  consultasEncoladas: 3,
  consultasOmitidas: 0,
};

describe("MOTIVOS_FILA_IMPORTACION", () => {
  it("es la lista cerrada del plan", () => {
    expect([...MOTIVOS_FILA_IMPORTACION].sort()).toEqual(
      [
        "celda_peligrosa",
        "credencial_incompleta",
        "cupo_rucs",
        "duplicado",
        "duplicado_en_archivo",
        "responsable_inexistente",
        "responsable_no_asignable",
        "ruc_invalido",
      ].sort(),
    );
  });
});

describe("vistaPreviaSchema", () => {
  it("acepta una vista previa válida y la devuelve igual", () => {
    expect(datos(vistaPreviaSchema, previa)).toEqual(previa);
  });

  it("acepta una vista previa vacía", () => {
    const v = {
      filas: [],
      validas: 0,
      conError: 0,
      cupoLibre: 0,
      excedentes: 0,
    };
    expect(datos(vistaPreviaSchema, v)).toEqual(v);
  });

  it("acepta varios motivos y la marca archivado en un duplicado", () => {
    const f = {
      ...fila,
      estado: "error",
      motivos: ["duplicado", "cupo_rucs"],
      archivado: true,
    };
    const r = datos(vistaPreviaSchema, { ...previa, filas: [f] });
    expect((r.filas as unknown[])[0]).toEqual(f);
  });

  it.each([
    "ruc_invalido",
    "duplicado_en_archivo",
    "duplicado",
    "responsable_inexistente",
    "responsable_no_asignable",
    "credencial_incompleta",
    "celda_peligrosa",
    "cupo_rucs",
  ])("acepta el motivo %s", (m) => {
    const f = { ...fila, estado: "error", motivos: [m] };
    expect(ok(vistaPreviaSchema, { ...previa, filas: [f] })).toBe(true);
  });

  it.each([CANARIO, "otro_motivo", "", "RUC_INVALIDO", 1, null])(
    "los motivos no admiten texto libre: rechaza %j",
    (m) => {
      const f = { ...fila, estado: "error", motivos: [m] };
      expect(ok(vistaPreviaSchema, { ...previa, filas: [f] })).toBe(false);
    },
  );

  it.each([
    ["estado", "dudosa"],
    ["estado", CANARIO],
    ["n", 0],
    ["n", 1.5],
    ["n", "2"],
    ["tieneSol", CANARIO],
    ["tieneSol", "true"],
    ["tieneSire", 1],
    ["tieneSire", null],
    ["ruc", 20100070970],
    ["motivos", "ruc_invalido"],
  ])("rechaza la fila con %s = %j", (campo, valor) => {
    expect(
      ok(vistaPreviaSchema, {
        ...previa,
        filas: [{ ...fila, [campo]: valor }],
      }),
    ).toBe(false);
  });

  it.each(["validas", "conError", "cupoLibre", "excedentes"])(
    "%s es un entero >= 0",
    (campo) => {
      expect(ok(vistaPreviaSchema, { ...previa, [campo]: 0 })).toBe(true);
      expect(ok(vistaPreviaSchema, { ...previa, [campo]: -1 })).toBe(false);
      expect(ok(vistaPreviaSchema, { ...previa, [campo]: 1.5 })).toBe(false);
      expect(ok(vistaPreviaSchema, { ...previa, [campo]: "1" })).toBe(false);
      expect(ok(vistaPreviaSchema, { ...previa, [campo]: undefined })).toBe(
        false,
      );
    },
  );

  it("ningún campo admite el valor de una clave: los campos extra se descartan", () => {
    const sucia = {
      ...previa,
      claveSol: CANARIO,
      filas: [
        {
          ...fila,
          usuarioSol: CANARIO,
          claveSol: CANARIO,
          clave: CANARIO,
          clientId: CANARIO,
          clientSecret: CANARIO,
          razonSocial: "X",
        },
      ],
    };
    const r = datos(vistaPreviaSchema, sucia);
    expect(JSON.stringify(r)).not.toContain("CANARIO");
    expect(
      Object.keys((r.filas as Record<string, unknown>[])[0]!).sort(),
    ).toEqual(
      ["estado", "motivos", "n", "ruc", "tieneSire", "tieneSol"].sort(),
    );
    expect(Object.keys(r).sort()).toEqual(
      ["conError", "cupoLibre", "excedentes", "filas", "validas"].sort(),
    );
  });
});

describe("informeImportacionSchema", () => {
  it("acepta un informe válido y lo devuelve igual", () => {
    expect(datos(informeImportacionSchema, informe)).toEqual(informe);
  });

  it("acepta un informe sin no importadas", () => {
    const v = {
      creadas: 0,
      noImportadas: [],
      consultasEncoladas: 0,
      consultasOmitidas: 0,
    };
    expect(datos(informeImportacionSchema, v)).toEqual(v);
  });

  it.each([CANARIO, "otro", "", 1, null])(
    "el motivo de una no importada no admite texto libre: rechaza %j",
    (m) => {
      const v = {
        ...informe,
        noImportadas: [{ n: 2, ruc: "20100070970", motivo: m }],
      };
      expect(ok(informeImportacionSchema, v)).toBe(false);
    },
  );

  it.each(["creadas", "consultasEncoladas", "consultasOmitidas"])(
    "%s es un entero >= 0",
    (campo) => {
      expect(ok(informeImportacionSchema, { ...informe, [campo]: 0 })).toBe(
        true,
      );
      expect(ok(informeImportacionSchema, { ...informe, [campo]: -1 })).toBe(
        false,
      );
      expect(ok(informeImportacionSchema, { ...informe, [campo]: 0.5 })).toBe(
        false,
      );
      expect(ok(informeImportacionSchema, { ...informe, [campo]: "0" })).toBe(
        false,
      );
    },
  );

  it("ningún campo admite el valor de una clave: los campos extra se descartan", () => {
    const sucia = {
      ...informe,
      clave: CANARIO,
      noImportadas: [
        {
          n: 2,
          ruc: "20100070970",
          motivo: "cupo_rucs",
          claveSol: CANARIO,
          clientSecret: CANARIO,
        },
      ],
    };
    const r = datos(informeImportacionSchema, sucia);
    expect(JSON.stringify(r)).not.toContain("CANARIO");
    expect(
      Object.keys((r.noImportadas as Record<string, unknown>[])[0]!).sort(),
    ).toEqual(["motivo", "n", "ruc"].sort());
  });
});
