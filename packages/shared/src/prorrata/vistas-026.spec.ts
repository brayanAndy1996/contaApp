import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 026 · T2 (rojo). Vistas de la prorrata y códigos de error (plan 026, Contratos: shared; D-4, D-6, D-7; R-2b, R-4, R-5, R-7, R-8).
// Contrato fijado por estas pruebas (packages/shared/src/prorrata/{vistas,errores}.ts, exportado por prorrata/index.ts y src/index.ts).
// Montos y porcentajes viajan como CADENAS decimales (nunca number): montos con signo y hasta 2 decimales; porcentajes «NN.NN».
//  - prorrataVistaSchema = {periodo, ventana: MesVista[12], coeficiente, igvEstimado, diferencia, ultimaObtencion, prorrataUsada, versionUsada}.
//    MesVista = {periodo, origen: declarado|manual|sire|falta, gravadas, exportaciones, noGravadas, total, avisos: AvisoMes[],
//    declaracion: {numeroOrden, fechaPresentacion, tipo: original|rectificatoria, presentaciones >= 1} | null,
//    manual: {motivo, autor: {id, nombre}, guardadoEn} | null, versionManual >= 0, sireCargado}.
//    AvisoMes = usd_sin_tipo_cambio | sire_sin_exportaciones | manual_reemplazado. Un mes `falta` lleva sus montos en «0.00».
//    coeficiente = {estado: "calculado", porcentaje, numerador, total, provisional, avisos: (numerador_cero | exportaciones_en_sire)[]}
//      | {estado: "faltan_meses", faltantes: AAAAMM[]} | {estado: "no_determinable", motivo: total_cero | acumulado_invalido}.
//    igvEstimado = {estado: "calculado", igvVentas, creditoDg, igvDgng, creditoDgng, igvDng, resultado, situacion: a_pagar|saldo_a_favor|cero,
//      estadoPeriodoCompras: abierto|revisado|generado} | {estado: "no_estimable", motivo: coeficiente|sin_ventas|sin_compras}.
//    diferencia = {diferencia: «NN.NN», alerta: boolean} | null (null: sin prorrata usada o sin coeficiente calculado).
//    ultimaObtencion = {obtenidaEn: ISO, periodosSinDeclaracion: AAAAMM[]} | null.
//    prorrataUsada = {valor: «NN.NN», origen: declarada|ingresada} | null; versionUsada entero >= 0.
//  - historialMesVistaSchema = {declaraciones: [{numeroOrden, fechaPresentacion, tipo, gravadas, exportaciones, noGravadas, prorrataUsada|null,
//    obtenidaEn}], manual: [{version >= 1, accion: guardado|eliminado, montos: {gravadas, exportaciones, noGravadas} | null, motivo, autor, en}]}.
//  - CODIGOS_ERROR_PRORRATA = mes_cambiado (409), mes_declarado (409), prorrata_declarada (409), periodo_futuro (400);
//    errorProrrataSchema = {codigo}. Se reutilizan cliente_archivado, credencial_no_configurada, credencial_invalida, solicitud_invalida,
//    no_encontrado y permiso_denegado (no se redefinen aquí). El cuerpo es solo `{codigo}`: sin montos ni RUC (D-7).
// Los esquemas se piden por nombre: si el export no existe, la prueba falla con «no implementado», no al cargar el archivo.
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

const autor = (o: Record<string, unknown> = {}) => ({ id: randomUUID(), nombre: "Ana Pérez", ...o });
const PERIODOS = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];

