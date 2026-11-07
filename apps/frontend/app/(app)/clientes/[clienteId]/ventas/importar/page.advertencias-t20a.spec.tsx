import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../../lib/sesion";
import { asentar, celdas } from "../../../../../../pruebas/acceso";
import { archivoDe } from "../../../../../../pruebas/importacion";
import { crearRouterFalso } from "../../../../../../pruebas/soporte";
import {
  BASE,
  CSV_VENTAS,
  MENSAJES_VENTAS as M,
  PERIODO,
  filaImportadaDe,
  instalarFetchVentas,
  propuestaDe,
  vistaPreviaVentasDe,
  type FetchVentas,
  type OpcionesVentas,
} from "../../../../../../pruebas/ventas";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/ventas/importar",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import("./page")) as { default: () => ReactElement };
  const Pagina = modulo.default;
  return <Pagina />;
}

// Spec 013 · T20a (rojo), decisión D22 del usuario (2026-11-07, defecto D-2 de T20): la vista previa distingue las
// ADVERTENCIAS de los errores. Una fila legible pero descuadrada (`descuadre`) o en USD sin tipo de cambio
// (`tipo_cambio_requerido`) es «Válida con advertencia»: NO bloquea, se puede confirmar y se guarda tal cual (D3).
// Contrato de la pantalla (la respuesta trae `advertencias` por fila y `conAdvertencia` en total, ver `shared`):
//  - Cuenta M.conAdvertencia(n) junto a M.validas y M.conError (una fila con advertencia cuenta también como válida).
//  - La fila con advertencia dice M.estadoFila.conAdvertencia (no «Con error») y lista un texto por código en
//    M.advertencias (distintos de los M.motivos de error). Las filas sin advertencia siguen diciendo M.estadoFila.valida.
//  - Con advertencias y SIN errores «Confirmar importación» está habilitado y se lee M.avisoAdvertencias; con errores
//    sigue deshabilitado (todo o nada). Sin advertencias no aparece ni la línea de conteo ni el aviso.

const PREVIA = `POST ${BASE}/importar/vista-previa`;
const CONFIRMAR = `POST ${BASE}/importar/confirmar`;

const SOLO_ADVERTENCIAS = vistaPreviaVentasDe([
  filaImportadaDe(2),
  filaImportadaDe(3, [], ["descuadre"]),
  filaImportadaDe(4, [], ["tipo_cambio_requerido"]),
  filaImportadaDe(5, [], ["descuadre", "tipo_cambio_requerido"]),
]);
const ADVERTENCIAS_Y_ERRORES = vistaPreviaVentasDe([
  filaImportadaDe(2, [], ["descuadre"]),
  filaImportadaDe(3, ["fecha_invalida"]),
]);
const SIN_ADVERTENCIAS = vistaPreviaVentasDe([filaImportadaDe(2), filaImportadaDe(3)]);
const IMPORTADA = propuestaDe(7, {
  fuente: "importacion",
  filasNuevas: 4,
  filasIguales: 0,
  filasDistintas: 0,
});

async function montar(extra: OpcionesVentas["extra"]): Promise<FetchVentas> {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchVentas({ extra });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}
async function revisar(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.upload(
    await screen.findByLabelText(M.archivo),
    archivoDe("ventas.csv", CSV_VENTAS),
  );
  await user.click(await screen.findByRole("button", { name: M.revisarArchivo }));
  return screen.findByRole("region", { name: "Vista previa" });
}
function filaN(region: HTMLElement, n: number): HTMLElement {
  const f = within(region)
    .queryAllByRole("row")
    .find((r) => (celdas(r)[0] ?? "").trim() === String(n));
  if (!f) throw new Error(`no hay fila ${n}`);
  return f;
}
const botonConfirmar = () =>
  screen.getByRole("button", { name: M.confirmarImportacion }) as HTMLButtonElement;

