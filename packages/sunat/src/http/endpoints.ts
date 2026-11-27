/**
 * URLs, parámetros y topes fijos del SIRE (plan 041, «Endpoints» y P-8). Los hosts NO se leen del entorno: una variable
 * mal puesta mandaría el token a otro host. Las pruebas cambian solo el origen con `urlsDePrueba` (constructor).
 */
import type { LibroSire } from "../puertos.js";

export const ORIGEN_SEGURIDAD = "https://api-seguridad.sunat.gob.pe";
export const ORIGEN_SIRE = "https://api-sire.sunat.gob.pe";
/** Únicos hosts reales con los que habla el adaptador. */
export const HOSTS_PERMITIDOS: readonly string[] = ["api-seguridad.sunat.gob.pe", "api-sire.sunat.gob.pe"];

export const SCOPE_SIRE = "https://api-sire.sunat.gob.pe";
const BASE_LIBROS = "/v1/contribuyente/migeigv/libros";

/** `client_id` antes de ir a la ruta del token. */
export const GRAMATICA_CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Periodo AAAAMM con mes 01–12. */
export const GRAMATICA_PERIODO = /^\d{4}(0[1-9]|1[0-2])$/;
export const GRAMATICA_RUC = /^\d{11}$/;

export function rutaToken(clientId: string): string {
  return `/v1/clientessol/${clientId}/oauth2/token/`;
}

export function rutaExportar(libro: LibroSire, periodo: string): string {
  return libro === "compras"
    ? `${BASE_LIBROS}/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta`
    : `${BASE_LIBROS}/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta`;
}

export const PARAMETROS_EXPORTAR: Readonly<Record<LibroSire, Readonly<Record<string, string>>>> = {
  compras: { codTipoArchivo: "0", codOrigenEnvio: "2" },
  ventas: { codTipoArchivo: "0" },
};

export const RUTA_TICKET = `${BASE_LIBROS}/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`;
export const RUTA_ARCHIVO = `${BASE_LIBROS}/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`;

export const COD_LIBRO: Readonly<Record<LibroSire, string>> = { compras: "080000", ventas: "140000" };

// ── Presupuestos y topes (P-8, CA-10) ───────────────────────────────────────────────────────────────────────
export const TIMEOUT_TOKEN_MS = 10_000;
export const TIMEOUT_API_MS = 10_000;
export const TIMEOUT_DESCARGA_MS = 60_000;
export const PRESUPUESTO_OPERACION_MS = 90_000;
/** Tope de toda respuesta JSON. */
export const MAX_BYTES_JSON = 1_048_576;
/** Tope del ZIP comprimido (CA-10). */
export const MAX_BYTES_ZIP = 32 * 1_048_576;
/** Vida del ticket pendiente guardado para retomarlo (P-4 c). */
export const TTL_TICKET_MS = 3_600_000;

/** Origen (esquema + host + puerto) de una URL de prueba; descarta ruta, query y credenciales. */
export function origenDe(url: string): string {
  return new URL(url).origin;
}

/** URL completa con los parámetros codificados por `URLSearchParams`. */
export function armarUrl(origen: string, ruta: string, parametros?: Readonly<Record<string, string>>): string {
  if (parametros === undefined) return `${origen}${ruta}`;
  return `${origen}${ruta}?${new URLSearchParams(parametros).toString()}`;
}