type Json = Record<string, unknown>;
const mes = (periodo: string, o: Json = {}): Json => ({
  periodo,
  origen: "declarado",
  gravadas: "100000.00",
  exportaciones: "0.00",
  noGravadas: "20000.00",
  total: "120000.00",
  avisos: [],
  declaracion: { numeroOrden: "7654321", fechaPresentacion: "2026-11-10", tipo: "original", presentaciones: 1 },
  manual: null,
  versionManual: 0,
  sireCargado: false,
  ...o,
});
const ventana = (): Json[] => PERIODOS.map((p) => mes(p));
const calculado = (o: Json = {}): Json => ({
  estado: "calculado",
  porcentaje: "83.33",
  numerador: "1200000.00",
  total: "1440000.00",
  provisional: false,
  avisos: [],
  ...o,
});
const igvCalculado = (o: Json = {}): Json => ({
  estado: "calculado",
  igvVentas: "18000.00",
  creditoDg: "9000.00",
  igvDgng: "3600.00",
  creditoDgng: "3000.00",
  igvDng: "180.00",
  resultado: "6000.00",
  situacion: "a_pagar",
  estadoPeriodoCompras: "revisado",
  ...o,
});
const vista = (o: Json = {}): Json => ({
  periodo: "202610",
  ventana: ventana(),
  coeficiente: calculado(),
  igvEstimado: igvCalculado(),
  diferencia: { diferencia: "0.01", alerta: true },
  ultimaObtencion: { obtenidaEn: "2026-11-22T15:00:00.000Z", periodosSinDeclaracion: ["202511"] },
  prorrataUsada: { valor: "83.34", origen: "declarada" },
  versionUsada: 0,
  ...o,
});

describe("exportaciones de @contapp/shared para las vistas de la prorrata (026)", () => {
  it.each(["prorrataVistaSchema", "historialMesVistaSchema", "errorProrrataSchema"])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
  it("exporta CODIGOS_ERROR_PRORRATA", () => {
    expect((shared as Record<string, unknown>).CODIGOS_ERROR_PRORRATA).toBeDefined();
  });
});

