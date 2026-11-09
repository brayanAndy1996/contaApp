import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  CLIENTE_ID,
  MENSAJES_COMPRAS as M,
  PERIODO,
  instalarFetchCompras,
} from "../../pruebas/compras";
import { ExportarCompras } from "./exportar-compras";

// «Exportar a Excel» (spec 015, T3; D-15; CA-15): descarga el archivo del periodo y un error se informa.

const RUTA_EXCEL = `${BASE}/exportar.xlsx`;

/** Delega todo al `fetch` simulado salvo el Excel, que responde con un archivo (no JSON) o con un error. */
function conExcel(respuesta: () => Response) {
  const delegado = globalThis.fetch;
  const pedidos: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof entrada === "string" ? entrada : String(entrada);
      if (url === RUTA_EXCEL) {
        pedidos.push({ url, headers: new Headers(init?.headers) });
        return respuesta();
      }
      return delegado(entrada, init);
    }),
  );
  return pedidos;
}

function montar(periodoValido = true) {
  render(
    <ExportarCompras
      clienteId={CLIENTE_ID}
      periodo={PERIODO}
      periodoValido={periodoValido}
    />,
  );
}

describe("ExportarCompras (spec 015 T3, D-15, CA-15)", () => {
  const crearUrl = vi.fn(() => "blob:excel-1");
  const revocarUrl = vi.fn();
  const clics: { descarga: string; href: string }[] = [];

  beforeEach(() => {
    reiniciarSesion();
    clics.length = 0;
    crearUrl.mockClear();
    revocarUrl.mockClear();
    Object.assign(URL, { createObjectURL: crearUrl, revokeObjectURL: revocarUrl });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clics.push({ descarga: this.download, href: this.href });
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("feliz: pide el Excel del periodo con la sesión del estudio y lo guarda con su nombre", async () => {
    instalarFetchCompras();
    const pedidos = conExcel(
      () =>
        new Response("contenido-xlsx", {
          status: 200,
          headers: {
            "content-disposition": `attachment; filename="compras-202610.xlsx"`,
          },
        }),
    );
    montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.exportar }));

    await vi.waitFor(() => expect(clics).toHaveLength(1));
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.headers.get("x-estudio")).toBe("e-a");
    expect(clics[0]!.descarga).toBe("compras-202610.xlsx");
    expect(clics[0]!.href).toBe("blob:excel-1");
    expect(crearUrl).toHaveBeenCalledTimes(1);
    expect(revocarUrl).toHaveBeenCalledWith("blob:excel-1");
    expect(screen.queryByRole("alert")).toBeNull();
    // El enlace temporal no queda en la página.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("error: un fallo del servidor se informa como aviso y no se guarda nada", async () => {
    instalarFetchCompras();
    conExcel(
      () =>
        new Response(JSON.stringify({ codigo: "error_interno" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.exportar }));
    expect((await screen.findByRole("alert")).textContent).toBe(M.errorExportar);
    expect(clics).toHaveLength(0);
    expect(crearUrl).not.toHaveBeenCalled();
    // Se puede reintentar.
    expect(
      (screen.getByRole("button", { name: M.exportar }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("error: 403 con código explica con el mensaje del servidor", async () => {
    instalarFetchCompras();
    conExcel(
      () =>
        new Response(JSON.stringify({ codigo: "permiso_denegado" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.exportar }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      M.errores.permiso_denegado,
    );
  });

  it("con periodo inválido el botón está deshabilitado", () => {
    instalarFetchCompras();
    montar(false);
    expect(
      (screen.getByRole("button", { name: M.exportar }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
