import type { PrevioArchivoDto, VersionArchivoDto } from "@contapp/shared";
import { MENSAJES_ARCHIVO } from "../lib/archivos";
import { rutaSesion } from "./acceso";
import { trabajoDe } from "./credenciales";
import { instalarFetchFalso, type FetchFalso, type Manejador } from "./soporte";

// Soporte de las pruebas del panel «Generar archivo» (spec 012b, T14): un previo y una versión de ejemplo, el
// trabajo `archivo.generar` y un `fetch` simulado del contrato del plan (el backend aún no existe). Los textos
// visibles salen de `MENSAJES_ARCHIVO`. Solo datos de prueba; los montos son SIEMPRE cadenas.

export { MENSAJES_ARCHIVO };

export const CLIENTE_ID = "c-1";
export const PERIODO = "202610";
export const BASE = `/api/clientes/${CLIENTE_ID}/periodos/${PERIODO}/compras/archivos`;

export const HUELLA_1 = "a".repeat(64);
export const HUELLA_2 = "b".repeat(64);
export const FILA_ID = "00000000-0000-4000-8000-000000002056";
export const ARCHIVO_ID = "00000000-0000-4000-8000-0000000000f1";
export const USUARIO_ID = "00000000-0000-4000-8000-0000000000a1";
export const TEXTO_HOSTIL = `<img src=x onerror=alert(1)>`;

export function previoDe(parcial: Partial<PrevioArchivoDto> = {}): PrevioArchivoDto {
  return {
    apto: true,
    generable: true,
    motivo: null,
    errores: [],
    erroresOmitidos: 0,
    avisos: [],
    resumen: {
      modificadas: 2,
      excluidas: 1,
      agregadas: 0,
      impactoIgv: { DG: "1234.50", DGNG: "0.00", DNG: null, total: "1234.50" },
      filasSinConvertir: [],
    },
    excluidas: [],
    excluidasOmitidas: 0,
    formato: { id: "rce-8.3", version: "1", oficial: true },
    estado: { estado: "abierto", por: null, en: null },
    huella: HUELLA_1,
    ultimaVersion: null,
    reabiertoTrasUltima: false,
    ...parcial,
  };
}

/** CA-1: la compra mixta 21.48 / 1.61 no cuadra con 18 % ni 10 %. */
export function previoConErrorDe(parcial: Partial<PrevioArchivoDto> = {}): PrevioArchivoDto {
  return previoDe({
    apto: false,
    generable: false,
    motivo: "prevalidacion_fallida",
    errores: [
      {
        filaId: FILA_ID,
        codigo: "IGV",
        campo: "igvDg",
        destino: "DG",
        explicacion: "El IGV 1.61 no corresponde al 18 % ni al 10 % de la base 21.48.",
        diferencia: "-2.26",
        excluible: false,
      },
    ],
    ...parcial,
  });
}

export function versionDe(n: number, parcial: Partial<VersionArchivoDto> = {}): VersionArchivoDto {
  return {
    id: n === 1 ? ARCHIVO_ID : `00000000-0000-4000-8000-0000000000f${n}`,
    version: n,
    generadoEn: "2026-11-05T15:30:00.000Z",
    generadoPor: USUARIO_ID,
    formato: { id: "rce-8.3", version: "1" },
    provisional: false,
    nombreZip: "LE20700000002202610080400021112.zip",
    sha256Txt: "c".repeat(64),
    sha256Zip: "d".repeat(64),
    bytesZip: 2048,
    lineas: 5,
    resumen: previoDe().resumen,
    avisos: {},
    ...parcial,
  };
}

export function trabajoArchivo(
  n: number,
  estado: "en_cola" | "ejecutando" | "completado" | "error" | "cancelado",
  posicion = 1,
) {
  const terminal = ["completado", "error", "cancelado"].includes(estado);
  return trabajoDe({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    tipo: "archivo.generar",
    estado,
    posicion: estado === "en_cola" ? posicion : null,
    intentos: terminal ? 1 : 0,
    motivo: estado === "error" ? "datos_invalidos" : null,
    iniciadoEn: estado === "en_cola" ? null : "2026-11-05T15:30:01.000Z",
    terminadoEn: terminal ? "2026-11-05T15:30:05.000Z" : null,
  });
}

export interface OpcionesArchivos {
  /** Cuerpo de `GET …/previo` en su `vez`-ésima llamada (desde 1). */
  previo?: (vez: number) => { status: number; cuerpo?: unknown };
  versiones?: (vez: number) => { status: number; cuerpo?: unknown };
  extra?: Record<string, Manejador>;
}

/** `fetch` simulado: sesión, previo y versiones. Generar y descargar los declara cada prueba en `extra`. */
export function instalarFetchArchivos(o: OpcionesArchivos = {}): FetchFalso {
  return instalarFetchFalso({
    ...rutaSesion(),
    [`GET ${BASE}/previo`]: (_, vez) =>
      (o.previo ?? (() => ({ status: 200, cuerpo: previoDe() })))(vez),
    [`GET ${BASE}`]: (_, vez) => (o.versiones ?? (() => ({ status: 200, cuerpo: [] })))(vez),
    ...o.extra,
  });
}