describe("prorrataVistaSchema: la vista completa", () => {
  const S = "prorrataVistaSchema";

  it("acepta la vista de CA-1: 12 meses declarados, coeficiente calculado, IGV a pagar y prorrata usada declarada", () => {
    const d = datos(S, vista());
    expect(d.periodo).toBe("202610");
    expect(d.ventana).toHaveLength(12);
    expect(d.ventana.map((m: { periodo: string }) => m.periodo)).toEqual(PERIODOS);
    expect(d.coeficiente.porcentaje).toBe("83.33");
    expect(d.igvEstimado.resultado).toBe("6000.00");
  });
  it("acepta la vista sin obtención, sin prorrata usada y sin diferencia", () => {
    expect(ok(S, vista({ ultimaObtencion: null, prorrataUsada: null, diferencia: null }))).toBe(true);
  });
  it.each(["periodo", "ventana", "coeficiente", "igvEstimado", "diferencia", "ultimaObtencion", "prorrataUsada", "versionUsada"])(
    "%s es obligatorio (null no equivale a ausente)",
    (clave) => {
      const o = vista();
      delete o[clave];
      expect(ok(S, o)).toBe(false);
    },
  );
  it.each(["2026-10", "202613", "", null, 202610])("rechaza el periodo %j", (periodo) => {
    expect(ok(S, vista({ periodo }))).toBe(false);
  });
  it("la ventana tiene exactamente 12 meses", () => {
    expect(ok(S, vista({ ventana: ventana().slice(1) }))).toBe(false);
    expect(ok(S, vista({ ventana: [...ventana(), mes("202612")] }))).toBe(false);
    expect(ok(S, vista({ ventana: [] }))).toBe(false);
  });
  it.each([-1, 1.5, "0", null, undefined])("rechaza versionUsada = %j (entero >= 0)", (versionUsada) => {
    expect(ok(S, vista({ versionUsada }))).toBe(false);
  });
  it("no filtra datos ajenos: descarta tenantId, clienteId, RUC, clave y razón social (D-7)", () => {
    const d = datos(S, vista({ tenantId: randomUUID(), clienteId: randomUUID(), ruc: "20100070970", claveSol: "CANARIO-SOL-clave", razonSocial: "CLIENTE SAC" }));
    for (const k of ["tenantId", "clienteId", "ruc", "claveSol", "razonSocial"]) expect(k in d).toBe(false);
  });

  describe("ultimaObtencion", () => {
    it("lleva la fecha y los periodos sin declaración, nada más", () => {
      const d = datos(S, vista({ ultimaObtencion: { obtenidaEn: "2026-11-22T15:00:00.000Z", periodosSinDeclaracion: [], ruc: "20100070970", nuevas: 3 } }));
      expect(Object.keys(d.ultimaObtencion).sort()).toEqual(["obtenidaEn", "periodosSinDeclaracion"]);
    });
    it.each(["ayer", "2026-11-22", "", 0, null])("rechaza obtenidaEn %j", (obtenidaEn) => {
      expect(ok(S, vista({ ultimaObtencion: { obtenidaEn, periodosSinDeclaracion: [] } }))).toBe(false);
    });
    it.each([["2026-05"], ["202613"], [202605], "202605", 1])("rechaza periodosSinDeclaracion %j", (periodosSinDeclaracion) => {
      expect(ok(S, vista({ ultimaObtencion: { obtenidaEn: "2026-11-22T15:00:00.000Z", periodosSinDeclaracion } }))).toBe(false);
    });
  });

  describe("prorrataUsada y diferencia (R-8, U-9, U-10)", () => {
    it.each(["declarada", "ingresada"])("acepta el origen %s", (origen) => {
      expect(ok(S, vista({ prorrataUsada: { valor: "83.34", origen } }))).toBe(true);
    });
    it.each(["manual", "sire", "Declarada", "", null, 1])("rechaza el origen %j", (origen) => {
      expect(ok(S, vista({ prorrataUsada: { valor: "83.34", origen } }))).toBe(false);
    });
    it.each(["100.01", "87.345", "-1", "1e2", "", 87.34, null, undefined])("rechaza el valor usado %j", (valor) => {
      expect(ok(S, vista({ prorrataUsada: { valor, origen: "declarada" } }))).toBe(false);
    });
    it.each(["0.00", "100.00", "83.34"])("acepta el valor usado %s", (valor) => {
      expect(ok(S, vista({ prorrataUsada: { valor, origen: "ingresada" } }))).toBe(true);
    });
    it("la diferencia es una cadena «NN.NN» con la alerta booleana", () => {
      expect(ok(S, vista({ diferencia: { diferencia: "0.00", alerta: false } }))).toBe(true);
      expect(ok(S, vista({ diferencia: { diferencia: "12.50", alerta: true } }))).toBe(true);
      expect(ok(S, vista({ diferencia: { diferencia: 0.01, alerta: true } }))).toBe(false);
      expect(ok(S, vista({ diferencia: { diferencia: "0.01", alerta: "si" } }))).toBe(false);
      expect(ok(S, vista({ diferencia: { diferencia: "0.01" } }))).toBe(false);
      expect(ok(S, vista({ diferencia: { alerta: true } }))).toBe(false);
    });
  });
});

