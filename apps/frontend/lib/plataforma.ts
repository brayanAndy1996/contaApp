import { useEffect, useState } from "react";
import {
  planCrearSchema,
  planEditarSchema,
  suscripcionAsignarSchema,
  type PlanDto,
  type PlanEntrada,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { api } from "./api";

// Super-admin de plataforma en la UI (spec 006, D5, D13, CA-10). Solo presentación: el servidor decide
// (`@SoloPlataforma` y las funciones SQL). No usa `usePuede()`, que lee los permisos del estudio activo,
// y el super-admin no tiene estudio: aquí se pregunta a `GET /plataforma/yo`. Los precios viajan como
// cadena decimal y se muestran tal cual; nunca se calculan en la UI.

/** Fila de `GET /plataforma/estudios` (D13): sin precios ni límites. */
export interface EstudioPlataforma {
  id: string;
  nombre: string;
  plan: { codigo: string; nombre: string };
  estado: "prueba" | "activa";
}

export type AccesoPlataforma = "admin" | "sin_permiso" | "error";

export const MENSAJES_PLATAFORMA = {
  planCreado: "Plan creado.",
  planGuardado: "Plan guardado.",
  planInvalido: "Revisa los valores del plan.",
  codigoExistente: "Ya existe un plan con ese código.",
  featuresInvalidas: "Las características deben ser un objeto JSON.",
  planInactivo: "El plan está desactivado y no se puede asignar.",
  extraInvalido: "Los RUCs adicionales superan el tope del plan.",
  extraNoValido: "Indica una cantidad entera de RUCs adicionales (0 o más).",
  suscripcionGuardada: "Suscripción actualizada.",
} as const;

/** `GET /plataforma/yo`: 200 con `admin: true` es "admin"; 403 es "sin_permiso"; otro fallo es "error". */
export async function comprobarAccesoPlataforma(): Promise<AccesoPlataforma> {
  try {
    const r = await api<{ admin?: boolean }>("/plataforma/yo");
    if (r.ok) return r.datos?.admin === true ? "admin" : "sin_permiso";
    return r.status === 403 ? "sin_permiso" : "error";
  } catch {
    return "error";
  }
}

/** Acceso del super-admin; `undefined` mientras responde `GET /plataforma/yo` (como `usePuede()`). */
export function useAccesoPlataforma(): AccesoPlataforma | undefined {
  const [acceso, setAcceso] = useState<AccesoPlataforma | undefined>(undefined);

  useEffect(() => {
    let vigente = true;
    void comprobarAccesoPlataforma().then((resultado) => {
      if (vigente) setAcceso(resultado);
    });
    return () => {
      vigente = false;
    };
  }, []);

  return acceso;
}

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

/** Mensaje de un error común (403, 404 o cualquier otro); nunca muestra el `codigo` del servidor. */
export function mensajeGeneral(status: number): string {
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 404) return MENSAJES.noEncontrado;
  return MENSAJES.errorGeneral;
}

/** Errores de crear o editar un plan: 400 (valores), 409 `codigo_existente`, 403 y 404. */
export function mensajeDePlan(status: number, datos: unknown): string {
  if (status === 400) return MENSAJES_PLATAFORMA.planInvalido;
  if (status === 409 && codigoDe(datos) === "codigo_existente") {
    return MENSAJES_PLATAFORMA.codigoExistente;
  }
  return mensajeGeneral(status);
}

/** Errores de asignar plan: 409 `plan_inactivo`, 400 (extra sobre el tope del plan), 403 y 404. */
export function mensajeDeAsignacion(status: number, datos: unknown): string {
  if (status === 400) return MENSAJES_PLATAFORMA.extraInvalido;
  if (status === 409 && codigoDe(datos) === "plan_inactivo") {
    return MENSAJES_PLATAFORMA.planInactivo;
  }
  return mensajeGeneral(status);
}

/** Campos del formulario de plan. Todos son texto: se convierten y validan al enviar. */
export interface FormularioPlan {
  codigo: string;
  nombre: string;
  precioMensual: string;
  precioAnual: string;
  maxRucs: string;
  maxUsuarios: string;
  precioRucExtra: string;
  maxRucsExtra: string;
  frecuenciaBuzonMin: string;
  features: string;
}

