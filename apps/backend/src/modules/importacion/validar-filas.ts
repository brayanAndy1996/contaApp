// Validación por fila de la importación (spec 007b, D7–D9; plan: Contratos "motivos", Decisiones "Columnas" y
// "Celdas peligrosas"). Pura: sin IO ni logs. Nunca copia una clave a un motivo ni a la vista previa.
import {
  guardarCredencialSireSchema,
  guardarCredencialSolSchema,
  puedeSerResponsable,
  validarRuc,
  type Rol,
} from "@contapp/shared";
import type { FilaLeida } from "./tipos.js";

export type CodigoMotivo =
  | "ruc_invalido"
  | "duplicado_en_archivo"
  | "duplicado"
  | "responsable_inexistente"
  | "responsable_no_asignable"
  | "credencial_incompleta"
  | "celda_peligrosa"
  | "cupo_rucs";

export interface Motivo {
  codigo: CodigoMotivo;
  /** Solo en `duplicado`: el RUC existente está archivado (la interfaz sugiere reactivarlo). */
  archivado?: boolean;
}

export interface ContextoValidacion {
  /** RUC que ya existen en el estudio (activos y archivados). */
  existentes: ReadonlyMap<string, { archivado: boolean }>;
  /** Miembros ACTIVOS del estudio por correo en minúsculas (P1 a: el responsable se identifica por correo). */
  miembros: ReadonlyMap<string, { usuarioId: string; rol: Rol }>;
}

export interface FilaValidada {
  n: number;
  ruc: string;
  estado: "valida" | "error";
  motivos: Motivo[];
  tieneSol: boolean;
  tieneSire: boolean;
  /** Usuario responsable resuelto; null si la celda venía vacía o la fila tiene error. */
  responsableId: string | null;
  /** La fila original (con claves): solo para `confirmar`; nunca se serializa hacia el cliente. */
  fila: FilaLeida;
}

export interface VistaPrevia {
  filas: Array<
    Pick<
      FilaValidada,
      "n" | "ruc" | "estado" | "motivos" | "tieneSol" | "tieneSire"
    >
  >;
  validas: number;
  conError: number;
  cupoLibre: number;
  excedentes: number;
}

/**
 * Texto que una hoja de cálculo podría interpretar (CSV/fórmula injection): empieza, tras espacios opcionales, con
 * `= + - @`, o lleva en cualquier posición un carácter de control (tabulador, retorno, NUL…; D7, T4).
 */
const PELIGROSA = /^[ ]*[=+\-@]|[\u0000-\u001f\u007f]/;

/** Celdas de texto visibles que se rechazan si son peligrosas; las claves aceptan cualquier carácter. */
const CAMPOS_TEXTO = [
  "razonSocial",
  "usuarioSol",
  "clientId",
  "responsable",
] as const;

/** Largo máximo con que se devuelve el RUC de una fila (si no es un RUC, no se refleja más que esto). */
const MAX_RUC_VISIBLE = 32;

const lleno = (s: string) => s !== "";

/** El RUC tal como se devuelve al cliente: lo que no es un RUC no se refleja más allá de este largo. */
export const rucVisible = (ruc: string): string => ruc.slice(0, MAX_RUC_VISIBLE);

/** Pura, sin IO. Conserva el orden y el número de fila; la primera aparición de un RUC es la que vale. */
export function validarFilas(
  filas: FilaLeida[],
  ctx: ContextoValidacion,
): FilaValidada[] {
  const vistos = new Set<string>();
  return filas.map((fila) => {
    const motivos: Motivo[] = [];
    const agregar = (m: Motivo) => {
      if (!motivos.some((x) => x.codigo === m.codigo)) motivos.push(m);
    };

    if (!validarRuc(fila.ruc)) agregar({ codigo: "ruc_invalido" });
    else if (vistos.has(fila.ruc)) agregar({ codigo: "duplicado_en_archivo" });
    else {
      vistos.add(fila.ruc);
      const existente = ctx.existentes.get(fila.ruc);
      if (existente !== undefined)
        agregar(
          existente.archivado
            ? { codigo: "duplicado", archivado: true }
            : { codigo: "duplicado" },
        );
    }

    if (fila.formulas.length > 0) agregar({ codigo: "celda_peligrosa" });
    for (const campo of CAMPOS_TEXTO)
      if (PELIGROSA.test(fila[campo])) agregar({ codigo: "celda_peligrosa" });

    // Un par a medias, o un valor que el guardado de D4 no aceptaría (> 256 B), no es una credencial utilizable.
    const tieneSol = lleno(fila.usuarioSol) && lleno(fila.claveSol);
    const tieneSire = lleno(fila.clientId) && lleno(fila.clientSecret);
    const solIncompleta =
      lleno(fila.usuarioSol) !== lleno(fila.claveSol) ||
      (tieneSol &&
        !guardarCredencialSolSchema.safeParse({
          usuario: fila.usuarioSol,
          clave: fila.claveSol,
        }).success);
    const sireIncompleta =
      lleno(fila.clientId) !== lleno(fila.clientSecret) ||
      (tieneSire &&
        !guardarCredencialSireSchema.safeParse({
          clientId: fila.clientId,
          clientSecret: fila.clientSecret,
        }).success);
    if (solIncompleta || sireIncompleta)
      agregar({ codigo: "credencial_incompleta" });

    // P1 (a): el responsable se identifica por el correo de un miembro activo.
    let responsableId: string | null = null;
    const correo = fila.responsable.trim().toLowerCase();
    if (correo !== "" && !PELIGROSA.test(fila.responsable)) {
      const miembro = ctx.miembros.get(correo);
      if (miembro === undefined) agregar({ codigo: "responsable_inexistente" });
      else if (!puedeSerResponsable(miembro.rol))
        agregar({ codigo: "responsable_no_asignable" });
      else responsableId = miembro.usuarioId;
    }

    const valida = motivos.length === 0;
    return {
      n: fila.n,
      ruc: fila.ruc,
      estado: valida ? "valida" : "error",
      motivos,
      tieneSol,
      tieneSire,
      responsableId: valida ? responsableId : null,
      fila,
    };
  });
}

/** Proyección sin claves ni usuarios: solo `tieneSol`/`tieneSire`. */
export function aVistaPrevia(
  filas: FilaValidada[],
  cupoLibre: number,
): VistaPrevia {
  const validas = filas.filter((f) => f.estado === "valida").length;
  return {
    filas: filas.map((f) => ({
      n: f.n,
      ruc: rucVisible(f.ruc),
      estado: f.estado,
      motivos: f.motivos.map((m) => ({ ...m })),
      tieneSol: f.tieneSol,
      tieneSire: f.tieneSire,
    })),
    validas,
    conError: filas.length - validas,
    cupoLibre,
    excedentes: Math.max(0, validas - cupoLibre),
  };
}