describe("prorrataVistaSchema: cada mes de la ventana (R-2, R-5)", () => {
  const S = "prorrataVistaSchema";
  const con = (indice: number, mesNuevo: Json) => vista({ ventana: ventana().map((m, i) => (i === indice ? mesNuevo : m)) });

  it("acepta los cuatro orígenes en una misma ventana (CA-3)", () => {
    const m = ventana();
    m[0] = mes("202511", { origen: "falta", gravadas: "0.00", exportaciones: "0.00", noGravadas: "0.00", total: "0.00", declaracion: null });
    m[1] = mes("202512", {
      origen: "manual",
      declaracion: null,
      manual: { motivo: "Libro físico", autor: autor(), guardadoEn: "2026-11-20T10:00:00.000Z" },
      versionManual: 2,
    });
    m[2] = mes("202601", { origen: "sire", declaracion: null, sireCargado: true, avisos: ["sire_sin_exportaciones"] });
    expect(ok(S, vista({ ventana: m, coeficiente: { estado: "faltan_meses", faltantes: ["202511"] } }))).toBe(true);
  });
  it.each(["declarado", "manual", "sire", "falta"])("acepta el origen %s", (origen) => {
    expect(ok(S, con(0, mes("202511", { origen })))).toBe(true);
  });
  it.each(["rectificatoria", "Declarado", "SIRE", "", null, 1, undefined])("rechaza el origen %j", (origen) => {
    expect(ok(S, con(0, mes("202511", { origen })))).toBe(false);
  });
  it.each(["usd_sin_tipo_cambio", "sire_sin_exportaciones", "manual_reemplazado"])("acepta el aviso %s", (aviso) => {
    expect(ok(S, con(0, mes("202511", { avisos: [aviso] })))).toBe(true);
  });
  it("acepta varios avisos en un mes", () => {
    expect(ok(S, con(0, mes("202511", { avisos: ["usd_sin_tipo_cambio", "sire_sin_exportaciones"] })))).toBe(true);
  });
  it.each([["otro_aviso"], ["numerador_cero"], [""], [null], "usd_sin_tipo_cambio", 1])("rechaza los avisos %j", (avisos) => {
    expect(ok(S, con(0, mes("202511", { avisos })))).toBe(false);
  });
  it.each(["gravadas", "exportaciones", "noGravadas", "total"])("%s del mes es una cadena decimal: rechaza number, 3 decimales y 1e3", (campo) => {
    expect(ok(S, con(0, mes("202511", { [campo]: "-12.30" })))).toBe(true);
    for (const malo of [1000, 12.3, "1.234", "1e3", "", " 1", null, undefined]) {
      expect(ok(S, con(0, mes("202511", { [campo]: malo }))), `${campo}=${String(malo)}`).toBe(false);
    }
  });
  it.each(["periodo", "origen", "gravadas", "exportaciones", "noGravadas", "total", "avisos", "declaracion", "manual", "versionManual", "sireCargado"])(
    "el mes exige %s",
    (clave) => {
      const m = mes("202511");
      delete m[clave];
      expect(ok(S, con(0, m))).toBe(false);
    },
  );
  it.each(["2026-05", "202613", 202605, "", null])("rechaza el periodo %j del mes", (periodo) => {
    expect(ok(S, con(0, mes("202511", { periodo })))).toBe(false);
  });

  describe("declaracion (RF-130, R-5)", () => {
    const decl = (o: Json = {}) => ({ numeroOrden: "7654321", fechaPresentacion: "2026-11-10", tipo: "original", presentaciones: 1, ...o });
    it.each(["original", "rectificatoria"])("acepta el tipo %s con varias presentaciones", (tipo) => {
      expect(ok(S, con(0, mes("202511", { declaracion: decl({ tipo, presentaciones: 2 }) })))).toBe(true);
    });
    it.each(["1", "123456789012345", "7654321"])("acepta el número de orden %j", (numeroOrden) => {
      expect(ok(S, con(0, mes("202511", { declaracion: decl({ numeroOrden }) })))).toBe(true);
    });
    it.each([["tipo", "sustitutoria"], ["numeroOrden", ""], ["numeroOrden", "1234567890123456"], ["numeroOrden", "12a"], ["numeroOrden", 7654321], ["fechaPresentacion", "10/11/2026"], ["fechaPresentacion", "2026-13-01"], ["presentaciones", 0], ["presentaciones", 1.5], ["presentaciones", "1"]])(
      "rechaza %s = %j",
      (campo, valor) => {
        expect(ok(S, con(0, mes("202511", { declaracion: decl({ [campo]: valor }) })))).toBe(false);
      },
    );
    it.each(["numeroOrden", "fechaPresentacion", "tipo", "presentaciones"])("la declaración exige %s", (clave) => {
      const d: Json = decl();
      delete d[clave];
      expect(ok(S, con(0, mes("202511", { declaracion: d })))).toBe(false);
    });
  });

  describe("manual (RF-133, U-4)", () => {
    const man = (o: Json = {}) => ({ motivo: "Libro físico", autor: autor(), guardadoEn: "2026-11-20T10:00:00.000Z", ...o });
    it("acepta el manual con motivo, autor y fecha", () => {
      const d = datos(S, con(0, mes("202511", { origen: "manual", declaracion: null, manual: man(), versionManual: 3 })));
      expect(d.ventana[0].manual.motivo).toBe("Libro físico");
      expect(d.ventana[0].manual.autor.nombre).toBe("Ana Pérez");
      expect(d.ventana[0].versionManual).toBe(3);
    });
    it("acepta un mes declarado que conserva un manual reemplazado (R-5)", () => {
      expect(ok(S, con(0, mes("202511", { manual: man(), versionManual: 1, avisos: ["manual_reemplazado"] })))).toBe(true);
    });
    it.each([["id", "no-es-uuid"], ["id", null], ["nombre", ""], ["nombre", null]])("rechaza el autor con %s = %j", (campo, valor) => {
      expect(ok(S, con(0, mes("202511", { manual: man({ autor: autor({ [campo]: valor }) }) })))).toBe(false);
    });
    it.each(["motivo", "autor", "guardadoEn"])("el manual exige %s", (clave) => {
      const m: Json = man();
      delete m[clave];
      expect(ok(S, con(0, mes("202511", { manual: m })))).toBe(false);
    });
    it.each(["ayer", "2026-11-20", "", 0, null])("rechaza guardadoEn %j", (guardadoEn) => {
      expect(ok(S, con(0, mes("202511", { manual: man({ guardadoEn }) })))).toBe(false);
    });
    it.each([-1, 1.5, "1", null])("rechaza versionManual %j", (versionManual) => {
      expect(ok(S, con(0, mes("202511", { versionManual }))), String(versionManual)).toBe(false);
    });
    it("el manual no filtra el autor más allá de id y nombre", () => {
      const d = datos(S, con(0, mes("202511", { manual: man({ autor: autor({ email: "ana@estudio.pe", tenantId: randomUUID() }) }) })));
      expect(Object.keys(d.ventana[0].manual.autor).sort()).toEqual(["id", "nombre"]);
    });
  });

  it("sireCargado es booleano", () => {
    expect(ok(S, con(0, mes("202511", { sireCargado: true })))).toBe(true);
    expect(ok(S, con(0, mes("202511", { sireCargado: "si" })))).toBe(false);
    expect(ok(S, con(0, mes("202511", { sireCargado: null })))).toBe(false);
  });
});

