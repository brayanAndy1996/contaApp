import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CATEGORIAS_BUZON,
  CODIGOS_ERROR_BUZON,
  ESTADOS_ATENCION,
  FILTROS_ATENCION,
  detalleMensajeSchema,
  errorBuzonSchema,
  filaBandejaSchema,
  filtrosBandejaClienteSchema,
  filtrosBandejaSchema,
  indicadorBuzonSchema,
  paginaMensajesBuzonSchema,
  respuestaBandejaSchema,
} from "./index.js";
import { filtrosClientesSchema } from "../clientes/index.js";
import * as raiz from "../index.js";

// Spec 024 · T1 (rojo). Contratos de la bandeja en `shared` (plan 024, Contratos: shared; D-2 a D-4, D-7, D-9, D-12; CA-2, CA-4, CA-8).
// Contrato fijado por estas pruebas (packages/shared/src/buzon/bandeja.ts, exportado por buzon/index.ts y por src/index.ts):
//  - ESTADOS_ATENCION = [pendiente, atendido, historico]; FILTROS_ATENCION = [pendientes, atendidos, historicos, todos].
//  - filtrosBandejaSchema (.strict(); valores de query como texto): responsable? "yo", categoria? CATEGORIAS_BUZON | "criticos",
//    leido? "si" | "no", atencion? FILTROS_ATENCION (por defecto "todos"), desde?/hasta? AAAA-MM-DD reales con desde <= hasta,
//    archivados? "1", cursor? string 1..256, limite? entero 1..100 (llega como texto, sale como number). Clave desconocida = error (400).
//  - filtrosBandejaClienteSchema = el mismo sin `responsable` ni `archivados` (la ruta del cliente los rechaza).
//  - filaBandejaSchema = fila de 023 + cliente {id, razonSocial, archivado} + atencion {estado, por {id, nombre}|null, en ISO|null}.
//  - respuestaBandejaSchema = {mensajes: fila[], siguiente: string|null}. paginaMensajesBuzonSchema (ruta del cliente, 023) pasa a
//    llevar filaBandejaSchema en `mensajes` (no descarta cliente ni atencion).
//  - detalleMensajeSchema (023) suma atencion {estado, por, en, comentario: string|null} e historial: EventoAtencion[] (obligatorios).
//  - CODIGOS_ERROR_BUZON suma atencion_cambiada, comentario_requerido y cursor_invalido (errorBuzonSchema los acepta).
//  - indicadorBuzonSchema = {nuevos: entero >= 0, criticosNuevos: entero >= 0}: es la forma de `ClienteDto.buzon` (nombre NUEVO, no está
//    en el plan: el tester lo fija porque ClienteDto es una interfaz y no hay otra forma de probar el contrato en ejecución).
//  - filtrosClientesSchema suma conMensajesNuevos? "1" (cualquier otro valor = error).
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const esq = (s: Esquema | undefined): Esquema => {
  if (!s) throw new Error("no implementado: export ausente");
  return s;
};
const ok = (s: Esquema | undefined, v: unknown) => esq(s).safeParse(v).success;
const datos = (s: Esquema | undefined, v: unknown) => {
  const r = esq(s).safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

const U1 = "01920000-0000-7000-8000-0000000000a1";
const U2 = "01920000-0000-7000-8000-0000000000a2";

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
const atencionPendiente = { estado: "pendiente", por: null, en: null };
const atencionAtendida = {
  estado: "atendido",
  por: { id: U1, nombre: "Ana Paredes" },
  en: "2026-11-13T09:30:00.000Z",
};
const filaBandeja = (o: Record<string, unknown> = {}) => ({
  ...fila(),
  cliente: { id: U2, razonSocial: "San Juan SAC", archivado: false },
  atencion: atencionPendiente,
  ...o,
});
const evento = (o: Record<string, unknown> = {}) => ({
  accion: "atendido",
  comentario: "Se presentó el escrito de reclamo",
  usuario: { id: U1, nombre: "Ana Paredes" },
  en: "2026-11-13T09:30:00.000Z",
  ...o,
});

describe("constantes de atención", () => {
  it("ESTADOS_ATENCION = pendiente, atendido, historico", () => {
    expect([...ESTADOS_ATENCION]).toEqual(["pendiente", "atendido", "historico"]);
  });
  it("FILTROS_ATENCION = pendientes, atendidos, historicos, todos", () => {
    expect([...FILTROS_ATENCION]).toEqual(["pendientes", "atendidos", "historicos", "todos"]);
  });
  it("se exportan desde el índice de shared", () => {
    expect(ESTADOS_ATENCION).toBeDefined();
    expect(raiz.ESTADOS_ATENCION).toBe(ESTADOS_ATENCION);
    expect(FILTROS_ATENCION).toBeDefined();
    expect(raiz.FILTROS_ATENCION).toBe(FILTROS_ATENCION);
  });
});

describe("filtrosBandejaSchema", () => {
  it("acepta la query vacía y deja la atención en «todos» (la API sin filtro devuelve todos)", () => {
    expect(datos(filtrosBandejaSchema, {}).atencion).toBe("todos");
  });
  it.each(["pendientes", "atendidos", "historicos", "todos"])("acepta atencion=%s", (atencion) => {
    expect(datos(filtrosBandejaSchema, { atencion }).atencion).toBe(atencion);
  });
  it.each(["pendiente", "Pendientes", "historico", "", "1", "nuevos", 1, null])("rechaza atencion=%j", (atencion) => {
    expect(ok(filtrosBandejaSchema, { atencion })).toBe(false);
  });

  it.each(["coactiva", "resolucion_determinacion", "resolucion_multa", "requerimiento_fiscalizacion", "otro", "criticos"])(
    "acepta categoria=%s",
    (categoria) => {
      expect(datos(filtrosBandejaSchema, { categoria }).categoria).toBe(categoria);
    },
  );
  it.each(["inexistente", "Coactiva", "critico", "", " coactiva", "todos", 5])("rechaza categoria=%j", (categoria) => {
    expect(ok(filtrosBandejaSchema, { categoria })).toBe(false);
  });
  it("«criticos» es un valor del filtro y no una categoría de CATEGORIAS_BUZON", () => {
    expect(CATEGORIAS_BUZON as readonly string[]).not.toContain("criticos");
    expect(ok(filtrosBandejaSchema, { categoria: "criticos" })).toBe(true);
  });

  it.each(["si", "no"])("acepta leido=%s", (leido) => {
    expect(datos(filtrosBandejaSchema, { leido }).leido).toBe(leido);
  });
  it.each(["true", "1", "SI", "", "sí", true])("rechaza leido=%j", (leido) => {
    expect(ok(filtrosBandejaSchema, { leido })).toBe(false);
  });

  it("acepta responsable=yo y rechaza cualquier otro valor", () => {
    expect(ok(filtrosBandejaSchema, { responsable: "yo" })).toBe(true);
    for (const malo of ["todos", "", "Yo", U1, "1", true]) {
      expect(ok(filtrosBandejaSchema, { responsable: malo })).toBe(false);
    }
  });
  it("acepta archivados=1 y rechaza lo demás", () => {
    expect(ok(filtrosBandejaSchema, { archivados: "1" })).toBe(true);
    for (const malo of ["0", "true", "", "si", 1, true]) {
      expect(ok(filtrosBandejaSchema, { archivados: malo })).toBe(false);
    }
  });

  describe("fechas (días de Lima, AAAA-MM-DD)", () => {
    it("acepta desde, hasta y ambos", () => {
      expect(ok(filtrosBandejaSchema, { desde: "2026-11-01" })).toBe(true);
      expect(ok(filtrosBandejaSchema, { hasta: "2026-11-30" })).toBe(true);
      expect(ok(filtrosBandejaSchema, { desde: "2026-11-01", hasta: "2026-11-30" })).toBe(true);
    });
    it("acepta desde igual a hasta (un solo día, inclusive)", () => {
      expect(ok(filtrosBandejaSchema, { desde: "2026-11-20", hasta: "2026-11-20" })).toBe(true);
    });
    it("rechaza desde posterior a hasta", () => {
      expect(ok(filtrosBandejaSchema, { desde: "2026-11-21", hasta: "2026-11-20" })).toBe(false);
      expect(ok(filtrosBandejaSchema, { desde: "2027-01-01", hasta: "2026-12-31" })).toBe(false);
    });
    it("compara fechas, no textos: 2026-09-30 no es posterior a 2026-10-01", () => {
      expect(ok(filtrosBandejaSchema, { desde: "2026-09-30", hasta: "2026-10-01" })).toBe(true);
    });
    it.each(["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-11-31", "2026-04-31", "2026-11-00"])(
      "rechaza la fecha imposible %s",
      (f) => {
        expect(ok(filtrosBandejaSchema, { desde: f })).toBe(false);
        expect(ok(filtrosBandejaSchema, { hasta: f })).toBe(false);
      },
    );
    it("acepta el 29 de febrero de un año bisiesto", () => {
      expect(ok(filtrosBandejaSchema, { desde: "2028-02-29" })).toBe(true);
    });
    it.each(["20-11-2026", "2026/11/20", "2026-1-5", "2026-11-20T00:00:00Z", "2026-11-20 ", "", "hoy", "20261120", 20261120])(
      "rechaza el formato %j",
      (f) => {
        expect(ok(filtrosBandejaSchema, { desde: f })).toBe(false);
        expect(ok(filtrosBandejaSchema, { hasta: f })).toBe(false);
      },
    );
  });

  describe("cursor y límite", () => {
    it("acepta un cursor de 256 caracteres y rechaza uno de 257", () => {
      expect(ok(filtrosBandejaSchema, { cursor: "a".repeat(256) })).toBe(true);
      expect(ok(filtrosBandejaSchema, { cursor: "a".repeat(257) })).toBe(false);
    });
    it("devuelve el cursor igual y rechaza vacío o no texto", () => {
      const cursor = "eyJ2IjoxLCJmIjoiMjAyNi0xMS0xMlQxMDowMDowMC4wMDAwMDBaIn0";
      expect(datos(filtrosBandejaSchema, { cursor }).cursor).toBe(cursor);
      for (const malo of ["", 1, null, {}, ["a"]]) expect(ok(filtrosBandejaSchema, { cursor: malo })).toBe(false);
    });
    it("limite llega como texto y sale como número", () => {
      expect(datos(filtrosBandejaSchema, { limite: "7" }).limite).toBe(7);
      expect(datos(filtrosBandejaSchema, { limite: 40 }).limite).toBe(40);
    });
    it.each(["1", "50", "100"])("acepta limite=%s", (limite) => {
      expect(ok(filtrosBandejaSchema, { limite })).toBe(true);
    });
    it.each(["0", "101", "-1", "1.5", "abc", "", "1e2", 0, 101, -5, 2.5, NaN, null])("rechaza limite=%j", (limite) => {
      expect(ok(filtrosBandejaSchema, { limite })).toBe(false);
    });
  });

  it("acepta todos los filtros juntos", () => {
    const q = {
      responsable: "yo",
      categoria: "criticos",
      leido: "no",
      atencion: "pendientes",
      desde: "2026-11-01",
      hasta: "2026-11-30",
      archivados: "1",
      cursor: "abc",
      limite: "25",
    };
    const r = datos(filtrosBandejaSchema, q);
    expect(r).toMatchObject({ ...q, limite: 25 });
  });

  it.each(["clienteId", "tenantId", "foo", "q", "usuarioId"])(
    "rechaza la clave desconocida %s (D-3: parámetro desconocido = 400)",
    (clave) => {
      expect(ok(filtrosBandejaSchema, { [clave]: U1 })).toBe(false);
      expect(ok(filtrosBandejaSchema, { atencion: "todos", [clave]: "x" })).toBe(false);
    },
  );
  it("se exporta desde el índice de shared", () => {
    expect(filtrosBandejaSchema).toBeDefined();
    expect(raiz.filtrosBandejaSchema).toBe(filtrosBandejaSchema);
  });
});

describe("filtrosBandejaClienteSchema (ruta del cliente)", () => {
  it("acepta la query vacía con atención «todos»", () => {
    expect(datos(filtrosBandejaClienteSchema, {}).atencion).toBe("todos");
  });
  it("acepta categoria, leido, atencion, fechas, cursor y limite", () => {
    const q = { categoria: "coactiva", leido: "si", atencion: "historicos", desde: "2026-11-01", hasta: "2026-11-30", cursor: "x", limite: "10" };
    expect(datos(filtrosBandejaClienteSchema, q)).toMatchObject({ ...q, limite: 10 });
  });
  it("rechaza `responsable` y `archivados`: el cliente ya viene fijado por la ruta", () => {
    expect(ok(filtrosBandejaClienteSchema, { responsable: "yo" })).toBe(false);
    expect(ok(filtrosBandejaClienteSchema, { archivados: "1" })).toBe(false);
  });
  it("rechaza claves desconocidas (clienteId no viaja por la query)", () => {
    expect(ok(filtrosBandejaClienteSchema, { clienteId: U1 })).toBe(false);
    expect(ok(filtrosBandejaClienteSchema, { tenantId: U1 })).toBe(false);
  });
  it("aplica las mismas validaciones de valores que el esquema global", () => {
    expect(ok(filtrosBandejaClienteSchema, { atencion: "otro" })).toBe(false);
    expect(ok(filtrosBandejaClienteSchema, { desde: "2026-02-30" })).toBe(false);
    expect(ok(filtrosBandejaClienteSchema, { desde: "2026-11-21", hasta: "2026-11-20" })).toBe(false);
    expect(ok(filtrosBandejaClienteSchema, { limite: "101" })).toBe(false);
    expect(ok(filtrosBandejaClienteSchema, { cursor: "a".repeat(257) })).toBe(false);
  });
  it("se exporta desde el índice de shared", () => {
    expect(filtrosBandejaClienteSchema).toBeDefined();
    expect(raiz.filtrosBandejaClienteSchema).toBe(filtrosBandejaClienteSchema);
  });
});

describe("filaBandejaSchema", () => {
  it("acepta una fila pendiente y la devuelve igual", () => {
    const f = filaBandeja();
    expect(datos(filaBandejaSchema, f)).toEqual(f);
  });
  it("acepta una fila atendida con quién y cuándo", () => {
    const f = filaBandeja({ atencion: atencionAtendida });
    expect(datos(filaBandejaSchema, f)).toEqual(f);
  });
  it("acepta una fila histórica y un cliente archivado", () => {
    const f = filaBandeja({
      atencion: { estado: "historico", por: null, en: null },
      cliente: { id: U2, razonSocial: "Cliente cerrado SAC", archivado: true },
    });
    expect(datos(filaBandejaSchema, f)).toEqual(f);
  });
  it.each(["pendiente", "atendido", "historico"])("acepta atencion.estado=%s", (estado) => {
    expect(ok(filaBandejaSchema, filaBandeja({ atencion: { estado, por: null, en: null } }))).toBe(true);
  });
  it.each(["atendida", "nuevo", "", null, 1])("rechaza atencion.estado=%j", (estado) => {
    expect(ok(filaBandejaSchema, filaBandeja({ atencion: { estado, por: null, en: null } }))).toBe(false);
  });
  it("exige cliente y atencion", () => {
    const sinCliente = filaBandeja() as Record<string, unknown>;
    delete sinCliente.cliente;
    const sinAtencion = filaBandeja() as Record<string, unknown>;
    delete sinAtencion.atencion;
    expect(ok(filaBandejaSchema, sinCliente)).toBe(false);
    expect(ok(filaBandejaSchema, sinAtencion)).toBe(false);
  });
  it("rechaza un cliente mal formado", () => {
    expect(ok(filaBandejaSchema, filaBandeja({ cliente: { id: "x", razonSocial: "A", archivado: false } }))).toBe(false);
    expect(ok(filaBandejaSchema, filaBandeja({ cliente: { id: U2, razonSocial: "A" } }))).toBe(false);
    expect(ok(filaBandejaSchema, filaBandeja({ cliente: { id: U2, archivado: false } }))).toBe(false);
    expect(ok(filaBandejaSchema, filaBandeja({ cliente: null }))).toBe(false);
  });
  it("rechaza `por` mal formado y `en` que no es una fecha ISO", () => {
    expect(ok(filaBandejaSchema, filaBandeja({ atencion: { estado: "atendido", por: { id: "x", nombre: "A" }, en: "2026-11-13T09:30:00.000Z" } }))).toBe(false);
    expect(ok(filaBandejaSchema, filaBandeja({ atencion: { estado: "atendido", por: { id: U1, nombre: "A" }, en: "ayer" } }))).toBe(false);
  });
  it("conserva la validación de la fila de 023 (categoría inválida, id no uuid)", () => {
    expect(ok(filaBandejaSchema, filaBandeja({ categoria: "x" }))).toBe(false);
    expect(ok(filaBandejaSchema, filaBandeja({ id: "no-uuid" }))).toBe(false);
  });
  it("descarta claves desconocidas: ni RUC, ni tenantId, ni idSunat, ni el comentario salen en la fila", () => {
    const f = filaBandeja({
      tenantId: U1,
      idSunat: "999",
      cliente: { id: U2, razonSocial: "San Juan SAC", archivado: false, ruc: "20100070970" },
      atencion: { ...atencionAtendida, comentario: "CANARIO-COMENTARIO" },
    });
    const r = datos(filaBandejaSchema, f) as { cliente: Record<string, unknown>; atencion: Record<string, unknown> };
    expect(r).not.toHaveProperty("tenantId");
    expect(r).not.toHaveProperty("idSunat");
    expect(r.cliente).not.toHaveProperty("ruc");
    expect(r.atencion).not.toHaveProperty("comentario");
  });
  it("se exporta desde el índice de shared", () => {
    expect(filaBandejaSchema).toBeDefined();
    expect(raiz.filaBandejaSchema).toBe(filaBandejaSchema);
  });
});

describe("respuestaBandejaSchema", () => {
  it("acepta la página con cursor siguiente y la devuelve igual", () => {
    const r = { mensajes: [filaBandeja(), filaBandeja({ atencion: atencionAtendida })], siguiente: "abc" };
    expect(datos(respuestaBandejaSchema, r)).toEqual(r);
  });
  it("acepta la última página (siguiente null) y la página vacía", () => {
    expect(ok(respuestaBandejaSchema, { mensajes: [filaBandeja()], siguiente: null })).toBe(true);
    expect(ok(respuestaBandejaSchema, { mensajes: [], siguiente: null })).toBe(true);
  });
  it("rechaza siguiente vacío o no texto, y exige la clave", () => {
    expect(ok(respuestaBandejaSchema, { mensajes: [], siguiente: "" })).toBe(false);
    expect(ok(respuestaBandejaSchema, { mensajes: [], siguiente: 5 })).toBe(false);
    expect(ok(respuestaBandejaSchema, { mensajes: [] })).toBe(false);
  });
  it("rechaza filas sin cliente o sin atención", () => {
    expect(ok(respuestaBandejaSchema, { mensajes: [fila()], siguiente: null })).toBe(false);
  });
  it("rechaza mensajes que no es una lista", () => {
    expect(ok(respuestaBandejaSchema, { mensajes: null, siguiente: null })).toBe(false);
    expect(ok(respuestaBandejaSchema, { siguiente: null })).toBe(false);
  });
  it("se exporta desde el índice de shared", () => {
    expect(respuestaBandejaSchema).toBeDefined();
    expect(raiz.respuestaBandejaSchema).toBe(respuestaBandejaSchema);
  });
});

describe("paginaMensajesBuzonSchema (ruta del cliente) con filas de bandeja", () => {
  const estado = { ultimaCaptura: "2026-11-17T07:41:00.000Z", sincronizado: true, revisarDesde: null };
  it("conserva cliente y atencion de cada fila (ya no los descarta)", () => {
    const f = filaBandeja({ atencion: atencionAtendida });
    const r = datos(paginaMensajesBuzonSchema, { estado, mensajes: [f], siguiente: null }) as { mensajes: unknown[] };
    expect(r.mensajes[0]).toEqual(f);
  });
  it("rechaza una fila sin atencion", () => {
    expect(ok(paginaMensajesBuzonSchema, { estado, mensajes: [fila()], siguiente: null })).toBe(false);
  });
});

describe("detalleMensajeSchema con atención e historial", () => {
  const adjunto = { id: randomUUID(), nombre: "resolucion.pdf", mime: "application/pdf", tamano: 20480, omitido: null };
  const detalle = (o: Record<string, unknown> = {}) => ({
    mensaje: fila({ contenidoObtenido: true }),
    contenido: "Se le notifica la Resolución Coactiva…",
    adjuntos: [adjunto],
    atencion: { ...atencionAtendida, comentario: "Se presentó el escrito de reclamo" },
    historial: [
      evento({ accion: "atendido", comentario: "Primer intento", en: "2026-11-13T09:30:00.000Z" }),
      evento({ accion: "deshecho", comentario: null, usuario: { id: U2, nombre: "Luis Rojas" }, en: "2026-11-14T08:00:00.000Z" }),
      evento({ accion: "atendido", comentario: "Se presentó el escrito de reclamo", en: "2026-11-15T10:00:00.000Z" }),
    ],
    ...o,
  });

  it("acepta el detalle con atención e historial y lo devuelve igual (el orden se conserva)", () => {
    const d = detalle();
    expect(datos(detalleMensajeSchema, d)).toEqual(d);
  });
  it("acepta un mensaje pendiente: sin comentario y con historial vacío", () => {
    const d = detalle({ atencion: { ...atencionPendiente, comentario: null }, historial: [] });
    expect(datos(detalleMensajeSchema, d)).toEqual(d);
  });
  it("acepta un histórico sin atender", () => {
    const d = detalle({ atencion: { estado: "historico", por: null, en: null, comentario: null }, historial: [] });
    expect(datos(detalleMensajeSchema, d)).toEqual(d);
  });
  it("exige atencion e historial", () => {
    const sinAtencion = detalle() as Record<string, unknown>;
    delete sinAtencion.atencion;
    const sinHistorial = detalle() as Record<string, unknown>;
    delete sinHistorial.historial;
    expect(ok(detalleMensajeSchema, sinAtencion)).toBe(false);
    expect(ok(detalleMensajeSchema, sinHistorial)).toBe(false);
  });
  it("exige la clave atencion.comentario (null explícito)", () => {
    expect(ok(detalleMensajeSchema, detalle({ atencion: { ...atencionAtendida } }))).toBe(false);
  });
  it("rechaza atencion con estado inválido y comentario que no es texto", () => {
    expect(ok(detalleMensajeSchema, detalle({ atencion: { estado: "x", por: null, en: null, comentario: null } }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ atencion: { ...atencionAtendida, comentario: 5 } }))).toBe(false);
  });
  it("rechaza un historial que no es lista o con eventos mal formados", () => {
    expect(ok(detalleMensajeSchema, detalle({ historial: null }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ historial: [evento({ accion: "marcar" })] }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ historial: [evento({ usuario: { id: "x", nombre: "A" } })] }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ historial: [evento({ en: "ayer" })] }))).toBe(false);
  });
  it("conserva la validación de 023 (contenido, adjuntos, mensaje)", () => {
    expect(ok(detalleMensajeSchema, detalle({ contenido: 5 }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ adjuntos: null }))).toBe(false);
    expect(ok(detalleMensajeSchema, detalle({ mensaje: fila({ categoria: "x" }) }))).toBe(false);
  });
});

