/**
 * Servidor SUNAT FALSO para las pruebas del SIRE real (spec 041). Solo pruebas: nunca se importa desde producción.
 * `node:http` en 127.0.0.1 (puerto efímero); no sale a internet ni duerme. API ESTABLE: la reutilizan T3 y T4.
 *
 * ── Arranque ─────────────────────────────────────────────────────────────────────────────────────────────────
 *   const srv = await iniciarServidorSireFalso();        // escucha en 127.0.0.1:0
 *   srv.origen                                           // "http://127.0.0.1:PUERTO" (sin barra final)
 *   const urlsDePrueba = { seguridad: srv.origen, sire: srv.origen };  // para `new HttpSireAuth({ urlsDePrueba })`
 *   await srv.cerrar();                                  // en `afterEach`/`afterAll`; corta lo que siga colgado
 *
 *   Un solo servidor atiende ambos «hosts» (se distinguen por ruta). Para probar que un secreto o el token solo viaja
 *   a SU host, levanta DOS servidores (`seguridad` y `sire`) y revisa el log de cada uno.
 *
 * ── Guion por ruta ───────────────────────────────────────────────────────────────────────────────────────────
 *   srv.guionar(metodo, ruta, ...respuestas);
 *     metodo     "GET" | "POST" (mayúsculas).
 *     ruta       `string` = ruta EXACTA sin query (la barra final cuenta: el token es ".../oauth2/token/"), o `RegExp`
 *                contra la ruta sin query. Guion repetido para la misma (metodo, ruta) REEMPLAZA al anterior.
 *     respuestas una o más; se consumen EN ORDEN, una por petición, y la ÚLTIMA se repite para siempre.
 *                Cada una es un objeto `RespuestaFalsa` o una función `(peticion) => RespuestaFalsa | Promise<…>`.
 *
 *   interface RespuestaFalsa {
 *     estado?: number;                     // HTTP; por defecto 200
 *     json?: unknown;                      // cuerpo JSON (+ `content-type: application/json`)
 *     texto?: string;                      // cuerpo de texto (utf-8)
 *     bytes?: Uint8Array;                  // cuerpo binario (p. ej. un ZIP) (+ `content-type: application/octet-stream`)
 *     cabeceras?: Record<string, string>;  // cabeceras extra; con 3xx, p. ej. { location: otro.origen + "/x" }
 *     hasta?: Promise<void>;               // retiene la respuesta hasta que la promesa se cumpla (sin dormir)
 *     colgar?: true;                       // nunca responde; `cerrar()` destruye el socket
 *     cortar?: true;                       // destruye el socket sin responder (ECONNRESET en el cliente)
 *     sinContentLength?: true;             // cuerpo en trozos (chunked), sin `content-length`
 *     trozosBytes?: number;                // envía el cuerpo en trozos de ese tamaño (con `sinContentLength`)
 *     repetirBytes?: { byte: number; total: number };  // cuerpo de `total` bytes iguales generado al vuelo (sin memoria)
 *   }
 *   Cuerpo: si hay más de uno de `json`/`texto`/`bytes`/`repetirBytes`, gana el primero en ese orden.
 *   Una petición SIN guion recibe 501 `{"error":"sin_guion"}` y queda en `srv.sinGuion` (además de en `peticiones`).
 *
 * ── Log de peticiones ────────────────────────────────────────────────────────────────────────────────────────
 *   srv.peticiones                       // PeticionFalsa[] en orden de llegada (incluye las sin guion)
 *   srv.peticionesDe(metodo, ruta)       // las de esa (metodo, ruta exacta o RegExp)
 *   srv.sinGuion                         // las que no tenían guion
 *   srv.reiniciar()                      // vacía el log y los guiones (el servidor sigue escuchando)
 *
 *   interface PeticionFalsa {
 *     n: number;                         // 1, 2, 3… en orden de llegada
 *     metodo: string;                    // "GET" | "POST" | …
 *     ruta: string;                      // sin query, tal como llegó (con barra final si la trae)
 *     query: Record<string, string>;     // parámetros de la query (el último gana si se repite)
 *     queryCruda: string;                // query sin "?"
 *     cabeceras: Record<string, string>; // nombres en minúsculas
 *     cuerpo: string;                    // cuerpo crudo en utf-8 (tope 1 MiB)
 *     formulario: Record<string, string> | null;  // si es `application/x-www-form-urlencoded`: pares decodificados
 *   }
 *   El log guarda lo que el cliente ENVIÓ (incluido `authorization` y el formulario del token): úsalo solo con
 *   canarios sintéticos y nunca lo imprimas.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RespuestaFalsa {
  estado?: number;
  json?: unknown;
  texto?: string;
  bytes?: Uint8Array;
  cabeceras?: Record<string, string>;
  hasta?: Promise<void>;
  colgar?: true;
  cortar?: true;
  sinContentLength?: true;
  trozosBytes?: number;
  repetirBytes?: { byte: number; total: number };
}

export interface PeticionFalsa {
  n: number;
  metodo: string;
  ruta: string;
  query: Record<string, string>;
  queryCruda: string;
  cabeceras: Record<string, string>;
  cuerpo: string;
  formulario: Record<string, string> | null;
}

export type GuionRespuesta =
  | RespuestaFalsa
  | ((peticion: PeticionFalsa) => RespuestaFalsa | Promise<RespuestaFalsa>);

export type RutaFalsa = string | RegExp;

export interface ServidorSireFalso {
  readonly origen: string;
  readonly peticiones: readonly PeticionFalsa[];
  readonly sinGuion: readonly PeticionFalsa[];
  guionar(metodo: string, ruta: RutaFalsa, ...respuestas: GuionRespuesta[]): void;
  peticionesDe(metodo: string, ruta: RutaFalsa): PeticionFalsa[];
  reiniciar(): void;
  cerrar(): Promise<void>;
}

const TOPE_CUERPO_REGISTRADO = 1_048_576;

interface Guion {
  metodo: string;
  ruta: RutaFalsa;
  respuestas: GuionRespuesta[];
  usadas: number;
}

function mismaRuta(a: RutaFalsa, b: RutaFalsa): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.source === b.source && a.flags === b.flags;
}

function coincide(ruta: RutaFalsa, real: string): boolean {
  if (typeof ruta === "string") return ruta === real;
  // Sin estado (`lastIndex`) aunque la expresión traiga la bandera `g` o `y`.
  return new RegExp(ruta.source, ruta.flags.replace(/[gy]/g, "")).test(real);
}

async function leerCuerpo(req: IncomingMessage): Promise<string> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of req) {
    const b = Buffer.isBuffer(trozo) ? trozo : Buffer.from(trozo as string);
    if (total < TOPE_CUERPO_REGISTRADO) trozos.push(b);
    total += b.length;
  }
  return Buffer.concat(trozos).subarray(0, TOPE_CUERPO_REGISTRADO).toString("utf8");
}

function aRegistro(n: number, req: IncomingMessage, cuerpo: string): PeticionFalsa {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cabeceras: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) cabeceras[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  const esForm = (cabeceras["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  const formulario = esForm ? Object.fromEntries(new URLSearchParams(cuerpo)) : null;
  return {
    n,
    metodo: (req.method ?? "GET").toUpperCase(),
    ruta: url.pathname,
    query: Object.fromEntries(url.searchParams),
    queryCruda: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    cabeceras,
    cuerpo,
    formulario,
  };
}

function esperar(sock: Socket | null, res: ServerResponse): boolean {
  return sock !== null && !sock.destroyed && !res.destroyed;
}

async function escribir(res: ServerResponse, r: RespuestaFalsa): Promise<void> {
  const cabeceras: Record<string, string> = { ...(r.cabeceras ?? {}) };
  let cuerpo: Uint8Array | null = null;
  if (r.json !== undefined) {
    cuerpo = Buffer.from(JSON.stringify(r.json), "utf8");
    cabeceras["content-type"] ??= "application/json";
  } else if (r.texto !== undefined) {
    cuerpo = Buffer.from(r.texto, "utf8");
    cabeceras["content-type"] ??= "text/plain; charset=utf-8";
  } else if (r.bytes !== undefined) {
    cuerpo = r.bytes;
    cabeceras["content-type"] ??= "application/octet-stream";
  } else if (r.repetirBytes !== undefined) {
    cabeceras["content-type"] ??= "application/octet-stream";
  }
  const estado = r.estado ?? 200;

  if (r.repetirBytes !== undefined) {
    const { byte, total } = r.repetirBytes;
    const trozo = Buffer.alloc(Math.min(total, 65_536), byte);
    if (r.sinContentLength !== true) cabeceras["content-length"] = String(total);
    res.writeHead(estado, cabeceras);
    let restante = total;
    while (restante > 0 && !res.destroyed) {
      const n = Math.min(restante, trozo.length);
      const ok = res.write(n === trozo.length ? trozo : trozo.subarray(0, n));
      restante -= n;
      if (!ok) await new Promise<void>((fin) => res.once("drain", fin).once("close", fin));
    }
    res.end();
    return;
  }

  if (cuerpo !== null && r.sinContentLength !== true) cabeceras["content-length"] = String(cuerpo.length);
  res.writeHead(estado, cabeceras);
  if (cuerpo === null) {
    res.end();
    return;
  }
  if (r.sinContentLength === true && r.trozosBytes !== undefined && r.trozosBytes > 0) {
    for (let i = 0; i < cuerpo.length && !res.destroyed; i += r.trozosBytes) {
      const ok = res.write(cuerpo.subarray(i, i + r.trozosBytes));
      if (!ok) await new Promise<void>((fin) => res.once("drain", fin).once("close", fin));
    }
    res.end();
    return;
  }
  res.end(cuerpo);
}

export async function iniciarServidorSireFalso(): Promise<ServidorSireFalso> {
  const peticiones: PeticionFalsa[] = [];
  const sinGuion: PeticionFalsa[] = [];
  let guiones: Guion[] = [];
  const sockets = new Set<Socket>();

  const servidor: Server = createServer((req, res) => {
    void (async () => {
      const cuerpo = await leerCuerpo(req);
      const peticion = aRegistro(peticiones.length + 1, req, cuerpo);
      peticiones.push(peticion);

      const guion = guiones.find((g) => g.metodo === peticion.metodo && coincide(g.ruta, peticion.ruta));
      if (guion === undefined) {
        sinGuion.push(peticion);
        await escribir(res, { estado: 501, json: { error: "sin_guion" } });
        return;
      }
      const indice = Math.min(guion.usadas, guion.respuestas.length - 1);
      guion.usadas += 1;
      const elegida = guion.respuestas[indice]!;
      const respuesta = typeof elegida === "function" ? await elegida(peticion) : elegida;

      if (respuesta.cortar === true) {
        req.socket.destroy();
        return;
      }
      if (respuesta.colgar === true) return; // `cerrar()` destruye el socket
      if (respuesta.hasta !== undefined) await respuesta.hasta;
      if (!esperar(req.socket, res)) return;
      await escribir(res, respuesta);
    })().catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
  servidor.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(0, "127.0.0.1", () => resolver());
  });
  const { port } = servidor.address() as AddressInfo;

  return {
    origen: `http://127.0.0.1:${port}`,
    peticiones,
    sinGuion,
    guionar(metodo, ruta, ...respuestas) {
      if (respuestas.length === 0) throw new Error("guionar: falta al menos una respuesta");
      const m = metodo.toUpperCase();
      guiones = guiones.filter((g) => !(g.metodo === m && mismaRuta(g.ruta, ruta)));
      guiones.push({ metodo: m, ruta, respuestas, usadas: 0 });
    },
    peticionesDe(metodo, ruta) {
      const m = metodo.toUpperCase();
      return peticiones.filter((p) => p.metodo === m && coincide(ruta, p.ruta));
    },
    reiniciar() {
      peticiones.length = 0;
      sinGuion.length = 0;
      guiones = [];
    },
    async cerrar() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolver) => servidor.close(() => resolver()));
    },
  };
}
