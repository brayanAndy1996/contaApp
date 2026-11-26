import type { ComponentType } from "react";
import { fechaCorta } from "../lib/fechas";
import { rutaSesion } from "./acceso";
import { instalarFetchFalso, type FetchFalso, type Manejador, type RespuestaSimulada } from "./soporte";

// Soporte de las pruebas de 028 · avisos por correo (T7, rojo). Es el CONTRATO que fija el frontend para T13:
//  - Textos visibles (`MENSAJES_CORREO`): T13 los define (p. ej. en `lib/correo.ts`) con estos mismos textos.
//  - Rutas de la API del plan 028 (Contratos: HTTP), bajo `/api`.
//  - Vista de ejemplo con la forma de `PreferenciasCorreoVista` (`@contapp/shared`, ya implementada en T9) y un servidor
//    falso con estado: el `PUT` guarda los cinco valores, apaga la invitación y los `GET` siguientes ya lo reflejan.
//  - Pantallas de la lista cerrada de `/ir` (D-3) y el destino de cada una.
// Solo datos de prueba y simulación; sin lógica de producción. Sin correos, tokens ni nombres reales.

export const MENSAJES_CORREO = {
  // «Mi cuenta → Correo» (`/cuenta/correo`).
  titulo: "Correo",
  entradaMenu: "Correo",
  interruptores: {
    buzonCritico: "Coactivas y avisos críticos del buzón",
    credencialInvalida: "Clave SOL inválida",
    planLimite: "Límite del plan",
    resumen: "Resumen diario a las 7:00, de lunes a viernes",
  },
  todos: "Incluir todos los clientes del estudio",
  todosIgnorado:
    "«Todos los clientes» ya no aplica: tu resumen solo incluye los clientes que tienes asignados.",
  fallo: (fecha: string) => `No pudimos enviarte el último correo (${fecha})`,
  guardar: "Guardar",
  guardado: "Guardamos tus preferencias.",
  sinPermisoTodos: "No tienes permiso para incluir todos los clientes del estudio.",
  todosNoDisponible: "Ya no puedes incluir todos los clientes: tienes clientes asignados.",
  errorGuardar: "No se pudieron guardar tus preferencias. Inténtalo de nuevo.",
  errorCarga: "No se pudieron cargar tus preferencias. Inténtalo de nuevo.",
  // Invitación al resumen (`invitacion-resumen.tsx`).
  invitacion: "Recibe un resumen diario por correo",
  activarResumen: "Activar resumen",
  ahoraNo: "Ahora no",
  errorInvitacion: "No se pudo guardar. Inténtalo de nuevo.",
  // `/baja` (D-4, U-18).
  bajaPregunta: "¿Quieres dejar de recibir este tipo de correo?",
  bajaBoton: "Darme de baja",
  // Sin punto final: es el texto exacto de D-4 y sale igual con 200, 400, 429 o error de red.
  bajaListo: "Listo. Si el enlace era válido, ya no recibirás este tipo de correo",
  bajaEnlaceCuenta: "Mi cuenta → Correo",
} as const;

/** Valores internos que nunca deben verse en pantalla («sin códigos crudos», CA-13). */
export const TEXTOS_CRUDOS_CORREO = [
  "buzon_critico",
  "credencial_invalida",
  "plan_limite",
  "todos_clientes_no_disponible",
  "permiso_denegado",
  "solicitud_invalida",
  "demasiados_intentos",
  "todosDisponible",
  "invitacionResumen",
  "undefined",
  "[object",
  "NaN",
] as const;

export const RUTA_CORREO = "/api/cuenta/correo";
export const LEER_CORREO = `GET ${RUTA_CORREO}`;
export const GUARDAR_CORREO = `PUT ${RUTA_CORREO}`;
export const RUTA_BAJA = "/api/correo/baja";
export const BAJA = `POST ${RUTA_BAJA}`;
export const ELEGIR_ESTUDIO = "POST /api/auth/estudio";
export const LEER_SESION = "GET /api/auth/sesion";

export const ESTUDIO_A = { id: "00000000-0000-4000-8000-0000000000e1", nombre: "Estudio Alfa" };
export const ESTUDIO_B = { id: "00000000-0000-4000-8000-0000000000e2", nombre: "Estudio Beta" };
export const CLIENTE_ID = "00000000-0000-4000-8000-0000000000c1";

/** Token de baja de ejemplo: base64url de 43 caracteres (32 bytes sin relleno), como `bajaSchema`. */
export const TOKEN_BAJA = "Zm9vYmFyLWJhc2U2NHVybC10b2tlbi0xMjM0NTY3ODk";
/** Fecha del último envío fallido y cómo se muestra (hora de Lima, `fechaCorta`). */
export const FALLO_ISO = "2026-11-20T12:30:00.000Z";
export const FALLO_TEXTO = fechaCorta(FALLO_ISO);

export interface VistaCorreoPrueba {
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  todosClientes: boolean;
  todosDisponible: boolean;
  todosIgnorado: boolean;
  invitacionResumen: boolean;
  ultimoEnvioFallido: string | null;
}

