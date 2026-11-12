import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sesionDe } from "../pruebas/soporte";
import { eventoSse, trabajoN } from "../pruebas/trabajos";
import { reiniciarSesion, obtenerSesion } from "./sesion";
import { seguirTrabajos, TOPE_ESPERA_STREAM_MS } from "./trabajos";

// Spec 018, T11e: el stream se abre y se espera (con tope) ANTES de listar. El backend manda `: conectado` cuando la
// conexión ya está registrada y suscrita; lo que ocurra después queda en el flujo. Si se lista antes, un «terminado»
// que cae entre el listado y el registro del stream se pierde y el panel se queda en «Generando…».

const json = (status: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Montaje {
  registro: string[];
  /** Entrega las cabeceras del stream con el cuerpo dado (`: conectado`). */
  responderStream: (
    status?: number,
  ) => ReadableStreamDefaultController<Uint8Array>;
  alListar: ReturnType<typeof vi.fn>;
  alEvento: ReturnType<typeof vi.fn>;
  alError: ReturnType<typeof vi.fn>;
  control: AbortController;
  fin: Promise<void>;
}

function montar(listado: () => Response = () => json(200, [])): Montaje {
  const registro: string[] = [];
  let entregar!: (r: Response) => void;
  let controlador!: ReadableStreamDefaultController<Uint8Array>;
  const cuerpo = new ReadableStream<Uint8Array>({
    start(c) {
      controlador = c;
    },
  });
  const control = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const ruta = String(entrada).split("?")[0];
      registro.push(ruta!);
      if (ruta === "/api/trabajos/stream") {
        return new Promise<Response>((resolver, rechazar) => {
          entregar = resolver;
          init?.signal?.addEventListener("abort", () => {
            rechazar(new DOMException("aborted", "AbortError"));
            try {
              controlador.error(new DOMException("aborted", "AbortError"));
            } catch {
              // El lector ya canceló el flujo.
            }
          });
        });
      }
      if (ruta === "/api/trabajos") return listado();
      if (ruta === "/api/trabajos/resumen") return json(404, {});
      throw new Error(`ruta no simulada: ${ruta}`);
    }),
  );
  const alListar = vi.fn();
  const alEvento = vi.fn();
  const alError = vi.fn();
  const fin = seguirTrabajos({
    alListar,
    alEvento,
    alError,
    senal: control.signal,
  });
  return {
    registro,
    responderStream: (status = 200) => {
      entregar(new Response(status === 200 ? cuerpo : null, { status }));
      return controlador;
    },
    alListar,
    alEvento,
    alError,
    control,
    fin,
  };
}

describe("lib/trabajos: seguirTrabajos espera al stream antes de listar", () => {
  beforeEach(async () => {
    reiniciarSesion();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, sesionDe({ id: "e-1", nombre: "Estudio" }))),
    );
    await obtenerSesion(); // sesión ya en memoria: los temporizadores falsos no la tocan
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caso feliz: el listado ocurre después de que el stream resuelve, y los eventos posteriores llegan", async () => {
    const m = montar();
    await vi.advanceTimersByTimeAsync(500);
    // El stream aún no respondió: no se ha listado nada.
    expect(m.registro).toEqual(["/api/trabajos/stream"]);

    const flujo = m.responderStream();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.registro.slice(0, 2)).toEqual([
      "/api/trabajos/stream",
      "/api/trabajos",
    ]);
    expect(m.alListar).toHaveBeenCalledTimes(1);
    // Con el stream a tiempo no hay segundo listado (DT-7).
    expect(m.registro.filter((r) => r === "/api/trabajos")).toHaveLength(1);

    // Un «terminado» emitido después del registro llega por el flujo, no se pierde.
    flujo.enqueue(
      new TextEncoder().encode(
        `: conectado\n\n${eventoSse(trabajoN(1, "archivo.generar", "completado"))}`,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(m.alEvento).toHaveBeenCalledTimes(1);
    expect(m.alEvento.mock.calls[0]![0]).toMatchObject({
      estado: "completado",
    });

    m.control.abort();
    await m.fin;
  });

  it("con el stream colgado, lista al pasar el tope y sigue leyendo el stream cuando llegue", async () => {
    const m = montar();
    await vi.advanceTimersByTimeAsync(TOPE_ESPERA_STREAM_MS - 1);
    expect(m.registro).toEqual(["/api/trabajos/stream"]);
    expect(m.alListar).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(m.registro).toContain("/api/trabajos");
    expect(m.alListar).toHaveBeenCalledTimes(1);

    // El stream llega tarde: se relista UNA vez (DT-7) y se lee igualmente.
    const flujo = m.responderStream();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.alListar).toHaveBeenCalledTimes(2);
    expect(m.registro.filter((r) => r === "/api/trabajos")).toHaveLength(2);
    flujo.enqueue(
      new TextEncoder().encode(
        eventoSse(trabajoN(2, "archivo.generar", "error")),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(m.alEvento).toHaveBeenCalledTimes(1);

    m.control.abort();
    await m.fin;
  });

  it("error: si el stream tarda más que el tope y luego falla (503), no se relista", async () => {
    const m = montar();
    await vi.advanceTimersByTimeAsync(TOPE_ESPERA_STREAM_MS);
    expect(m.alListar).toHaveBeenCalledTimes(1);
    m.responderStream(503);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.alListar).toHaveBeenCalledTimes(1);
    m.control.abort();
    await m.fin;
  });

  it("error: si el stream falla (503) se lista igual sin esperar el tope", async () => {
    const m = montar();
    await vi.advanceTimersByTimeAsync(0);
    m.responderStream(503);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.alListar).toHaveBeenCalledTimes(1);
    m.control.abort();
    await m.fin;
  });

  it("error: un 401 del listado detiene el ciclo y cancela el stream", async () => {
    const m = montar(() => json(401, { codigo: "no_autenticado" }));
    await vi.advanceTimersByTimeAsync(0);
    const flujo = m.responderStream();
    await vi.advanceTimersByTimeAsync(0);
    await m.fin;
    expect(m.alError).toHaveBeenCalledWith(401);
    expect(m.alListar).not.toHaveBeenCalled();
    expect(flujo).toBeTruthy();
  });

  it("aborta durante la espera: no lista y termina", async () => {
    const m = montar();
    await vi.advanceTimersByTimeAsync(100);
    m.control.abort();
    await m.fin;
    expect(m.registro).toEqual(["/api/trabajos/stream"]);
    expect(m.alListar).not.toHaveBeenCalled();
  });
});