describe("prorrataVistaSchema: coeficiente (R-3, R-4, R-6)", () => {
  const S = "prorrataVistaSchema";
  const con = (coeficiente: unknown) => vista({ coeficiente });

  it("calculado: porcentaje, numerador, total, provisional y avisos", () => {
    const d = datos(S, con(calculado({ provisional: true, avisos: ["numerador_cero", "exportaciones_en_sire"] })));
    expect(d.coeficiente.provisional).toBe(true);
    expect(d.coeficiente.avisos).toEqual(["numerador_cero", "exportaciones_en_sire"]);
  });
  it.each(["0.00", "0.01", "83.33", "99.99", "100.00"])("acepta el porcentaje %s", (porcentaje) => {
    expect(ok(S, con(calculado({ porcentaje })))).toBe(true);
  });
  it.each(["100.01", "-0.01", "87.345", "87.3", "87", "1e2", "", 83.33, null, undefined])("rechaza el porcentaje calculado %j", (porcentaje) => {
    expect(ok(S, con(calculado({ porcentaje })))).toBe(false);
  });
  it.each(["numerador", "total"])("%s es una cadena decimal, no un number", (campo) => {
    expect(ok(S, con(calculado({ [campo]: "999999999999.99" })))).toBe(true);
    for (const malo of [1200000, "1.234", "1e6", null, undefined]) expect(ok(S, con(calculado({ [campo]: malo }))), String(malo)).toBe(false);
  });
  it.each(["porcentaje", "numerador", "total", "provisional", "avisos"])("el coeficiente calculado exige %s", (clave) => {
    const c = calculado();
    delete c[clave];
    expect(ok(S, con(c))).toBe(false);
  });
  it.each([["otro"], ["usd_sin_tipo_cambio"], ["sire_sin_exportaciones"], "numerador_cero", 1])("rechaza los avisos del coeficiente %j", (avisos) => {
    expect(ok(S, con(calculado({ avisos })))).toBe(false);
  });
  it("faltan_meses: lista los periodos que faltan, en orden", () => {
    const d = datos(S, con({ estado: "faltan_meses", faltantes: ["202511", "202603"] }));
    expect(d.coeficiente.faltantes).toEqual(["202511", "202603"]);
  });
  it.each([["2025-11"], ["202613"], [202511], "202511", null])("faltan_meses rechaza faltantes %j", (faltantes) => {
    expect(ok(S, con({ estado: "faltan_meses", faltantes }))).toBe(false);
  });
  it("faltan_meses sin faltantes se rechaza", () => {
    expect(ok(S, con({ estado: "faltan_meses" }))).toBe(false);
  });
  it.each(["total_cero", "acumulado_invalido"])("no_determinable acepta el motivo %s", (motivo) => {
    expect(datos(S, con({ estado: "no_determinable", motivo })).coeficiente.motivo).toBe(motivo);
  });
  it.each(["otro", "", null, undefined, 1])("no_determinable rechaza el motivo %j", (motivo) => {
    expect(ok(S, con({ estado: "no_determinable", motivo }))).toBe(false);
  });
  it.each(["pendiente", "CALCULADO", "", null, undefined, 1])("rechaza el estado %j", (estado) => {
    expect(ok(S, con({ ...calculado(), estado }))).toBe(false);
  });
  it("un coeficiente no calculado no arrastra porcentaje: lo descarta", () => {
    const d = datos(S, con({ estado: "no_determinable", motivo: "total_cero", porcentaje: "83.33" }));
    expect("porcentaje" in d.coeficiente).toBe(false);
  });
});