/** Usuario sin ninguna fila (R-15): críticos y clave SOL activados, resumen apagado, con la invitación pendiente. */
export const VISTA_INICIAL: VistaCorreoPrueba = {
  buzonCritico: true,
  credencialInvalida: true,
  planLimite: false,
  resumen: false,
  todosClientes: false,
  todosDisponible: false,
  todosIgnorado: false,
  invitacionResumen: true,
  ultimoEnvioFallido: null,
};

/** Dueño sin asignaciones que ya decidió sobre el resumen: ve «todos los clientes» y recibe el límite del plan. */
export const VISTA_DUENO: VistaCorreoPrueba = {
  ...VISTA_INICIAL,
  planLimite: true,
  todosDisponible: true,
  invitacionResumen: false,
};

/** Contador o Asistente que ya decidió sobre el resumen: sin «todos los clientes» ni límite del plan. */
export const VISTA_CONTADOR: VistaCorreoPrueba = { ...VISTA_INICIAL, invitacionResumen: false };

/** Los cinco valores que viajan en el `PUT` (`preferenciasCorreoSchema`, `.strict()`), tomados de una vista. */
export function cuerpoDe(v: VistaCorreoPrueba, cambios: Partial<VistaCorreoPrueba> = {}) {
  const f = { ...v, ...cambios };
  return {
    buzonCritico: f.buzonCritico,
    credencialInvalida: f.credencialInvalida,
    planLimite: f.planLimite,
    resumen: f.resumen,
    todosClientes: f.todosClientes,
  };
}

export interface ServidorCorreo extends FetchFalso {
  /** Estado vivo del servidor falso (lo que devolvería el siguiente `GET`). */
  estado: VistaCorreoPrueba;
}

/**
 * `fetch` simulado con sesión y un `/cuenta/correo` con estado. `guardar` reemplaza al `PUT` (para probar 403, 409, 500…);
 * `extra` añade otras rutas (p. ej. las de `/notificaciones`). El `PUT` válido guarda los cinco valores y apaga la invitación.
 */
export function instalarServidorCorreo(
  inicial: VistaCorreoPrueba = VISTA_DUENO,
  opciones: { guardar?: Manejador; leer?: Manejador; extra?: Record<string, Manejador> } = {},
): ServidorCorreo {
  const estado: VistaCorreoPrueba = { ...inicial };
  const f = instalarFetchFalso({
    ...rutaSesion(),
    [LEER_CORREO]: opciones.leer ?? (() => ({ status: 200, cuerpo: { ...estado } })),
    [GUARDAR_CORREO]:
      opciones.guardar ??
      ((l): RespuestaSimulada => {
        Object.assign(estado, l.body as Record<string, unknown>, { invitacionResumen: false });
        return { status: 200, cuerpo: { ...estado } };
      }),
    ...opciones.extra,
  });
  return Object.assign(f, { estado });
}

/** Pantallas de la lista cerrada de `/ir` (D-3): `?estudio=<uuid>&pantalla=<clave>[&cliente=<uuid>]`. */
export interface PantallaIr {
  pantalla: string;
  /** ¿Exige `cliente`? */
  cliente: boolean;
  destino: (cliente: string) => string;
}
export const PANTALLAS_IR: PantallaIr[] = [
  { pantalla: "buzon_cliente", cliente: true, destino: (c) => `/clientes/${c}/buzon` },
  { pantalla: "credenciales_cliente", cliente: true, destino: (c) => `/clientes/${c}` },
  { pantalla: "compras_cliente", cliente: true, destino: (c) => `/clientes/${c}/compras` },
  { pantalla: "ventas_cliente", cliente: true, destino: (c) => `/clientes/${c}/ventas` },
  { pantalla: "buzon_estudio", cliente: false, destino: () => "/buzon" },
  { pantalla: "uso_plan", cliente: false, destino: () => "/" },
];

/**
 * Carga un componente o página que T13 aún no creó. Si falta, la prueba falla con «no implementado» (y no el archivo entero
 * al importar). Uso: `cargarComponente(() => import(/* @vite-ignore *\/ RUTA), "Nombre")`, con `RUTA` una constante.
 */
export async function cargarComponente(
  importar: () => Promise<Record<string, unknown>>,
  nombre: string,
): Promise<ComponentType> {
  let modulo: Record<string, unknown>;
  try {
    modulo = await importar();
  } catch (e) {
    throw new Error(`no implementado: falta el módulo de ${nombre} (${e instanceof Error ? e.message : String(e)})`);
  }
  const c = modulo[nombre];
  if (typeof c !== "function") throw new Error(`no implementado: el módulo no exporta ${nombre}`);
  return c as ComponentType;
}

/** ¿El control está encendido? Vale para `role="switch"` con `aria-checked` y para una casilla (`checked`). */
export function encendido(el: HTMLElement): boolean {
  if (el.getAttribute("aria-checked") !== null) return el.getAttribute("aria-checked") === "true";
  return (el as HTMLInputElement).checked === true;
}

/** ¿Cumple el objetivo táctil de 44 px (D: `min-h-11`, `h-11`, `h-12`, con o sin prefijo `max-lg:`)? */
export function alcanza44px(el: HTMLElement): boolean {
  return /(?:^|\s)(?:max-lg:)?(?:min-h-11|h-11|h-12|size-11|size-12)(?:\s|$)/.test(el.getAttribute("class") ?? "");
}
