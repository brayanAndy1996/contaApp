import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 025 · T2 (rojo). Candidatas importadas: filtros, vista, activar, reemplazar y descartar (plan 025, Contratos: shared;
// D-4 a D-6, D-10, D-11; U-2, U-8; CA-3, CA-4, CA-5).
// Contrato fijado por estas pruebas (packages/shared/src/reglas/candidatas.ts, exportado por reglas/index.ts y por src/index.ts):
//  - filtrosCandidatasSchema = {grupo?: propuestas|sin_criterio|conflicto|resueltas, cursor?: texto 1..256, limite?: entero 1..200
//    (también como texto numérico, porque llega por query string); por defecto 100} (.strict()).
//  - candidataVistaSchema = {id, proveedor: {tipo, numero, razonSocial|null}, destinoPropuesto: DG|DGNG|DNG|null,
//    conteos: {DG, DGNG, DNG, mixto, total} enteros >= 0 (la forma de `aprenderDeHistorial`), periodosConProveedor, periodosLeidos,
//    estado: pendiente|activada|descartada|reemplazada, destinoElegido: Destino|null, regla: {id, destino, version}|null,
//    conflicto: ninguno|ya_aprendida|distinto}. El único dato de RUC y razón social viaja dentro de `proveedor`.
//  - activarCandidatasSchema = {items: [{id: uuid, destino?}] 1..1000 sin id repetido} | {todas: true, importacionId: uuid}; las dos
//    formas son estrictas y no se mezclan.
//  - respuestaActivarSchema = {activadas: uuid[], omitidas: [{id, motivo: conflicto|ya_aprendida|no_pendiente|sin_criterio}]}.
//  - reemplazarCandidataSchema = {destino?, versionRegla: entero 1..2147483647 (obligatoria)}.
//  - descartarCandidatasSchema = {ids: uuid[1..1000]}.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const esquema = (nombre: string): Esquema => {
  const s = (shared as Record<string, unknown>)[nombre] as Esquema | undefined;
  if (s === undefined) throw new Error(`no implementado: @contapp/shared no exporta ${nombre}`);
  return s;
};
const ok = (nombre: string, v: unknown) => esquema(nombre).safeParse(v).success;
const datos = (nombre: string, v: unknown) => {
  const r = esquema(nombre).safeParse(v);
  expect(r.success).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.data as Record<string, any>;
};
const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const items = (n: number) => ids(n).map((id) => ({ id }));

describe("exportaciones de @contapp/shared para las candidatas (025)", () => {
  it.each([
    "filtrosCandidatasSchema",
    "candidataVistaSchema",
    "activarCandidatasSchema",
    "respuestaActivarSchema",
    "reemplazarCandidataSchema",
    "descartarCandidatasSchema",
  ])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
});

describe("filtrosCandidatasSchema", () => {
  const S = "filtrosCandidatasSchema";

  it("sin nada es válido y el límite queda en 100", () => {
    const d = datos(S, {});
    expect(d.limite).toBe(100);
    expect(d.grupo).toBeUndefined();
    expect(d.cursor).toBeUndefined();
  });
  it.each(["propuestas", "sin_criterio", "conflicto", "resueltas"])("acepta el grupo %s", (grupo) => {
    expect(datos(S, { grupo }).grupo).toBe(grupo);
  });
  it.each(["Propuestas", "sin criterio", "todas", "pendientes", "", null, 1])("rechaza el grupo %j", (grupo) => {
    expect(ok(S, { grupo })).toBe(false);
  });
  it.each([1, 7, 100, 200])("acepta limite %j", (limite) => {
    expect(datos(S, { limite }).limite).toBe(limite);
  });
  it("acepta el límite como texto numérico (query string)", () => {
    expect(datos(S, { limite: "50" }).limite).toBe(50);
  });
  it.each([0, -1, 201, 1000, 1.5, "0", "201", "1.5", "abc", "", null, NaN, true])("rechaza limite %j", (limite) => {
    expect(ok(S, { limite })).toBe(false);
  });
  it("el cursor es un texto de 1 a 256 caracteres", () => {
    expect(datos(S, { cursor: "x".repeat(256) }).cursor).toBe("x".repeat(256));
    expect(ok(S, { cursor: "x".repeat(257) })).toBe(false);
    expect(ok(S, { cursor: "" })).toBe(false);
    for (const malo of [1, null, [], {}]) expect(ok(S, { cursor: malo })).toBe(false);
  });
  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["importacionId", { importacionId: randomUUID() }],
    ["ruc", { ruc: "20100070970" }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok(S, extra)).toBe(false);
    expect(ok(S, { grupo: "propuestas", ...extra })).toBe(false);
  });
});

