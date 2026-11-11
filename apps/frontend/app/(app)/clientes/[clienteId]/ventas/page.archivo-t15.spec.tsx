import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import {
  HUELLA_1,
  MENSAJES_ARCHIVO as MA,
  USUARIO_ID,
  previoDe,
} from "../../../../../pruebas/archivos";
import { MENSAJES_COMPRAS } from "../../../../../lib/compras";
import { MENSAJES_VENTAS as TEXTOS } from "../../../../../lib/ventas";
import type { Manejador } from "../../../../../pruebas/soporte";
import {
  BASE,
  MENSAJES_VENTAS as TEXTOS_PRUEBA,
  PERIODO,
  PERMISOS,
  RESUMEN_BASE,
  TEXTO_HOSTIL,
  V290,
  V292,
  V_DESCUADRADA,
  instalarFetchVentas,
  paginaDe,
  trabajoDescarga,
  ventaDe,
  type EstadoVentas,
  type FetchVentas,
} from "../../../../../pruebas/ventas";

// Los textos de ventas de 013 vienen del soporte de pruebas; los de 012b, de la pantalla.
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
  usePathname: () => "/clientes/c-1/ventas",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import("./page")) as { default: () => ReactElement };
  const Pagina = modulo.default;
  return <Pagina />;
}

// Spec 012b · T15 (nivel C): ventas con estado del periodo (P-1, P-9), panel «Generar archivo» con la explicación
// de P-6, excluir y restaurar (P-8, D12) y escrituras deshabilitadas con `generado`. El backend aún no existe: el
// `fetch` simula el contrato del plan (`…/ventas/archivos/previo`, `…/ventas/:id/excluir`, `…/ventas/estado/*`).

const ARCH = `${BASE}/archivos`;
const TODOS_Y_GENERAR = [...PERMISOS.todos, "sire.aprobar_generar"];
const MOTIVO = "Factura anulada en el sistema de facturación";
const EN = "2026-11-05T15:30:00.000Z";
const CLAVE_DESCUADRADA = "B001-294";

const previoVentas = (parcial: Parameters<typeof previoDe>[0] = {}) =>
  previoDe({ formato: { id: "rvie-8.1", version: "1", oficial: true }, ...parcial });

const AVISO_291 = {
  filaId: null,
  codigo: "SALTO_CORRELATIVIDAD" as const,
  explicacion: "Falta B001-291",
};

const PREVIO_CON_ERROR = previoVentas({
  apto: false,
  generable: false,
  motivo: "prevalidacion_fallida",
  errores: [
    {
      filaId: V_DESCUADRADA.id,
      codigo: "CUADRE",
      campo: "total",
      destino: null,
      explicacion: "El total 118.01 no cuadra con la suma de los componentes 118.00.",
      diferencia: "0.01",
      excluible: true,
    },
  ],
});

const excluidaDe = (motivo: string) => ({
  filaId: V_DESCUADRADA.id,
  comprobante: CLAVE_DESCUADRADA,
  motivo,
});

const conExclusion = (motivo: string) => ({
  ...V_DESCUADRADA,
  exclusion: { motivo, por: USUARIO_ID, en: EN },
});

const resumenCon = (parcial: Record<string, unknown>) => ({ ...RESUMEN_BASE, ...parcial });

interface Opciones {
  permisos?: readonly string[];
  estado?: "abierto" | "revisado" | "generado";
  previo?: (vez: number) => { status: number; cuerpo?: unknown };
  extra?: (e: EstadoVentas) => Record<string, Manejador>;
  filas?: unknown[];
}

async function montar(o: Opciones = {}): Promise<FetchVentas> {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchVentas({
    permisos: o.permisos ?? TODOS_Y_GENERAR,
    estado: {
      pagina: paginaDe((o.filas ?? [V290, V292]) as never),
      resumen: resumenCon({ estado: o.estado ?? "abierto", excluidas: 0 }),
    },
    extra: (e) => ({
      [`GET ${ARCH}/previo`]: (_, vez) =>
        (o.previo ?? (() => ({ status: 200, cuerpo: previoVentas() })))(vez),
      [`GET ${ARCH}`]: { status: 200, cuerpo: [] },
      ...o.extra?.(e),
    }),
  });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  await vi.waitFor(() => expect(f.lecturas("/resumen").length).toBeGreaterThan(0));
  return f;
}