export const FORMULARIO_VACIO: FormularioPlan = {
  codigo: "",
  nombre: "",
  precioMensual: "",
  precioAnual: "",
  maxRucs: "",
  maxUsuarios: "",
  precioRucExtra: "",
  maxRucsExtra: "",
  frecuenciaBuzonMin: "",
  features: "{}",
};

/** Valores de un plan guardado para editarlo; las características van como JSON con sangría. */
export function formularioDe(plan: PlanDto): FormularioPlan {
  return {
    codigo: plan.codigo,
    nombre: plan.nombre,
    precioMensual: plan.precioMensual,
    precioAnual: plan.precioAnual ?? "",
    maxRucs: String(plan.maxRucs),
    maxUsuarios: plan.maxUsuarios === null ? "" : String(plan.maxUsuarios),
    precioRucExtra: plan.precioRucExtra,
    maxRucsExtra: String(plan.maxRucsExtra),
    frecuenciaBuzonMin: String(plan.frecuenciaBuzonMin),
    features: JSON.stringify(plan.features, null, 2),
  };
}

/** Número de un campo. Vacío o no numérico da NaN, que el esquema rechaza. */
const numero = (texto: string): number =>
  texto.trim() === "" ? Number.NaN : Number(texto);

const esObjeto = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === "object" && valor !== null && !Array.isArray(valor);

export type EntradaPlan =
  { ok: true; cuerpo: PlanEntrada } | { ok: false; error: string };

/**
 * Pasa el formulario al cuerpo de POST o PUT y lo valida con `planCrearSchema` o `planEditarSchema` de
 * shared. Las características se leen primero: un JSON que no es objeto tiene su propio mensaje.
 */
export function entradaDePlan(
  formulario: FormularioPlan,
  editando: boolean,
  activo: boolean,
): EntradaPlan {
  let features: unknown;
  try {
    features = JSON.parse(formulario.features);
  } catch {
    return { ok: false, error: MENSAJES_PLATAFORMA.featuresInvalidas };
  }
  if (!esObjeto(features)) {
    return { ok: false, error: MENSAJES_PLATAFORMA.featuresInvalidas };
  }

  const f = formulario;
  const datos = {
    codigo: f.codigo.trim(),
    nombre: f.nombre.trim(),
    precioMensual: f.precioMensual.trim(),
    precioAnual: f.precioAnual.trim() === "" ? null : f.precioAnual.trim(),
    maxRucs: numero(f.maxRucs),
    maxUsuarios: f.maxUsuarios.trim() === "" ? null : numero(f.maxUsuarios),
    precioRucExtra: f.precioRucExtra.trim(),
    maxRucsExtra: numero(f.maxRucsExtra),
    frecuenciaBuzonMin: numero(f.frecuenciaBuzonMin),
    features,
    activo,
  };
  const resultado = editando
    ? planEditarSchema.safeParse(datos)
    : planCrearSchema.safeParse(datos);
  return resultado.success
    ? { ok: true, cuerpo: resultado.data }
    : { ok: false, error: MENSAJES_PLATAFORMA.planInvalido };
}

/** Cuerpo de reemplazo completo de un plan guardado (PUT): sin `id` y con el `activo` indicado. */
export function cuerpoDePlan(plan: PlanDto, activo: boolean): PlanEntrada {
  return {
    codigo: plan.codigo,
    nombre: plan.nombre,
    precioMensual: plan.precioMensual,
    precioAnual: plan.precioAnual,
    maxRucs: plan.maxRucs,
    maxUsuarios: plan.maxUsuarios,
    precioRucExtra: plan.precioRucExtra,
    maxRucsExtra: plan.maxRucsExtra,
    frecuenciaBuzonMin: plan.frecuenciaBuzonMin,
    features: plan.features,
    activo,
  };
}

// Solo el número se valida aquí: el `planId` viene de la lista del servidor (`GET /plataforma/planes`).
const rucsExtraSchema = suscripcionAsignarSchema.pick({
  rucsExtraContratados: true,
});

/** RUCs adicionales del formulario: entero mayor o igual que 0 según shared; `null` si no es válido. */
export function rucsExtraDe(texto: string): number | null {
  const resultado = rucsExtraSchema.safeParse({
    rucsExtraContratados: numero(texto),
  });
  return resultado.success ? resultado.data.rucsExtraContratados : null;
}