describe("candidataVistaSchema", () => {
  const S = "candidataVistaSchema";
  const candidata = (o: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" },
    destinoPropuesto: "DNG",
    conteos: { DG: 0, DGNG: 0, DNG: 11, mixto: 1, total: 12 },
    periodosConProveedor: 5,
    periodosLeidos: 6,
    estado: "pendiente",
    destinoElegido: null,
    regla: null,
    conflicto: "ninguno",
    ...o,
  });

  it("acepta una propuesta pendiente sin conflicto y la devuelve igual", () => {
    const c = candidata();
    expect(esquema(S).safeParse(c).data).toEqual(c);
  });
  it("acepta una «sin criterio claro»: destinoPropuesto null", () => {
    expect(ok(S, candidata({ destinoPropuesto: null, conteos: { DG: 2, DGNG: 0, DNG: 2, mixto: 0, total: 4 } }))).toBe(true);
  });
  it("acepta razón social null y un proveedor con documento que no es RUC (tipo 1, DNI)", () => {
    expect(ok(S, candidata({ proveedor: { tipo: "1", numero: "12345678", razonSocial: null } }))).toBe(true);
  });
  it.each(["DG", "DGNG", "DNG"])("acepta el destino propuesto %s", (destinoPropuesto) => {
    expect(ok(S, candidata({ destinoPropuesto }))).toBe(true);
  });
  it.each(["XX", "dng", "", 1, undefined])("rechaza destinoPropuesto %j", (destinoPropuesto) => {
    expect(ok(S, candidata({ destinoPropuesto }))).toBe(false);
  });

  it.each(["pendiente", "activada", "descartada", "reemplazada"])("acepta el estado %s", (estado) => {
    expect(ok(S, candidata({ estado }))).toBe(true);
  });
  it.each(["en_curso", "Pendiente", "resuelta", "", null, 1])("rechaza el estado %j", (estado) => {
    expect(ok(S, candidata({ estado }))).toBe(false);
  });
  it.each(["ninguno", "ya_aprendida", "distinto"])("acepta el conflicto %s", (conflicto) => {
    expect(ok(S, candidata({ conflicto }))).toBe(true);
  });
  it.each(["conflicto", "igual", "", null, 1, undefined])("rechaza el conflicto %j", (conflicto) => {
    expect(ok(S, candidata({ conflicto }))).toBe(false);
  });

  it("con una regla viva del proveedor trae su id, destino y versión (para «Reemplazar»)", () => {
    const regla = { id: randomUUID(), destino: "DG", version: 3 };
    const d = datos(S, candidata({ conflicto: "distinto", regla }));
    expect(d.regla).toEqual(regla);
  });
  it.each([
    ["id que no es uuid", { id: "x", destino: "DG", version: 3 }],
    ["destino inválido", { id: randomUUID(), destino: "XX", version: 3 }],
    ["versión 0", { id: randomUUID(), destino: "DG", version: 0 }],
    ["versión decimal", { id: randomUUID(), destino: "DG", version: 1.5 }],
    ["sin versión", { id: randomUUID(), destino: "DG" }],
  ])("rechaza una regla con %s", (_c, regla) => {
    expect(ok(S, candidata({ regla }))).toBe(false);
  });
  it("destinoElegido es Destino o null", () => {
    expect(ok(S, candidata({ estado: "activada", destinoElegido: "DGNG" }))).toBe(true);
    expect(ok(S, candidata({ destinoElegido: "XX" }))).toBe(false);
    expect(ok(S, candidata({ destinoElegido: undefined }))).toBe(false);
  });

  describe("conteos", () => {
    it.each(["DG", "DGNG", "DNG", "mixto", "total"])("%s es un entero >= 0 y obligatorio", (clave) => {
      const base = { DG: 1, DGNG: 0, DNG: 4, mixto: 0, total: 5 };
      for (const malo of [-1, 1.5, "2", null]) expect(ok(S, candidata({ conteos: { ...base, [clave]: malo } })), `${clave}=${String(malo)}`).toBe(false);
      const sin: Record<string, unknown> = { ...base };
      delete sin[clave];
      expect(ok(S, candidata({ conteos: sin }))).toBe(false);
    });
  });
  it.each([
    ["periodosConProveedor", -1],
    ["periodosConProveedor", 1.5],
    ["periodosConProveedor", "5"],
    ["periodosLeidos", -1],
    ["periodosLeidos", null],
  ])("rechaza %s = %j", (campo, valor) => {
    expect(ok(S, candidata({ [campo]: valor }))).toBe(false);
  });
  it.each(["no-es-uuid", "", null, 1])("rechaza id %j", (id) => {
    expect(ok(S, candidata({ id }))).toBe(false);
  });
  it("rechaza un proveedor sin número o con número que no es texto", () => {
    expect(ok(S, candidata({ proveedor: { tipo: "6", razonSocial: null } }))).toBe(false);
    expect(ok(S, candidata({ proveedor: { tipo: "6", numero: 20100070970, razonSocial: null } }))).toBe(false);
  });
  it("el RUC y la razón social solo salen dentro de `proveedor`: las claves ajenas se descartan", () => {
    const d = datos(
      S,
      candidata({ ruc: "20100070970", docNumero: "20100070970", razonSocial: "PROVEEDOR SAC", tenantId: randomUUID(), clienteId: randomUUID(), importacionId: randomUUID(), total: "118.00" }),
    );
    for (const k of ["ruc", "docNumero", "razonSocial", "tenantId", "clienteId", "importacionId", "total"]) expect(k in d).toBe(false);
  });
  it("descarta claves ajenas dentro de `proveedor`", () => {
    const d = datos(S, candidata({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: "X", tenantId: randomUUID() } }));
    expect(Object.keys(d.proveedor).sort()).toEqual(["numero", "razonSocial", "tipo"]);
  });
});

