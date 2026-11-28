import { describe, expect, it } from "vitest";
import { archivo, capturarSync, cuerpoTicket, esperarError, registroTicket } from "./pruebas/ayudas-http.js";
import { TOPE_ESPERA_TICKET_MS, interpretarConsultaTicket, planEsperaTicket } from "./ticket.js";

// Contrato de `ticket.ts` (plan 041, «ticket.ts» y Decisiones; spec CA-8, CA-9):
//  - `interpretarConsultaTicket(cuerpo: unknown, numTicket: string): EstadoTicket` es PURA y sin IO.
//    Busca en `cuerpo.registros` el que tenga `numTicket` EXACTO (nunca `registros[0]`):
//      codEstadoProceso "01" | "02" | "05" -> { listo: false }
//      "04" | "06"                         -> { listo: true, codProceso, perTributario, partes: [{ nombre, codTipo }] }
//                                             `nombre` = nomArchivoReporte; `codTipo` = codTipoAchivoReporte ??
//                                             codTipoArchivoReporte (texto) o `null`; el orden de `archivoReporte` se conserva.
//      "03"                                -> lanza ErrorDatosSire("ticket_con_errores")
//      otro código                         -> lanza ErrorPortalSire("estado_desconocido")
//    Ningún registro con ese `numTicket` (incluida lista vacía) -> ErrorDatosSire("respuesta_ajena").
//    Cuerpo que no cumple el esquema (no objeto, `registros` no es lista, registro sin numTicket/estado) ->
//    ErrorPortalSire("respuesta_inesperada"). Un registro AJENO malformado o en error no afecta al nuestro si el nuestro es válido.
//  - `TOPE_ESPERA_TICKET_MS` = 20_000. `planEsperaTicket()` = esperas (ms) entre consultas pendientes: empieza
//    500, 1000, 2000, 4000, ninguna pasa de 4000 y la suma no pasa del tope (y lo aprovecha: >= 19_500).
const T = "202610000777";
const ARCH = [archivo("parte1.zip", "00"), archivo("parte2.zip", null)];

describe("interpretarConsultaTicket · estados", () => {
  it.each(["01", "02", "05"])("estado %s = pendiente", (estado) => {
    expect(interpretarConsultaTicket(cuerpoTicket([registroTicket(T, estado)]), T)).toEqual({ listo: false });
  });

  it.each(["04", "06"])("estado %s = listo, con codProceso, periodo y partes en orden", (estado) => {
    const r = interpretarConsultaTicket(cuerpoTicket([registroTicket(T, estado, ARCH, { codProceso: "10", perTributario: "202610" })]), T);
    expect(r).toEqual({
      listo: true,
      codProceso: "10",
      perTributario: "202610",
      partes: [
        { nombre: "parte1.zip", codTipo: "00" },
        { nombre: "parte2.zip", codTipo: null },
      ],
    });
  });

  it("03 = ErrorDatosSire ticket_con_errores", () => {
    const e = capturarSync(() => interpretarConsultaTicket(cuerpoTicket([registroTicket(T, "03")]), T));
    esperarError(e, "ErrorDatosSire", "ticket_con_errores");
  });

  it.each(["00", "07", "99", "", "4"])("código desconocido %j = ErrorPortalSire estado_desconocido", (estado) => {
    const e = capturarSync(() => interpretarConsultaTicket(cuerpoTicket([registroTicket(T, estado)]), T));
    esperarError(e, "ErrorPortalSire", "estado_desconocido");
  });

  it("lee el tipo de archivo con el nombre del portal (sin «r») o con el corregido", () => {
    const r = interpretarConsultaTicket(
      cuerpoTicket([
        registroTicket(T, "04", [
          { nomArchivoReporte: "a.zip", codTipoAchivoReporte: "01" },
          { nomArchivoReporte: "b.zip", codTipoArchivoReporte: "02" },
          { nomArchivoReporte: "c.zip" },
        ]),
      ]),
      T,
    );
    expect(r).toMatchObject({ listo: true, partes: [{ codTipo: "01" }, { codTipo: "02" }, { codTipo: null }] });
  });
});

