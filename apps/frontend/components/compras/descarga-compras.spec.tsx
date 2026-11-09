import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import type { OpcionesSeguimiento } from "../../lib/trabajos";
import {
  BASE,
  CLIENTE_ID,
  MENSAJES_COMPRAS as M,
  PERIODO,
  instalarFetchCompras,
} from "../../pruebas/compras";
import { MENSAJES_CREDENCIALES } from "../../pruebas/credenciales";
import { idTrabajo } from "../../pruebas/trabajos";
import { propuestaDe, trabajoDescarga } from "../../pruebas/ventas";
import { DescargaCompras } from "./descarga-compras";

// Región «Descarga» de compras (spec 015, T3; D-14; CA-3). El seguimiento de trabajos (SSE) se simula con un
// `seguirTrabajos` controlado por la prueba: aquí importa lo que la región hace con cada estado del trabajo.

const seguimiento = vi.hoisted(() => ({
  opciones: null as OpcionesSeguimiento | null,
}));
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

const POST_DESCARGAR = `POST ${BASE}/descargar`;
const emitir = (t: ReturnType<typeof trabajoDescarga>) =>
  seguimiento.opciones?.alEvento(t as unknown as TrabajoVista);

function montar(
  o: {
    puedeDescargar?: boolean;
    ultima?: ReturnType<typeof propuestaDe>;
    alCompletar?: () => void;
  } = {},
) {
  const alCompletar = o.alCompletar ?? vi.fn();
  render(
    <DescargaCompras
      clienteId={CLIENTE_ID}
      periodo={PERIODO}
      puedeDescargar={o.puedeDescargar ?? true}
      periodoValido
      ultimaPropuesta={o.ultima}
      cargadas
      alCompletar={alCompletar}
    />,
  );
  return alCompletar;
}

describe("DescargaCompras · región «Descarga» (spec 015 T3, D-14, CA-3)", () => {
  beforeEach(() => {
    seguimiento.opciones = null;
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: encola, muestra la posición, ejecuta, completa y avisa para refrescar", async () => {
    const f = instalarFetchCompras({
      extra: {
        [POST_DESCARGAR]: { status: 202, cuerpo: { trabajoId: idTrabajo(1) } },
      },
    });
    const alCompletar = montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.descargar }));

    expect(await screen.findByRole("link", { name: MENSAJES_CREDENCIALES.enlacePanel }))
      .toHaveProperty("href", expect.stringContaining("/trabajos"));
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    emitir(trabajoDescarga(1, "en_cola", { posicion: 3 }));
    expect(await screen.findByText(M.enCola(3))).toBeTruthy();
    emitir(trabajoDescarga(1, "en_cola", { posicion: 1 }));
    expect(await screen.findByText(M.enCola(1))).toBeTruthy();
    emitir(trabajoDescarga(1, "ejecutando"));
    expect(await screen.findByText(M.ejecutando)).toBeTruthy();
    expect(alCompletar).not.toHaveBeenCalled();

    emitir(trabajoDescarga(1, "completado"));
    await vi.waitFor(() => expect(alCompletar).toHaveBeenCalledTimes(1));
    expect(f.de(POST_DESCARGAR)).toHaveLength(1);
    expect(f.de(POST_DESCARGAR)[0]!.headers["x-csrf-token"]).toBe("csrf-acceso-1");
  });

  it("muestra «N nuevas, M distintas» de la última descarga y «distintas» enlaza a las diferencias", () => {
    instalarFetchCompras();
    montar({
      ultima: propuestaDe(3, { filasNuevas: 2, filasIguales: 1, filasDistintas: 1 }),
    });
    const enlace = screen.getByRole("link", { name: M.resumenDescarga(2, 1) });
    expect(enlace.getAttribute("href")).toBe("#diferencias-compras");
    expect(screen.getByText(/Última descarga:/)).toBeTruthy();
  });

  it("sin distintas no hay enlace a diferencias", () => {
    instalarFetchCompras();
    montar({ ultima: propuestaDe(3, { filasNuevas: 4, filasDistintas: 0 }) });
    expect(screen.getByText(M.resumenDescarga(4, 0))).toBeTruthy();
    expect(screen.queryByRole("link", { name: M.resumenDescarga(4, 0) })).toBeNull();
  });

  it.each([
    ["sunat_no_responde", M.motivosTrabajo.sunat_no_responde],
    ["credencial_invalida", M.motivosTrabajo.credencial_invalida],
  ])("error del trabajo (%s): dice el motivo y «Reintentar» encola de nuevo", async (motivo, texto) => {
    let veces = 0;
    const f = instalarFetchCompras({
      extra: {
        [POST_DESCARGAR]: () => {
          veces += 1;
          return { status: 202, cuerpo: { trabajoId: idTrabajo(veces) } };
        },
      },
    });
    const alCompletar = montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.descargar }));
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    emitir(trabajoDescarga(1, "error", { motivo }));
    expect(await screen.findByText(`${M.descargaFallida}: ${texto}`)).toBeTruthy();
    expect(alCompletar).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: M.reintentar }));
    await vi.waitFor(() => expect(f.de(POST_DESCARGAR)).toHaveLength(2));
    expect(screen.queryByText(`${M.descargaFallida}: ${texto}`)).toBeNull();
  });

  it.each([
    ["credencial_no_configurada", 409, M.errores.credencial_no_configurada!],
    ["periodo_generado", 409, M.errores.periodo_generado!],
    ["periodo_revisado", 403, M.errores.periodo_revisado!],
  ])("el servidor rechaza con %s: mensaje propio y no hay trabajo", async (codigo, status, mensaje) => {
    instalarFetchCompras({
      extra: { [POST_DESCARGAR]: { status, cuerpo: { codigo } } },
    });
    montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.descargar }));
    const alerta = await screen.findByRole("alert");
    expect(within(alerta).getByText(mensaje)).toBeTruthy();
    expect(screen.queryByRole("link", { name: MENSAJES_CREDENCIALES.enlacePanel })).toBeNull();
    expect(seguimiento.opciones).toBeNull();
  });

  it("sin sire.descargar no hay «Descargar» ni «Reintentar»", async () => {
    instalarFetchCompras();
    montar({ puedeDescargar: false });
    expect(screen.queryByRole("button", { name: M.descargar })).toBeNull();
    expect(screen.queryByRole("button", { name: M.reintentar })).toBeNull();
  });

  it("sin descargas previas lo dice", () => {
    instalarFetchCompras();
    montar({ ultima: undefined });
    expect(screen.getByText(M.sinDescargas)).toBeTruthy();
  });
});
