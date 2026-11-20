import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  abrirMensajeRespuestaSchema,
  adjuntoVistaSchema,
  detalleMensajeSchema,
  estadoBuzonSchema,
  mensajeBuzonFilaSchema,
  paginaMensajesBuzonSchema,
  revisarBuzonRespuestaSchema,
} from "./index.js";
import * as raiz from "../index.js";

// Spec 023 · T2 (rojo). Respuestas HTTP del buzón (plan 023, Contratos: HTTP; D-3, D-4, D-8; CA-4, CA-8, CA-10).
// Contrato fijado por estas pruebas (packages/shared/src/buzon/respuestas.ts, exportado por buzon/index.ts y por src/index.ts):
//  - mensajeBuzonFilaSchema = {id: uuid, asunto: string ≤ 500, remitente: string ≤ 200, fecha: ISO, categoria: CATEGORIAS_BUZON,
//    critico: boolean, motivoCritico: codigo|asunto|duda|null, leidoEnSunat: boolean, contenidoObtenido: boolean,
//    adjuntosDeclarados: entero ≥ 0}. Claves desconocidas descartadas: idSunat, tenantId, clienteId, contenidoRuta no salen.
//  - adjuntoVistaSchema = {id: uuid, nombre: string 1..120, mime: string|null, tamano: entero ≥ 0, omitido: mime|tamano|tope_mensaje|null}.
//    Nunca la ruta de storage ni el sha256.
//  - detalleMensajeSchema = {mensaje: fila, contenido: string | null, adjuntos: AdjuntoVista[]}; contenido null = aún no obtenido.
//    (024 suma `atencion` e `historial`, obligatorios; ver bandeja-024.spec.ts.)
//  - estadoBuzonSchema = {ultimaCaptura: ISO|null, sincronizado: boolean, revisarDesde: ISO|null}.
//  - paginaMensajesBuzonSchema = {estado, mensajes: fila[] (≤ 100; desde 024, filas de bandeja con cliente y atencion), siguiente: string (cursor opaco) | null}.
//  - revisarBuzonRespuestaSchema = {trabajo: TrabajoVista} (202 nuevo y 200 vivo); abrirMensajeRespuestaSchema = {trabajo: TrabajoVista | null}
//    (null = el contenido ya se obtuvo).
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

const fila = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  asunto: "Resolución de Intendencia N° 0150140012345",
  remitente: "SUNAT - Notificaciones",
  fecha: "2026-11-12T10:00:00.000Z",
  categoria: "coactiva",
  critico: true,
  motivoCritico: "codigo",
  leidoEnSunat: false,
  contenidoObtenido: false,
  adjuntosDeclarados: 1,
  ...o,
});
// Spec 024: en la ruta del cliente la fila lleva `cliente` y `atencion` (filaBandejaSchema).
const filaBandeja = (o: Record<string, unknown> = {}) => ({
  ...fila(),
  cliente: { id: randomUUID(), razonSocial: "San Juan SAC", archivado: false },
  atencion: { estado: "pendiente", por: null, en: null },
  ...o,
});
const adjunto = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  nombre: "resolucion.pdf",
  mime: "application/pdf",
  tamano: 20480,
  omitido: null,
  ...o,
});
const estado = (o: Record<string, unknown> = {}) => ({
  ultimaCaptura: "2026-11-17T07:41:00.000Z",
  sincronizado: true,
  revisarDesde: null,
  ...o,
});
const trabajo = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tipo: "sol.buzon.revisar",
  clienteId: randomUUID(),
  estado: "en_cola",
  posicion: 3,
  intentos: 0,
  motivo: null,
  creadoEn: "2026-11-17T12:00:00.000Z",
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: { usuarioId: randomUUID() },
  ...o,
});

