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