describe("códigos de error de la bandeja", () => {
  it.each(["atencion_cambiada", "comentario_requerido", "cursor_invalido"])("CODIGOS_ERROR_BUZON incluye %s", (c) => {
    expect(CODIGOS_ERROR_BUZON as readonly string[]).toContain(c);
  });
  it.each(["atencion_cambiada", "comentario_requerido", "cursor_invalido"])("errorBuzonSchema acepta {codigo: %s}", (codigo) => {
    expect(datos(errorBuzonSchema, { codigo })).toEqual({ codigo });
  });
  it("siguen los de 023 y no se repiten", () => {
    for (const c of ["cliente_archivado", "credencial_no_configurada", "credencial_invalida", "captura_reciente"]) {
      expect(CODIGOS_ERROR_BUZON as readonly string[]).toContain(c);
    }
    expect(new Set(CODIGOS_ERROR_BUZON).size).toBe(CODIGOS_ERROR_BUZON.length);
  });
  it("el cuerpo de error sigue siendo solo {codigo}: nada de datos del mensaje", () => {
    const r = datos(errorBuzonSchema, { codigo: "comentario_requerido", comentario: "CANARIO", asunto: "x" });
    expect(r).toEqual({ codigo: "comentario_requerido" });
  });
});

describe("indicadorBuzonSchema (ClienteDto.buzon)", () => {
  it("acepta nuevos y criticosNuevos y los devuelve igual", () => {
    expect(datos(indicadorBuzonSchema, { nuevos: 12, criticosNuevos: 3 })).toEqual({ nuevos: 12, criticosNuevos: 3 });
    expect(ok(indicadorBuzonSchema, { nuevos: 0, criticosNuevos: 0 })).toBe(true);
  });
  it.each([-1, 1.5, "3", null, NaN, undefined])("rechaza nuevos=%j", (nuevos) => {
    expect(ok(indicadorBuzonSchema, { nuevos, criticosNuevos: 0 })).toBe(false);
  });
  it.each([-1, 0.5, "1", null, undefined])("rechaza criticosNuevos=%j", (criticosNuevos) => {
    expect(ok(indicadorBuzonSchema, { nuevos: 1, criticosNuevos })).toBe(false);
  });
  it("exige las dos claves", () => {
    expect(ok(indicadorBuzonSchema, { nuevos: 1 })).toBe(false);
    expect(ok(indicadorBuzonSchema, { criticosNuevos: 1 })).toBe(false);
    expect(ok(indicadorBuzonSchema, {})).toBe(false);
  });
});

describe("filtrosClientesSchema.conMensajesNuevos (D-9)", () => {
  it("acepta «1» y lo deja activo", () => {
    const r = datos(filtrosClientesSchema, { conMensajesNuevos: "1" });
    expect(r.conMensajesNuevos).toBeTruthy();
  });
  it("sin el parámetro, la query vacía sigue válida y no activa el filtro", () => {
    const r = datos(filtrosClientesSchema, {});
    expect(r.conMensajesNuevos ?? false).toBeFalsy();
  });
  it.each(["0", "true", "si", "", "2", 1, true])("rechaza conMensajesNuevos=%j", (v) => {
    expect(ok(filtrosClientesSchema, { conMensajesNuevos: v })).toBe(false);
  });
  it("se combina con los filtros de 007a", () => {
    const r = datos(filtrosClientesSchema, { conMensajesNuevos: "1", archivados: "1", q: "san" });
    expect(r.conMensajesNuevos).toBeTruthy();
    expect(r.archivados).toBe(true);
    expect(r.q).toBe("san");
  });
});
