// Acciones por API para preparar un flujo sin pasar por la UI que no se prueba (spec 018, D-4): cargar
// credenciales SOL/SIRE, lanzar la descarga de compras o ventas y esperar el trabajo, generar un archivo y
// bajar su ZIP. Habla con el backend con la sesión de `Sesion` (cookie, CSRF, `X-Estudio`, `Origin` y la IP de
// la sesión). Los trabajos se esperan con `expect.poll` y un tope de 30 s. Nada de esto registra secretos:
// los cuerpos de credenciales solo se envían, y las respuestas pasan por la vigilancia.
import { expect } from "@playwright/test";
import { URL_BACKEND, URL_FRONTEND } from "./pila/entorno.js";
import type { Sesion } from "./sesiones.js";
import type { Vigilancia } from "./vigilancia.js";

export type Libro = "compras" | "ventas";
export type Metodo = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Valores de fixture de las credenciales: son los canarios de la vigilancia (D-8). */
export const CREDENCIALES_FIXTURE = {
  usuario: "USUPRUEBA",
  clave: "CLAVEPRUEBA",
  clientId: "CIDPRUEBA",
  clientSecret: "CSECPRUEBA",
} as const;

export interface RespuestaApi<T = unknown> {
  readonly status: number;
  /** JSON ya leído, o `null` si el cuerpo no es JSON (ZIP, 204). */
  readonly cuerpo: T;
  readonly headers: Headers;
}

export interface TrabajoApi {
  readonly id: string;
  readonly tipo: string;
  readonly clienteId: string;
  readonly estado:
    "en_cola" | "ejecutando" | "completado" | "error" | "cancelado";
  readonly motivo: string | null;
  /** Cuándo pasó a `ejecutando` (null si nunca salió de la cola). */
  readonly iniciadoEn: string | null;
}

export interface PrevioApi {
  readonly apto: boolean;
  readonly generable: boolean;
  readonly motivo: string | null;
  readonly errores: readonly { filaId: string | null; codigo: string }[];
  readonly estado: { estado: "abierto" | "revisado" | "generado" };
  readonly huella: string;
}

export interface VersionApi {
  readonly id: string;
  readonly version: number;
  readonly nombreZip: string;
  readonly sha256Txt: string;
  readonly sha256Zip: string;
  readonly lineas: number;
}

const TOPE_TRABAJO_MS = 30_000;
const SONDEO_MS = [100, 250, 500, 1_000];

export class Api {
  constructor(
    readonly sesion: Sesion,
    private readonly vigilancia?: Vigilancia,
  ) {}

