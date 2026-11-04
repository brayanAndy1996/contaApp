import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { MENSAJES_ACCESO } from "../../../pruebas/acceso";
import { crearRouterFalso } from "../../../pruebas/soporte";
import {
  MENSAJES_TRABAJOS as M,
  instalarFetchPanel,
  trabajoN,
  type ConexionStream,
  type OpcionesPanel,
  type PanelFalso,
  type TrabajoPrueba,
} from "../../../pruebas/trabajos";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/trabajos",
  useSearchParams: () => new URLSearchParams(),
}));

import Trabajos from "./page";

// Contrato (plan 007b, Decisiones: Panel; D10; CA-5, CA-7). Pantalla /trabajos:
// - Al montar: GET /api/trabajos (TrabajoVista[]) y abre el stream con
//   `fetch("/api/trabajos/stream")` GET (X-Estudio, Accept text/event-stream, credentials same-origin,
//   AbortSignal) leyendo el flujo; NO usa EventSource. <h1> M.titulo. Lista vacía → M.vacio.
// - Cada trabajo es una fila (role=row) con el nombre del tipo (M.tipos; un tipo desconocido se muestra
//   tal cual), el estado (M.estados) y, si lo hay, el motivo (M.motivos). Un trabajo terminado
//   (completado, error, cancelado) sigue visible con su estado y motivo. 403 → sinPermiso, otro error
//   → errorGeneral (role=alert).
// - Más de 10 trabajos de un tipo se resumen en UNA línea M.resumen(tipo, terminados, total) (miles con
//   punto: «640 de 1.000»; terminados = completado + error + cancelado), más «N con error» (M.conError)
//   si N > 0, y un botón "Ver detalle" que despliega las filas de ese tipo. Sin desplegar no hay una
//   fila por trabajo.
// - Eventos SSE `event: trabajo` + `data: <TrabajoVista>`: actualizan el trabajo por id (o lo añaden) en
//   ≤ 2 s; se aplican por lotes (≤ 4 repintados por segundo) sin perder ninguno; los comentarios
//   (`: latido`), los JSON rotos y los eventos que no cumplen el esquema se ignoran; un evento puede
//   llegar partido en varios trozos.
// - Reconexión: si el stream termina (cierre normal a los 5 min o error de red) vuelve a abrirlo en ≤ 5 s
//   y re-sincroniza con GET /api/trabajos (el stream no trae estado inicial).
// - Respaldo: si el stream no se puede abrir, sondea GET /api/trabajos al menos cada 10 s.
// - Al desmontar aborta la conexión y no reconecta.

const RUC = "cliente.consultar_ruc";
const SOL = "credencial.verificar_sol";
const SIRE = "credencial.verificar_sire";

const lista = (trabajos: TrabajoPrueba[]): OpcionesPanel["listado"] => () => ({
  status: 200,
  cuerpo: trabajos,
});

function montar(opciones: OpcionesPanel): {
  panel: PanelFalso;
  desmontar: () => void;
} {
  const panel = instalarFetchPanel(opciones);
  const r = render(<Trabajos />);
  return { panel, desmontar: r.unmount };
}

async function conectado(panel: PanelFalso, n = 1): Promise<ConexionStream> {
  await vi.waitFor(() => expect(panel.conexiones.length).toBeGreaterThanOrEqual(n));
  return panel.conexiones[n - 1]!;
}

function fila(texto: string): HTMLElement {
  const f = screen
    .queryAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}
const filasDe = (texto: string) =>
  screen.queryAllByRole("row").filter((r) => r.textContent?.includes(texto));

/** Trabajos `desde..desde+n-1` del tipo con el estado dado. */
function varios(
  desde: number,
  n: number,
  tipo: string,
  estado: Parameters<typeof trabajoN>[2],
): TrabajoPrueba[] {
  return Array.from({ length: n }, (_, i) => trabajoN(desde + i, tipo, estado));
}

