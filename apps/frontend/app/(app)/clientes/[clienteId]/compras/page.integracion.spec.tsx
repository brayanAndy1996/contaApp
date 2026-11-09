import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXTOS_GRILLA } from "../../../../../components/compras/columnas-compras";
import { reiniciarSesion } from "../../../../../lib/sesion";
import { seguirTrabajos, type OpcionesSeguimiento } from "../../../../../lib/trabajos";
import { idTrabajo } from "../../../../../pruebas/trabajos";
import { trabajoDescarga } from "../../../../../pruebas/ventas";
import {
  BASE,
  C_1040_ISC,
  C_3064_BOLSAS,
  C_5070_ZAPATILLAS,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  PERIODO,
  PERMISOS,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  uuidDe,
  type FetchCompras,
  type OpcionesCompras,
} from "../../../../../pruebas/compras";

// Ensamblado de la pantalla de compras (spec 015, T10; CA-6 a CA-11, CA-14, CA-16 integrados): la página une las
// acciones por fila, la barra masiva, deshacer/rehacer, agregar y el panel de historial. Cada prueba parte del
// `fetch` simulado de 014: lo que el servidor responde es lo que la pantalla muestra, sin cálculos propios.

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/compras",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));
vi.mock("../../../../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../../../../lib/trabajos")>();
  return {
    ...real,
    seguirTrabajos: vi.fn(
      (o: { senal: AbortSignal }) =>
        new Promise<void>((resolver) =>
          o.senal.addEventListener("abort", () => resolver(), { once: true }),
        ),
    ),
  };
});

const RUTA_PAGINA = "./page";
async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import(/* @vite-ignore */ RUTA_PAGINA)) as { default: () => ReactElement };
  const Pagina = modulo.default;
  return <Pagina />;
}

const rutaFila = (id: string, sufijo: string) => `POST ${BASE}/${id}/${sufijo}`;
const DESHACER = `POST ${BASE}/deshacer`;
const REHACER = `POST ${BASE}/rehacer`;
const MASIVA_CLASIFICAR = `POST ${BASE}/masivas/clasificar`;
const OPERACION = uuidDe(9, 1);