describe("prorrataVistaSchema: IGV estimado (R-7, U-8)", () => {
  const S = "prorrataVistaSchema";
  const con = (igvEstimado: unknown) => vista({ igvEstimado });

  it.each([
    ["a_pagar", "6000.00"],
    ["saldo_a_favor", "-2500.50"],
    ["cero", "0.00"],
  ])("calculado: situación %s con resultado %s", (situacion, resultado) => {
    const d = datos(S, con(igvCalculado({ situacion, resultado })));
    expect(d.igvEstimado.situacion).toBe(situacion);
    expect(d.igvEstimado.resultado).toBe(resultado);
  });
  it.each(["abierto", "revisado", "generado"])("acepta el estado del periodo de compras %s", (estadoPeriodoCompras) => {
    expect(ok(S, con(igvCalculado({ estadoPeriodoCompras })))).toBe(true);
  });
  it.each(["cerrado", "Abierto", "", null, undefined, 1])("rechaza el estado del periodo de compras %j", (estadoPeriodoCompras) => {
    expect(ok(S, con(igvCalculado({ estadoPeriodoCompras })))).toBe(false);
  });
  it.each(["pendiente", "A_PAGAR", "", null, undefined])("rechaza la situación %j", (situacion) => {
    expect(ok(S, con(igvCalculado({ situacion })))).toBe(false);
  });
  it.each(["igvVentas", "creditoDg", "igvDgng", "creditoDgng", "igvDng", "resultado"])("%s es una cadena decimal, no un number", (campo) => {
    expect(ok(S, con(igvCalculado({ [campo]: "-0.01" })))).toBe(true);
    for (const malo of [18000, 18000.5, "1.234", "1e3", "", null, undefined]) {
      expect(ok(S, con(igvCalculado({ [campo]: malo }))), `${campo}=${String(malo)}`).toBe(false);
    }
  });
  it.each(["igvVentas", "creditoDg", "igvDgng", "creditoDgng", "igvDng", "resultado", "situacion", "estadoPeriodoCompras"])("calculado exige %s", (clave) => {
    const i = igvCalculado();
    delete i[clave];
    expect(ok(S, con(i))).toBe(false);
  });
  it.each(["coeficiente", "sin_ventas", "sin_compras"])("no_estimable acepta el motivo %s", (motivo) => {
    expect(datos(S, con({ estado: "no_estimable", motivo })).igvEstimado.motivo).toBe(motivo);
  });
  it.each(["otro", "", null, undefined, 1])("no_estimable rechaza el motivo %j", (motivo) => {
    expect(ok(S, con({ estado: "no_estimable", motivo }))).toBe(false);
  });
  it.each(["listo", "CALCULADO", "", null, undefined])("rechaza el estado %j", (estado) => {
    expect(ok(S, con({ ...igvCalculado(), estado }))).toBe(false);
  });
  it("no_estimable no lleva componentes: los descarta", () => {
    const d = datos(S, con({ estado: "no_estimable", motivo: "sin_compras", igvVentas: "1.00", resultado: "1.00" }));
    expect("igvVentas" in d.igvEstimado).toBe(false);
    expect("resultado" in d.igvEstimado).toBe(false);
  });
});