describe("interpretarConsultaTicket · ticket ajeno (CA-8)", () => {
  it("elige el registro por numTicket exacto aunque no sea el primero", () => {
    const r = interpretarConsultaTicket(
      cuerpoTicket([registroTicket("OTRO-1", "04", [archivo("ajeno.zip")]), registroTicket(T, "04", [archivo("mio.zip")])]),
      T,
    );
    expect(r).toMatchObject({ listo: true, partes: [{ nombre: "mio.zip" }] });
  });

  it("un registro ajeno en error o pendiente no cambia el estado del nuestro", () => {
    const r = interpretarConsultaTicket(cuerpoTicket([registroTicket("OTRO-1", "03"), registroTicket(T, "04", [archivo("mio.zip")])]), T);
    expect(r).toMatchObject({ listo: true });
    const p = interpretarConsultaTicket(cuerpoTicket([registroTicket("OTRO-1", "04", [archivo("x.zip")]), registroTicket(T, "01")]), T);
    expect(p).toEqual({ listo: false });
  });

  it.each([
    ["solo registros ajenos", cuerpoTicket([registroTicket("OTRO-1", "04", [archivo("ajeno.zip")])])],
    ["lista vacía", cuerpoTicket([])],
    ["numTicket parecido (prefijo)", cuerpoTicket([registroTicket(`${T}0`, "04", [archivo("ajeno.zip")])])],
    ["numTicket con espacios", cuerpoTicket([registroTicket(` ${T} `, "04", [archivo("ajeno.zip")])])],
  ])("%s -> ErrorDatosSire respuesta_ajena", (_caso, cuerpo) => {
    const e = capturarSync(() => interpretarConsultaTicket(cuerpo, T));
    esperarError(e, "ErrorDatosSire", "respuesta_ajena");
  });
});

describe("interpretarConsultaTicket · esquema", () => {
  it.each([
    ["null", null],
    ["lista", []],
    ["texto", "ok"],
    ["sin registros", {}],
    ["registros no es lista", { registros: "x" }],
    ["registro sin numTicket", { registros: [{ codEstadoProceso: "04", archivoReporte: [] }] }],
    ["registro sin estado", { registros: [{ numTicket: T, archivoReporte: [] }] }],
    ["estado numérico", { registros: [{ numTicket: T, codEstadoProceso: 4, archivoReporte: [] }] }],
    ["archivoReporte no es lista", { registros: [{ numTicket: T, codEstadoProceso: "04", archivoReporte: "x.zip" }] }],
    ["archivo sin nombre", { registros: [{ numTicket: T, codEstadoProceso: "04", archivoReporte: [{ codTipoAchivoReporte: "00" }] }] }],
  ])("%s -> ErrorPortalSire respuesta_inesperada", (_caso, cuerpo) => {
    const e = capturarSync(() => interpretarConsultaTicket(cuerpo, T));
    esperarError(e, "ErrorPortalSire", "respuesta_inesperada");
  });

  it("listo (04/06) sin archivos devuelve partes vacías (el cliente decide qué hacer)", () => {
    const r = interpretarConsultaTicket(cuerpoTicket([registroTicket(T, "04", [])]), T);
    expect(r).toMatchObject({ listo: true, partes: [] });
  });
});

describe("planEsperaTicket (P-4 c)", () => {
  it("el tope es de 20 s", () => {
    expect(TOPE_ESPERA_TICKET_MS).toBe(20_000);
  });

  it("empieza 0,5 / 1 / 2 / 4 s y ninguna espera pasa de 4 s", () => {
    const plan = planEsperaTicket();
    expect(plan.slice(0, 4)).toEqual([500, 1000, 2000, 4000]);
    for (const ms of plan) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(4000);
    }
  });

  it("la suma no pasa de 20 s y aprovecha casi todo el tope", () => {
    const suma = planEsperaTicket().reduce((a, b) => a + b, 0);
    expect(suma).toBeLessThanOrEqual(20_000);
    expect(suma).toBeGreaterThanOrEqual(19_500);
  });
});
