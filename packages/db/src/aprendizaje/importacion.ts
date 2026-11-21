/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB de la spec 025 (T4, rojo): solo la firma del contrato; T10 lo reemplaza por la implementación (funciones acotadas de 0062).
import type { TxConsulta } from "../compras/errores";
import type { DestinoRegla } from "../reglas/tipos";

const NO_IMPLEMENTADO = "aprendizaje: no implementado";

/** SQLSTATE de la BD (`P0002`, `55000`, `23505`, `22023`, `42501`, ...) o `"desconocido"`; nunca el mensaje ni el detalle. */
export class AprendizajeRepoError extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en aprendizaje (SQLSTATE ${codigo})`);
    this.name = "AprendizajeRepoError";
    this.codigo = codigo;
  }
  static desde(_error: unknown): AprendizajeRepoError {
    throw new Error(NO_IMPLEMENTADO);
  }
}

export type EstadoImportacion = "en_curso" | "completada" | "fallida";

export interface ResumenImportacion {
  periodosLeidos: number;
  periodosSinDatos: string[];
  candidatas: number;
  sinCriterio: number;
}

export interface ImportacionFila {
  id: string;
  estado: EstadoImportacion;
  periodos: string[];
  solicitadaPor: { id: string; nombre: string };
  solicitadaEn: Date;
  terminadaEn: Date | null;
  resumen: ResumenImportacion | null;
  motivo: string | null;
  trabajoId: string | null;
}

/** Lo que el worker necesita para trabajar una importación. */
export interface ImportacionParaTrabajo {
  id: string;
  clienteId: string;
  estado: EstadoImportacion;
  periodos: string[];
  ruc: string;
}

export interface CandidataNueva {
  proveedor: { tipo: string; numero: string };
  razonSocial: string | null;
  destino: DestinoRegla | null;
  conteos: {
    DG: number;
    DGNG: number;
    DNG: number;
    mixto: number;
    total: number;
  };
  periodosConProveedor: number;
}

export async function iniciarImportacion(
  _tx: TxConsulta,
  _e: { clienteId: string; periodos: string[] },
): Promise<string> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function fijarTrabajoImportacion(
  _tx: TxConsulta,
  _e: { importacionId: string; trabajoId: string },
): Promise<void> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function ultimaImportacion(
  _tx: TxConsulta,
  _clienteId: string,
): Promise<ImportacionFila | null> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function leerImportacion(
  _tx: TxConsulta,
  _importacionId: string,
): Promise<ImportacionParaTrabajo | null> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function completarImportacion(
  _tx: TxConsulta,
  _e: {
    importacionId: string;
    resumen: ResumenImportacion;
    candidatas: CandidataNueva[];
  },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function fallarImportacion(
  _tx: TxConsulta,
  _e: { importacionId: string; motivo: string },
): Promise<void> {
  throw new Error(NO_IMPLEMENTADO);
}
