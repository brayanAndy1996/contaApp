import {
  accionCompraRespuestaSchema,
  detalleCompraSchema,
  filaCompraVistaSchema,
  resumenComprasSchema,
} from "@contapp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  C_3064_BOLSAS,
  CLIENTE_ID,
  FILAS_014,
  PERIODO,
  accionDe,
  consultaDe,
  detalleDe,
  generarFilas,
  instalarFetchCompras,
  listadoDe,
  resumenDe,
} from "../pruebas/compras";
import {
  FILTROS_INICIALES,
  MENSAJES_COMPRAS,
  cargarPeriodo,
  clasificarCompra,
  consultaDeListado,
  deshacerCompras,
  descartarCompra,
  exportarCompras,
  listarCompras,
  mensajeDeErrorCompras,
  mensajeDeRechazoMasivo,
  obtenerResumenCompras,
  reabrirPeriodoCompras,
} from "./compras";
import { MENSAJES } from "./acceso";
import { reiniciarSesion } from "./sesion";

const ID = C_3064_BOLSAS.id;
const UUID_OTRO = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  reiniciarSesion();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soporte de pruebas · las formas cumplen los esquemas de shared", () => {
  it("las 5 compras de 014, 5.000 generadas, el detalle, la acción y el resumen son válidos", () => {
    for (const fila of [...FILAS_014, ...generarFilas(300)]) {
      expect(filaCompraVistaSchema.safeParse(fila).success).toBe(true);
    }
    expect(detalleCompraSchema.safeParse(detalleDe(C_3064_BOLSAS)).success).toBe(true);
    expect(accionCompraRespuestaSchema.safeParse(accionDe(C_3064_BOLSAS)).success).toBe(true);
    expect(resumenComprasSchema.safeParse(resumenDe(FILAS_014)).success).toBe(true);
    expect(generarFilas(5000)).toHaveLength(5000);
    expect(new Set(generarFilas(5000).map((f) => f.id)).size).toBe(5000);
  });

  it("los totales de las 5 compras son la suma de sus columnas", () => {
    expect(FILAS_014.map((f) => f.montos.total)).toEqual([
      "770.00",
      "23.09",
      "119.50",
      "0.18",
      "177.00",
    ]);
  });
});

describe("cargarPeriodo · carga por cursor (D-4)", () => {
  it("feliz: 1.500 compras llegan en 2 bloques de 1.000 y se entregan en orden", async () => {
    const f = instalarFetchCompras({ estado: { filas: generarFilas(1500) } });
    const bloques: { n: number; primero: boolean; ultimo: boolean }[] = [];
    const r = await cargarPeriodo(CLIENTE_ID, PERIODO, FILTROS_INICIALES, {
      senal: new AbortController().signal,
      alBloque: (b, info) => bloques.push({ n: b.length, ...info }),
    });
    expect(r).toEqual({ estado: "completa", filas: 1485 });
    // 1.500 generadas menos 15 excluidas (cada centésima) quedan 1.485 en la vista «con IGV».
    expect(bloques.length).toBe(2);
    expect(bloques[0]).toEqual({ n: 1000, primero: true, ultimo: false });
    expect(bloques[1]?.primero).toBe(false);
    expect(bloques[1]?.ultimo).toBe(true);
    const consultas = f.listados().map((l) => consultaDe(l.url));
    expect(consultas).toHaveLength(2);
    expect(consultas[0]?.get("limite")).toBe("1000");
    expect(consultas[0]?.has("cursor")).toBe(false);
    expect(consultas[1]?.get("cursor")).toBe("1000");
  });

  it("error: la respuesta que llega después de cancelar se descarta", async () => {
    const control = new AbortController();
    instalarFetchCompras({
      extra: () => ({
        [`GET ${BASE}`]: () => {
          control.abort();
          return { status: 200, cuerpo: listadoDe(FILAS_014, "1000") };
        },
      }),
    });
    const alBloque = vi.fn();
    const r = await cargarPeriodo(CLIENTE_ID, PERIODO, FILTROS_INICIALES, {
      senal: control.signal,
      alBloque,
    });
    expect(r).toEqual({ estado: "cancelada" });
    expect(alBloque).not.toHaveBeenCalled();
  });

  it("error: no pide más bloques tras cancelar entre el primero y el segundo", async () => {
    const control = new AbortController();
    const f = instalarFetchCompras({ estado: { filas: generarFilas(1500) } });
    const r = await cargarPeriodo(CLIENTE_ID, PERIODO, FILTROS_INICIALES, {
      senal: control.signal,
      alBloque: () => control.abort(),
    });
    expect(r).toEqual({ estado: "cancelada" });
    expect(f.listados()).toHaveLength(1);
  });

  it("error: un bloque inválido termina sin pintar nada a medias; el anterior sigue entregado", async () => {
    instalarFetchCompras({
      extra: () => ({
        [`GET ${BASE}`]: (llamada) =>
          consultaDe(llamada.url).has("cursor")
            ? { status: 200, cuerpo: { filas: [{ id: "x" }], siguiente: null } }
            : { status: 200, cuerpo: listadoDe(FILAS_014, "5") },
      }),
    });
    const alBloque = vi.fn();
    const r = await cargarPeriodo(CLIENTE_ID, PERIODO, FILTROS_INICIALES, {
      senal: new AbortController().signal,
      alBloque,
    });
    expect(alBloque).toHaveBeenCalledTimes(1);
    expect(r.estado).toBe("error");
    if (r.estado === "error") {
      expect(r.error.codigo).toBe("respuesta_invalida");
      expect(r.error.mensaje).toBe(MENSAJES.errorGeneral);
    }
  });

  it("error: un cursor repetido no deja un bucle infinito", async () => {
    const f = instalarFetchCompras({
      extra: () => ({
        [`GET ${BASE}`]: { status: 200, cuerpo: listadoDe(FILAS_014, "mismo") },
      }),
    });
    const r = await cargarPeriodo(CLIENTE_ID, PERIODO, FILTROS_INICIALES, {
      senal: new AbortController().signal,
      alBloque: () => undefined,
    });
    expect(r.estado).toBe("error");
    expect(f.listados()).toHaveLength(2);
  });

  it("error: un 403 del listado llega con su mensaje, sin el código", async () => {
    instalarFetchCompras({
      extra: () => ({
        [`GET ${BASE}`]: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
      }),
    });
    const r = await cargarPeriodo(CLIENTE_ID, PERIODO, FILTROS_INICIALES, {
      senal: new AbortController().signal,
      alBloque: () => undefined,
    });
    expect(r).toMatchObject({
      estado: "error",
      error: { status: 403, mensaje: MENSAJES.sinPermiso },
    });
  });
});

