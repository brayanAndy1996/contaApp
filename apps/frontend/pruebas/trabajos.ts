import { vi } from "vitest";
import { yoDe } from "./acceso";
import { trabajoDe } from "./credenciales";
import { sesionDe } from "./soporte";

// Soporte de las pruebas del panel de trabajos (spec 007b, T6): textos visibles, trabajos de ejemplo y un
// `fetch` simulado con un stream SSE controlable. Son el contrato de T15. Solo datos de prueba.

export const MENSAJES_TRABAJOS = {
  titulo: "Trabajos",
  vacio: "No hay trabajos.",
  tipos: {
    "cliente.consultar_ruc": "Consultando datos de RUC",
    "credencial.verificar_sol": "Verificando clave SOL",
    "credencial.verificar_sire": "Verificando credencial SIRE",
    // T20a (D24): la descarga de la propuesta del SIRE (ventas y compras comparten tipo).
    "sire.propuesta.descargar": "Descargando propuesta del SIRE",
  },
  /** T20a (D24): el periodo (AAAAMM) que la fila del trabajo muestra junto al cliente. */
  periodo: (p: string) => `Periodo ${p}`,
  estados: {
    en_cola: "En cola",
    ejecutando: "Ejecutando",
    completado: "Completado",
    error: "Con error",
    cancelado: "Cancelado",
  },
  motivos: {
    credencial_invalida: "Credencial inválida",
    sunat_no_responde: "SUNAT no responde",
  },
  /** Más de 10 trabajos de un tipo se resumen en una línea; `terminados` = completado | error | cancelado. */
  resumen: (tipo: string, terminados: string, total: string) =>
    `${tipo}: ${terminados} de ${total}`,
  conError: (n: string) => `${n} con error`,
  verDetalle: "Ver detalle",
} as const;

export type EstadoTrabajoPrueba =
  | "en_cola"
  | "ejecutando"
  | "completado"
  | "error"
  | "cancelado";

