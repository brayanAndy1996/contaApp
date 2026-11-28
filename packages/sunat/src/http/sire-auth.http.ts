/**
 * `HttpSireAuth` (plan 041): token OAuth del SIRE con el flujo `password`. Sin caché (la caché es de 008) y sin logger:
 * los secretos solo viajan en el cuerpo del formulario y los errores llevan mensaje fijo (CA-2, CA-12).
 */
import { z } from "zod";
import { ErrorCredencial, ErrorPortalSire } from "../errores.js";
import type { CredencialSire, SireAuth, TokenSire } from "../puertos.js";
import type { AlmacenTicketsSire } from "./almacen-tickets.js";
import {
  GRAMATICA_CLIENT_ID,
  MAX_BYTES_JSON,
  ORIGEN_SEGURIDAD,
  ORIGEN_SIRE,
  SCOPE_SIRE,
  TIMEOUT_TOKEN_MS,
  armarUrl,
  origenDe,
  rutaToken,
} from "./endpoints.js";
import { pedir } from "./transporte.js";

export interface OpcionesHttpSire {
  fetch?: typeof fetch;
  ahora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
  /** Sin él, un ticket que no termina obliga a exportar de nuevo en el siguiente intento (P-4 a). */
  almacenTickets?: AlmacenTicketsSire;
  /** Solo pruebas y solo por constructor (nunca desde el entorno): reemplaza el ORIGEN de cada host. */
  urlsDePrueba?: { seguridad: string; sire: string };
}

/** Orígenes efectivos: los reales salvo `urlsDePrueba`. */
export function origenes(o: OpcionesHttpSire): { seguridad: string; sire: string } {
  if (o.urlsDePrueba === undefined) return { seguridad: ORIGEN_SEGURIDAD, sire: ORIGEN_SIRE };
  return { seguridad: origenDe(o.urlsDePrueba.seguridad), sire: origenDe(o.urlsDePrueba.sire) };
}

/** Texto JSON → valor; lo que no es JSON es un cambio del portal. */
export function parsearJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ErrorPortalSire("respuesta_inesperada");
  }
}

/**
 * Tope de `expires_in` (H-041-1-2): SUNAT emite tokens de 1 h; más de 24 h no es un token del SIRE y un valor enorme
 * (`1e13`) daría `Invalid Date`. Fuera de 1..86400 segundos enteros → `ErrorPortalSire` (CA-2 «expires_in inválido»).
 */
const MAX_EXPIRES_IN_S = 86_400;

const esquemaToken = z.object({
  // Va luego en la cabecera Authorization: solo ASCII visible.
  access_token: z.string().regex(/^[\x21-\x7E]+$/),
  // `z.number()` ya rechaza NaN; `.int()` rechaza Infinity y no enteros; cadenas y null no son número.
  expires_in: z.number().int().min(1).max(MAX_EXPIRES_IN_S),
});

export class HttpSireAuth implements SireAuth {
  private readonly fetch: typeof fetch | undefined;
  private readonly ahora: () => Date;
  private readonly origen: string;

  constructor(o: OpcionesHttpSire = {}) {
    this.fetch = o.fetch;
    this.ahora = o.ahora ?? (() => new Date());
    this.origen = origenes(o).seguridad;
  }

  async obtenerToken(credencial: CredencialSire): Promise<TokenSire> {
    if (!GRAMATICA_CLIENT_ID.test(credencial.clientId)) throw new ErrorCredencial();
    const formulario = new URLSearchParams({
      grant_type: "password",
      scope: SCOPE_SIRE,
      client_id: credencial.clientId,
      client_secret: credencial.clientSecret,
      username: `${credencial.ruc}${credencial.usuarioSol}`,
      password: credencial.claveSol,
    });
    const r = await pedir({
      url: armarUrl(this.origen, rutaToken(credencial.clientId)),
      metodo: "POST",
      cabeceras: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      cuerpo: formulario.toString(),
      contexto: "token",
      timeoutMs: TIMEOUT_TOKEN_MS,
      maxBytes: MAX_BYTES_JSON,
      ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
    });
    const t = esquemaToken.safeParse(parsearJson(r.cuerpo));
    if (!t.success) throw new ErrorPortalSire("respuesta_inesperada");
    const expiraEn = new Date(this.ahora().getTime() + t.data.expires_in * 1000);
    if (Number.isNaN(expiraEn.getTime())) throw new ErrorPortalSire("respuesta_inesperada");
    return { token: t.data.access_token, expiraEn };
  }
}
