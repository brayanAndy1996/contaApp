// Soporte de las pruebas del worker con `SIRE_CLIENT=http` (spec 041, T4). No es código de producción ni una prueba.
//
// - ZIP mínimo (una entrada deflate) armado con `node:zlib`: el worker no depende de `fflate`.
// - Guion del servidor falso de `packages/sunat/src/http/pruebas/servidor-sire-falso.ts` (T3; el worker lo importa del `dist` de @contapp/sunat) para los cuatro pasos del SIRE:
//   token, exportar, estado del ticket y archivo. Las rutas se reconocen por su final, así que no fijan el prefijo de `urlsDePrueba`.
// - Reloj y `dormir` falsos: ninguna prueba duerme de verdad (041, «Reglas comunes»).
import { crc32, deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContappDb } from "@contapp/db";
import type { MundoVentas } from "./ventas.js";
import { guardarCredencial } from "./procesadores-007b.js";
import type { Escenario } from "./trabajos.js";
import { canario } from "./soporte.js";
import type {
  PeticionFalsa,
  RespuestaFalsa,
  ServidorSireFalso,
} from "@contapp/sunat/dist/http/pruebas/servidor-sire-falso.js";

export type { PeticionFalsa, RespuestaFalsa, ServidorSireFalso };

const AQUI = dirname(fileURLToPath(import.meta.url));
/** Fixtures sintéticos de T1 (`fixtures/sire/http`). */
export const DIR_FIXTURES_HTTP = resolve(AQUI, "../../../fixtures/sire/http");

export function leerFixture(nombre: string): Buffer {
  return readFileSync(resolve(DIR_FIXTURES_HTTP, nombre));
}

/** ZIP de una sola entrada (deflate). Sin cifrado, sin directorios, nombre plano. */
export function zipDe(nombreEntrada: string, contenido: Uint8Array): Buffer {
  const nombre = Buffer.from(nombreEntrada, "utf8");
  const datos = Buffer.from(contenido);
  const comprimido = deflateRawSync(datos);
  const crc = crc32(datos);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // versión mínima
  local.writeUInt16LE(0x0800, 6); // nombre en UTF-8
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comprimido.length, 18);
  local.writeUInt32LE(datos.length, 22);
  local.writeUInt16LE(nombre.length, 26);
  const parteLocal = Buffer.concat([local, nombre, comprimido]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comprimido.length, 20);
  central.writeUInt32LE(datos.length, 24);
  central.writeUInt16LE(nombre.length, 28);
  central.writeUInt32LE(0, 42); // desplazamiento de la entrada local
  const parteCentral = Buffer.concat([central, nombre]);

  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(1, 8);
  fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(parteCentral.length, 12);
  fin.writeUInt32LE(parteLocal.length, 16);
  return Buffer.concat([parteLocal, parteCentral, fin]);
}