describe("listado, filtros y lecturas", () => {
  it("feliz: los filtros viajan al servidor con sus parámetros", async () => {
    const f = instalarFetchCompras();
    const r = await listarCompras(
      CLIENTE_ID,
      PERIODO,
      { vista: "sin_igv", alertas: true, proveedorNuevo: true, q: " 2070 & x " },
      "10",
      50,
    );
    expect(r.ok).toBe(true);
    const q = consultaDe(f.listados()[0]!.url);
    expect(Object.fromEntries(q)).toEqual({
      limite: "50",
      vista: "sin_igv",
      alertas: "true",
      proveedorNuevo: "true",
      q: "2070 & x",
      cursor: "10",
    });
  });

  it("consultaDeListado solo manda lo que tiene valor", () => {
    expect(consultaDeListado(FILTROS_INICIALES)).toBe("limite=1000&vista=con_igv");
  });

  it("el filtro «con alertas» devuelve solo las filas con hallazgos (F001-1040 no tiene IGV: es «sin IGV»)", async () => {
    instalarFetchCompras();
    const r = await listarCompras(CLIENTE_ID, PERIODO, {
      ...FILTROS_INICIALES,
      alertas: true,
    });
    expect(r.ok && r.datos.filas.map((x) => x.numero)).toEqual(["2056", "3064", "5070"]);
  });

  it("error: un resumen que no cumple el esquema es un error genérico", async () => {
    instalarFetchCompras({ estado: { resumen: { estado: "abierto" } as never } });
    const r = await obtenerResumenCompras(CLIENTE_ID, PERIODO);
    expect(r).toMatchObject({
      ok: false,
      codigo: "respuesta_invalida",
      mensaje: MENSAJES.errorGeneral,
    });
  });
});

