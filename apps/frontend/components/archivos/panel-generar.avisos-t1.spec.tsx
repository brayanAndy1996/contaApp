import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import type { OpcionesSeguimiento } from "../../lib/trabajos";
import {
  BASE,
  CLIENTE_ID,
  MENSAJES_ARCHIVO as M,
  PERIODO,
  instalarFetchArchivos,
  trabajoArchivo,
} from "../../pruebas/archivos";
import { PanelGenerar } from "./panel-generar";

// Avisos únicos del panel «Generar archivo» (spec 018, T1; P-2, CA-10): cada aviso del panel sale una sola vez
// en el árbol de accesibilidad (un `role="status"` o `role="alert"`), sin una región `aria-live` que lo repita.

const seguimiento = vi.hoisted(() => ({ opciones: null as OpcionesSeguimiento | null }));
vi.mock("../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../lib/trabajos")>();
  return {
    ...real,
    seguirTrabajos: vi.fn(async (o: OpcionesSeguimiento) => {
      seguimiento.opciones = o;
      await new Promise<void>((resolver) =>
        o.senal.addEventListener("abort", () => resolver(), { once: true }),
      );
    }),
  };
});

const POST_GENERAR = `POST ${BASE}`;
const emitir = (t: ReturnType<typeof trabajoArchivo>) =>
  seguimiento.opciones?.alEvento(t as unknown as TrabajoVista);

/** Los anunciadores (`alert` y `status`) y las regiones `aria-live` cuyo texto contiene el aviso. */
const anunciadores = (texto: string) =>
  [...screen.queryAllByRole("alert"), ...screen.queryAllByRole("status")].filter((el) =>
    (el.textContent ?? "").includes(texto),
  );
const regionesVivas = (texto: string) =>
  [...document.querySelectorAll<HTMLElement>('[aria-live="polite"],[aria-live="assertive"]')].filter(
    (el) => (el.textContent ?? "").includes(texto),
  );

async function abrirYGenerar() {
  render(
    <PanelGenerar
      clienteId={CLIENTE_ID}
      periodo={PERIODO}
      libro="compras"
      puedeVer
      puedeGenerar
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: M.abrir }));
  const panel = await screen.findByRole("complementary", { name: M.titulo });
  await user.click(await within(panel).findByRole("button", { name: M.generar }));
  return panel;
}

describe("PanelGenerar · avisos únicos (spec 018 T1, CA-10)", () => {
  beforeEach(() => {
    seguimiento.opciones = null;
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: «en cola» y «Archivo generado» salen una sola vez", async () => {
    instalarFetchArchivos({
      extra: {
        [POST_GENERAR]: { status: 202, cuerpo: { trabajoId: trabajoArchivo(7, "en_cola").id } },
      },
    });
    await abrirYGenerar();
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

    emitir(trabajoArchivo(7, "en_cola", 2));
    await screen.findByText(M.generacionEnCola(2));
    expect(anunciadores(M.generacionEnCola(2))).toHaveLength(1);
    expect(regionesVivas(M.generacionEnCola(2))).toHaveLength(0);

    emitir(trabajoArchivo(7, "completado"));
    await screen.findByText(M.generacionCompletada);
    expect(anunciadores(M.generacionCompletada)).toHaveLength(1);
    expect(regionesVivas(M.generacionCompletada)).toHaveLength(0);
  });

  it("error: un 409 resumen_cambiado sale una sola vez", async () => {
    instalarFetchArchivos({
      extra: { [POST_GENERAR]: { status: 409, cuerpo: { codigo: "resumen_cambiado" } } },
    });
    await abrirYGenerar();

    await screen.findByText(new RegExp(M.seRecargo));
    expect(anunciadores(M.seRecargo)).toHaveLength(1);
    expect(regionesVivas(M.seRecargo)).toHaveLength(0);
  });
});