describe("mensajeBuzonFilaSchema", () => {
  it("acepta una fila crítica completa y la devuelve igual", () => {
    const f = fila();
    expect(datos(mensajeBuzonFilaSchema, f)).toEqual(f);
  });
  it("acepta un mensaje común: categoría «otro», no crítico, sin motivo", () => {
    expect(ok(mensajeBuzonFilaSchema, fila({ categoria: "otro", critico: false, motivoCritico: null }))).toBe(true);
  });
  it.each(["coactiva", "resolucion_determinacion", "resolucion_multa", "requerimiento_fiscalizacion", "otro"])(
    "acepta la categoría %s",
    (categoria) => {
      expect(ok(mensajeBuzonFilaSchema, fila({ categoria }))).toBe(true);
    },
  );
  it.each(["codigo", "asunto", "duda", null])("acepta el motivo %j", (motivoCritico) => {
    expect(ok(mensajeBuzonFilaSchema, fila({ motivoCritico }))).toBe(true);
  });
  it.each(["Coactiva", "embargo", "", null, 1, undefined])("rechaza la categoría %j", (categoria) => {
    expect(ok(mensajeBuzonFilaSchema, fila({ categoria }))).toBe(false);
  });
  it.each(["CODIGO", "manual", "", 1, undefined])("rechaza el motivo %j", (motivoCritico) => {
    expect(ok(mensajeBuzonFilaSchema, fila({ motivoCritico }))).toBe(false);
  });
  it.each([
    ["id", "no-es-uuid"],
    ["id", null],
    ["asunto", 5],
    ["asunto", null],
    ["asunto", "x".repeat(501)],
    ["remitente", null],
    ["remitente", "x".repeat(201)],
    ["fecha", "ayer"],
    ["fecha", "2026-11-12"],
    ["fecha", null],
    ["critico", "si"],
    ["critico", 1],
    ["leidoEnSunat", null],
    ["contenidoObtenido", "true"],
    ["adjuntosDeclarados", -1],
    ["adjuntosDeclarados", 1.5],
    ["adjuntosDeclarados", "2"],
    ["adjuntosDeclarados", null],
  ])("rechaza %s = %j", (campo, valor) => {
    expect(ok(mensajeBuzonFilaSchema, fila({ [campo]: valor }))).toBe(false);
  });
  it("acepta asunto de 500 y remitente de 200 caracteres (los topes de la columna)", () => {
    expect(ok(mensajeBuzonFilaSchema, fila({ asunto: "a".repeat(500), remitente: "r".repeat(200) }))).toBe(true);
  });
  it.each(["id", "asunto", "remitente", "fecha", "categoria", "critico", "motivoCritico", "leidoEnSunat", "contenidoObtenido", "adjuntosDeclarados"])(
    "exige la clave %s",
    (clave) => {
      const f = fila() as Record<string, unknown>;
      delete f[clave];
      expect(ok(mensajeBuzonFilaSchema, f)).toBe(false);
    },
  );
  it("no deja salir idSunat, tenantId, clienteId, contenidoRuta ni la clave SOL", () => {
    const r = datos(mensajeBuzonFilaSchema, {
      ...fila(),
      idSunat: "9988776655",
      tenantId: randomUUID(),
      clienteId: randomUUID(),
      contenidoRuta: "buzon/t/c/x.txt",
      claveSol: "CANARIO",
    });
    for (const k of ["idSunat", "tenantId", "clienteId", "contenidoRuta", "claveSol"]) expect(r).not.toHaveProperty(k);
  });
});

describe("adjuntoVistaSchema", () => {
  it("acepta un adjunto guardado y lo devuelve igual", () => {
    const a = adjunto();
    expect(datos(adjuntoVistaSchema, a)).toEqual(a);
  });
  it.each(["mime", "tamano", "tope_mensaje"])("acepta un adjunto omitido por %s (sin MIME confiable)", (omitido) => {
    expect(ok(adjuntoVistaSchema, adjunto({ omitido, mime: null }))).toBe(true);
  });
  it.each(["otro", "", 1, undefined])("rechaza el motivo de omisión %j", (omitido) => {
    expect(ok(adjuntoVistaSchema, adjunto({ omitido }))).toBe(false);
  });
  it.each([
    ["id", "x"],
    ["nombre", ""],
    ["nombre", "x".repeat(121)],
    ["nombre", null],
    ["tamano", -1],
    ["tamano", 1.5],
    ["tamano", "10"],
    ["mime", 5],
  ])("rechaza %s = %j", (campo, valor) => {
    expect(ok(adjuntoVistaSchema, adjunto({ [campo]: valor }))).toBe(false);
  });
  it("no deja salir la ruta de storage, el sha256 ni los ids de SUNAT o del mensaje", () => {
    const r = datos(adjuntoVistaSchema, {
      ...adjunto(),
      ruta: "buzon/t/c/u.pdf",
      sha256: "ab".repeat(32),
      idSunat: "1",
      mensajeId: randomUUID(),
      tenantId: randomUUID(),
    });
    for (const k of ["ruta", "sha256", "idSunat", "mensajeId", "tenantId"]) expect(r).not.toHaveProperty(k);
  });
});

