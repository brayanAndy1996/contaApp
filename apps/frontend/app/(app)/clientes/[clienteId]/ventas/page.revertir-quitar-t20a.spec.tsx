import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import { asentar } from "../../../../../pruebas/acceso";
import { clienteDe } from "../../../../../pruebas/clientes";
import { crearRouterFalso } from "../../../../../pruebas/soporte";
import {
  BASE,
  CLIENTE_ID,
  CORRELATIVIDAD_BASE,
  CORRELATIVIDAD_JUSTIFICADA,
  CORRELATIVIDAD_JUSTIFICADA_CON_ID,
  JUSTIFICACION_ID,
  MENSAJES_VENTAS as M,
  PERIODO,
  PERMISOS,
  RESUMEN_BASE,
  V290,
  V292,
  V_MANUAL,
  instalarFetchVentas,
  paginaDe,
  propuestaDe,
  type EstadoVentas,
  type FetchVentas,
  type OpcionesVentas,
} from "../../../../../pruebas/ventas";

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

// Spec 013 · T20a (rojo), decisión D23 del usuario (2026-11-07, observación (a) de T20): la pantalla de ventas deja
// REVERTIR una justificación y QUITAR una venta agregada a mano, los dos con confirmación. Solo los ve quien tiene
// `sire.clasificar` (y con el cliente activo); el backend vuelve a validar (T13). Contrato:
//  - «Revertir» (M.revertir) aparece en el faltante «Justificado» que trae `justificacionId` (la correlatividad lo
//    entrega solo cuando una única justificación vigente lo cubre); sin id, o en un salto pendiente o parcial, no.
//  - «Quitar» (M.quitar) aparece solo en la fila de una venta de origen `manual`; las del SIRE no lo tienen.
//  - Cada botón abre una confirmación (role=alertdialog) con el comprobante en su texto (M.confirmarRevertir /
//    M.confirmarQuitar) y los botones M.confirmar y M.cancelar. «Cancelar» cierra sin llamar a la API.
//  - Confirmar revertir: DELETE <BASE>/saltos-justificados/<justificacionId> (204, con CSRF y X-Estudio), recarga la
//    correlatividad (el salto vuelve a alertar) y dice M.justificacionRevertida (role=status).
//  - Confirmar quitar: DELETE <BASE>/<ventaId> (204), recarga grilla, resumen y correlatividad (el salto reaparece) y
//    dice M.ventaQuitada (role=status).
//  - Un error del servidor (404 al revertir, 409 `venta_no_quitable` al quitar) se muestra en un role=alert con
//    M.errorRevertir / M.errorQuitar y el diálogo se cierra.

const P2 = propuestaDe(2);
const VENTA_MANUAL_ID = V_MANUAL.id;
const DELETE_REVERTIR = `DELETE ${BASE}/saltos-justificados/${JUSTIFICACION_ID}`;
const DELETE_QUITAR = `DELETE ${BASE}/${VENTA_MANUAL_ID}`;

function estadoBase(): Partial<EstadoVentas> {
  return {
    pagina: paginaDe([V290, V_MANUAL, V292]),
    resumen: RESUMEN_BASE,
    correlatividad: CORRELATIVIDAD_JUSTIFICADA_CON_ID,
    propuestas: [P2],
    diferencias: { [P2.id]: [] },
  };
}