/** Reloj controlado: `dormir` no espera; solo avanza el reloj y anota los milisegundos pedidos. */
export class RelojSire {
  private t = Date.now();
  readonly dormidos: number[] = [];
  readonly ahora = (): Date => new Date(this.t);
  readonly dormir = async (ms: number): Promise<void> => {
    this.dormidos.push(ms);
    this.t += ms;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Guion del servidor falso
// ---------------------------------------------------------------------------------------------------------------

const RUTA_TOKEN = /\/oauth2\/token\/$/;
const RUTA_EXPORTAR = /\/exportapropuesta$|\/exportacioncomprobantepropuesta$/;
const RUTA_TICKET = /\/consultaestadotickets$/;
const RUTA_ARCHIVO = /\/archivoreporte$/;
export const RUTAS_SIRE = {
  token: RUTA_TOKEN,
  exportar: RUTA_EXPORTAR,
  ticket: RUTA_TICKET,
  archivo: RUTA_ARCHIVO,
} as const;

/** Respuesta del servicio de token (`access_token`, `token_type`, `expires_in`). */
export const respuestaToken = (
  token: string,
  expiresIn = 3600,
): RespuestaFalsa => ({
  json: { access_token: token, token_type: "JWT", expires_in: expiresIn },
});

export const NOMBRE_ZIP = "reporte-propuesta-202610.zip";

/** Cuerpo de «consultar estado del ticket» con un único registro. */
export function registroTicket(
  numTicket: string,
  estado: string,
  periodo: string,
  opciones: { archivos?: Array<{ nom: string; cod: string | null }> } = {},
) {
  const archivos =
    estado === "06" || estado === "04"
      ? (opciones.archivos ?? [{ nom: NOMBRE_ZIP, cod: "01" }])
      : [];
  return {
    paginacion: { page: 1, perPage: 20, totalRegistros: 1 },
    registros: [
      {
        numTicket,
        codProceso: "10",
        desProceso: "Exportar propuesta",
        codEstadoProceso: estado,
        desEstadoProceso: estado === "06" ? "Terminado" : "En proceso",
        perTributario: periodo,
        archivoReporte: archivos.map((a) => ({
          nomArchivoReporte: a.nom,
          codTipoAchivoReporte: a.cod,
        })),
      },
    ],
  };
}

export interface OpcionesGuionSire {
  /** Un token por llamada al servicio de token, en orden (el último se repite). */
  tokens: string[];
  periodo: string;
  /** ZIP que entrega el archivo. */
  zip: Buffer;
  /** Números de ticket que devuelve el exportar, en orden. Por defecto `T1`, `T2`… */
  ticket?: () => string;
  /** Estado del ticket por consulta; por defecto `06` (listo). */
  estadoTicket?: (numTicket: string) => string;
  /** Si es true, el exportar responde 401 mientras el `Authorization` sea el de `tokens[0]`. */
  rechazarPrimerToken?: boolean;
}

/** Guiona los 4 pasos del SIRE para un solo libro. Devuelve contadores útiles para las aserciones. */
export function guionarSire(srv: ServidorSireFalso, o: OpcionesGuionSire) {
  let n = 0;
  const siguienteTicket = o.ticket ?? (() => `2026000000${String(++n).padStart(4, "0")}`);
  srv.guionar("POST", RUTA_TOKEN, ...o.tokens.map((t) => respuestaToken(t)));
  srv.guionar("GET", RUTA_EXPORTAR, (p) => {
    if (
      o.rechazarPrimerToken === true &&
      p.cabeceras["authorization"] === `Bearer ${o.tokens[0]}`
    )
      return { estado: 401, json: { cod: "401", msg: "Unauthorized" } };
    return { json: { numTicket: siguienteTicket() } };
  });
  srv.guionar("GET", RUTA_TICKET, (p) => ({
    json: registroTicket(
      p.query["numTicket"] ?? "",
      (o.estadoTicket ?? (() => "06"))(p.query["numTicket"] ?? ""),
      o.periodo,
    ),
  }));
  srv.guionar("GET", RUTA_ARCHIVO, () => ({ bytes: o.zip }));
}

// ---------------------------------------------------------------------------------------------------------------
// Escenario de datos
// ---------------------------------------------------------------------------------------------------------------

/**
 * Como `mundoVentas`, pero con un `client_id` que cumple la gramática `[A-Za-z0-9-]{1,64}` (el de `mundoVentas` lleva `_` y el
 * cliente HTTP lo rechaza antes de llamar). Los secretos siguen siendo canarios.
 */
export async function mundoSireHttp(
  e: Escenario,
  backend: ContappDb,
  o: { ruc?: string } = {},
): Promise<MundoVentas> {
  const T = await e.estudio();
  const u = await e.usuario(T, "contador");
  const c =
    o.ruc === undefined ? await e.cliente(T) : await e.cliente(T, o.ruc);
  await e.asignar(T, c.id, u);
  const secretos = {
    clave: canario("clave_sol"),
    clientSecret: canario("client_secret"),
    clientId: canario("clientid"),
    usuario: "USUARIOSOL",
  };
  await guardarCredencial(backend, T, c.id, "sol", {
    usuario: secretos.usuario,
    clave: secretos.clave,
  });
  await guardarCredencial(backend, T, c.id, "sire_api", {
    clientId: secretos.clientId,
    clientSecret: secretos.clientSecret,
  });
  return { T, u, c, secretos };
}