describe("detalleMensajeSchema", () => {
  const detalle = (o: Record<string, unknown> = {}) => ({
    mensaje: fila({ contenidoObtenido: true }),
    contenido: "Se le notifica la Resolución Coactiva…\nSaludos.",
    adjuntos: [adjunto()],
    // Spec 024: atención e historial son obligatorios (el detalle de 023 los suma).
    atencion: { estado: "pendiente", por: null, en: null, comentario: null },
    historial: [],
    ...o,
  });

  it("acepta el detalle con contenido y lo devuelve igual", () => {
    const d = detalle();
    expect(datos(detalleMensajeSchema, d)).toEqual(d);
  });
  it("acepta contenido null (aún no se abrió) y adjuntos vacíos", () => {
    expect(ok(detalleMensajeSchema, detalle({ contenido: null, adjuntos: [], mensaje: fila() }))).toBe(true);
  });
  it("acepta contenido vacío (cadena vacía no es null)", () => {
    expect(datos(detalleMensajeSchema, detalle({ contenido: "" })).contenido).toBe("");
  });
  it.each([5, undefined, ["a"], {}, true])("rechaza el contenido %j", (contenido) => {
    expect(ok(detalleMensajeSchema, detalle({ contenido }))).toBe(false);
  });
  it("exige la clave contenido (null explícito, no ausente)", () => {
    const d = detalle() as Record<string, unknown>;
    delete d.contenido;
    expect(ok(detalleMensajeSchema, d)).toBe(false);
  });
  it("rechaza adjuntos mal formados y un mensaje inválido", () => {
    expect(ok(detalleMensajeSchema, detalle({ adjuntos: [{ id: "x" }] }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ adjuntos: null }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ mensaje: fila({ categoria: "x" }) }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ mensaje: null }))).toBe(false);
  });
  it("el contenido viaja como texto: no se interpreta (un <script> es solo una cadena)", () => {
    const c = "<script>alert(1)</script>";
    expect(datos(detalleMensajeSchema, detalle({ contenido: c })).contenido).toBe(c);
  });
});

describe("estadoBuzonSchema", () => {
  it("acepta el estado con captura y sin espera, y lo devuelve igual", () => {
    const e = estado();
    expect(datos(estadoBuzonSchema, e)).toEqual(e);
  });
  it("acepta un cliente nunca capturado: ultimaCaptura null, sincronizado false", () => {
    expect(ok(estadoBuzonSchema, estado({ ultimaCaptura: null, sincronizado: false }))).toBe(true);
  });
  it("acepta revisarDesde con fecha (fin del enfriamiento de 10 min)", () => {
    expect(ok(estadoBuzonSchema, estado({ revisarDesde: "2026-11-17T12:10:00.000Z" }))).toBe(true);
  });
  it.each([
    ["ultimaCaptura", "hoy"],
    ["ultimaCaptura", 5],
    ["sincronizado", "true"],
    ["sincronizado", null],
    ["revisarDesde", "pronto"],
    ["revisarDesde", 600],
  ])("rechaza %s = %j", (campo, valor) => {
    expect(ok(estadoBuzonSchema, estado({ [campo]: valor }))).toBe(false);
  });
  it.each(["ultimaCaptura", "sincronizado", "revisarDesde"])("exige la clave %s", (clave) => {
    const e = estado() as Record<string, unknown>;
    delete e[clave];
    expect(ok(estadoBuzonSchema, e)).toBe(false);
  });
  it("no deja salir el cursor pendiente ni la última solicitud", () => {
    const r = datos(estadoBuzonSchema, { ...estado(), cursorPendiente: "abc", ultimaSolicitudEn: "2026-11-17T12:00:00.000Z" });
    expect(r).not.toHaveProperty("cursorPendiente");
    expect(r).not.toHaveProperty("ultimaSolicitudEn");
  });
});