/** UUID válido y determinista para el trabajo `n` (el esquema de `shared` exige `z.uuid()`). */
export function idTrabajo(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function trabajoN(
  n: number,
  tipo: string,
  estado: EstadoTrabajoPrueba,
  motivo: string | null = null,
) {
  const terminal = ["completado", "error", "cancelado"].includes(estado);
  return trabajoDe({
    id: idTrabajo(n),
    tipo,
    estado,
    motivo,
    posicion: estado === "en_cola" ? n : null,
    intentos: terminal ? 1 : 0,
    iniciadoEn: estado === "en_cola" ? null : "2026-11-04T10:00:01.000Z",
    terminadoEn: terminal ? "2026-11-04T10:00:02.000Z" : null,
  });
}

export type TrabajoPrueba = ReturnType<typeof trabajoN>;

export const TIPO_DESCARGA = "sire.propuesta.descargar";

/**
 * T20a (D24): una descarga de la propuesta del SIRE. `TrabajoVista` trae `clienteId` y, para este tipo, el `periodo`
 * (AAAAMM, opcional en `shared`); el nombre del cliente sale de `GET /api/clientes`.
 */
export function trabajoDescargaN(
  n: number,
  estado: EstadoTrabajoPrueba,
  opciones: { clienteId?: string; periodo?: string | null } = {},
) {
  const base = trabajoN(n, TIPO_DESCARGA, estado);
  const periodo = opciones.periodo === undefined ? "202610" : opciones.periodo;
  return {
    ...base,
    ...(opciones.clienteId ? { clienteId: opciones.clienteId } : {}),
    ...(periodo === null ? {} : { periodo }),
  };
}

/** Trozo SSE de un evento `trabajo` (008: `event: trabajo` + `data: <JSON>`). */
export const eventoSse = (t: TrabajoPrueba): string =>
  `event: trabajo\ndata: ${JSON.stringify(t)}\n\n`;

export interface ConexionStream {
  /** Cabeceras de la petición, con nombres en minúsculas. */
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
  /** Envía un trozo crudo (puede cortar un evento por la mitad). */
  enviar(texto: string): void;
  evento(t: TrabajoPrueba): void;
  /** Cierre normal del servidor (a los 5 min). */
  cerrar(): void;
  /** Error de red a mitad del stream. */
  fallar(): void;
}

export interface PanelFalso {
  conexiones: ConexionStream[];
  /** Cuántas veces se pidió `GET /api/trabajos`. */
  listados(): number;
  /** Cuántas veces se pidió `GET /api/trabajos/resumen` (007b T18a, D-1). */
  resumenes(): number;
  /** Entrega las cabeceras del stream retenidas por `cabecerasStreamTarde` (D-2). */
  liberarCabeceras(): void;
}

export interface OpcionesPanel {
  /** Respuesta de `GET /api/trabajos` (la `vez`-ésima llamada, desde 1). */
  listado: (vez: number) => { status: number; cuerpo?: unknown };
  /** `true` → la apertura del stream falla (red caída / 503); por defecto abre normal. */
  rechazarStream?: (vez: number) => boolean;
  permisos?: string[];
  /**
   * Respuesta de `GET /api/trabajos/resumen` (la `vez`-ésima llamada, desde 1): conteo por tipo y estado de TODOS
   * los trabajos. Sin esta opción la ruta responde 404 y el panel cuenta con lo que trae el listado.
   */
  resumen?: (vez: number) => { status: number; cuerpo?: unknown };
  /** `true` → el `fetch` del stream no resuelve hasta `liberarCabeceras()` (Next sin primer byte, D-2). */
  cabecerasStreamTarde?: boolean;
  /**
   * Respuesta de `GET /api/clientes` (T20a, D24: el panel resuelve el nombre del cliente de una descarga). Sin esta
   * opción la ruta responde 404 y el panel sigue funcionando sin el nombre.
   */
  clientes?: () => { status: number; cuerpo?: unknown };
}

/** `fetch` simulado del panel: sesión, permisos, listado y un stream SSE por conexión. */
export function instalarFetchPanel(opciones: OpcionesPanel): PanelFalso {
  const conexiones: ConexionStream[] = [];
  let listados = 0;
  let resumenes = 0;
  let intentosStream = 0;
  let liberar: () => void = () => undefined;
  const retenidas = new Promise<void>((r) => {
    liberar = r;
  });
  const codificador = new TextEncoder();

  const json = (status: number, cuerpo: unknown = {}) =>
    new Response(status === 204 ? null : JSON.stringify(cuerpo), {
      status,
      headers: { "content-type": "application/json" },
    });

  const falso = vi.fn(
    async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof entrada === "string"
          ? entrada
          : entrada instanceof URL
            ? entrada.pathname + entrada.search
            : entrada.url;
      const ruta = url.split("?")[0] ?? url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && ruta === "/api/auth/sesion") {
        return json(200, sesionDe({ id: "e-a", nombre: "Estudio Alfa" }));
      }
      if (method === "GET" && ruta === "/api/acceso/yo") {
        return json(
          200,
          yoDe("dueno", opciones.permisos ?? ["clientes.ver"]),
        );
      }
      if (method === "GET" && ruta === "/api/trabajos") {
        listados += 1;
        const r = opciones.listado(listados);
        return json(r.status, r.cuerpo);
      }
      if (method === "GET" && ruta === "/api/trabajos/resumen") {
        resumenes += 1;
        if (!opciones.resumen) return json(404, { codigo: "no_encontrado" });
        const r = opciones.resumen(resumenes);
        return json(r.status, r.cuerpo);
      }
      if (method === "GET" && ruta === "/api/clientes") {
        if (!opciones.clientes) return json(404, { codigo: "no_encontrado" });
        const r = opciones.clientes();
        return json(r.status, r.cuerpo);
      }
      if (method === "GET" && ruta === "/api/trabajos/stream") {
        intentosStream += 1;
        if (opciones.rechazarStream?.(intentosStream)) {
          throw new TypeError("fetch failed");
        }
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((valor, nombre) => {
          headers[nombre.toLowerCase()] = valor;
        });
        let controlador!: ReadableStreamDefaultController<Uint8Array>;
        const cuerpo = new ReadableStream<Uint8Array>({
          start(c) {
            controlador = c;
          },
        });
        let terminada = false;
        const terminar = (f: () => void) => {
          if (terminada) return;
          terminada = true;
          try {
            f();
          } catch {
            // El lector ya canceló el stream: nada que cerrar.
          }
        };
        init?.signal?.addEventListener("abort", () =>
          terminar(() =>
            controlador.error(new DOMException("aborted", "AbortError")),
          ),
        );
        conexiones.push({
          headers,
          signal: init?.signal,
          enviar: (texto) =>
            controlador.enqueue(codificador.encode(texto)),
          evento: (t) =>
            controlador.enqueue(codificador.encode(eventoSse(t))),
          cerrar: () => terminar(() => controlador.close()),
          fallar: () =>
            terminar(() => controlador.error(new TypeError("network error"))),
        });
        if (opciones.cabecerasStreamTarde) await retenidas;
        return new Response(cuerpo, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error(`ruta no simulada: ${method} ${ruta}`);
    },
  );
  vi.stubGlobal("fetch", falso);
  return {
    conexiones,
    listados: () => listados,
    resumenes: () => resumenes,
    liberarCabeceras: () => liberar(),
  };
}
