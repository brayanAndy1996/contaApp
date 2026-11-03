import { sesionDe, type Manejador } from "./soporte";

// Soporte de las pruebas de pantallas de 006 (planes, registro, uso): mensajes visibles y cuerpos de
// ejemplo. Son el contrato de T10a/T10b: las pantallas deben mostrar estos textos exactos. Solo datos
// de prueba (canarios); sin lógica de producción.

export const MENSAJES_PLANES = {
  // /registro: el mismo mensaje exista o no una cuenta con ese correo (CA-4); nunca repite el correo.
  revisaCorreo: "Revisa tu correo para continuar con el registro.",
  rucInvalido: "El RUC debe tener 11 dígitos.",
  solicitudInvalida: "Revisa los datos ingresados.",
  // /registro/confirmar
  registroInvalido:
    "El enlace no es válido o venció. Solicita un registro nuevo.",
  registroNoDisponible:
    "El registro no está disponible por ahora. Inténtalo más tarde.",
  registroCreado: "Tu estudio fue creado. Ya puedes iniciar sesión.",
  estudioCreado: (estudio: string) => `Tu estudio ${estudio} fue creado.`,
  // Indicador de uso: elementos de texto propios (no se mezclan con otro texto).
  limiteRucs: "Llegaste al límite de RUCs de tu plan.",
  limiteUsuarios: "Llegaste al límite de usuarios de tu plan.",
  // D8: el Dueño aún no cambia de plan; se busca con regex /contacta a ContApp para subir de plan/i.
  subirDePlan: "Contacta a ContApp para subir de plan.",
  // /admin y /admin/planes
  planCreado: "Plan creado.",
  planGuardado: "Plan guardado.",
  planInvalido: "Revisa los valores del plan.",
  codigoExistente: "Ya existe un plan con ese código.",
  featuresInvalidas: "Las características deben ser un objeto JSON.",
  planInactivo: "El plan está desactivado y no se puede asignar.",
  extraInvalido: "Los RUCs adicionales superan el tope del plan.",
  suscripcionGuardada: "Suscripción actualizada.",
} as const;

/** Cuerpo de `GET /plan/uso` (UsoPlanDto del plan 006, sin precios). */
export function usoDe(
  parcial: {
    plan?: { codigo: string; nombre: string };
    estado?: "prueba" | "activa";
    pruebaVenceEn?: string | null;
    rucs?: Partial<{
      usados: number;
      limite: number;
      libres: number;
      extra: number;
    }>;
    usuarios?: Partial<{
      usados: number;
      pendientes: number;
      limite: number | null;
    }>;
  } = {},
) {
  return {
    plan: parcial.plan ?? { codigo: "estudio", nombre: "Estudio" },
    estado: parcial.estado ?? "activa",
    pruebaVenceEn: parcial.pruebaVenceEn ?? null,
    rucs: { usados: 12, limite: 100, libres: 88, extra: 0, ...parcial.rucs },
    usuarios: { usados: 3, pendientes: 0, limite: 5, ...parcial.usuarios },
  };
}

/** Ruta simulada de la sesión con estudio activo y de `GET /plan/uso`. */
export function rutaUso(
  uso: Manejador = { status: 200, cuerpo: usoDe() },
  csrf = "csrf-planes-1",
): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }, csrf),
    },
    "GET /api/plan/uso": uso,
  };
}

/** Planes de ejemplo (PlanDto del plan 006: precios como cadena decimal). */
export const PLANES = [
  {
    id: "p-prueba",
    codigo: "prueba",
    nombre: "Prueba",
    precioMensual: "0.00",
    precioAnual: null,
    maxRucs: 5,
    maxUsuarios: 1,
    precioRucExtra: "0.00",
    maxRucsExtra: 0,
    frecuenciaBuzonMin: 1440,
    features: {},
    activo: true,
  },
  {
    id: "p-estudio",
    codigo: "estudio",
    nombre: "Estudio",
    precioMensual: "249.00",
    precioAnual: "2490.00",
    maxRucs: 100,
    maxUsuarios: 5,
    precioRucExtra: "4.00",
    maxRucsExtra: 20,
    frecuenciaBuzonMin: 720,
    features: { reportes: true },
    activo: true,
  },
  {
    id: "p-corp",
    codigo: "corporativo",
    nombre: "Corporativo",
    precioMensual: "1200.00",
    precioAnual: null,
    maxRucs: 600,
    maxUsuarios: null,
    precioRucExtra: "4.00",
    maxRucsExtra: 120,
    frecuenciaBuzonMin: 60,
    features: {},
    activo: true,
  },
  {
    id: "p-viejo",
    codigo: "heredado",
    nombre: "Heredado",
    precioMensual: "50.00",
    precioAnual: null,
    maxRucs: 10,
    maxUsuarios: 2,
    precioRucExtra: "0.00",
    maxRucsExtra: 0,
    frecuenciaBuzonMin: 1440,
    features: {},
    activo: false,
  },
];

/** Estudios de ejemplo de `GET /plataforma/estudios` (D13). */
export const ESTUDIOS = [
  {
    id: "t-alfa",
    nombre: "Estudio Alfa",
    plan: { codigo: "estudio", nombre: "Estudio" },
    estado: "activa",
  },
  {
    id: "t-beta",
    nombre: "Estudio Beta",
    plan: { codigo: "prueba", nombre: "Prueba" },
    estado: "prueba",
  },
];