describe("activarCandidatasSchema (CA-3, CA-4)", () => {
  const S = "activarCandidatasSchema";

  it("acepta un ítem con solo el id y lo devuelve igual", () => {
    const it1 = { items: [{ id: randomUUID() }] };
    expect(esquema(S).safeParse(it1).data).toEqual(it1);
  });
  it("acepta un ítem con el destino elegido (cambiar el destino antes de activar)", () => {
    const x = { id: randomUUID(), destino: "DGNG" };
    expect(datos(S, { items: [x] }).items).toEqual([x]);
  });
  it.each(["DG", "DGNG", "DNG"])("acepta el destino %s", (destino) => {
    expect(ok(S, { items: [{ id: randomUUID(), destino }] })).toBe(true);
  });
  it.each(["dng", "XX", "", null, 1, ["DNG"]])("rechaza el destino %j", (destino) => {
    expect(ok(S, { items: [{ id: randomUUID(), destino }] })).toBe(false);
  });

  describe("items: de 1 a 1000 sin repetidos", () => {
    it("1 y 1000 valen", () => {
      expect(ok(S, { items: items(1) })).toBe(true);
      expect(ok(S, { items: items(1000) })).toBe(true);
    });
    it("0 y 1001 no", () => {
      expect(ok(S, { items: [] })).toBe(false);
      expect(ok(S, { items: items(1001) })).toBe(false);
    });
    it("rechaza ids repetidos, también por mayúsculas y aunque cambie el destino", () => {
      const id = randomUUID();
      expect(ok(S, { items: [{ id }, { id }] })).toBe(false);
      expect(ok(S, { items: [{ id }, { id: id.toUpperCase() }] })).toBe(false);
      expect(ok(S, { items: [{ id, destino: "DG" }, { id, destino: "DNG" }] })).toBe(false);
    });
    it.each([["no-es-uuid"], [123], [null], [""], [{}]])("rechaza el id %j", (id) => {
      expect(ok(S, { items: [{ id }] })).toBe(false);
    });
    it("un ítem sin id se rechaza", () => {
      expect(ok(S, { items: [{ destino: "DNG" }] })).toBe(false);
    });
    it.each([undefined, null, "a", randomUUID(), {}, [randomUUID()]])("rechaza items = %j", (x) => {
      expect(ok(S, { items: x })).toBe(false);
    });
    it("rechaza una clave extra dentro del ítem (la candidata no cambia por el cuerpo)", () => {
      expect(ok(S, { items: [{ id: randomUUID(), regla: { id: randomUUID() } }] })).toBe(false);
      expect(ok(S, { items: [{ id: randomUUID(), proveedor: { numero: "20100070970" } }] })).toBe(false);
    });
  });

  describe("todas: true con importacionId", () => {
    it("acepta la forma completa y la devuelve igual", () => {
      const cuerpo = { todas: true, importacionId: randomUUID() };
      expect(esquema(S).safeParse(cuerpo).data).toEqual(cuerpo);
    });
    it("sin importacionId se rechaza", () => {
      expect(ok(S, { todas: true })).toBe(false);
      expect(ok(S, { todas: true, importacionId: undefined })).toBe(false);
    });
    it.each(["no-es-uuid", "", null, 1])("rechaza importacionId %j", (importacionId) => {
      expect(ok(S, { todas: true, importacionId })).toBe(false);
    });
    it.each([false, "true", 1, null])("todas = %j no vale", (todas) => {
      expect(ok(S, { todas, importacionId: randomUUID() })).toBe(false);
    });
    it("importacionId sin todas se rechaza", () => {
      expect(ok(S, { importacionId: randomUUID() })).toBe(false);
    });
  });

  describe("las dos formas no se mezclan", () => {
    it("items con todas, con importacionId o con ambos", () => {
      const importacionId = randomUUID();
      expect(ok(S, { items: items(1), todas: true, importacionId })).toBe(false);
      expect(ok(S, { items: items(1), todas: true })).toBe(false);
      expect(ok(S, { items: items(1), importacionId })).toBe(false);
    });
  });
  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["destino global", { destino: "DNG" }],
  ])("rechaza la clave extra %s en las dos formas", (_c, extra) => {
    expect(ok(S, { items: items(1), ...extra })).toBe(false);
    expect(ok(S, { todas: true, importacionId: randomUUID(), ...extra })).toBe(false);
  });
  it.each([undefined, null, [], "todas", 1, {}])("rechaza el cuerpo %j", (cuerpo) => {
    expect(ok(S, cuerpo)).toBe(false);
  });
});