async function abrirPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: MA.abrir }));
  return screen.findByRole("complementary", { name: MA.titulo });
}

const grilla = () => screen.findByRole("region", { name: M.tablaVentas });
function filaDe(contenedor: HTMLElement, texto: string): HTMLElement {
  const f = within(contenedor)
    .queryAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}

describe("Ventas · panel «Generar archivo» (spec 012b T15, D1, P-6, CA-10)", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: genera el RVIE con el aviso de la 291 y envía el estado y la huella del previo visto", async () => {
    const f = await montar({
      previo: () => ({ status: 200, cuerpo: previoVentas({ avisos: [AVISO_291] }) }),
      extra: () => ({
        [`POST ${ARCH}`]: { status: 202, cuerpo: { trabajoId: trabajoDescarga(9, "en_cola").id } },
      }),
    });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);

    expect(await within(panel).findByText(/Falta B001-291/)).toBeTruthy();
    expect(within(panel).getByText(MA.generable)).toBeTruthy();
    // En ventas la explicación de P-6 solo sale si hay errores.
    expect(within(panel).queryByText(MA.erroresVentasAyuda)).toBeNull();
    await user.click(within(panel).getByRole("button", { name: MA.generar }));

    await vi.waitFor(() => expect(f.de(`POST ${ARCH}`)).toHaveLength(1));
    expect(f.de(`POST ${ARCH}`)[0]!.body).toEqual({ estadoVisto: "abierto", huella: HUELLA_1 });
  });

  it("error: la venta descuadrada bloquea, el panel explica que se corrige en facturación y ubica la fila", async () => {
    await montar({
      filas: [V290, V_DESCUADRADA, V292],
      previo: () => ({ status: 200, cuerpo: PREVIO_CON_ERROR }),
    });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);

    expect(await within(panel).findByText(/no cuadra con la suma/)).toBeTruthy();
    expect(within(panel).getByText(MA.erroresVentasAyuda)).toBeTruthy();
    expect(
      (within(panel).getByRole("button", { name: MA.generar }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(within(panel).getByRole("button", { name: MA.ubicarFila }));
    const fila = filaDe(await grilla(), CLAVE_DESCUADRADA);
    await vi.waitFor(() => expect(fila.getAttribute("data-resaltada")).toBe("true"));
  });
});

