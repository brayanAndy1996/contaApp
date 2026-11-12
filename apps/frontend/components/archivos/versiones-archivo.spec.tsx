import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  ARCHIVO_ID,
  BASE,
  CLIENTE_ID,
  MENSAJES_ARCHIVO as M,
  PERIODO,
  versionDe,
} from "../../pruebas/archivos";
import { rutaSesion } from "../../pruebas/acceso";
import { VersionesArchivo } from "./versiones-archivo";

// Versiones y «Descargar» (spec 012b, T14; D9, P-4; CA-9, CA-12).

const RUTA_ZIP = `${BASE}/${ARCHIVO_ID}/zip`;

/** `fetch` con sesión simulada; el ZIP responde con bytes (no JSON) o con un error. */
function conZip(respuesta: () => Response) {
  const sesion = rutaSesion()["GET /api/auth/sesion"] as { cuerpo: unknown };
  const pedidos: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof entrada === "string" ? entrada : String(entrada);
      if (url === "/api/auth/sesion") return Response.json(sesion.cuerpo);
      pedidos.push({ url, headers: new Headers(init?.headers) });
      return respuesta();
    }),
  );
  return pedidos;
}

function montar(reabierto = false, versiones = [versionDe(1)]) {
  render(
    <VersionesArchivo
      clienteId={CLIENTE_ID}
      periodo={PERIODO}
      libro="compras"
      versiones={versiones}
      reabiertoTrasUltima={reabierto}
    />,
  );
}

describe("VersionesArchivo (spec 012b T14)", () => {
  const crearUrl = vi.fn(() => "blob:zip-1");
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

  it("feliz: «Descargar» pide el ZIP con la sesión del estudio y lo guarda con su nombre", async () => {
    const pedidos = conZip(
      () =>
        new Response("zip", {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="LE20700000002202610080400021112.zip"',
          },
        }),
    );
    montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.descargarVersion(1) }));

    await vi.waitFor(() => expect(clics).toHaveLength(1));
    expect(pedidos[0]!.url).toBe(`/api${RUTA_ZIP.slice("/api".length)}`);
    expect(clics[0]!.descarga).toBe("LE20700000002202610080400021112.zip");
    expect(clics[0]!.href).toBe("blob:zip-1");
    expect(revocarUrl).toHaveBeenCalledWith("blob:zip-1");
  });

  it("error: un archivo alterado se explica y no se guarda nada", async () => {
    conZip(() => Response.json({ codigo: "archivo_alterado" }, { status: 500 }));
    montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.descargarVersion(1) }));

    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.archivo_alterado);
    expect(clics).toHaveLength(0);
    expect(crearUrl).not.toHaveBeenCalled();
  });

  it("error: un fallo cualquiera da el aviso general de descarga", async () => {
    conZip(() => Response.json({ codigo: "algo" }, { status: 404 }));
    montar();
    await userEvent.setup().click(screen.getByRole("button", { name: M.descargarVersion(1) }));
    expect((await screen.findByRole("alert")).textContent).toBe(M.errorDescarga);
  });

  it("muestra la versión, marca la provisional y avisa si se reabrió después de la última", () => {
    montar(true, [versionDe(2, { provisional: true }), versionDe(1)]);
    expect(screen.getByText(M.version(2))).toBeTruthy();
    expect(screen.getByText(M.provisional)).toBeTruthy();
    expect(screen.getByText(M.reabiertoTrasUltima)).toBeTruthy();
  });

  it("muestra quién generó la versión con su nombre (D-12), «(inactivo)» o desconocido, nunca el id", () => {
    const id = versionDe(1).generadoPor;
    montar(false, [
      versionDe(3),
      versionDe(2, { autor: { id, nombre: "Ana Torres", activo: false } }),
      versionDe(1, { autor: { id, nombre: null, activo: false } }),
    ]);
    expect(screen.getByText("Ana Torres")).toBeTruthy();
    expect(screen.getByText("Ana Torres (inactivo)")).toBeTruthy();
    expect(screen.getByText("Usuario desconocido")).toBeTruthy();
    expect(document.body.textContent).not.toContain(id.slice(0, 8));
  });

  it("muestra la fecha en hora de Lima y el SHA-256 completo del ZIP de cada versión (CA-7, CA-8)", () => {
    // 2026-11-05T15:30Z es 10:30 a. m. en Lima.
    montar(false, [versionDe(2, { sha256Zip: "a".repeat(64) }), versionDe(1)]);
    expect(document.body.textContent).toMatch(/05\/11\/26,? 10:30\s?a\.\s?m\.|5\/11\/26,? 10:30\s?a\.\s?m\./);
    expect(screen.getByText("a".repeat(64))).toBeTruthy();
    expect(screen.getByText("d".repeat(64))).toBeTruthy();
    expect(document.body.textContent).not.toContain("UTC");
  });

  it("dos versiones se descargan con nombres distintos: la última el del servidor, la anterior con `_v1` (P-6)", async () => {
    conZip(
      () =>
        new Response("zip", {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="LE20700000002202610080400021112.zip"',
          },
        }),
    );
    montar(false, [versionDe(2), versionDe(1)]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.descargarVersion(2) }));
    await vi.waitFor(() => expect(clics).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: M.descargarVersion(1) }));
    await vi.waitFor(() => expect(clics).toHaveLength(2));
    expect(clics[0]!.descarga).toBe("LE20700000002202610080400021112.zip");
    expect(clics[1]!.descarga).toBe("LE20700000002202610080400021112_v1.zip");
  });

  it("sin versiones lo dice y no avisa de reapertura", () => {
    montar(true, []);
    expect(screen.getByText(M.sinVersiones)).toBeTruthy();
    expect(screen.queryByText(M.reabiertoTrasUltima)).toBeNull();
  });
});