describe("respuestaActivarSchema (CA-4, U-8)", () => {
  const S = "respuestaActivarSchema";

  it("acepta activadas y omitidas con sus motivos", () => {
    const r = {
      activadas: ids(2),
      omitidas: [
        { id: randomUUID(), motivo: "conflicto" },
        { id: randomUUID(), motivo: "ya_aprendida" },
        { id: randomUUID(), motivo: "no_pendiente" },
        { id: randomUUID(), motivo: "sin_criterio" },
      ],
    };
    expect(esquema(S).safeParse(r).data).toEqual(r);
  });
  it("acepta las dos listas vacías", () => {
    expect(ok(S, { activadas: [], omitidas: [] })).toBe(true);
  });
  it.each(["otro", "Conflicto", "conflicto ", "", null, 1, undefined])("rechaza el motivo %j", (motivo) => {
    expect(ok(S, { activadas: [], omitidas: [{ id: randomUUID(), motivo }] })).toBe(false);
  });
  it("rechaza ids que no son uuid, en las dos listas", () => {
    expect(ok(S, { activadas: ["x"], omitidas: [] })).toBe(false);
    expect(ok(S, { activadas: [], omitidas: [{ id: "x", motivo: "conflicto" }] })).toBe(false);
  });
  it("las dos claves son obligatorias", () => {
    expect(ok(S, { activadas: [] })).toBe(false);
    expect(ok(S, { omitidas: [] })).toBe(false);
  });
  it("descarta claves ajenas: la respuesta no devuelve proveedor ni montos", () => {
    const r = datos(S, { activadas: [], omitidas: [{ id: randomUUID(), motivo: "conflicto", ruc: "20100070970", razonSocial: "PROVEEDOR SAC" }], total: "1.00" });
    expect(Object.keys(r).sort()).toEqual(["activadas", "omitidas"]);
    expect(Object.keys(r.omitidas[0]).sort()).toEqual(["id", "motivo"]);
  });
});