describe("/clientes/:id/ventas/importar · advertencias de la vista previa (T20a, D22)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    busqueda.actual = new URLSearchParams();
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cuenta las filas con advertencia aparte de las válidas y de las que tienen error", async () => {
    await montar({ [PREVIA]: { status: 200, cuerpo: SOLO_ADVERTENCIAS } });
    const region = await revisar();
    expect(within(region).getByText(M.validas(4))).toBeTruthy();
    expect(within(region).getByText(M.conError(0))).toBeTruthy();
    expect(within(region).getByText(M.conAdvertencia(3))).toBeTruthy();
  });

  it("cada fila con advertencia dice «Válida con advertencia» y un texto por código, distinto del de los errores", async () => {
    await montar({ [PREVIA]: { status: 200, cuerpo: SOLO_ADVERTENCIAS } });
    const region = await revisar();

    const limpia = filaN(region, 2);
    expect(limpia.textContent).toContain(M.estadoFila.valida);
    expect(limpia.textContent).not.toContain(M.estadoFila.conAdvertencia);
    expect(limpia.textContent).not.toContain(M.advertencias.descuadre);

    const descuadre = filaN(region, 3);
    expect(descuadre.textContent).toContain(M.estadoFila.conAdvertencia);
    expect(descuadre.textContent).not.toContain(M.estadoFila.conError);
    expect(descuadre.textContent).toContain(M.advertencias.descuadre);
    expect(descuadre.textContent).not.toContain(M.advertencias.tipo_cambio_requerido);
    // El texto de la advertencia no es el del error del mismo código.
    expect(descuadre.textContent).not.toContain(M.motivos.descuadre);

    const usd = filaN(region, 4);
    expect(usd.textContent).toContain(M.estadoFila.conAdvertencia);
    expect(usd.textContent).toContain(M.advertencias.tipo_cambio_requerido);
    expect(usd.textContent).not.toContain(M.motivos.tipo_cambio_requerido);

    const ambas = filaN(region, 5);
    expect(ambas.textContent).toContain(M.advertencias.descuadre);
    expect(ambas.textContent).toContain(M.advertencias.tipo_cambio_requerido);
  });

  it("solo con advertencias «Confirmar importación» está habilitado, se avisa que se guarda tal cual y se confirma", async () => {
    const f = await montar({
      [PREVIA]: { status: 200, cuerpo: SOLO_ADVERTENCIAS },
      [CONFIRMAR]: { status: 201, cuerpo: { propuesta: IMPORTADA } },
    });
    const region = await revisar();
    expect(botonConfirmar().disabled).toBe(false);
    expect(within(region).getByText(M.avisoAdvertencias)).toBeTruthy();
    expect(screen.queryByText(M.corregirFilas)).toBeNull();

    await userEvent.setup().click(botonConfirmar());
    await vi.waitFor(() => expect(f.de(CONFIRMAR)).toHaveLength(1));
    const resultado = await screen.findByRole("region", { name: "Resultado" });
    expect(within(resultado).getByText(M.resumenDescarga(4, 0))).toBeTruthy();
  });

  it("con advertencias y también errores «Confirmar importación» sigue deshabilitado (todo o nada)", async () => {
    const f = await montar({ [PREVIA]: { status: 200, cuerpo: ADVERTENCIAS_Y_ERRORES } });
    const region = await revisar();
    expect(within(region).getByText(M.conAdvertencia(1))).toBeTruthy();
    expect(within(region).getByText(M.conError(1))).toBeTruthy();
    expect(botonConfirmar().disabled).toBe(true);
    expect(screen.getByText(M.corregirFilas)).toBeTruthy();
    await userEvent.setup().click(botonConfirmar());
    await asentar();
    expect(f.de(CONFIRMAR)).toHaveLength(0);
  });

  it("sin advertencias no aparece el conteo ni el aviso", async () => {
    await montar({ [PREVIA]: { status: 200, cuerpo: SIN_ADVERTENCIAS } });
    const region = await revisar();
    expect(within(region).queryByText(M.conAdvertencia(0))).toBeNull();
    expect(within(region).queryByText(M.avisoAdvertencias)).toBeNull();
    expect(botonConfirmar().disabled).toBe(false);
  });
});