describe("escrituras y errores con datos", () => {
  it("feliz: clasificar envía versionBase y destino a su ruta y valida la fila", async () => {
    const f = instalarFetchCompras({
      extra: {
        [`POST ${BASE}/${ID}/clasificar`]: {
          status: 200,
          cuerpo: accionDe({ ...C_3064_BOLSAS, version: 2, clasificada: true }),
        },
      },
    });
    const r = await clasificarCompra(CLIENTE_ID, PERIODO, ID, {
      versionBase: 1,
      destino: "DNG",
    });
    expect(r.ok && r.datos.fila.version).toBe(2);
    const llamada = f.de(`POST ${BASE}/${ID}/clasificar`)[0]!;
    expect(llamada.body).toEqual({ versionBase: 1, destino: "DNG" });
    expect(llamada.headers["x-csrf-token"]).toBeTruthy();
    expect(llamada.headers["x-estudio"]).toBe("e-a");
  });

  it("error: 409 version_obsoleta trae la versión vigente y un mensaje en español", async () => {
    instalarFetchCompras({
      extra: {
        [`POST ${BASE}/${ID}/descartar`]: {
          status: 409,
          cuerpo: { codigo: "version_obsoleta", versionVigente: 4 },
        },
      },
    });
    const r = await descartarCompra(CLIENTE_ID, PERIODO, ID, { versionBase: 1 });
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      codigo: "version_obsoleta",
      versionVigente: 4,
      mensaje: MENSAJES_COMPRAS.errores["version_obsoleta"],
    });
  });

  it("error: los cuerpos con datos de 014 (requiere_dato, duplicado, fila_cambiada) se conservan", async () => {
    instalarFetchCompras({
      extra: {
        [`POST ${BASE}/${ID}/clasificar`]: {
          status: 422,
          cuerpo: { codigo: "requiere_dato", dato: "gravado" },
        },
        [`POST ${BASE}/${ID}/descartar`]: {
          status: 409,
          cuerpo: { codigo: "duplicado", id: UUID_OTRO },
        },
        [`POST ${BASE}/deshacer`]: {
          status: 409,
          cuerpo: { codigo: "fila_cambiada", ids: [UUID_OTRO] },
        },
      },
    });
    const a = await clasificarCompra(CLIENTE_ID, PERIODO, ID, { versionBase: 1, destino: "DG" });
    expect(a).toMatchObject({ ok: false, status: 422, dato: "gravado" });
    const b = await descartarCompra(CLIENTE_ID, PERIODO, ID, { versionBase: 1 });
    expect(b).toMatchObject({ ok: false, codigo: "duplicado", id: UUID_OTRO });
    const c = await deshacerCompras(CLIENTE_ID, PERIODO);
    expect(c).toMatchObject({ ok: false, codigo: "fila_cambiada", ids: [UUID_OTRO] });
  });

  it("feliz: reabrir envía el estado visto (DU-23)", async () => {
    const f = instalarFetchCompras({
      extra: {
        [`POST ${BASE}/estado/reabrir`]: {
          status: 200,
          cuerpo: { estado: "abierto", por: null, en: null },
        },
      },
    });
    const r = await reabrirPeriodoCompras(CLIENTE_ID, PERIODO, { estadoVisto: "revisado" });
    expect(r.ok && r.datos.estado).toBe("abierto");
    expect(f.de(`POST ${BASE}/estado/reabrir`)[0]?.body).toEqual({ estadoVisto: "revisado" });
  });
});

describe("mensajes por código", () => {
  it("cada código conocido tiene su texto; los demás caen al estado HTTP", () => {
    expect(mensajeDeErrorCompras(409, { codigo: "periodo_generado" })).toBe(
      MENSAJES_COMPRAS.errores["periodo_generado"],
    );
    expect(mensajeDeErrorCompras(403, { codigo: "inventado" })).toBe(MENSAJES.sinPermiso);
    expect(mensajeDeErrorCompras(404, null)).toBe(MENSAJES.noEncontrado);
    expect(mensajeDeErrorCompras(500, { codigo: "x" })).toBe(MENSAJES.errorGeneral);
  });

  it("los motivos de rechazo masivo y el código desconocido", () => {
    expect(mensajeDeRechazoMasivo("no_masiva")).toBe(MENSAJES_COMPRAS.rechazoMasiva.no_masiva);
    expect(mensajeDeRechazoMasivo("otro")).toBe(MENSAJES.errorGeneral);
  });
});

describe("exportar", () => {
  it("feliz: entrega el archivo y un nombre seguro por omisión", async () => {
    instalarFetchCompras({
      extra: { [`GET ${BASE}/exportar.xlsx`]: { status: 200, cuerpo: { x: 1 } } },
    });
    const r = await exportarCompras(CLIENTE_ID, PERIODO);
    expect(r.ok && r.nombre).toBe(`compras-${PERIODO}.xlsx`);
    expect(r.ok && r.archivo.size).toBeGreaterThan(0);
  });

  it("error: un 403 se explica y no entrega archivo", async () => {
    instalarFetchCompras({
      extra: {
        [`GET ${BASE}/exportar.xlsx`]: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
      },
    });
    const r = await exportarCompras(CLIENTE_ID, PERIODO);
    expect(r).toMatchObject({ ok: false, status: 403, mensaje: MENSAJES.sinPermiso });
  });
});