describe("historialMesVistaSchema (RF-133, D-4)", () => {
  const S = "historialMesVistaSchema";
  const declaracion = (o: Json = {}) => ({
    numeroOrden: "7654321",
    fechaPresentacion: "2026-11-10",
    tipo: "original",
    gravadas: "100000.00",
    exportaciones: "0.00",
    noGravadas: "20000.00",
    prorrataUsada: null,
    obtenidaEn: "2026-11-22T15:00:00.000Z",
    ...o,
  });
  const montos = (o: Json = {}) => ({ gravadas: "100.00", exportaciones: "0.00", noGravadas: "50.00", ...o });
  const manual = (o: Json = {}) => ({
    version: 1,
    accion: "guardado",
    montos: montos(),
    motivo: "Libro físico",
    autor: autor(),
    en: "2026-11-20T10:00:00.000Z",
    ...o,
  });
  const historial = (o: Json = {}) => ({ declaraciones: [], manual: [], ...o });

  it("acepta un historial vacío", () => {
    expect(datos(S, historial())).toEqual({ declaraciones: [], manual: [] });
  });
  it("acepta una original y su rectificatoria con prorrata usada", () => {
    const h = historial({
      declaraciones: [declaracion(), declaracion({ numeroOrden: "7654999", tipo: "rectificatoria", prorrataUsada: "83.34" })],
    });
    expect(datos(S, h).declaraciones).toHaveLength(2);
  });
  it("acepta guardado, guardado y eliminado: el historial conserva todas las versiones (CA-4)", () => {
    const h = historial({
      manual: [manual({ version: 1 }), manual({ version: 2, montos: montos({ gravadas: "-1.00" }) }), manual({ version: 3, accion: "eliminado", montos: null, motivo: "Mes equivocado" })],
    });
    const d = datos(S, h);
    expect(d.manual.map((m: { version: number }) => m.version)).toEqual([1, 2, 3]);
    expect(d.manual[2].montos).toBeNull();
  });
  it.each(["guardado", "eliminado"])("acepta la acción %s", (accion) => {
    expect(ok(S, historial({ manual: [manual({ accion, montos: accion === "guardado" ? montos() : null })] }))).toBe(true);
  });
  it.each(["borrado", "Guardado", "", null, undefined, 1])("rechaza la acción %j", (accion) => {
    expect(ok(S, historial({ manual: [manual({ accion })] }))).toBe(false);
  });
  it.each([0, -1, 1.5, "1", null, undefined])("rechaza version = %j (entero >= 1)", (version) => {
    expect(ok(S, historial({ manual: [manual({ version })] }))).toBe(false);
  });
  it.each(["gravadas", "exportaciones", "noGravadas"])("los montos del manual son cadenas decimales: %s", (campo) => {
    for (const malo of [100, "1.234", "1e3", "", null, undefined]) {
      expect(ok(S, historial({ manual: [manual({ montos: montos({ [campo]: malo }) })] })), `${campo}=${String(malo)}`).toBe(false);
    }
  });
  it.each(["version", "accion", "montos", "motivo", "autor", "en"])("el manual exige %s (montos puede ser null, no ausente)", (clave) => {
    const m: Json = manual();
    delete m[clave];
    expect(ok(S, historial({ manual: [m] }))).toBe(false);
  });
  it.each(["ayer", "2026-11-20", "", 0, null])("rechaza la fecha del manual %j", (en) => {
    expect(ok(S, historial({ manual: [manual({ en })] }))).toBe(false);
  });
  it("rechaza un autor sin uuid", () => {
    expect(ok(S, historial({ manual: [manual({ autor: autor({ id: "x" }) })] }))).toBe(false);
  });
  it.each(["100.01", "87.345", "-1", 83.34, ""])("rechaza la prorrata usada de la declaración %j", (prorrataUsada) => {
    expect(ok(S, historial({ declaraciones: [declaracion({ prorrataUsada })] }))).toBe(false);
  });
  it.each(["original", "rectificatoria"])("acepta el tipo de declaración %s", (tipo) => {
    expect(ok(S, historial({ declaraciones: [declaracion({ tipo })] }))).toBe(true);
  });
  it.each(["sustitutoria", "", null])("rechaza el tipo de declaración %j", (tipo) => {
    expect(ok(S, historial({ declaraciones: [declaracion({ tipo })] }))).toBe(false);
  });
  it.each(["declaraciones", "manual"])("%s es obligatorio", (clave) => {
    const h: Json = historial();
    delete h[clave];
    expect(ok(S, h)).toBe(false);
  });
  it("descarta claves ajenas (tenantId, clienteId, RUC, clave SOL)", () => {
    const d = datos(S, historial({ tenantId: randomUUID(), clienteId: randomUUID(), ruc: "20100070970", claveSol: "CANARIO-SOL-clave" }));
    for (const k of ["tenantId", "clienteId", "ruc", "claveSol"]) expect(k in d).toBe(false);
  });
});