describe("Ventas · excluir y restaurar (spec 012b T15, D12, P-8, CA-15)", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Backend simulado: excluir cambia la grilla y el previo; restaurar los devuelve. */
  const servidor = (excluida: { motivo: string | null }) => ({
    previo: () => ({
      status: 200,
      cuerpo:
        excluida.motivo === null
          ? PREVIO_CON_ERROR
          : previoVentas({
              excluidas: [excluidaDe(excluida.motivo)],
              resumen: { ...previoVentas().resumen, excluidas: 1 },
            }),
    }),
    extra: (e: EstadoVentas): Record<string, Manejador> => ({
      [`POST ${BASE}/${V_DESCUADRADA.id}/excluir`]: (llamada) => {
        excluida.motivo = (llamada.body as { motivo: string }).motivo;
        e.pagina = paginaDe([V290, conExclusion(excluida.motivo), V292] as never);
        e.resumen = resumenCon({ estado: "abierto", excluidas: 1 });
        return { status: 200, cuerpo: conExclusion(excluida.motivo) };
      },
      [`POST ${BASE}/${V_DESCUADRADA.id}/restaurar`]: () => {
        excluida.motivo = null;
        e.pagina = paginaDe([V290, V_DESCUADRADA, V292]);
        e.resumen = resumenCon({ estado: "abierto", excluidas: 0 });
        return { status: 200, cuerpo: { ...V_DESCUADRADA, exclusion: null } };
      },
    }),
  });

  it("feliz: excluir con motivo deja el previo apto, lista la excluida y marca la grilla", async () => {
    const excluida = { motivo: null as string | null };
    const f = await montar({ filas: [V290, V_DESCUADRADA, V292], ...servidor(excluida) });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);

    await user.click(await within(panel).findByRole("button", { name: MA.excluir }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(M.avisoExcluir)).toBeTruthy();
    await user.type(within(dialogo).getByLabelText(M.motivoExclusion), `  ${MOTIVO}  `);
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));

    await vi.waitFor(() =>
      expect(f.de(`POST ${BASE}/${V_DESCUADRADA.id}/excluir`)).toHaveLength(1),
    );
    expect(f.de(`POST ${BASE}/${V_DESCUADRADA.id}/excluir`)[0]!.body).toEqual({ motivo: MOTIVO });
    expect(await screen.findByText(M.ventaExcluida)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Previo, grilla y resumen se recargaron.
    expect(await within(panel).findByText(MA.excluidaMotivo(MOTIVO))).toBeTruthy();
    expect(within(panel).getByText(MA.generable)).toBeTruthy();
    expect(
      (within(panel).getByRole("button", { name: MA.generar }) as HTMLButtonElement).disabled,
    ).toBe(false);
    const fila = await vi.waitFor(async () => filaDe(await grilla(), CLAVE_DESCUADRADA));
    expect(within(fila).getByText(M.marcaExcluida)).toBeTruthy();
    expect(await screen.findByText(M.excluidas(1))).toBeTruthy();
  });

  it("error: sin motivo no se envía; «Cancelar» no llama a la API; el 409 no_excluible se explica", async () => {
    const excluida = { motivo: null as string | null };
    const f = await montar({
      filas: [V290, V_DESCUADRADA, V292],
      ...servidor(excluida),
      extra: (e) => ({
        ...servidor(excluida).extra(e),
        [`POST ${BASE}/${V_DESCUADRADA.id}/excluir`]: {
          status: 409,
          cuerpo: { codigo: "no_excluible" },
        },
      }),
    });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);
    const POST = `POST ${BASE}/${V_DESCUADRADA.id}/excluir`;

    // Sin motivo (o solo espacios): mensaje y ninguna llamada.
    await user.click(await within(panel).findByRole("button", { name: MA.excluir }));
    let dialogo = await screen.findByRole("alertdialog");
    await user.type(within(dialogo).getByLabelText(M.motivoExclusion), "   ");
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));
    expect(await within(dialogo).findByText(M.motivoExclusionInvalido)).toBeTruthy();
    expect(f.de(POST)).toHaveLength(0);

    // «Cancelar» cierra sin llamar.
    await user.click(within(dialogo).getByRole("button", { name: M.cancelar }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(f.de(POST)).toHaveLength(0);

    // Más de 200 caracteres: tampoco se envía.
    await user.click(within(panel).getByRole("button", { name: MA.excluir }));
    dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByLabelText(M.motivoExclusion));
    await user.paste("x".repeat(201));
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));
    expect(await within(dialogo).findByText(M.motivoExclusionInvalido)).toBeTruthy();
    expect(f.de(POST)).toHaveLength(0);

    // El servidor rechaza: se explica y el diálogo sigue abierto.
    await user.clear(within(dialogo).getByLabelText(M.motivoExclusion));
    await user.type(within(dialogo).getByLabelText(M.motivoExclusion), MOTIVO);
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));
    expect(await within(dialogo).findByText(M.errores.no_excluible!)).toBeTruthy();
    expect(f.de(POST)).toHaveLength(1);
  });

  it("feliz: restaurar pide confirmación y devuelve la venta al previo con su error", async () => {
    const excluida = { motivo: MOTIVO as string | null };
    const f = await montar({
      filas: [V290, conExclusion(MOTIVO), V292],
      ...servidor(excluida),
    });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);

    await user.click(
      await within(panel).findByRole("button", { name: MA.restaurarVenta(CLAVE_DESCUADRADA) }),
    );
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(M.confirmarRestaurar(CLAVE_DESCUADRADA))).toBeTruthy();
    expect(f.de(`POST ${BASE}/${V_DESCUADRADA.id}/restaurar`)).toHaveLength(0);
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));

    await vi.waitFor(() =>
      expect(f.de(`POST ${BASE}/${V_DESCUADRADA.id}/restaurar`)).toHaveLength(1),
    );
    expect(f.de(`POST ${BASE}/${V_DESCUADRADA.id}/restaurar`)[0]!.body).toEqual({});
    expect(await screen.findByText(M.ventaRestaurada)).toBeTruthy();
    expect(await within(panel).findByText(/no cuadra con la suma/)).toBeTruthy();
    const fila = await vi.waitFor(async () => filaDe(await grilla(), CLAVE_DESCUADRADA));
    expect(within(fila).queryByText(M.marcaExcluida)).toBeNull();
  });

  it("error: «Cancelar» al restaurar no llama; sin sire.clasificar no hay Excluir ni Restaurar", async () => {
    const excluida = { motivo: MOTIVO as string | null };
    const f = await montar({
      filas: [V290, conExclusion(MOTIVO), V292],
      ...servidor(excluida),
    });
    const user = userEvent.setup();
    let panel = await abrirPanel(user);
    await user.click(
      await within(panel).findByRole("button", { name: MA.restaurarVenta(CLAVE_DESCUADRADA) }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: M.cancelar }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(f.de(`POST ${BASE}/${V_DESCUADRADA.id}/restaurar`)).toHaveLength(0);

    cleanup();
    vi.unstubAllGlobals();
    reiniciarSesion();
    await montar({
      permisos: [...PERMISOS.soloDescargar, "sire.aprobar_generar"],
      filas: [V290, conExclusion(MOTIVO), V292],
      ...servidor(excluida),
    });
    panel = await abrirPanel(userEvent.setup());
    expect(await within(panel).findByText(MA.excluidaMotivo(MOTIVO))).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Restaurar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restaurar/ })).toBeNull();
  });

  it("el motivo hostil de una exclusión se muestra como texto, no como HTML", async () => {
    const excluida = { motivo: TEXTO_HOSTIL as string | null };
    await montar({ filas: [V290, conExclusion(TEXTO_HOSTIL), V292], ...servidor(excluida) });
    const fila = await vi.waitFor(async () => filaDe(await grilla(), CLAVE_DESCUADRADA));
    expect(within(fila).getByText(M.motivoDeExclusion(TEXTO_HOSTIL))).toBeTruthy();
    expect(fila.querySelector("img")).toBeNull();
  });
});

