import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_VENTAS as TEXTOS } from "../../../../../../lib/ventas";
import { reiniciarSesion } from "../../../../../../lib/sesion";
import {
  MENSAJES_VENTAS as TEXTOS_PRUEBA,
  PERIODO,
  PERMISOS,
  RESUMEN_BASE,
  instalarFetchVentas,
} from "../../../../../../pruebas/ventas";

const M = { ...TEXTOS_PRUEBA, ...TEXTOS };

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

// Spec 012b · T15 (nivel C), P-1 y P-9: la importación sigue el estado del periodo de ventas.
describe("Importar ventas · estado del periodo (spec 012b T15)", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function montar(estado: string, permisos: readonly string[]) {
    busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
    const f = instalarFetchVentas({
      permisos,
      estado: { resumen: { ...RESUMEN_BASE, estado, excluidas: 0 } },
    });
    render(await cargarPagina());
    await vi.waitFor(() => expect(f.lecturas("/resumen").length).toBeGreaterThan(0));
    return f;
  }

  it("error: con `generado` no se revisa ni se confirma y se explica el motivo", async () => {
    await montar("generado", [...PERMISOS.todos, "sire.aprobar_generar"]);
    expect(await screen.findByText(M.soloLectura.generado)).toBeTruthy();
    const boton = (await screen.findByRole("button", { name: M.revisarArchivo })) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
  });

  it("error: con `revisado` y sin sire.aprobar_generar queda deshabilitado", async () => {
    await montar("revisado", PERMISOS.todos);
    expect(await screen.findByText(M.soloLectura.revisadoSinAprobar)).toBeTruthy();
  });

  it("feliz: con `abierto` no hay bloqueo", async () => {
    await montar("abierto", PERMISOS.todos);
    await screen.findByRole("button", { name: M.revisarArchivo });
    expect(screen.queryByText(M.soloLectura.generado)).toBeNull();
    expect(screen.queryByText(M.soloLectura.revisadoSinAprobar)).toBeNull();
  });
});
