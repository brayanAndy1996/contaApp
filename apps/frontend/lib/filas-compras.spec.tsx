import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILTROS_INICIALES } from "./compras";
import { UMBRAL_RECARGA_INDIVIDUAL, useFilasCompras } from "./filas-compras";
import { reiniciarSesion } from "./sesion";
import {
  BASE,
  CLIENTE_ID,
  FILAS_014,
  C_3064_BOLSAS,
  PERIODO,
  filaDe,
  generarFilas,
  instalarFetchCompras,
  montosDe,
  uuidDe,
} from "../pruebas/compras";

// Spec 015 · T5 (D-4): carga por cursor, recarga de una fila (inserta si no está cargada; T9 la usa al agregar)
// y recarga de varias. Un caso feliz y uno de error por comportamiento, sin montar la pantalla.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montarHook(alFallar = vi.fn()) {
  const r = renderHook(() =>
    useFilasCompras({
      clienteId: CLIENTE_ID,
      periodo: PERIODO,
      activo: true,
      filtros: FILTROS_INICIALES,
      alFallar,
    }),
  );
  return { ...r, alFallar };
}

const detalles = (f: ReturnType<typeof instalarFetchCompras>) =>
  f.llamadas.filter((l) => l.method === "GET" && /\/compras\/[^/?]+$/.test(l.ruta));

describe("useFilasCompras", () => {
  it("carga por cursor hasta que `siguiente` es null y termina en «completa»", async () => {
    const f = instalarFetchCompras({ estado: { filas: generarFilas(2500) } });
    const { result } = montarHook();
    await waitFor(() => expect(result.current.carga).toBe("completa"));
    // 2.500 generadas menos las 25 excluidas (no están en «con IGV»): 3 bloques encadenados por cursor.
    expect(result.current.filas).toHaveLength(2475);
    expect(f.listados()).toHaveLength(3);
    expect(f.listados()[1]!.url).toContain("cursor=1000");
  });

  it("recargarFila inserta la fila si el id no está cargado (compra agregada) y la reemplaza si ya está", async () => {
    const f = instalarFetchCompras();
    const { result } = montarHook();
    await waitFor(() => expect(result.current.carga).toBe("completa"));
    const antes = result.current.filas.length;

    const agregada = filaDe({
      id: uuidDe(7, 1),
      origen: "agregada",
      numero: "9001",
      montos: montosDe({ biDg: "50.00", igvDg: "9.00" }),
    });
    f.estado.filas = [...f.estado.filas, agregada];
    await act(() => result.current.recargarFila(agregada.id));
    expect(result.current.filas).toHaveLength(antes + 1);
    expect(result.current.filas.some((x) => x.id === agregada.id)).toBe(true);

    // Ya cargada: se reemplaza en su lugar con lo que dice el servidor (sin duplicarla).
    f.estado.filas = f.estado.filas.map((x) =>
      x.id === C_3064_BOLSAS.id ? { ...x, version: 2, clasificada: true } : x,
    );
    await act(() => result.current.recargarFila(C_3064_BOLSAS.id));
    expect(result.current.filas).toHaveLength(antes + 1);
    expect(result.current.filas.find((x) => x.id === C_3064_BOLSAS.id)?.version).toBe(2);
  });

  it("error: un 404 quita la fila (y de la selección); un 500 avisa y deja la fila como estaba", async () => {
    const f = instalarFetchCompras();
    const { result, alFallar } = montarHook();
    await waitFor(() => expect(result.current.carga).toBe("completa"));
    act(() => result.current.setSeleccion(new Set([C_3064_BOLSAS.id])));

    const otra = FILAS_014.find((x) => x.numero === "2056")!;
    f.estado.filas = f.estado.filas.filter((x) => x.id !== C_3064_BOLSAS.id);
    await act(() => result.current.recargarFila(C_3064_BOLSAS.id));
    expect(result.current.filas.some((x) => x.id === C_3064_BOLSAS.id)).toBe(false);
    expect(result.current.seleccion.has(C_3064_BOLSAS.id)).toBe(false);

    const antes = result.current.filas;
    instalarFetchCompras({
      estado: { filas: f.estado.filas },
      extra: { [`GET ${BASE}/${otra.id}`]: { status: 500, cuerpo: {} } },
    });
    await act(() => result.current.recargarFila(otra.id));
    expect(alFallar).toHaveBeenCalledTimes(1);
    expect(result.current.filas).toEqual(antes);
  });

  it("recargarFilas solo toca las ya cargadas y, con muchas, pide el listado una vez en vez de una fila por GET", async () => {
    const f = instalarFetchCompras({ estado: { filas: generarFilas(150) } });
    const { result } = montarHook();
    await waitFor(() => expect(result.current.carga).toBe("completa"));
    const ids = result.current.filas.map((x) => x.id);
    expect(ids.length).toBeGreaterThan(UMBRAL_RECARGA_INDIVIDUAL);

    // Un id que no está en este filtro no se agrega.
    await act(() => result.current.recargarFilas([uuidDe(8, 1), ids[0]!]));
    expect(detalles(f)).toHaveLength(1);
    expect(result.current.filas).toHaveLength(ids.length);

    const antes = f.listados().length;
    await act(() => result.current.recargarFilas(ids));
    expect(detalles(f)).toHaveLength(1);
    expect(f.listados()).toHaveLength(antes + 1);
    expect(result.current.filas).toHaveLength(ids.length);
  });
});
