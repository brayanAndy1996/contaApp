import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import type { OpcionesSeguimiento } from "../../lib/trabajos";
import {
  BASE,
  CLIENTE_ID,
  FILA_ID,
  HUELLA_1,
  HUELLA_2,
  MENSAJES_ARCHIVO as M,
  PERIODO,
  TEXTO_HOSTIL,
  instalarFetchArchivos,
  previoConErrorDe,
  previoDe,
  trabajoArchivo,
  versionDe,
} from "../../pruebas/archivos";
import { PanelGenerar } from "./panel-generar";

// Panel lateral «Generar archivo» (spec 012b, T14; D1, D2, P-2, P-4, P-7, P-10; CA-1, CA-9, CA-12). El
// seguimiento de trabajos (SSE) lo controla la prueba: aquí importa lo que el panel hace con cada estado.

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

const GET_PREVIO = `GET ${BASE}/previo`;
const POST_GENERAR = `POST ${BASE}`;
const emitir = (t: ReturnType<typeof trabajoArchivo>) =>
  seguimiento.opciones?.alEvento(t as unknown as TrabajoVista);

function montar(
  o: {
    puedeVer?: boolean;
    puedeGenerar?: boolean;
    alUbicarFila?: (id: string) => void;
    alGenerado?: () => void;
  } = {},
) {
  render(
    <PanelGenerar
      clienteId={CLIENTE_ID}
      periodo={PERIODO}
      libro="compras"
      puedeVer={o.puedeVer ?? true}
      puedeGenerar={o.puedeGenerar ?? true}
      alUbicarFila={o.alUbicarFila}
      alGenerado={o.alGenerado}
    />,
  );
}

async function abrir(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: M.abrir }));
  return screen.findByRole("complementary", { name: M.titulo });
}