describe("CODIGOS_ERROR_PRORRATA y errorProrrataSchema (D-5)", () => {
  const CODIGOS = ["mes_cambiado", "mes_declarado", "periodo_futuro", "prorrata_declarada"];
  const lista = () => (shared as Record<string, unknown>).CODIGOS_ERROR_PRORRATA as readonly string[] | undefined;

  it("son mes_cambiado, mes_declarado, prorrata_declarada y periodo_futuro", () => {
    expect(lista()).toBeDefined();
    expect([...lista()!].sort()).toEqual(CODIGOS);
    expect(new Set(lista()).size).toBe(lista()!.length);
  });
  it("no redefine los códigos que se reutilizan", () => {
    for (const reutilizado of ["cliente_archivado", "credencial_no_configurada", "credencial_invalida", "solicitud_invalida", "no_encontrado", "permiso_denegado"]) {
      expect(lista()).not.toContain(reutilizado);
    }
  });
  it.each(CODIGOS)("errorProrrataSchema acepta {codigo: %s}", (codigo) => {
    expect(datos("errorProrrataSchema", { codigo })).toEqual({ codigo });
  });
  it.each(["mes_cambiado ", "Mes_cambiado", "version_obsoleta", "cliente_archivado", "", null, 409, undefined])("errorProrrataSchema rechaza el código %j", (codigo) => {
    expect(ok("errorProrrataSchema", { codigo })).toBe(false);
  });
  it("sin código se rechaza", () => {
    expect(ok("errorProrrataSchema", {})).toBe(false);
  });
  it("el cuerpo no filtra datos: descarta RUC, montos y motivo (D-7)", () => {
    const d = datos("errorProrrataSchema", { codigo: "mes_declarado", ruc: "20100070970", gravadas: "100000.00", motivo: "CANARIO-MOTIVO" });
    expect(Object.keys(d)).toEqual(["codigo"]);
  });
});
