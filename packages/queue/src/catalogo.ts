// Catálogo de tipos de trabajo (plan 008, D7). Cada tipo declara cola, canal, credencial, permiso,
// si es idempotente y el esquema zod de sus parámetros. Falla cerrado: lo no registrado no existe.
import {
  PERMISOS,
  ROLES,
  PERMISOS_POR_ROL,
  type Permiso,
} from "@contapp/shared";
import { z, type ZodType } from "zod";
import { TipoDesconocidoError, TipoInvalidoError } from "./errores.js";
import {
  CANALES,
  COLAS,
  type Canal,
  type CredencialRequerida,
  type NombreCola,
} from "./tipos.js";

export interface DefinicionTrabajo<P = unknown> {
  tipo: string;
  cola: NombreCola;
  canal: Canal;
  credencial: CredencialRequerida;
  permiso: Permiso | null;
  idempotente: boolean;
  parametros: ZodType<P>;
}

/** Igual que el CHECK de `job_registro.tipo`. */
const TIPO_VALIDO = /^[a-z]+(\.[a-z_]+)+$/;

const registro = new Map<string, DefinicionTrabajo>();

function valida(def: DefinicionTrabajo<unknown>): boolean {
  return (
    typeof def === "object" &&
    def !== null &&
    typeof def.tipo === "string" &&
    TIPO_VALIDO.test(def.tipo) &&
    (COLAS as readonly string[]).includes(def.cola) &&
    (CANALES as readonly string[]).includes(def.canal) &&
    (def.credencial === null ||
      def.credencial === "sol" ||
      def.credencial === "sire_api") &&
    (def.permiso === null ||
      (PERMISOS as readonly string[]).includes(def.permiso)) &&
    typeof def.idempotente === "boolean" &&
    typeof def.parametros?.safeParse === "function"
  );
}

const mismaForma = (a: DefinicionTrabajo, b: DefinicionTrabajo): boolean =>
  a.cola === b.cola &&
  a.canal === b.canal &&
  a.credencial === b.credencial &&
  a.permiso === b.permiso &&
  a.idempotente === b.idempotente;

/**
 * Registra un tipo. Rechaza (TipoInvalidoError) una definición mal formada o que cambie la cola,
 * el canal, la credencial, el permiso o la idempotencia de un tipo ya registrado.
 */
export function registrarTipo<P>(def: DefinicionTrabajo<P>): void {
  const d = def as DefinicionTrabajo<unknown>;
  if (!valida(d)) throw new TipoInvalidoError();
  const previo = registro.get(d.tipo);
  if (previo !== undefined && !mismaForma(previo, d)) {
    throw new TipoInvalidoError();
  }
  registro.set(d.tipo, Object.freeze({ ...d }));
}

/** Definición registrada; un tipo desconocido lanza TipoDesconocidoError (también "constructor" y afines). */
export function definicionDe(tipo: string): DefinicionTrabajo {
  const d = typeof tipo === "string" ? registro.get(tipo) : undefined;
  if (d === undefined) throw new TipoDesconocidoError();
  return d;
}

/** Roles de PERMISOS_POR_ROL que tienen el permiso del tipo, o null si el tipo no exige permiso (D17). */
export function rolesPermitidos(permiso: Permiso | null): string[] | null {
  return permiso === null
    ? null
    : ROLES.filter((r) => PERMISOS_POR_ROL[r].has(permiso));
}

const parametrosVacios = z.object({}).strict();

/** Spec 007b: consulta de datos del RUC tras el alta o la importación (cola `xml`, sin lock por RUC). */
export const CLIENTE_CONSULTAR_RUC: DefinicionTrabajo<Record<string, never>> = {
  tipo: "cliente.consultar_ruc",
  cola: "xml",
  canal: "ninguno",
  credencial: null,
  permiso: "clientes.crear",
  idempotente: true,
  parametros: parametrosVacios as ZodType<Record<string, never>>,
};

/**
 * Spec 007b: verificar la clave SOL / la credencial SIRE. `credencial: null` es deliberado: el despachador
 * cancela con `credencial_invalida` todo tipo cuyo sobre esté inválido, y verificar debe poder correr
 * justo en ese estado. El procesador lee el sobre por su cuenta.
 */
export const CREDENCIAL_VERIFICAR_SOL: DefinicionTrabajo<
  Record<string, never>
> = {
  tipo: "credencial.verificar_sol",
  cola: "sol",
  canal: "sol",
  credencial: null,
  permiso: "credenciales.editar",
  idempotente: true,
  parametros: parametrosVacios as ZodType<Record<string, never>>,
};

export const CREDENCIAL_VERIFICAR_SIRE: DefinicionTrabajo<
  Record<string, never>
> = {
  tipo: "credencial.verificar_sire",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: "credenciales.editar",
  idempotente: true,
  parametros: parametrosVacios as ZodType<Record<string, never>>,
};

const HUSO_LIMA_MS = 5 * 60 * 60 * 1000;
const PERIODO_AAAAMM = /^\d{4}(0[1-9]|1[0-2])$/;

/** Mes en curso (hora de Lima, UTC-5) como AAAAMM; se evalúa en cada validación, no al cargar el módulo. */
function periodoEnCurso(): string {
  const ahora = new Date(Date.now() - HUSO_LIMA_MS);
  return `${ahora.getUTCFullYear()}${String(ahora.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Periodo AAAAMM con mes 01-12 y sin futuro: no posterior al mes en curso (el mes en curso sí vale). */
const periodoSireSchema = z
  .string()
  .regex(PERIODO_AAAAMM)
  .refine((p) => p <= periodoEnCurso());

export interface ParametrosDescargarPropuesta {
  periodo: string;
  libro: "compras" | "ventas";
}

/**
 * Spec 013 (D2): descarga de la propuesta mensual del SIRE (cola y canal `sire`, credencial `sire_api`).
 * Los parámetros son estrictos: no hay dónde llevar un secreto, un cliente ni un estudio en el payload.
 * 014 reutiliza el mismo tipo con `libro: "compras"`.
 */
export const SIRE_PROPUESTA_DESCARGAR: DefinicionTrabajo<ParametrosDescargarPropuesta> =
  {
    tipo: "sire.propuesta.descargar",
    cola: "sire",
    canal: "sire",
    credencial: "sire_api",
    permiso: "sire.descargar",
    idempotente: true,
    parametros: z
      .object({
        periodo: periodoSireSchema,
        libro: z.enum(["compras", "ventas"]),
      })
      .strict(),
  };

registrarTipo(CLIENTE_CONSULTAR_RUC);
registrarTipo(CREDENCIAL_VERIFICAR_SOL);
registrarTipo(CREDENCIAL_VERIFICAR_SIRE);
registrarTipo(SIRE_PROPUESTA_DESCARGAR);

/** Tipo de pruebas: solo existe con NODE_ENV=test (el worker le programa el comportamiento). */
export const PRUEBA_ECO: DefinicionTrabajo<{ n?: number; rango?: string }> = {
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: "sire.descargar",
  idempotente: true,
  parametros: z.object({
    n: z.number().int().min(0).max(1_000_000).optional(),
    rango: z.string().max(64).optional(),
  }),
};

if (process.env.NODE_ENV === "test") registrarTipo(PRUEBA_ECO);
