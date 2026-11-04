import { validarRuc, type Rol } from "@contapp/shared";
import { describe, expect, it } from "vitest";
import { rucConPrefijo } from "../../../test/soporte-importacion.js";
import type { FilaLeida } from "./tipos.js";
import {
  aVistaPrevia,
  validarFilas,
  type ContextoValidacion,
} from "./validar-filas.js";

const USUARIO = (n: number) =>
  `0190a000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const miembro = (n: number, rol: Rol) => ({ usuarioId: USUARIO(n), rol });

const ctx = (extra: Partial<ContextoValidacion> = {}): ContextoValidacion => ({
  existentes: new Map(),
  miembros: new Map([
    ["ana@estudio.pe", miembro(1, "contador")],
    ["beto@estudio.pe", miembro(2, "asistente")],
    ["lola@estudio.pe", miembro(3, "lectura")],
  ]),
  ...extra,
});

let serie = 0;
const fila = (ov: Partial<FilaLeida> = {}): FilaLeida => ({
  n: 2 + serie,
  ruc: rucConPrefijo("20", 100 + serie++),
  razonSocial: "",
  usuarioSol: "",
  claveSol: "",
  clientId: "",
  clientSecret: "",
  responsable: "",
  formulas: [],
  ...ov,
});
const una = (ov: Partial<FilaLeida>, c = ctx()) =>
  validarFilas([fila(ov)], c)[0]!;
const codigos = (f: { motivos: Array<{ codigo: string }> }) =>
  f.motivos.map((m) => m.codigo);

describe("validarFilas · fila válida (CA-1)", () => {
  it("solo el RUC exige valor: sin claves ni responsable es válida", () => {
    const r = una({});
    expect(r).toMatchObject({
      estado: "valida",
      motivos: [],
      tieneSol: false,
      tieneSire: false,
      responsableId: null,
    });
  });

  it("con los dos pares completos y un responsable por correo", () => {
    const r = una({
      usuarioSol: "U",
      claveSol: "C",
      clientId: "I",
      clientSecret: "S",
      responsable: "ana@estudio.pe",
    });
    expect(r).toMatchObject({
      estado: "valida",
      tieneSol: true,
      tieneSire: true,
      responsableId: USUARIO(1),
    });
  });

  it("el correo del responsable se compara sin mayúsculas ni espacios laterales", () => {
    expect(una({ responsable: "  ANA@Estudio.PE " })).toMatchObject({
      estado: "valida",
      responsableId: USUARIO(1),
    });
  });

  it("un asistente puede ser responsable (D18: quien clasifica SIRE)", () => {
    expect(una({ responsable: "beto@estudio.pe" })).toMatchObject({
      estado: "valida",
      responsableId: USUARIO(2),
    });
  });

  it("conserva el número de fila del archivo y el orden", () => {
    const filas = [fila({ n: 7 }), fila({ n: 9 }), fila({ n: 12 })];
    expect(validarFilas(filas, ctx()).map((f) => f.n)).toEqual([7, 9, 12]);
  });
});

describe("validarFilas · RUC", () => {
  it("la sanidad del soporte: prefijos 10/15/16/17/20 válidos; 11/12/30 con verificador correcto pero no permitidos", () => {
    for (const p of ["10", "15", "16", "17", "20"])
      expect(validarRuc(rucConPrefijo(p, 5))).toBe(true);
    for (const p of ["11", "12", "30"])
      expect(validarRuc(rucConPrefijo(p, 5))).toBe(false);
  });

  it.each(["11", "12", "30"])("prefijo %s -> ruc_invalido", (p) => {
    const r = una({ ruc: rucConPrefijo(p, 6) });
    expect(r.estado).toBe("error");
    expect(codigos(r)).toEqual(["ruc_invalido"]);
  });

  it.each([
    [
      "dígito verificador errado",
      () =>
        `${rucConPrefijo("20", 7).slice(0, 10)}${(Number(rucConPrefijo("20", 7)[10]) + 1) % 10}`,
    ],
    ["menos de 11 dígitos", () => rucConPrefijo("20", 7).slice(0, 10)],
    ["letras", () => "2010007097X"],
    ["vacío", () => ""],
    [
      "con un espacio interior",
      () =>
        `${rucConPrefijo("20", 7).slice(0, 5)} ${rucConPrefijo("20", 7).slice(5)}`,
    ],
  ])("%s -> ruc_invalido", (_n, ruc) => {
    expect(codigos(una({ ruc: ruc() }))).toContain("ruc_invalido");
  });

  it("acumula los motivos de una misma fila (RUC inválido y responsable inexistente)", () => {
    const r = una({ ruc: "123", responsable: "nadie@x.pe" });
    expect(codigos(r).sort()).toEqual([
      "responsable_inexistente",
      "ruc_invalido",
    ]);
    expect(r.responsableId).toBeNull();
  });
});

describe("validarFilas · duplicados (D9, CA-8)", () => {
  it("duplicado_en_archivo: vale la primera aparición y las demás son error", () => {
    const ruc = rucConPrefijo("20", 40);
    const [a, b, c] = validarFilas(
      [fila({ ruc }), fila({ ruc }), fila({ ruc })],
      ctx(),
    );
    expect(a).toMatchObject({ estado: "valida", motivos: [] });
    expect(codigos(b!)).toEqual(["duplicado_en_archivo"]);
    expect(codigos(c!)).toEqual(["duplicado_en_archivo"]);
  });

  it("existente activo -> duplicado sin sugerencia de reactivar", () => {
    const ruc = rucConPrefijo("20", 41);
    const r = una(
      { ruc },
      ctx({ existentes: new Map([[ruc, { archivado: false }]]) }),
    );
    expect(r.estado).toBe("error");
    expect(r.motivos).toEqual([
      expect.objectContaining({ codigo: "duplicado" }),
    ]);
    expect(r.motivos[0]?.archivado).not.toBe(true);
  });

  it("existente archivado -> duplicado con archivado: true (sugerir reactivar)", () => {
    const ruc = rucConPrefijo("20", 42);
    const r = una(
      { ruc },
      ctx({ existentes: new Map([[ruc, { archivado: true }]]) }),
    );
    expect(r.motivos).toEqual([{ codigo: "duplicado", archivado: true }]);
  });
});

describe("validarFilas · responsable por correo (P1 a)", () => {
  it("correo que no es de un miembro activo -> responsable_inexistente", () => {
    expect(codigos(una({ responsable: "otro@estudio.pe" }))).toEqual([
      "responsable_inexistente",
    ]);
  });

  it("un nombre en lugar del correo no resuelve (P1 a: solo correo)", () => {
    expect(codigos(una({ responsable: "Ana Pérez" }))).toEqual([
      "responsable_inexistente",
    ]);
  });

  it("miembro que no puede ser responsable (rol lectura) -> responsable_no_asignable", () => {
    const r = una({ responsable: "lola@estudio.pe" });
    expect(r.estado).toBe("error");
    expect(codigos(r)).toEqual(["responsable_no_asignable"]);
  });
});

describe("validarFilas · credenciales a medias", () => {
  it.each([
    ["usuario SOL sin clave", { usuarioSol: "U" }],
    ["clave SOL sin usuario", { claveSol: "C" }],
    ["client_id sin client_secret", { clientId: "I" }],
    ["client_secret sin client_id", { clientSecret: "S" }],
  ])("%s -> credencial_incompleta", (_n, ov) => {
    const r = una(ov);
    expect(r.estado).toBe("error");
    expect(codigos(r)).toEqual(["credencial_incompleta"]);
  });

  it("un par completo y el otro vacío es válido", () => {
    expect(una({ usuarioSol: "U", claveSol: "C" })).toMatchObject({
      estado: "valida",
      tieneSol: true,
      tieneSire: false,
    });
    expect(una({ clientId: "I", clientSecret: "S" })).toMatchObject({
      estado: "valida",
      tieneSol: false,
      tieneSire: true,
    });
  });
});

describe("validarFilas · celdas peligrosas (CA-2)", () => {
  const peligrosas = [
    '=HYPERLINK("http://x","a")',
    "+1+1",
    "-2+3",
    "@SUM(A1)",
    "\tcmd",
    "\rcmd",
    "\u0000x",
  ];

  it.each(["razonSocial", "usuarioSol", "clientId", "responsable"] as const)(
    "%s que empieza con = + - @ o control -> celda_peligrosa",
    (campo) => {
      for (const valor of peligrosas) {
        const par: Partial<FilaLeida> =
          campo === "usuarioSol"
            ? { usuarioSol: valor, claveSol: "C" }
            : campo === "clientId"
              ? { clientId: valor, clientSecret: "S" }
              : { [campo]: valor };
        const r = una(par);
        expect(r.estado, `${campo}=${JSON.stringify(valor)}`).toBe("error");
        expect(codigos(r), `${campo}=${JSON.stringify(valor)}`).toContain(
          "celda_peligrosa",
        );
      }
    },
  );

  it("una fórmula real (<f>) en cualquier columna, incluidas las claves, -> celda_peligrosa", () => {
    for (const col of [
      "ruc",
      "razonSocial",
      "claveSol",
      "clientSecret",
    ] as const) {
      const r = una({
        formulas: [col],
        claveSol: "C",
        usuarioSol: "U",
        clientId: "I",
        clientSecret: "S",
      });
      expect(codigos(r), col).toContain("celda_peligrosa");
    }
  });

  it("las claves (clave SOL, client_secret) que empiezan con = - @ + se aceptan: son claves reales", () => {
    for (const clave of ["=abc123", "-abc123", "@abc123", "+abc123"]) {
      const r = una({
        usuarioSol: "U",
        claveSol: clave,
        clientId: "I",
        clientSecret: clave,
      });
      expect(r, clave).toMatchObject({
        estado: "valida",
        motivos: [],
        tieneSol: true,
        tieneSire: true,
      });
    }
  });

  it("un guion o un @ dentro del texto (no al inicio) es normal", () => {
    expect(
      una({
        razonSocial: "AB-CD @ SUR S.A.C.",
        usuarioSol: "USU-1",
        claveSol: "C",
      }),
    ).toMatchObject({ estado: "valida" });
  });
});

describe("aVistaPrevia · sin claves (CA-1)", () => {
  const CANARIOS = [
    "canarioClaveSol_9f3a",
    "canarioClientSecret_77bd",
    "canarioUsuarioSol_1c2e",
    "canarioClientId_5d0a",
  ];

  it("cuenta válidas, con error, cupo y excedentes", () => {
    const filas = validarFilas(
      [
        fila({}),
        fila({}),
        fila({}),
        fila({ ruc: "1" }),
        fila({ responsable: "x@y.pe" }),
      ],
      ctx(),
    );
    expect(aVistaPrevia(filas, 2)).toMatchObject({
      validas: 3,
      conError: 2,
      cupoLibre: 2,
      excedentes: 1,
    });
    expect(aVistaPrevia(filas, 10)).toMatchObject({
      validas: 3,
      conError: 2,
      cupoLibre: 10,
      excedentes: 0,
    });
    expect(aVistaPrevia(filas, 0)).toMatchObject({ excedentes: 3 });
  });

  it("cada fila trae solo n, ruc, estado, motivos, tieneSol y tieneSire", () => {
    const vp = aVistaPrevia(
      validarFilas([fila({ usuarioSol: "U", claveSol: "C" })], ctx()),
      5,
    );
    expect(Object.keys(vp.filas[0]!).sort()).toEqual([
      "estado",
      "motivos",
      "n",
      "ruc",
      "tieneSire",
      "tieneSol",
    ]);
    expect(vp.filas[0]).toMatchObject({
      estado: "valida",
      tieneSol: true,
      tieneSire: false,
    });
  });

  it("la vista previa serializada no contiene ninguna clave, usuario SOL ni client_id (••••)", () => {
    const [claveSol, clientSecret, usuarioSol, clientId] = CANARIOS as [
      string,
      string,
      string,
      string,
    ];
    const filas = validarFilas(
      [
        fila({
          usuarioSol,
          claveSol,
          clientId,
          clientSecret,
          responsable: "ana@estudio.pe",
        }),
        fila({
          usuarioSol,
          claveSol: `=${claveSol}`,
          clientId: `=${clientId}`,
          clientSecret,
        }), // con error de celda peligrosa
        fila({ claveSol, clientSecret }), // credencial incompleta
      ],
      ctx(),
    );
    const texto = JSON.stringify(aVistaPrevia(filas, 1));
    for (const canario of CANARIOS) expect(texto).not.toContain(canario);
    expect(texto).not.toContain("ana@estudio.pe");
  });
});