describe("Ventas · estado del periodo y escrituras (spec 012b T15, P-1, P-9, CA-10)", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const POST_REABRIR = `POST ${BASE}/estado/reabrir`;
  const POST_REVISAR = `POST ${BASE}/estado/revisar`;

  const botonDe = (nombre: string | RegExp) =>
    screen.findByRole("button", { name: nombre }) as Promise<HTMLButtonElement>;

  async function esperarEstado(estado: string) {
    const seccion = await screen.findByRole("region", { name: "Estado del periodo" });
    await vi.waitFor(() => expect(within(seccion).getByText(estado)).toBeTruthy());
    return seccion;
  }

  it("feliz: con `generado` las escrituras quedan deshabilitadas con el motivo y reabrir las habilita", async () => {
    const f = await montar({
      estado: "generado",
      filas: [V290, V_DESCUADRADA, V292, ventaDe({ origen: "manual", numero: "295" })],
      extra: (e) => ({
        [POST_REABRIR]: () => {
          e.resumen = resumenCon({ estado: "abierto", excluidas: 0 });
          return { status: 200, cuerpo: { estado: "abierto", por: USUARIO_ID, autor: { id: USUARIO_ID, nombre: "Rosa Quispe", activo: true }, en: EN } };
        },
      }),
    });
    const user = userEvent.setup();
    await esperarEstado(M.estadoPeriodo.generado);

    expect(await screen.findByText(M.soloLectura.generado, { selector: "p" })).toBeTruthy();
    expect((await botonDe(M.descargar)).disabled).toBe(true);
    expect((await botonDe(M.agregarVentaManual)).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: M.importar })).toBeNull();
    expect(screen.getByText(M.importar).getAttribute("aria-disabled")).toBe("true");
    const ventas = await grilla();
    expect((within(ventas).getByRole("button", { name: M.quitar }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (within(ventas).getByRole("button", { name: M.excluirComprobante(CLAVE_DESCUADRADA) }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await user.click(await botonDe(MENSAJES_COMPRAS.reabrir));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: M.confirmar }),
    );
    await vi.waitFor(() => expect(f.de(POST_REABRIR)).toHaveLength(1));
    expect(f.de(POST_REABRIR)[0]!.body).toEqual({ estadoVisto: "generado" });

    await vi.waitFor(async () => expect((await botonDe(M.descargar)).disabled).toBe(false));
    expect((await botonDe(M.agregarVentaManual)).disabled).toBe(false);
    expect(screen.getByRole("link", { name: M.importar })).toBeTruthy();
    expect(screen.queryByText(M.soloLectura.generado, { selector: "p" })).toBeNull();
  });

  it("error: con `revisado` y sin sire.aprobar_generar no se escribe ni se reabre; con el permiso sí", async () => {
    await montar({
      estado: "revisado",
      permisos: PERMISOS.todos,
      filas: [V290, V_DESCUADRADA, V292],
    });
    await esperarEstado(M.estadoPeriodo.revisado);
    expect(await screen.findByText(M.soloLectura.revisadoSinAprobar, { selector: "p" })).toBeTruthy();
    expect((await botonDe(M.descargar)).disabled).toBe(true);
    expect((await botonDe(M.agregarVentaManual)).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: MENSAJES_COMPRAS.reabrir })).toBeNull();

    cleanup();
    vi.unstubAllGlobals();
    reiniciarSesion();
    await montar({ estado: "revisado", filas: [V290, V_DESCUADRADA, V292] });
    await esperarEstado(M.estadoPeriodo.revisado);
    expect((await botonDe(M.descargar)).disabled).toBe(false);
    expect((await botonDe(M.agregarVentaManual)).disabled).toBe(false);
    expect(await botonDe(MENSAJES_COMPRAS.reabrir)).toBeTruthy();
  });

  it("feliz: abierto → «Marcar como revisado» llama a la ruta de ventas; error: 409 estado_invalido recarga el estado", async () => {
    let revisiones = 0;
    const f = await montar({
      extra: (e) => ({
        [POST_REVISAR]: () => {
          revisiones += 1;
          if (revisiones === 1) {
            e.resumen = resumenCon({ estado: "revisado", excluidas: 0 });
            return { status: 200, cuerpo: { estado: "revisado", por: USUARIO_ID, autor: { id: USUARIO_ID, nombre: "Rosa Quispe", activo: true }, en: EN } };
          }
          return { status: 409, cuerpo: { codigo: "estado_invalido" } };
        },
      }),
    });
    const user = userEvent.setup();
    await esperarEstado(M.estadoPeriodo.abierto);
    await user.click(await botonDe(MENSAJES_COMPRAS.marcarRevisado));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: M.confirmar }),
    );
    await vi.waitFor(() => expect(f.de(POST_REVISAR)).toHaveLength(1));
    await esperarEstado(M.estadoPeriodo.revisado);
    expect(await screen.findByText(MENSAJES_COMPRAS.periodoRevisado)).toBeTruthy();
  });

  it("el 409 periodo_generado de una escritura se explica con el motivo del estado", async () => {
    await montar({
      extra: () => ({
        [`POST ${BASE}/descargar`]: { status: 409, cuerpo: { codigo: "periodo_generado" } },
      }),
    });
    const user = userEvent.setup();
    await user.click(await botonDe(M.descargar));
    expect(await screen.findByText(M.errores.periodo_generado!)).toBeTruthy();
  });
});

