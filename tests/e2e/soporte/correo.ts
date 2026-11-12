// Correo de la E2E (spec 018, D-5): lee el último mensaje para un destinatario y devuelve su enlace.
// Con `E2E_CORREO=mailpit` consulta la API HTTP de Mailpit; con `consola` lee el `backend.log` de la pila
// (bloques `[correo:consola]` / `para:` / `asunto:` / texto de `CorreoConsola`). Espera hasta 30 s.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { leerConfig, type ModoCorreo } from "./pila/entorno.js";

export interface MensajeLeido {
  readonly para: string;
  readonly asunto: string;
  readonly texto: string;
}

const TOPE_MS = 30_000;
const SONDEO_MS = [100, 250, 500, 1_000];

function coincideAsunto(asunto: string, patron: string | RegExp): boolean {
  return typeof patron === "string"
    ? asunto.includes(patron)
    : patron.test(asunto);
}

/** Primer `http(s)://…` del texto, sin la puntuación final. */
export function primerEnlace(texto: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/.exec(texto);
  return m === null ? null : m[0].replace(/[).,;]+$/, "");
}

/** Mensajes de `backend.log`, en el orden en que se escribieron. */
export function mensajesDeConsola(log: string): MensajeLeido[] {
  const salida: MensajeLeido[] = [];
  const partes = log.split("[correo:consola]\n");
  for (const parte of partes.slice(1)) {
    const m = /^para: (.*)\nasunto: (.*)\n\n([\s\S]*)$/.exec(parte);
    if (m === null) continue;
    // El texto termina donde empieza la siguiente línea de log de Nest (o el fin del bloque).
    const texto = (m[3] ?? "").split(/\n\n(?=\[|\u001b)/)[0] ?? "";
    salida.push({ para: m[1] ?? "", asunto: m[2] ?? "", texto });
  }
  return salida;
}

async function desdeConsola(destinatario: string): Promise<MensajeLeido[]> {
  const dir = process.env.E2E_PILA_DIR;
  if (dir === undefined)
    throw new Error("No hay pila E2E en marcha (falta E2E_PILA_DIR).");
  let log = "";
  try {
    log = await readFile(join(dir, "backend.log"), "utf8");
  } catch {
    return [];
  }
  const buscado = destinatario.toLowerCase();
  return mensajesDeConsola(log).filter((m) => m.para.toLowerCase() === buscado);
}

async function desdeMailpit(
  destinatario: string,
  puerto: number,
): Promise<MensajeLeido[]> {
  const base = `http://localhost:${puerto}/api/v1`;
  const consulta = encodeURIComponent(`to:"${destinatario}"`);
  const lista = await fetch(`${base}/search?query=${consulta}`);
  if (!lista.ok) return [];
  const { messages = [] } = (await lista.json()) as {
    messages?: { ID: string; Subject: string }[];
  };
  const salida: MensajeLeido[] = [];
  // Mailpit lista del más nuevo al más viejo; se devuelve en orden de llegada.
  for (const resumen of [...messages].reverse()) {
    const detalle = await fetch(`${base}/message/${resumen.ID}`);
    if (!detalle.ok) continue;
    const { Text = "" } = (await detalle.json()) as { Text?: string };
    salida.push({ para: destinatario, asunto: resumen.Subject, texto: Text });
  }
  return salida;
}

export class Correo {
  constructor(
    private readonly modo: ModoCorreo = leerConfig().modoCorreo,
    private readonly puertoMailpit: number = leerConfig().mailpitUiPort,
  ) {}

  private leer(destinatario: string): Promise<MensajeLeido[]> {
    return this.modo === "consola"
      ? desdeConsola(destinatario)
      : desdeMailpit(destinatario, this.puertoMailpit);
  }

  /** El último mensaje para `destinatario` cuyo asunto coincide; espera hasta 30 s. */
  async ultimo(
    destinatario: string,
    asunto: string | RegExp,
  ): Promise<MensajeLeido> {
    let hallado: MensajeLeido | undefined;
    await expect
      .poll(
        async () => {
          const todos = await this.leer(destinatario);
          hallado = todos
            .filter((m) => coincideAsunto(m.asunto, asunto))
            .at(-1);
          return hallado !== undefined;
        },
        {
          message: `No llegó un correo para el destinatario con el asunto esperado`,
          timeout: TOPE_MS,
          intervals: SONDEO_MS,
        },
      )
      .toBe(true);
    if (hallado === undefined) throw new Error("Correo no encontrado.");
    return hallado;
  }

  /** El enlace del último correo para `destinatario` con ese asunto (registro, invitación, recuperación). */
  async enlaceDe(
    destinatario: string,
    asunto: string | RegExp,
  ): Promise<string> {
    const mensaje = await this.ultimo(destinatario, asunto);
    const enlace = primerEnlace(mensaje.texto);
    if (enlace === null) throw new Error("El correo no trae ningún enlace.");
    return enlace;
  }

  /** Cuántos correos hay para `destinatario` con ese asunto (para comprobar que no se mandó otro). */
  async cuantos(
    destinatario: string,
    asunto: string | RegExp,
  ): Promise<number> {
    const todos = await this.leer(destinatario);
    return todos.filter((m) => coincideAsunto(m.asunto, asunto)).length;
  }
}
