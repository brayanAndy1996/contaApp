/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): diccionario del estudio, umbral y globales desactivadas (spec 027, R-6, R-11, R-12). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

export interface GastosEstudioLeido {
  /** 3 si el estudio no fijó uno. */
  umbral: number;
  /** 0 si el estudio no fijó uno. */
  versionUmbral: number;
  /** Propias activas (cuentan para el límite de 2.000). */
  activasPropias: number;
  /** Globales activas, por palabra ascendente. */
  globales: {
    id: string;
    palabra: string;
    categoria: string;
    excepciones: string[];
    desactivadaPorEstudio: boolean;
  }[];
  /** Propias activas e inactivas, por palabra ascendente. */
  propias: {
    id: string;
    palabra: string;
    categoria: string;
    excepciones: string[];
    origen: "manual" | "aprendida";
    activa: boolean;
    version: number;
    autor: { id: string; nombre: string };
    compraOrigenId: string | null;
    creadaEn: Date;
  }[];
}

export async function leerGastosEstudio(
  _tx: TxConsulta,
): Promise<GastosEstudioLeido> {
  throw new Error(NO_IMPLEMENTADO);
}

/** `gnd_palabra_agregar`: devuelve el id de la palabra nueva (versión 1). */
export async function agregarPalabra(
  _tx: TxConsulta,
  _e: { palabra: string; categoria: string; excepciones?: string[] },
): Promise<string> {
  throw new Error(NO_IMPLEMENTADO);
}

/** `gnd_palabra_estado`: devuelve la versión nueva. */
export async function cambiarEstadoPalabra(
  _tx: TxConsulta,
  _e: { id: string; activa: boolean; version: number },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}

/** `gnd_global_estado`: `activa = false` desactiva la global para el estudio; `true` la reactiva. */
export async function cambiarEstadoGlobal(
  _tx: TxConsulta,
  _e: { palabraGlobalId: string; activa: boolean },
): Promise<void> {
  throw new Error(NO_IMPLEMENTADO);
}

/** `gnd_umbral_fijar`: devuelve la versión nueva (`version` = la vigente; 0 si nunca se fijó). */
export async function fijarUmbral(
  _tx: TxConsulta,
  _e: { umbral: number; version: number },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}