  /** Una petición JSON con la sesión. `cuerpo` se envía como JSON; no lanza por un estado de error. */
  async pedir<T = unknown>(
    metodo: Metodo,
    ruta: string,
    cuerpo?: unknown,
  ): Promise<RespuestaApi<T>> {
    const r = await fetch(`${URL_BACKEND}${ruta}`, {
      method: metodo,
      headers: {
        Cookie: this.sesion.cookie,
        "X-Estudio": this.sesion.tenantId,
        "X-Forwarded-For": this.sesion.ip,
        ...(metodo === "GET"
          ? {}
          : { "X-CSRF-Token": this.sesion.csrf, Origin: URL_FRONTEND }),
        ...(cuerpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
    });
    const texto = await r.text();
    this.vigilancia?.revisarTexto(`la respuesta ${metodo} ${ruta}`, texto);
    let json: unknown = null;
    try {
      json = texto === "" ? null : JSON.parse(texto);
    } catch {
      json = null;
    }
    return { status: r.status, cuerpo: json as T, headers: r.headers };
  }

  /** Igual que `pedir`, pero exige 2xx (el mensaje nombra la ruta y el estado, no el cuerpo). */
  async exigir<T = unknown>(
    metodo: Metodo,
    ruta: string,
    cuerpo?: unknown,
  ): Promise<T> {
    const r = await this.pedir<T>(metodo, ruta, cuerpo);
    if (r.status < 200 || r.status > 299) {
      throw new Error(`${metodo} ${ruta} respondió ${r.status}.`);
    }
    return r.cuerpo;
  }

  /** Guarda las dos credenciales del cliente (SOL y API SIRE) con los valores de fixture o los dados. */
  async cargarCredenciales(
    clienteId: string,
    valores: Partial<typeof CREDENCIALES_FIXTURE> = {},
  ): Promise<void> {
    const v = { ...CREDENCIALES_FIXTURE, ...valores };
    await this.exigir("PUT", `/clientes/${clienteId}/credenciales/sol`, {
      usuario: v.usuario,
      clave: v.clave,
    });
    await this.exigir("PUT", `/clientes/${clienteId}/credenciales/sire_api`, {
      clientId: v.clientId,
      clientSecret: v.clientSecret,
    });
  }

  /** Estado de una credencial del cliente (`no_configurada`, `configurada`, `verificada`, `invalida`…). */
  async estadoCredencial(
    clienteId: string,
    tipo: "sol" | "sire_api",
  ): Promise<string> {
    const lista = await this.exigir<{ tipo: string; estado: string }[]>(
      "GET",
      `/clientes/${clienteId}/credenciales`,
    );
    return lista.find((c) => c.tipo === tipo)?.estado ?? "no_configurada";
  }

  /** Lanza la descarga del SIRE del periodo y devuelve el id del trabajo (202). */
  async iniciarDescarga(
    clienteId: string,
    periodo: string,
    libro: Libro = "compras",
  ): Promise<string> {
    const r = await this.exigir<{ trabajoId: string }>(
      "POST",
      `/clientes/${clienteId}/periodos/${periodo}/${libro}/descargar`,
    );
    return r.trabajoId;
  }

  /** Espera (hasta 30 s) a que el trabajo termine y devuelve su vista final, sea cual sea. */
  async esperarTrabajo(
    clienteId: string,
    trabajoId: string,
  ): Promise<TrabajoApi> {
    let final: TrabajoApi | undefined;
    await expect
      .poll(
        async () => {
          const lista = await this.exigir<TrabajoApi[]>(
            "GET",
            `/trabajos?clienteId=${clienteId}`,
          );
          const t = lista.find((x) => x.id === trabajoId);
          if (
            t !== undefined &&
            ["completado", "error", "cancelado"].includes(t.estado)
          ) {
            final = t;
            return true;
          }
          return false;
        },
        {
          message: "El trabajo no terminó a tiempo",
          timeout: TOPE_TRABAJO_MS,
          intervals: SONDEO_MS,
        },
      )
      .toBe(true);
    if (final === undefined) throw new Error("Trabajo sin estado final.");
    return final;
  }

  /** Descarga el periodo y espera el trabajo. Lanza si no termina en `completado`. */
  async descargar(
    clienteId: string,
    periodo: string,
    libro: Libro = "compras",
  ): Promise<TrabajoApi> {
    const id = await this.iniciarDescarga(clienteId, periodo, libro);
    const t = await this.esperarTrabajo(clienteId, id);
    if (t.estado !== "completado") {
      throw new Error(
        `La descarga de ${libro} terminó en ${t.estado} (${t.motivo ?? "sin motivo"}).`,
      );
    }
    return t;
  }

  /** El previo del archivo (prevalidación, estado y huella). */
  previoArchivo(
    clienteId: string,
    periodo: string,
    libro: Libro = "compras",
  ): Promise<PrevioApi> {
    return this.exigir<PrevioApi>(
      "GET",
      `/clientes/${clienteId}/periodos/${periodo}/${libro}/archivos/previo`,
    );
  }

  /** Versiones ya generadas del archivo, de la más nueva a la más vieja según el servidor. */
  versionesArchivo(
    clienteId: string,
    periodo: string,
    libro: Libro = "compras",
  ): Promise<VersionApi[]> {
    return this.exigir<VersionApi[]>(
      "GET",
      `/clientes/${clienteId}/periodos/${periodo}/${libro}/archivos`,
    );
  }

  /**
   * Genera el archivo con el previo actual, sigue el trabajo y devuelve la versión nueva. Lanza si el previo
   * no es generable.
   */
  async generarArchivo(
    clienteId: string,
    periodo: string,
    libro: Libro = "compras",
  ): Promise<VersionApi> {
    const previo = await this.previoArchivo(clienteId, periodo, libro);
    if (!previo.generable) {
      throw new Error(
        `El archivo no es generable (${previo.motivo ?? "sin motivo"}).`,
      );
    }
    const antes = (await this.versionesArchivo(clienteId, periodo, libro))
      .length;
    const r = await this.exigir<{ trabajoId: string }>(
      "POST",
      `/clientes/${clienteId}/periodos/${periodo}/${libro}/archivos`,
      { estadoVisto: previo.estado.estado, huella: previo.huella },
    );
    const trabajo = await this.esperarTrabajo(clienteId, r.trabajoId);
    if (trabajo.estado !== "completado") {
      throw new Error(
        `La generación terminó en ${trabajo.estado} (${trabajo.motivo ?? "sin motivo"}).`,
      );
    }
    const despues = await this.versionesArchivo(clienteId, periodo, libro);
    expect(despues.length).toBe(antes + 1);
    const nueva = [...despues].sort((a, b) => b.version - a.version)[0];
    if (nueva === undefined) throw new Error("No hay versión generada.");
    return nueva;
  }

  /** Bytes del ZIP de una versión (para calcular su SHA-256 en la prueba). */
  async descargarZip(
    clienteId: string,
    periodo: string,
    archivoId: string,
    libro: Libro = "compras",
  ): Promise<Buffer> {
    const r = await fetch(
      `${URL_BACKEND}/clientes/${clienteId}/periodos/${periodo}/${libro}/archivos/${archivoId}/zip`,
      {
        headers: {
          Cookie: this.sesion.cookie,
          "X-Estudio": this.sesion.tenantId,
          "X-Forwarded-For": this.sesion.ip,
        },
      },
    );
    if (r.status !== 200) throw new Error(`El ZIP respondió ${r.status}.`);
    return Buffer.from(await r.arrayBuffer());
  }
}