async function montar(
  o: Omit<OpcionesVentas, "estado"> & { estado?: Partial<EstadoVentas> } = {},
): Promise<FetchVentas> {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchVentas({
    permisos: o.permisos,
    estado: { ...estadoBase(), ...o.estado },
    extra: o.extra,
  });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const region = (nombre: string) => screen.findByRole("region", { name: nombre });
function filaDe(contenedor: HTMLElement, texto: string): HTMLElement {
  const f = within(contenedor)
    .queryAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}
function faltante(contenedor: HTMLElement, texto: string): HTMLElement {
  const item = within(contenedor).getByText(texto).closest('li, [role="listitem"]');
  if (!item) throw new Error(`"${texto}" no está dentro de un listitem`);
  return item as HTMLElement;
}
const itemJustificado = async () => {
  const correlatividad = await region("Correlatividad");
  return vi.waitFor(() => faltante(correlatividad, M.faltaUno("B001-291")));
};
const filaManual = async () => {
  const ventas = await region(M.tablaVentas);
  return vi.waitFor(() => filaDe(ventas, "B001-291"));
};
const boton = (donde: HTMLElement, nombre: string) =>
  within(donde).queryByRole("button", { name: nombre });

describe("/clientes/:id/ventas · revertir y quitar (T20a, D23)", () => {
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

  describe("revertir una justificación", () => {
    it("el salto justificado con `justificacionId` ofrece «Revertir» y ya no «Justificar» ni «Agregar venta»", async () => {
      await montar();
      const item = await itemJustificado();
      expect(within(item).getByText(M.justificado)).toBeTruthy();
      expect(boton(item, M.revertir)).not.toBeNull();
      expect(boton(item, M.justificar)).toBeNull();
      expect(boton(item, M.agregarVenta)).toBeNull();
    });

    it("sin `justificacionId`, o con el salto pendiente o justificado en parte, no hay «Revertir»", async () => {
      await montar({ estado: { correlatividad: CORRELATIVIDAD_JUSTIFICADA } });
      expect(boton(await itemJustificado(), M.revertir)).toBeNull();
      cleanup();
      await montar({ estado: { correlatividad: CORRELATIVIDAD_BASE } });
      expect(boton(await itemJustificado(), M.revertir)).toBeNull();
    });

    it.each([
      ["lectura", PERMISOS.lectura, false],
      ["solo descargar", PERMISOS.soloDescargar, false],
      ["solo clasificar", PERMISOS.soloClasificar, true],
      ["todos", PERMISOS.todos, true],
    ] as const)("permisos %s: «Revertir» visible = %s", async (_n, permisos, visible) => {
      await montar({ permisos });
      expect(boton(await itemJustificado(), M.revertir) !== null).toBe(visible);
    });

    it("con el cliente archivado (solo lectura) no hay «Revertir»", async () => {
      await montar({
        extra: {
          [`GET /api/clientes/${CLIENTE_ID}`]: {
            status: 200,
            cuerpo: clienteDe({ id: CLIENTE_ID, archivado: true }),
          },
        },
      });
      await vi.waitFor(async () =>
        expect(await region(M.tablaVentas)).toBeTruthy(),
      );
      await asentar();
      expect(boton(await itemJustificado(), M.revertir)).toBeNull();
    });

    it("pide confirmación con el comprobante; «Cancelar» cierra sin llamar a la API", async () => {
      const f = await montar();
      const user = userEvent.setup();
      await user.click(boton(await itemJustificado(), M.revertir)!);
      const dialogo = await screen.findByRole("alertdialog");
      expect(dialogo.textContent).toContain(M.confirmarRevertir("B001-291"));
      expect(within(dialogo).getByRole("button", { name: M.confirmar })).toBeTruthy();
      await user.click(within(dialogo).getByRole("button", { name: M.cancelar }));
      await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await asentar();
      expect(f.de(DELETE_REVERTIR)).toHaveLength(0);
    });

    it("al confirmar envía el DELETE con CSRF, recarga la correlatividad y el salto vuelve a alertar", async () => {
      const f = await montar({
        extra: (estado) => ({
          [DELETE_REVERTIR]: () => {
            estado.correlatividad = CORRELATIVIDAD_BASE;
            return { status: 204 };
          },
        }),
      });
      const user = userEvent.setup();
      const correlatividad = await region("Correlatividad");
      await user.click(boton(await itemJustificado(), M.revertir)!);
      const dialogo = await screen.findByRole("alertdialog");
      await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));

      await vi.waitFor(() => expect(f.de(DELETE_REVERTIR)).toHaveLength(1));
      const llamada = f.de(DELETE_REVERTIR)[0]!;
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");
      await vi.waitFor(() => expect(f.lecturas("/correlatividad")).toHaveLength(2));
      await vi.waitFor(() => {
        const item = faltante(correlatividad, M.faltaUno("B001-291"));
        expect(boton(item, M.justificar)).not.toBeNull();
        expect(within(item).queryByText(M.justificado)).toBeNull();
      });
      expect(within(correlatividad).getByText(M.porRevisar(2))).toBeTruthy();
      expect((await screen.findByRole("status")).textContent).toContain(
        M.justificacionRevertida,
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("si el servidor no la encuentra (404) lo dice, cierra el diálogo y no deja el salto en falso", async () => {
      const f = await montar({
        extra: { [DELETE_REVERTIR]: { status: 404, cuerpo: { codigo: "no_encontrado" } } },
      });
      const user = userEvent.setup();
      await user.click(boton(await itemJustificado(), M.revertir)!);
      const dialogo = await screen.findByRole("alertdialog");
      await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));
      await vi.waitFor(() => expect(f.de(DELETE_REVERTIR)).toHaveLength(1));
      expect((await screen.findByRole("alert")).textContent).toContain(M.errorRevertir);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      // Se vuelve a leer la correlatividad: lo que ve la persona es lo que dice el servidor.
      await vi.waitFor(() => expect(f.lecturas("/correlatividad")).toHaveLength(2));
    });
  });

  describe("quitar una venta agregada a mano", () => {
    it("solo la fila de origen manual ofrece «Quitar»; las del SIRE no", async () => {
      await montar();
      const ventas = await region(M.tablaVentas);
      const manual = await vi.waitFor(() => filaDe(ventas, "B001-291"));
      expect(boton(manual, M.quitar)).not.toBeNull();
      expect(boton(filaDe(ventas, "B001-290"), M.quitar)).toBeNull();
      expect(boton(filaDe(ventas, "B001-292"), M.quitar)).toBeNull();
      expect(within(ventas).getAllByRole("button", { name: M.quitar })).toHaveLength(1);
    });

    it.each([
      ["lectura", PERMISOS.lectura, false],
      ["solo descargar", PERMISOS.soloDescargar, false],
      ["solo clasificar", PERMISOS.soloClasificar, true],
      ["todos", PERMISOS.todos, true],
    ] as const)("permisos %s: «Quitar» visible = %s", async (_n, permisos, visible) => {
      await montar({ permisos });
      expect(boton(await filaManual(), M.quitar) !== null).toBe(visible);
    });

    it("con el cliente archivado (solo lectura) no hay «Quitar»", async () => {
      await montar({
        extra: {
          [`GET /api/clientes/${CLIENTE_ID}`]: {
            status: 200,
            cuerpo: clienteDe({ id: CLIENTE_ID, archivado: true }),
          },
        },
      });
      const manual = await filaManual();
      await asentar();
      expect(boton(manual, M.quitar)).toBeNull();
    });

    it("pide confirmación con el comprobante; «Cancelar» cierra sin llamar a la API", async () => {
      const f = await montar();
      const user = userEvent.setup();
      await user.click(boton(await filaManual(), M.quitar)!);
      const dialogo = await screen.findByRole("alertdialog");
      expect(dialogo.textContent).toContain(M.confirmarQuitar("B001-291"));
      await user.click(within(dialogo).getByRole("button", { name: M.cancelar }));
      await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await asentar();
      expect(f.de(DELETE_QUITAR)).toHaveLength(0);
    });

    it("al confirmar envía el DELETE con CSRF y recarga grilla, resumen y correlatividad (el salto reaparece)", async () => {
      const f = await montar({
        estado: { correlatividad: CORRELATIVIDAD_BASE },
        extra: (estado) => ({
          [DELETE_QUITAR]: () => {
            estado.pagina = paginaDe([V290, V292]);
            estado.correlatividad = CORRELATIVIDAD_BASE;
            return { status: 204 };
          },
        }),
      });
      const user = userEvent.setup();
      const ventas = await region(M.tablaVentas);
      await user.click(boton(await filaManual(), M.quitar)!);
      const dialogo = await screen.findByRole("alertdialog");
      await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));

      await vi.waitFor(() => expect(f.de(DELETE_QUITAR)).toHaveLength(1));
      const llamada = f.de(DELETE_QUITAR)[0]!;
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(2));
      await vi.waitFor(() => expect(f.lecturas("/resumen")).toHaveLength(2));
      await vi.waitFor(() => expect(f.lecturas("/correlatividad")).toHaveLength(2));
      await vi.waitFor(() => expect(() => filaDe(ventas, "B001-291")).toThrow());
      expect((await screen.findByRole("status")).textContent).toContain(M.ventaQuitada);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("si el servidor la rechaza (409 venta_no_quitable) lo dice y la fila sigue", async () => {
      const f = await montar({
        extra: { [DELETE_QUITAR]: { status: 409, cuerpo: { codigo: "venta_no_quitable" } } },
      });
      const user = userEvent.setup();
      const manual = await filaManual();
      await user.click(boton(manual, M.quitar)!);
      const dialogo = await screen.findByRole("alertdialog");
      await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));
      await vi.waitFor(() => expect(f.de(DELETE_QUITAR)).toHaveLength(1));
      expect((await screen.findByRole("alert")).textContent).toContain(M.errorQuitar);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect((await region(M.tablaVentas)).textContent).toContain("B001-291");
    });
  });
});
