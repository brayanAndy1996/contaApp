/* eslint-disable @typescript-eslint/no-unused-vars -- stub de T5: T11 usa los parámetros */
// Stub de T5 (spec 012b, rojo). T11 implementa el procesador `archivo.generar` (plan, «Cola y worker»; D2, D4, D6, D10, D12).
//
// CONTRATO que fijan las pruebas de T5 (`generar-archivo.spec.ts`, `generar-archivo.int.spec.ts`, `test/archivos.ts`):
//  - `generarArchivo({ db, storage, nodeEnv?, ahora? })` devuelve un `Procesador`. `nodeEnv` es el NODE_ENV que decide
//    `permiteProvisional` (D2); si la clave no se pasa, `process.env.NODE_ENV`. `ahora` es el reloj de `generadoEn` del ZIP.
//  - Los rechazos de negocio son `ErrorArchivo` (subclase de `ErrorDatos`, sin reintento; 008 los deja en `datos_invalidos`):
//    el código fino va en `detalle`, un literal de `CODIGOS_ERROR_ARCHIVO` de `shared`, nunca con datos de una fila:
//      `parametros_invalidos` (esquema del catálogo), `cliente_archivado`, `estado_invalido` (el periodo no está en
//      `estadoVisto` y tampoco es `generado` con la misma huella), `resumen_cambiado` (huella distinta),
//      `prevalidacion_fallida` y `formato_no_oficial` (D2: NODE_ENV=production con solo formatos provisionales).
//    Un rechazo no deja rastro: ni cambio de estado, ni versión, ni ZIP en storage.
//  - Un fallo inesperado (p. ej. de BD tras `storage.guardar`) se propaga tal cual (no es `ErrorArchivo`), tras borrar el ZIP.
//  - `resultado` = exactamente `{ archivoId, version, nueva, lineas, provisional }` (D6).
import { ErrorDatos } from "@contapp/sunat";
import type { ContappDb } from "@contapp/db";
import type { StorageProvider } from "@contapp/storage";
import type { Procesador } from "../ejecutor.js";
import type { LoggerTrabajos } from "../registro.js";

export type DetalleErrorArchivo =
  | "parametros_invalidos"
  | "cliente_archivado"
  | "estado_invalido"
  | "resumen_cambiado"
  | "prevalidacion_fallida"
  | "formato_no_oficial";

export class ErrorArchivo extends ErrorDatos {
  constructor(readonly detalle: DetalleErrorArchivo) {
    super();
  }
}

export interface DepsGenerarArchivo {
  db: Pick<ContappDb, "withTenant">;
  storage: StorageProvider;
  /** NODE_ENV para `permiteProvisional` (D2). Sin la clave, `process.env.NODE_ENV`. */
  nodeEnv?: string | undefined;
  /** Reloj de la fecha del ZIP; por defecto `new Date()`. */
  ahora?: () => Date;
  /** Donde se registra (solo un código, nunca datos ni rutas) el borrado fallido de un ZIP huérfano. */
  logger?: LoggerTrabajos;
}

/** Forma del `resultado` del trabajo (D6): solo estos cinco campos. */
export interface ResultadoGenerarArchivo {
  archivoId: string;
  version: number;
  nueva: boolean;
  lineas: number;
  provisional: boolean;
}

export function generarArchivo(_d: DepsGenerarArchivo): Procesador {
  return async () => {
    throw new Error("no implementado");
  };
}