async function montar(o: OpcionesCompras = {}): Promise<FetchCompras> {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchCompras(o);
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const lecturas = (f: FetchCompras, sufijo: string) => f.de(`GET ${BASE}${sufijo}`);
const celda = (id: string, columna: string) =>
  document.querySelector<HTMLElement>(`[data-fila="${id}"] [data-col="${columna}"]`)!;
const fila = (id: string) => document.querySelector<HTMLElement>(`[data-fila="${id}"]`);
/** Un botón dentro de un `fieldset disabled` no tiene `.disabled`, pero sí `:disabled`. */
const deshabilitado = (el: HTMLElement | null): boolean => el?.matches(":disabled") === true;
const boton = (nombre: string) => screen.queryByRole("button", { name: nombre });
const accionesDe = (comprobante: string) =>
  screen.queryByRole("button", { name: `${M.columnas.acciones} ${comprobante}` });

describe("/clientes/:id/compras · ensamblado (spec 015 T10)", () => {
  beforeEach(() => {
    busqueda.actual = new URLSearchParams();
    reiniciarSesion();
    // jsdom no mide el diseño: el virtualizador lee `clientWidth`/`clientHeight` del contenedor.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("clasificar una fila (CA-6)", () => {
    const FILA = C_3064_BOLSAS;
    const clasificada = filaDe({
      ...FILA,
      version: 2,
      clasificada: true,
      hallazgos: [],
      montos: montosDe({ biDng: "100.00", igvDng: "18.00", icbper: "1.50" }),
    });

    it("feliz: la fila se actualiza con lo que responde el servidor y el resumen se vuelve a pedir", async () => {
      const f = await montar({
        extra: (estado) => ({
          [rutaFila(FILA.id, "clasificar")]: () => {
            estado.filas = estado.filas.map((x) => (x.id === FILA.id ? clasificada : x));
            return { status: 200, cuerpo: accionDe(clasificada) };
          },
        }),
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));
      const resumenes = lecturas(f, "/resumen").length;

      await user.click(accionesDe("F001-3064")!);
      await user.click(screen.getByRole("menuitem", { name: M.clasificarComo("DNG") }));

      expect(await screen.findByText(M.compraClasificada)).toBeTruthy();
      expect(f.de(rutaFila(FILA.id, "clasificar"))).toHaveLength(1);
      expect(f.de(rutaFila(FILA.id, "clasificar"))[0]!.body).toEqual({ versionBase: 1, destino: "DNG" });
      await vi.waitFor(() => expect(celda(FILA.id, "biDng").textContent).toBe("100.00"));
      expect(celda(FILA.id, "biDg").textContent).toBe("0.00");
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(resumenes + 1));
    });

    it("error: un 409 version_obsoleta se muestra con su mensaje, la fila se recarga y la pantalla sigue entera", async () => {
      const f = await montar({
        extra: (estado) => ({
          [rutaFila(FILA.id, "clasificar")]: () => {
            // Otra persona ya la había clasificado.
            estado.filas = estado.filas.map((x) =>
              x.id === FILA.id ? { ...clasificada, version: 5 } : x,
            );
            return { status: 409, cuerpo: { codigo: "version_obsoleta", versionVigente: 5 } };
          },
        }),
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));

      await user.click(accionesDe("F001-3064")!);
      await user.click(screen.getByRole("menuitem", { name: M.clasificarComo("DNG") }));

      const alertas = await screen.findAllByText(M.errores.version_obsoleta!);
      expect(alertas.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(lecturas(f, `/${FILA.id}`)).toHaveLength(1));
      await vi.waitFor(() => expect(celda(FILA.id, "biDng").textContent).toBe("100.00"));
      // La pantalla sigue operable: el menú de la fila sigue ahí.
      expect(accionesDe("F001-3064")).not.toBeNull();
    });

    it("con teclado: Enter en la celda de acciones, flechas en el menú y Enter clasifican la fila", async () => {
      const f = await montar({
        extra: (estado) => ({
          [rutaFila(FILA.id, "clasificar")]: () => {
            estado.filas = estado.filas.map((x) => (x.id === FILA.id ? clasificada : x));
            return { status: 200, cuerpo: accionDe(clasificada) };
          },
        }),
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));

      act(() => celda(FILA.id, "acciones").focus());
      await user.keyboard("{Enter}"); // entra al primer control de la celda: el botón del menú
      expect(document.activeElement).toBe(accionesDe("F001-3064"));
      await user.keyboard("{Enter}"); // abre el menú, con el primer elemento enfocado
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
      await user.keyboard("{ArrowDown}{ArrowDown}"); // DG → DGNG → DNG
      expect(document.activeElement?.textContent).toBe(M.clasificarComo("DNG"));
      await user.keyboard("{Enter}");

      await vi.waitFor(() => expect(f.de(rutaFila(FILA.id, "clasificar"))).toHaveLength(1));
      expect(f.de(rutaFila(FILA.id, "clasificar"))[0]!.body).toEqual({ versionBase: 1, destino: "DNG" });
    });
  });

  describe("excluir y restaurar (CA-9)", () => {
    it("feliz: la excluida sale de la lista principal y aparece en «Excluidas»", async () => {
      const excluida = filaDe({ ...C_5070_ZAPATILLAS, version: 2, excluida: true, motivo: "Gasto personal" });
      const f = await montar({
        extra: (estado) => ({
          [rutaFila(C_5070_ZAPATILLAS.id, "excluir")]: () => {
            estado.filas = estado.filas.map((x) => (x.id === excluida.id ? excluida : x));
            return { status: 200, cuerpo: accionDe(excluida) };
          },
        }),
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));
      expect(fila(C_5070_ZAPATILLAS.id)).not.toBeNull();

      await user.click(accionesDe("F001-5070")!);
      await user.click(screen.getByRole("menuitem", { name: M.excluir }));
      const dialogo = await screen.findByRole("dialog", { name: `${M.excluir} F001-5070` });
      await user.click(within(dialogo).getByRole("button", { name: M.excluir }));

      expect(await screen.findByText(M.compraExcluida)).toBeTruthy();
      expect(f.de(rutaFila(C_5070_ZAPATILLAS.id, "excluir"))).toHaveLength(1);
      // Sale de la lista principal (aunque el hook la conserve actualizada) y de ahí ya no se ofrece.
      await vi.waitFor(() => expect(fila(C_5070_ZAPATILLAS.id)).toBeNull());

      await user.click(screen.getByRole("radio", { name: M.vistas.excluidas }));
      await vi.waitFor(() => expect(fila(C_5070_ZAPATILLAS.id)).not.toBeNull());
    });
  });

  describe("masiva con informe (CA-7)", () => {
    it("feliz: dos filas seleccionadas, una sola petición, informe con aplicadas y rechazadas con su motivo", async () => {
      const f = await montar({
        extra: {
          [MASIVA_CLASIFICAR]: {
            status: 200,
            cuerpo: {
              operacionId: OPERACION,
              aplicadas: 1,
              rechazadas: [{ compraId: C_5070_ZAPATILLAS.id, codigo: "version_obsoleta" }],
            },
          },
        },
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));

      await user.click(screen.getByRole("checkbox", { name: M.seleccionarFila("F001-3064") }));
      await user.click(screen.getByRole("checkbox", { name: M.seleccionarFila("F001-5070") }));
      const barra = await screen.findByRole("toolbar");
      await user.click(within(barra).getByRole("button", { name: M.clasificarComo("DNG") }));

      const informe = await screen.findByRole("dialog", { name: M.informeMasivo });
      expect(within(informe).getByText(M.aplicadas(1))).toBeTruthy();
      expect(f.de(MASIVA_CLASIFICAR)).toHaveLength(1);
      expect(
        (f.de(MASIVA_CLASIFICAR)[0]!.body as { items: { compraId: string; versionBase: number }[] }).items,
      ).toEqual([
        { compraId: C_3064_BOLSAS.id, versionBase: 1 },
        { compraId: C_5070_ZAPATILLAS.id, versionBase: 1 },
      ]);
      // La obsoleta se recarga (y la aplicada también), por GET de cada fila.
      await vi.waitFor(() => expect(lecturas(f, `/${C_5070_ZAPATILLAS.id}`)).toHaveLength(1));
    });

    it("error: un 403 de la masiva se muestra con su mensaje y la selección sigue", async () => {
      await montar({
        extra: { [MASIVA_CLASIFICAR]: { status: 403, cuerpo: { codigo: "periodo_revisado" } } },
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));
      await user.click(screen.getByRole("checkbox", { name: M.seleccionarFila("F001-3064") }));
      const barra = await screen.findByRole("toolbar");
      await user.click(within(barra).getByRole("button", { name: M.clasificarComo("DNG") }));

      expect((await screen.findAllByText(M.errores.periodo_revisado!)).length).toBeGreaterThan(0);
      expect(screen.queryByRole("dialog", { name: M.informeMasivo })).toBeNull();
      expect(screen.getByRole("toolbar")).toBeTruthy();
    });
  });

  describe("deshacer y rehacer (CA-8)", () => {
    const FILA = C_3064_BOLSAS;
    const clasificada = filaDe({
      ...FILA,
      version: 2,
      clasificada: true,
      hallazgos: [],
      montos: montosDe({ biDng: "100.00", igvDng: "18.00", icbper: "1.50" }),
    });

    function conClasificar(deshaceCon: "ok" | "fila_cambiada") {
      return (estado: FetchCompras["estado"]) => ({
        [rutaFila(FILA.id, "clasificar")]: () => {
          estado.filas = estado.filas.map((x) => (x.id === FILA.id ? clasificada : x));
          return { status: 200, cuerpo: accionDe(clasificada) };
        },
        [DESHACER]: () => {
          if (deshaceCon === "fila_cambiada") {
            return { status: 409, cuerpo: { codigo: "fila_cambiada", ids: [FILA.id, C_5070_ZAPATILLAS.id] } };
          }
          estado.filas = estado.filas.map((x) => (x.id === FILA.id ? FILA : x));
          return { status: 200, cuerpo: { operacionId: OPERACION, filas: [FILA.id] } };
        },
        [REHACER]: () => {
          estado.filas = estado.filas.map((x) => (x.id === FILA.id ? clasificada : x));
          return { status: 200, cuerpo: { operacionId: OPERACION, filas: [FILA.id] } };
        },
      });
    }

    async function clasificarConMenu(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText(M.cargaCompleta(4));
      await user.click(accionesDe("F001-3064")!);
      await user.click(screen.getByRole("menuitem", { name: M.clasificarComo("DNG") }));
      expect(await screen.findByText(M.compraClasificada)).toBeTruthy();
    }

    it("feliz: Ctrl+Z en la grilla deshace solo esa operación, recarga la fila y la resalta; Ctrl+Y la repone", async () => {
      const f = await montar({ extra: conClasificar("ok") });
      const user = userEvent.setup();
      await clasificarConMenu(user);
      await vi.waitFor(() => expect(celda(FILA.id, "biDng").textContent).toBe("100.00"));
      const detallesAntes = lecturas(f, `/${FILA.id}`).length;

      act(() => celda(FILA.id, "comprobante").focus());
      await user.keyboard("{Control>}z{/Control}");

      await vi.waitFor(() => expect(f.de(DESHACER)).toHaveLength(1));
      await vi.waitFor(() => expect(celda(FILA.id, "biDng").textContent).toBe("0.00"));
      // Solo se recargó la fila afectada (no el listado) y quedó resaltada.
      expect(lecturas(f, `/${FILA.id}`).length).toBe(detallesAntes + 1);
      expect(lecturas(f, `/${C_5070_ZAPATILLAS.id}`)).toHaveLength(0);
      await vi.waitFor(() =>
        expect(within(fila(FILA.id)!).getByText(TEXTOS_GRILLA.actualizada)).toBeTruthy(),
      );

      await user.keyboard("{Control>}y{/Control}");
      await vi.waitFor(() => expect(f.de(REHACER)).toHaveLength(1));
      await vi.waitFor(() => expect(celda(FILA.id, "biDng").textContent).toBe("100.00"));
    });

    it("error: sin operación propia el atajo no llama al servidor y el botón pide confirmar (P-4)", async () => {
      const f = await montar({ extra: conClasificar("ok") });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));

      act(() => celda(FILA.id, "comprobante").focus());
      await user.keyboard("{Control>}z{/Control}");
      expect(f.de(DESHACER)).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: M.deshacer }));
      expect(await screen.findByText(M.confirmarDeshacerAjeno)).toBeTruthy();
      expect(f.de(DESHACER)).toHaveLength(0);
    });

    it("error: 409 fila_cambiada lista los comprobantes, no reintenta y «Ver filas» los resalta", async () => {
      const f = await montar({ extra: conClasificar("fila_cambiada") });
      const user = userEvent.setup();
      await clasificarConMenu(user);

      await user.click(screen.getByRole("button", { name: M.deshacer }));
      const alerta = await screen.findByText(M.filaCambiada);
      const caja = alerta.closest("[role=alert]") as HTMLElement;
      expect(within(caja).getByText("F001-3064")).toBeTruthy();
      expect(within(caja).getByText("F001-5070")).toBeTruthy();
      expect(f.de(DESHACER)).toHaveLength(1);

      await user.click(within(caja).getByRole("button", { name: M.verFilas }));
      await vi.waitFor(() =>
        expect(within(fila(C_5070_ZAPATILLAS.id)!).getByText(TEXTOS_GRILLA.actualizada)).toBeTruthy(),
      );
      expect(f.de(DESHACER)).toHaveLength(1);
    });

    it("descartar una compra agregada no se anota como operación que se pueda deshacer (014 DU-14)", async () => {
      const agregada = filaDe({ id: uuidDe(3, 1), origen: "agregada", numero: "9001", clasificada: true });
      const f = await montar({
        estado: { filas: [...FILAS_014, agregada] },
        extra: {
          [rutaFila(agregada.id, "descartar")]: { status: 200, cuerpo: accionDe(agregada) },
          [DESHACER]: { status: 200, cuerpo: { operacionId: OPERACION, filas: [] } },
        },
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(5));

      await user.click(accionesDe("F001-9001")!);
      await user.click(screen.getByRole("menuitem", { name: M.descartar }));
      const confirmacion = await screen.findByRole("alertdialog");
      await user.click(within(confirmacion).getByRole("button", { name: "Confirmar" }));
      expect(await screen.findByText(M.compraDescartada)).toBeTruthy();

      act(() => celda(C_3064_BOLSAS.id, "comprobante").focus());
      await user.keyboard("{Control>}z{/Control}");
      expect(f.de(DESHACER)).toHaveLength(0);
    });
  });

  describe("agregar una compra (CA-11)", () => {
    async function llenar(user: ReturnType<typeof userEvent.setup>) {
      const escribir = async (etiqueta: string, valor: string) => {
        const campo = within(screen.getByRole("dialog", { name: M.formularioAgregar })).getByLabelText(etiqueta);
        await user.clear(campo);
        await user.type(campo, valor);
      };
      await escribir(M.campos.serie, "f001");
      await escribir(M.campos.numero, "9001");
      await escribir(M.campos.documento, "20100070970");
      await escribir(M.campos.razonSocial, "PROVEEDOR NUEVO S.A.C.");
      await user.type(
        within(screen.getByRole("dialog", { name: M.formularioAgregar })).getByLabelText(M.campos.fecha),
        "2026-10-20",
      );
      await escribir(M.casilleros.biDg, "100");
      await escribir(M.casilleros.igvDg, "18");
    }

    it("feliz: la compra queda «Agregada» en la lista y resaltada, y el diálogo se cierra", async () => {
      const creada = filaDe({
        id: uuidDe(3, 1),
        origen: "agregada",
        serie: "F001",
        numero: "9001",
        clasificada: true,
        montos: montosDe({ biDg: "100.00", igvDg: "18.00" }),
      });
      const f = await montar({
        extra: (estado) => ({
          [`POST ${BASE}`]: () => {
            estado.filas = [...estado.filas, creada];
            return { status: 201, cuerpo: accionDe(creada) };
          },
        }),
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));

      await user.click(screen.getByRole("button", { name: M.agregarCompra }));
      await llenar(user);
      await user.click(screen.getByRole("button", { name: M.agregar }));

      await vi.waitFor(() => expect(f.de(`POST ${BASE}`)).toHaveLength(1));
      await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: M.formularioAgregar })).toBeNull());
      await vi.waitFor(() => expect(fila(creada.id)).not.toBeNull());
      expect(within(fila(creada.id)!).getByText(M.agregada)).toBeTruthy();
      await vi.waitFor(() =>
        expect(within(fila(creada.id)!).getByText(TEXTOS_GRILLA.actualizada)).toBeTruthy(),
      );
    });

    it("error: un duplicado de una compra excluida avisa y «Ubicar» cambia a «Excluidas» y la resalta", async () => {
      const excluida = filaDe({ ...C_5070_ZAPATILLAS, excluida: true, motivo: "Gasto personal" });
      const f = await montar({
        estado: { filas: [C_1040_ISC, C_3064_BOLSAS, excluida] },
        extra: { [`POST ${BASE}`]: { status: 409, cuerpo: { codigo: "duplicado", id: excluida.id } } },
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(1));
      expect(fila(excluida.id)).toBeNull();

      await user.click(screen.getByRole("button", { name: M.agregarCompra }));
      await llenar(user);
      await user.click(screen.getByRole("button", { name: M.agregar }));
      expect((await screen.findByRole("alert")).textContent).toContain(M.yaExisteEnPropuesta);
      await user.click(screen.getByRole("button", { name: M.ubicarExistente }));

      await vi.waitFor(() => expect(fila(excluida.id)).not.toBeNull());
      expect(
        (screen.getByRole("radio", { name: M.vistas.excluidas }) as HTMLInputElement).checked,
      ).toBe(true);
      await vi.waitFor(() =>
        expect(within(fila(excluida.id)!).getByText(TEXTOS_GRILLA.actualizada)).toBeTruthy(),
      );
      expect(f.listados().some((l) => l.url.includes("vista=excluidas"))).toBe(true);
    });
  });

  describe("historial y lupa (P-6)", () => {
    it("feliz: «Historial» abre el panel con el valor original y el vigente; la lupa está deshabilitada", async () => {
      const f = await montar();
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));
      const lupa = within(fila(C_3064_BOLSAS.id)!).getByRole("button", {
        name: `${M.columnas.lupa}: ${M.lupaDeshabilitada}`,
      }) as HTMLButtonElement;
      expect(lupa.disabled).toBe(true);

      await user.click(
        within(fila(C_3064_BOLSAS.id)!).getByRole("button", {
          name: TEXTOS_GRILLA.abrirHistorial("F001-3064"),
        }),
      );

      expect(await screen.findByText(M.tituloHistorial)).toBeTruthy();
      expect(lecturas(f, `/${C_3064_BOLSAS.id}`)).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: M.cerrar }));
      expect(screen.queryByText(M.tituloHistorial)).toBeNull();
    });

    it("error: si el detalle no existe (404) el panel lo dice y la pantalla sigue", async () => {
      await montar({
        extra: {
          [`GET ${BASE}/${C_3064_BOLSAS.id}`]: { status: 404, cuerpo: { codigo: "no_encontrada" } },
        },
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));
      await user.click(
        within(fila(C_3064_BOLSAS.id)!).getByRole("button", {
          name: TEXTOS_GRILLA.abrirHistorial("F001-3064"),
        }),
      );
      expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
      expect(screen.getByRole("grid", { name: M.tablaCompras })).toBeTruthy();
    });
  });

  describe("permisos y solo lectura (CA-14, D-13)", () => {
    it("sin sire.clasificar no hay ninguna acción de escritura", async () => {
      await montar({ permisos: PERMISOS.lectura });
      await screen.findByText(M.cargaCompleta(4));
      expect(accionesDe("F001-3064")).toBeNull();
      expect(boton(M.agregarCompra)).toBeNull();
      expect(boton(M.deshacer)).toBeNull();
      expect(boton(M.rehacer)).toBeNull();
      await userEvent
        .setup()
        .click(screen.getByRole("checkbox", { name: M.seleccionarFila("F001-3064") }));
      expect(screen.queryByRole("toolbar")).toBeNull();
    });

    it("periodo revisado sin sire.aprobar_generar: acciones, agregar y deshacer deshabilitados con el motivo", async () => {
      await montar({
        permisos: PERMISOS.sinAprobar,
        estado: { estado: "revisado" },
      });
      await screen.findByText(M.cargaCompleta(4));
      const acciones = accionesDe("F001-3064") as HTMLButtonElement;
      expect(acciones.disabled).toBe(true);
      expect(acciones.title).toBe(M.soloLectura.revisadoSinAprobar);
      expect(deshabilitado(boton(M.agregarCompra))).toBe(true);
      expect(deshabilitado(boton(M.deshacer))).toBe(true);
    });

    it("periodo generado: nadie excluye ni edita", async () => {
      await montar({ estado: { estado: "generado" } });
      await screen.findByText(M.cargaCompleta(4));
      expect((accionesDe("F001-3064") as HTMLButtonElement).disabled).toBe(true);
      expect(deshabilitado(boton(M.agregarCompra))).toBe(true);
      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: M.seleccionarFila("F001-3064") }));
      const barra = await screen.findByRole("toolbar");
      expect(
        (within(barra).getByRole("button", { name: M.clasificarComo("DNG") }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });
  describe("defectos de la prueba manual (spec 015 T11 → T12)", () => {
    it("D-1: al completar la descarga se vuelve a pedir el listado y la grilla muestra las filas nuevas", async () => {
      const f = await montar({
        estado: { filas: [] },
        extra: (estado) => ({
          [`POST ${BASE}/descargar`]: () => {
            // El worker trae las compras del SIRE mientras corre el trabajo.
            estado.filas = [...FILAS_014];
            return { status: 202, cuerpo: { trabajoId: idTrabajo(1) } };
          },
        }),
      });
      const user = userEvent.setup();
      expect(await screen.findByText(M.sinCompras)).toBeTruthy();
      const listadosAntes = f.listados().length;

      await user.click(screen.getByRole("button", { name: M.descargar }));
      await vi.waitFor(() => expect(vi.mocked(seguirTrabajos)).toHaveBeenCalled());
      const opciones = vi.mocked(seguirTrabajos).mock.calls.at(-1)![0] as OpcionesSeguimiento;
      act(() => opciones.alEvento(trabajoDescarga(1, "completado") as never));

      // CA-3: «al completar se refresca la grilla» (GET compras?limite=…), no solo resumen y propuestas.
      await vi.waitFor(() => expect(f.listados().length).toBeGreaterThan(listadosAntes));
      expect(await screen.findByText("F001-3064")).toBeTruthy();
      expect(screen.queryByText(M.sinCompras)).toBeNull();
    });

    it("una sola compra se dice «1 compra cargada», no «1 compras cargadas»", async () => {
      await montar({ estado: { filas: [C_3064_BOLSAS] } });
      const estadoCarga = await screen.findByText(/cargadas?$/);
      expect(estadoCarga.textContent).toMatch(/^1 compra cargada$/);
    });
  });
});