describe("PanelGenerar · previo y generación (spec 012b T14)", () => {
  beforeEach(() => {
    seguimiento.opciones = null;
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: abre el panel lateral y muestra el resumen con montos como texto", async () => {
    instalarFetchArchivos();
    montar();
    const user = userEvent.setup();
    const panel = await abrir(user);

    expect(await within(panel).findByText(M.generable)).toBeTruthy();
    // DG y total valen lo mismo: el monto sale dos veces, con miles y como texto.
    expect(within(panel).getAllByText("1,234.50", { selector: "dd" })).toHaveLength(2);
    expect(within(panel).queryByText(M.provisional)).toBeNull();
    expect((within(panel).getByRole("button", { name: M.generar }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("error: un error de prevalidación trae su enlace que ubica la fila y bloquea «Generar»", async () => {
    instalarFetchArchivos({ previo: () => ({ status: 200, cuerpo: previoConErrorDe() }) });
    const alUbicarFila = vi.fn();
    montar({ alUbicarFila });
    const user = userEvent.setup();
    const panel = await abrir(user);

    expect(await within(panel).findByText(/no corresponde al 18 %/)).toBeTruthy();
    expect(within(panel).getByText(M.diferencia("-2.26"))).toBeTruthy();
    expect(within(panel).getByText(new RegExp(M.motivos.prevalidacion_fallida))).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: M.ubicarFila }));
    expect(alUbicarFila).toHaveBeenCalledWith(FILA_ID);
    expect((within(panel).getByRole("button", { name: M.generar }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("la explicación hostil se muestra como texto, no como HTML", async () => {
    instalarFetchArchivos({
      previo: () => ({
        status: 200,
        cuerpo: previoConErrorDe({
          errores: [
            {
              filaId: null,
              codigo: "ESTRUCTURA",
              campo: null,
              destino: null,
              explicacion: TEXTO_HOSTIL,
              diferencia: null,
              excluible: false,
            },
          ],
        }),
      }),
    });
    montar();
    const panel = await abrir(userEvent.setup());
    expect(await within(panel).findByText(TEXTO_HOSTIL)).toBeTruthy();
    expect(panel.querySelector("img")).toBeNull();
  });

  it("feliz: «Generar» envía el estado y la huella del previo visto, sigue el trabajo y recarga al completar", async () => {
    const f = instalarFetchArchivos({
      versiones: (vez) => ({ status: 200, cuerpo: vez === 1 ? [] : [versionDe(1)] }),
      extra: {
        [POST_GENERAR]: { status: 202, cuerpo: { trabajoId: trabajoArchivo(7, "en_cola").id } },
      },
    });
    const alGenerado = vi.fn();
    montar({ alGenerado });
    const user = userEvent.setup();
    const panel = await abrir(user);
    await user.click(await within(panel).findByRole("button", { name: M.generar }));

    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    expect(f.de(POST_GENERAR)).toHaveLength(1);
    expect(f.de(POST_GENERAR)[0]!.body).toEqual({ estadoVisto: "abierto", huella: HUELLA_1 });
    expect(f.de(POST_GENERAR)[0]!.headers["x-csrf-token"]).toBe("csrf-acceso-1");

    emitir(trabajoArchivo(7, "en_cola", 2));
    expect(await screen.findByText(M.generacionEnCola(2))).toBeTruthy();
    emitir(trabajoArchivo(7, "ejecutando"));
    expect(await screen.findByText(M.generacionEjecutando)).toBeTruthy();
    expect(alGenerado).not.toHaveBeenCalled();

    emitir(trabajoArchivo(7, "completado"));
    await vi.waitFor(() => expect(alGenerado).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(M.generacionCompletada)).toBeTruthy();
    expect(await within(panel).findByText(M.version(1))).toBeTruthy();
    expect(f.de(GET_PREVIO)).toHaveLength(2);
  });

  it("error: 409 resumen_cambiado explica y recarga el previo (P-10)", async () => {
    const f = instalarFetchArchivos({
      previo: (vez) => ({
        status: 200,
        cuerpo: previoDe({ huella: vez === 1 ? HUELLA_1 : HUELLA_2 }),
      }),
      extra: { [POST_GENERAR]: { status: 409, cuerpo: { codigo: "resumen_cambiado" } } },
    });
    montar();
    const user = userEvent.setup();
    const panel = await abrir(user);
    await user.click(await within(panel).findByRole("button", { name: M.generar }));

    const alerta = await screen.findByText(new RegExp(M.errores.resumen_cambiado!));
    expect(alerta.textContent).toContain(M.seRecargo);
    await vi.waitFor(() => expect(f.de(GET_PREVIO)).toHaveLength(2));
    expect(seguimiento.opciones).toBeNull();
    // Un segundo intento manda la huella nueva.
    f.llamadas.length = 0;
    await user.click(await within(panel).findByRole("button", { name: M.generar }));
    await vi.waitFor(() => expect(f.de(POST_GENERAR)).toHaveLength(1));
    expect(f.de(POST_GENERAR)[0]!.body).toEqual({ estadoVisto: "abierto", huella: HUELLA_2 });
  });

  it("error: un trabajo que termina en error avisa y recarga el previo (P-10)", async () => {
    const f = instalarFetchArchivos({
      extra: {
        [POST_GENERAR]: { status: 202, cuerpo: { trabajoId: trabajoArchivo(8, "en_cola").id } },
      },
    });
    const alGenerado = vi.fn();
    montar({ alGenerado });
    const user = userEvent.setup();
    const panel = await abrir(user);
    await user.click(await within(panel).findByRole("button", { name: M.generar }));
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

    emitir(trabajoArchivo(8, "error"));
    expect(await screen.findByText(M.generacionFallida)).toBeTruthy();
    await vi.waitFor(() => expect(f.de(GET_PREVIO)).toHaveLength(2));
    expect(alGenerado).not.toHaveBeenCalled();
  });

  it("sin sire.aprobar_generar no hay botón «Generar», pero sí el previo", async () => {
    instalarFetchArchivos();
    montar({ puedeGenerar: false });
    const panel = await abrir(userEvent.setup());
    expect(await within(panel).findByText(M.generable)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: M.generar })).toBeNull();
    expect(within(panel).getByText(M.sinPermisoGenerar)).toBeTruthy();
  });

  it("sin clientes.ver no se ofrece el panel ni se llama a la API", () => {
    const f = instalarFetchArchivos();
    montar({ puedeVer: false });
    expect(screen.queryByRole("button", { name: M.abrir })).toBeNull();
    expect(f.llamadas).toHaveLength(0);
  });

  it("provisional: marca «no subir a SUNAT» cuando el formato no es oficial", async () => {
    instalarFetchArchivos({
      previo: () => ({
        status: 200,
        cuerpo: previoDe({ formato: { id: "rce-prov", version: "0", oficial: false } }),
      }),
    });
    montar();
    const panel = await abrir(userEvent.setup());
    expect(await within(panel).findByText(M.provisional)).toBeTruthy();
  });

  it("error de carga: muestra el mensaje y «Reintentar» vuelve a pedir", async () => {
    const f = instalarFetchArchivos({
      previo: (vez) =>
        vez === 1
          ? { status: 403, cuerpo: { codigo: "permiso_denegado" } }
          : { status: 200, cuerpo: previoDe() },
    });
    montar();
    const user = userEvent.setup();
    const panel = await abrir(user);
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: M.reintentar }));
    expect(await within(panel).findByText(M.generable)).toBeTruthy();
    expect(f.de(GET_PREVIO)).toHaveLength(2);
  });
});

describe("PanelGenerar · pantallas angostas (spec 012b T15)", () => {
  beforeEach(() => {
    seguimiento.opciones = null;
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const conAncho = (angosta: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((consulta: string) => ({
        matches: angosta,
        media: consulta,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

  it("feliz: en pantalla angosta «Ubicar en la grilla» cierra el panel para no tapar la fila", async () => {
    instalarFetchArchivos({ previo: () => ({ status: 200, cuerpo: previoConErrorDe() }) });
    conAncho(true);
    const alUbicarFila = vi.fn();
    montar({ alUbicarFila });
    const user = userEvent.setup();
    const panel = await abrir(user);
    await user.click(await within(panel).findByRole("button", { name: M.ubicarFila }));

    expect(alUbicarFila).toHaveBeenCalledWith(FILA_ID);
    expect(screen.queryByRole("complementary", { name: M.titulo })).toBeNull();
    // Se vuelve a abrir con el mismo botón.
    expect(await abrir(user)).toBeTruthy();
  });

  it("error: en pantalla ancha el panel se queda abierto al ubicar", async () => {
    instalarFetchArchivos({ previo: () => ({ status: 200, cuerpo: previoConErrorDe() }) });
    conAncho(false);
    const alUbicarFila = vi.fn();
    montar({ alUbicarFila });
    const user = userEvent.setup();
    const panel = await abrir(user);
    await user.click(await within(panel).findByRole("button", { name: M.ubicarFila }));

    expect(alUbicarFila).toHaveBeenCalledWith(FILA_ID);
    expect(screen.getByRole("complementary", { name: M.titulo })).toBeTruthy();
  });
});

describe("PanelGenerar · foco al cerrar (spec 012b T23a, P-2)", () => {
  beforeEach(() => {
    seguimiento.opciones = null;
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: «Cerrar» devuelve el foco al botón «Generar archivo»", async () => {
    instalarFetchArchivos();
    montar();
    const user = userEvent.setup();
    const panel = await abrir(user);
    await within(panel).findByText(M.generable);

    await user.click(within(panel).getByRole("button", { name: M.cerrar }));
    expect(screen.queryByRole("complementary", { name: M.titulo })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: M.abrir }));
  });

  it("error: aunque el previo no cargó, «Cerrar» también devuelve el foco al botón que abre el panel", async () => {
    instalarFetchArchivos({ previo: () => ({ status: 500, cuerpo: { codigo: "error_interno" } }) });
    montar();
    const user = userEvent.setup();
    const panel = await abrir(user);
    await within(panel).findByRole("alert");

    await user.click(within(panel).getByRole("button", { name: M.cerrar }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: M.abrir }));
  });
});