describe("paginaMensajesBuzonSchema", () => {
  const pagina = (o: Record<string, unknown> = {}) => ({ estado: estado(), mensajes: [filaBandeja()], siguiente: null, ...o });

  it("acepta una página con cursor y la devuelve igual", () => {
    const p = pagina({ siguiente: "eyJhIjoxfQ" });
    expect(datos(paginaMensajesBuzonSchema, p)).toEqual(p);
  });
  it("acepta una página vacía (sin mensajes) y la última sin cursor", () => {
    expect(ok(paginaMensajesBuzonSchema, pagina({ mensajes: [], siguiente: null }))).toBe(true);
  });
  it("acepta 100 filas y rechaza 101", () => {
    expect(ok(paginaMensajesBuzonSchema, pagina({ mensajes: Array.from({ length: 100 }, () => filaBandeja()) }))).toBe(true);
    expect(ok(paginaMensajesBuzonSchema, pagina({ mensajes: Array.from({ length: 101 }, () => filaBandeja()) }))).toBe(false);
  });
  it.each([5, undefined, "", ["a"]])("rechaza siguiente = %j", (siguiente) => {
    expect(ok(paginaMensajesBuzonSchema, pagina({ siguiente }))).toBe(false);
  });
  it("rechaza una fila inválida y un estado inválido", () => {
    expect(ok(paginaMensajesBuzonSchema, pagina({ mensajes: [filaBandeja({ categoria: "x" })] }))).toBe(false);
    expect(ok(paginaMensajesBuzonSchema, pagina({ estado: { sincronizado: "x" } }))).toBe(false);
    expect(ok(paginaMensajesBuzonSchema, pagina({ estado: undefined }))).toBe(false);
  });
});

describe("revisarBuzonRespuestaSchema y abrirMensajeRespuestaSchema", () => {
  it("revisar acepta {trabajo} (202 nuevo o 200 vivo)", () => {
    expect(ok(revisarBuzonRespuestaSchema, { trabajo: trabajo() })).toBe(true);
    expect(ok(revisarBuzonRespuestaSchema, { trabajo: trabajo({ estado: "ejecutando", posicion: null }) })).toBe(true);
  });
  it("revisar exige el trabajo: ni null ni ausente", () => {
    expect(ok(revisarBuzonRespuestaSchema, { trabajo: null })).toBe(false);
    expect(ok(revisarBuzonRespuestaSchema, {})).toBe(false);
    expect(ok(revisarBuzonRespuestaSchema, { trabajo: { id: "x" } })).toBe(false);
  });
  it("abrir acepta {trabajo} (202) y {trabajo: null} (200: ya se obtuvo)", () => {
    expect(ok(abrirMensajeRespuestaSchema, { trabajo: trabajo({ tipo: "sol.buzon.abrir" }) })).toBe(true);
    expect(datos(abrirMensajeRespuestaSchema, { trabajo: null }).trabajo).toBeNull();
  });
  it("abrir exige la clave trabajo", () => {
    expect(ok(abrirMensajeRespuestaSchema, {})).toBe(false);
    expect(ok(abrirMensajeRespuestaSchema, { trabajo: "x" })).toBe(false);
  });
  it("el trabajo no deja salir tenantId, ruc, parámetros ni resultado (CA-10)", () => {
    const r = datos(revisarBuzonRespuestaSchema, {
      trabajo: { ...trabajo(), tenantId: randomUUID(), ruc: "20100070970", parametros: { mensajeId: randomUUID() }, resultado: { nuevos: 1 } },
    });
    const t = r.trabajo as Record<string, unknown>;
    for (const k of ["tenantId", "ruc", "parametros", "resultado"]) expect(t).not.toHaveProperty(k);
  });
});

describe("índice de shared", () => {
  it("exporta los esquemas de respuesta del buzón", () => {
    expect(raiz.mensajeBuzonFilaSchema).toBe(mensajeBuzonFilaSchema);
    expect(raiz.detalleMensajeSchema).toBe(detalleMensajeSchema);
    expect(raiz.estadoBuzonSchema).toBe(estadoBuzonSchema);
    expect(raiz.paginaMensajesBuzonSchema).toBe(paginaMensajesBuzonSchema);
    expect(raiz.adjuntoVistaSchema).toBe(adjuntoVistaSchema);
    expect(raiz.revisarBuzonRespuestaSchema).toBe(revisarBuzonRespuestaSchema);
    expect(raiz.abrirMensajeRespuestaSchema).toBe(abrirMensajeRespuestaSchema);
  });
});