describe("reemplazarCandidataSchema (CA-4)", () => {
  const S = "reemplazarCandidataSchema";

  it("acepta la versión de la regla sola (reemplaza con el destino propuesto)", () => {
    expect(datos(S, { versionRegla: 3 }).versionRegla).toBe(3);
  });
  it("acepta un destino elegido", () => {
    expect(datos(S, { destino: "DNG", versionRegla: 1 })).toEqual({ destino: "DNG", versionRegla: 1 });
  });
  it("la versión es obligatoria: reemplazar sin versión se rechaza", () => {
    expect(ok(S, {})).toBe(false);
    expect(ok(S, { destino: "DNG" })).toBe(false);
    expect(ok(S, { versionRegla: undefined })).toBe(false);
  });
  it.each([0, -1, 1.5, "3", "", null, NaN, Infinity, true, [], {}, 2_147_483_648])("rechaza versionRegla %j", (versionRegla) => {
    expect(ok(S, { versionRegla })).toBe(false);
  });
  it("acepta el mayor entero de PostgreSQL", () => {
    expect(ok(S, { versionRegla: 2_147_483_647 })).toBe(true);
  });
  it("no acepta `versionBase` en su lugar (la candidata y la regla tienen versiones distintas)", () => {
    expect(ok(S, { versionBase: 3 })).toBe(false);
  });
  it.each(["dng", "XX", "", null, 1])("rechaza el destino %j", (destino) => {
    expect(ok(S, { destino, versionRegla: 1 })).toBe(false);
  });
  it("descarta claves ajenas (clienteId, reglaId, proveedor)", () => {
    const d = datos(S, { versionRegla: 1, clienteId: randomUUID(), reglaId: randomUUID(), proveedor: { numero: "20100070970" } });
    expect(Object.keys(d)).toEqual(["versionRegla"]);
  });
});

describe("descartarCandidatasSchema", () => {
  const S = "descartarCandidatasSchema";

  it("acepta de 1 a 1000 ids", () => {
    expect(ok(S, { ids: ids(1) })).toBe(true);
    expect(ok(S, { ids: ids(1000) })).toBe(true);
  });
  it("rechaza 0 y 1001 ids", () => {
    expect(ok(S, { ids: [] })).toBe(false);
    expect(ok(S, { ids: ids(1001) })).toBe(false);
  });
  it.each([["no-es-uuid"], [123], [null], [""], [{ id: randomUUID() }]])("rechaza el elemento %j", (x) => {
    expect(ok(S, { ids: [x] })).toBe(false);
  });
  it.each([undefined, null, "a", randomUUID(), {}])("rechaza ids = %j", (x) => {
    expect(ok(S, { ids: x })).toBe(false);
  });
  it("descarta claves ajenas (clienteId, importacionId)", () => {
    const d = datos(S, { ids: ids(1), clienteId: randomUUID(), importacionId: randomUUID() });
    expect(Object.keys(d)).toEqual(["ids"]);
  });
});

describe("R-STD y origen en los contratos de reglas (D-5, U-3; CA-9, CA-10)", () => {
  it("R-STD es el último de CODIGOS_REGLA y de CODIGOS_REGLA_MOTOR", () => {
    expect([...shared.CODIGOS_REGLA].at(-1)).toBe("R-STD");
    expect([...shared.CODIGOS_REGLA_MOTOR].at(-1)).toBe("R-STD");
  });
  it("las reglas previas no cambian de lugar", () => {
    expect([...shared.CODIGOS_REGLA]).toEqual(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-STD"]);
    expect([...shared.CODIGOS_REGLA_MOTOR]).toEqual(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS", "R-STD"]);
  });
  it("R-STD se acepta al aceptar una sugerencia y en la masiva por regla (la acepta en masa, U-3)", () => {
    expect(shared.aceptarSugerenciaSchema.safeParse({ versionBase: 1, regla: "R-STD" }).success).toBe(true);
    expect(shared.masivaAceptarSchema.safeParse({ items: [{ compraId: randomUUID(), versionBase: 1 }], regla: "R-STD" }).success).toBe(true);
  });
  it("R-STD se puede apagar en el estudio", () => {
    expect(shared.codigoReglaMotorSchema.safeParse("R-STD").success).toBe(true);
  });
  it("las acciones de auditoría nuevas existen", () => {
    for (const a of ["regla.historial_importado", "regla.candidata_descartada"]) {
      expect(shared.accionAuditoriaSchema.safeParse(a).success, a).toBe(true);
    }
  });
});