describe("/trabajos · panel con SSE (007b)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("lista", () => {
    it("muestra tipo, estado y motivo de cada trabajo, incluidos los terminados", async () => {
      montar({
        listado: lista([
          trabajoN(1, SOL, "en_cola"),
          trabajoN(2, SIRE, "error", "credencial_invalida"),
          trabajoN(3, RUC, "completado"),
        ]),
      });
      expect(
        await screen.findByRole("heading", { name: M.titulo, level: 1 }),
      ).toBeTruthy();
      await vi.waitFor(() => fila(M.tipos[SOL]));
      expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.en_cola);
      const error = fila(M.tipos[SIRE]);
      expect(error.textContent).toContain(M.estados.error);
      expect(error.textContent).toContain(M.motivos.credencial_invalida);
      expect(fila(M.tipos[RUC]).textContent).toContain(M.estados.completado);
    });

    it("lista vacía → mensaje", async () => {
      montar({ listado: lista([]) });
      expect(await screen.findByText(M.vacio)).toBeTruthy();
    });

    it.each([
      [403, MENSAJES_ACCESO.sinPermiso],
      [500, MENSAJES_ACCESO.errorGeneral],
    ])("GET /api/trabajos %i → mensaje de error", async (status, mensaje) => {
      montar({ listado: () => ({ status, cuerpo: { codigo: "x" } }) });
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(mensaje);
    });
  });

  describe("resumen de muchos trabajos del mismo tipo", () => {
    it("1.000 trabajos se resumen en una línea con terminados, errores y sin una fila por trabajo", async () => {
      montar({
        listado: lista([
          ...varios(1, 600, RUC, "completado"),
          ...varios(601, 40, RUC, "error"),
          ...varios(641, 360, RUC, "en_cola"),
        ]),
      });
      expect(
        await screen.findByText(
          M.resumen(M.tipos[RUC], "640", "1.000"),
          {},
          { timeout: 5000 },
        ),
      ).toBeTruthy();
      expect(screen.getByText(M.conError("40"))).toBeTruthy();
      expect(screen.queryAllByRole("row").length).toBeLessThan(20);
      expect(screen.getByRole("button", { name: M.verDetalle })).toBeTruthy();
    });

    it("el resumen sigue los eventos del stream (641 de 1.000)", async () => {
      const { panel } = montar({
        listado: lista([
          ...varios(1, 640, RUC, "completado"),
          ...varios(641, 360, RUC, "en_cola"),
        ]),
      });
      await screen.findByText(
        M.resumen(M.tipos[RUC], "640", "1.000"),
        {},
        { timeout: 5000 },
      );
      const c = await conectado(panel);
      c.evento(trabajoN(1000, RUC, "completado"));
      expect(
        await screen.findByText(
          M.resumen(M.tipos[RUC], "641", "1.000"),
          {},
          { timeout: 2000 },
        ),
      ).toBeTruthy();
    });

    it("«Ver detalle» despliega una fila por trabajo del tipo", async () => {
      montar({
        listado: lista([
          ...varios(1, 10, RUC, "completado"),
          ...varios(11, 2, RUC, "en_cola"),
        ]),
      });
      await screen.findByText(M.resumen(M.tipos[RUC], "10", "12"));
      expect(filasDe(M.tipos[RUC])).toHaveLength(0);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: M.verDetalle }));
      await vi.waitFor(() => expect(filasDe(M.estados.completado)).toHaveLength(10));
      expect(filasDe(M.estados.en_cola)).toHaveLength(2);
    });

    it("10 trabajos o menos de un tipo se listan sin resumir", async () => {
      montar({ listado: lista(varios(1, 10, RUC, "completado")) });
      await vi.waitFor(() => expect(filasDe(M.tipos[RUC])).toHaveLength(10));
      expect(screen.queryByText(/ de 10$/)).toBeNull();
    });
  });

  // 007b T18a. D-1: `GET /trabajos` trae solo los 100 más recientes; el total y el resumen salen de
  // `GET /trabajos/resumen` (conteo por tipo y estado de todos), también tras reconectar y al llegar eventos.
  describe("más de 100 trabajos (D-1)", () => {
    const filaResumen = (estado: string, total: number, tipo = RUC) => ({
      tipo,
      estado,
      total,
    });
    /** 1.000 consultas: 600 completadas, 40 con error, 360 en cola; el listado solo trae 100 en cola. */
    const MIL = [
      filaResumen("completado", 600),
      filaResumen("error", 40),
      filaResumen("en_cola", 360),
    ];
    const cien = () => varios(901, 100, RUC, "en_cola");

    it("el resumen cuenta los 1.000 aunque el listado traiga 100", async () => {
      montar({
        listado: lista(cien()),
        resumen: () => ({ status: 200, cuerpo: MIL }),
      });
      expect(
        await screen.findByText(
          M.resumen(M.tipos[RUC], "640", "1.000"),
          {},
          { timeout: 5000 },
        ),
      ).toBeTruthy();
      expect(screen.getByText(M.conError("40"))).toBeTruthy();
      expect(screen.queryAllByRole("row").length).toBeLessThan(20);
    });

    it("tras reconectar (el listado vuelve con 100) el total sigue en 1.000", async () => {
      const { panel } = montar({
        listado: lista(cien()),
        resumen: () => ({ status: 200, cuerpo: MIL }),
      });
      await screen.findByText(
        M.resumen(M.tipos[RUC], "640", "1.000"),
        {},
        { timeout: 5000 },
      );
      const c = await conectado(panel);
      act(() => c.cerrar());
      await vi.waitFor(() => expect(panel.listados()).toBeGreaterThanOrEqual(2), {
        timeout: 5000,
      });
      await vi.waitFor(() => expect(panel.resumenes()).toBeGreaterThanOrEqual(2), {
        timeout: 5000,
      });
      expect(screen.getByText(M.resumen(M.tipos[RUC], "640", "1.000"))).toBeTruthy();
      expect(screen.queryByText(/ de 100$/)).toBeNull();
    });

    it("un evento refresca el resumen y el panel muestra 641 de 1.000", async () => {
      const { panel } = montar({
        listado: lista(cien()),
        resumen: (vez) => ({
          status: 200,
          cuerpo:
            vez === 1
              ? MIL
              : [
                  filaResumen("completado", 601),
                  filaResumen("error", 40),
                  filaResumen("en_cola", 359),
                ],
        }),
      });
      await screen.findByText(
        M.resumen(M.tipos[RUC], "640", "1.000"),
        {},
        { timeout: 5000 },
      );
      const c = await conectado(panel);
      c.evento(trabajoN(901, RUC, "completado"));
      expect(
        await screen.findByText(
          M.resumen(M.tipos[RUC], "641", "1.000"),
          {},
          { timeout: 3000 },
        ),
      ).toBeTruthy();
    });

    it("si el resumen falla, cuenta con lo que trae el listado", async () => {
      montar({
        listado: lista(varios(1, 12, RUC, "completado")),
        resumen: () => ({ status: 500, cuerpo: { codigo: "x" } }),
      });
      expect(
        await screen.findByText(M.resumen(M.tipos[RUC], "12", "12")),
      ).toBeTruthy();
    });
  });

  // D-2: Next no entrega las cabeceras del stream hasta su primer byte (~15 s con el flujo ocioso); la lista no
  // puede esperar a ese `fetch`.
  describe("lista sin esperar las cabeceras del stream (D-2)", () => {
    it("muestra la lista aunque el stream aún no haya respondido y luego lo lee", async () => {
      const { panel } = montar({
        listado: lista([trabajoN(1, SOL, "en_cola")]),
        cabecerasStreamTarde: true,
      });
      await vi.waitFor(() => fila(M.tipos[SOL]), { timeout: 1000 });
      expect(panel.conexiones).toHaveLength(1);
      act(() => panel.liberarCabeceras());
      panel.conexiones[0]!.evento(trabajoN(1, SOL, "completado"));
      await vi.waitFor(
        () => expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.completado),
        { timeout: 2000 },
      );
    });
  });

  describe("eventos del stream (D10, CA-7)", () => {
    it("abre el stream con fetch, X-Estudio y Accept de event-stream (no EventSource)", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SOL, "en_cola")]) });
      const c = await conectado(panel);
      expect(c.headers["x-estudio"]).toBe("e-a");
      expect(c.headers["accept"]).toMatch(/text\/event-stream/);
      expect(c.signal).toBeTruthy();
    });

    it("un evento cambia el estado del trabajo en ≤ 2 s sin tocar los demás", async () => {
      const { panel } = montar({
        listado: lista([trabajoN(1, SOL, "en_cola"), trabajoN(2, SIRE, "en_cola")]),
      });
      await vi.waitFor(() => fila(M.tipos[SIRE]));
      const c = await conectado(panel);
      c.evento(trabajoN(2, SIRE, "ejecutando"));
      await vi.waitFor(
        () => expect(fila(M.tipos[SIRE]).textContent).toContain(M.estados.ejecutando),
        { timeout: 2000 },
      );
      expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.en_cola);
    });

    it("un evento terminal queda visible con su estado y motivo", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SIRE, "ejecutando")]) });
      await vi.waitFor(() => fila(M.tipos[SIRE]));
      const c = await conectado(panel);
      c.evento(trabajoN(1, SIRE, "error", "credencial_invalida"));
      await vi.waitFor(
        () => {
          const f = fila(M.tipos[SIRE]);
          expect(f.textContent).toContain(M.estados.error);
          expect(f.textContent).toContain(M.motivos.credencial_invalida);
        },
        { timeout: 2000 },
      );
    });

    it("un trabajo nuevo (no estaba en la lista) se añade", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SOL, "en_cola")]) });
      await vi.waitFor(() => fila(M.tipos[SOL]));
      const c = await conectado(panel);
      c.evento(trabajoN(7, SIRE, "en_cola"));
      await vi.waitFor(() => fila(M.tipos[SIRE]), { timeout: 2000 });
    });

    it("un evento partido en varios trozos se aplica una vez completo", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SOL, "en_cola")]) });
      await vi.waitFor(() => fila(M.tipos[SOL]));
      const c = await conectado(panel);
      const texto = `event: trabajo\ndata: ${JSON.stringify(trabajoN(1, SOL, "completado"))}\n\n`;
      const corte = Math.floor(texto.length / 2);
      c.enviar(texto.slice(0, corte));
      c.enviar(texto.slice(corte));
      await vi.waitFor(
        () => expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.completado),
        { timeout: 2000 },
      );
    });

    it("ignora latidos, JSON roto y eventos fuera de esquema, y sigue aplicando los válidos", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SOL, "en_cola")]) });
      await vi.waitFor(() => fila(M.tipos[SOL]));
      const c = await conectado(panel);
      c.enviar(": latido\n\n");
      c.enviar("event: trabajo\ndata: {esto no es json\n\n");
      c.enviar('event: trabajo\ndata: {"id":"x","estado":"inventado"}\n\n');
      c.evento(trabajoN(1, SOL, "ejecutando"));
      await vi.waitFor(
        () => expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.ejecutando),
        { timeout: 2000 },
      );
      expect(filasDe(M.tipos[SOL])).toHaveLength(1);
    });

    it("300 eventos seguidos se aplican todos (por lotes, sin perder ninguno)", async () => {
      const { panel } = montar({ listado: lista(varios(1, 300, RUC, "en_cola")) });
      await screen.findByText(
        M.resumen(M.tipos[RUC], "0", "300"),
        {},
        { timeout: 5000 },
      );
      const c = await conectado(panel);
      for (let n = 1; n <= 300; n++) c.evento(trabajoN(n, RUC, "completado"));
      expect(
        await screen.findByText(
          M.resumen(M.tipos[RUC], "300", "300"),
          {},
          { timeout: 4000 },
        ),
      ).toBeTruthy();
    });
  });

  describe("reconexión y respaldo (D10)", () => {
    const avanzar = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
    });

    it("si el servidor cierra el stream, reconecta en ≤ 5 s y re-sincroniza el listado", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SOL, "en_cola")]) });
      await avanzar(100);
      await avanzar(100);
      expect(panel.conexiones).toHaveLength(1);
      const antes = panel.listados();
      act(() => panel.conexiones[0]!.cerrar());
      await avanzar(5000);
      expect(panel.conexiones.length).toBeGreaterThanOrEqual(2);
      expect(panel.listados()).toBeGreaterThan(antes);
    });

    it("si el stream falla a mitad, también reconecta en ≤ 5 s", async () => {
      const { panel } = montar({ listado: lista([trabajoN(1, SOL, "en_cola")]) });
      await avanzar(100);
      await avanzar(100);
      expect(panel.conexiones).toHaveLength(1);
      act(() => panel.conexiones[0]!.fallar());
      await avanzar(5000);
      expect(panel.conexiones.length).toBeGreaterThanOrEqual(2);
    });

    it("sin poder abrir el stream sondea GET /api/trabajos al menos cada 10 s", async () => {
      const { panel } = montar({
        listado: lista([trabajoN(1, SOL, "en_cola")]),
        rechazarStream: () => true,
      });
      await avanzar(100);
      await avanzar(100);
      const inicial = panel.listados();
      expect(inicial).toBeGreaterThanOrEqual(1);
      await avanzar(30_000);
      expect(panel.listados()).toBeGreaterThanOrEqual(inicial + 2);
      // La pantalla sigue viva y refleja el último listado.
      expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.en_cola);
    });

    it("el sondeo trae los cambios aunque el stream esté caído", async () => {
      let vez = 0;
      const { panel } = montar({
        listado: () => {
          vez += 1;
          return {
            status: 200,
            cuerpo: [trabajoN(1, SOL, vez < 3 ? "en_cola" : "completado")],
          };
        },
        rechazarStream: () => true,
      });
      await avanzar(100);
      await avanzar(100);
      await avanzar(40_000);
      expect(panel.listados()).toBeGreaterThanOrEqual(3);
      expect(fila(M.tipos[SOL]).textContent).toContain(M.estados.completado);
    });

    it("al desmontar aborta la conexión y no vuelve a conectar", async () => {
      const { panel, desmontar } = montar({
        listado: lista([trabajoN(1, SOL, "en_cola")]),
      });
      await avanzar(100);
      await avanzar(100);
      expect(panel.conexiones).toHaveLength(1);
      desmontar();
      expect(panel.conexiones[0]!.signal?.aborted).toBe(true);
      const listados = panel.listados();
      await avanzar(30_000);
      expect(panel.conexiones).toHaveLength(1);
      expect(panel.listados()).toBe(listados);
    });
  });
});
