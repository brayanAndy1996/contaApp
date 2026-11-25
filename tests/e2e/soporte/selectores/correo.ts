// Selectores de «Mi cuenta → Correo» y de la baja del correo (spec 028, T21; CA-8, CA-13). Los textos salen de
// `MENSAJES_CORREO` en `apps/frontend/lib/correo.ts`. Cambia solo añadiendo.
import type { Locator, Page } from "@playwright/test";

/** Los nombres de los interruptores de `/cuenta/correo`. */
export const INTERRUPTORES = {
  buzonCritico: "Coactivas y avisos críticos del buzón",
  credencialInvalida: "Clave SOL inválida",
  planLimite: "Límite del plan",
  resumen: "Resumen diario a las 7:00, de lunes a viernes",
  todos: "Incluir todos los clientes del estudio",
} as const;

/** Un interruptor (`role="switch"`, `aria-checked`) de «Mi cuenta → Correo» por su nombre. */
export const interruptor = (
  page: Page,
  nombre: (typeof INTERRUPTORES)[keyof typeof INTERRUPTORES],
): Locator => page.getByRole("switch", { name: nombre, exact: true });

export const guardarCorreo = (page: Page): Locator =>
  page.getByRole("button", { name: "Guardar", exact: true });

/** La invitación al resumen y sus dos botones. */
export const invitacionResumen = (page: Page): Locator =>
  page.getByText("Recibe un resumen diario por correo", { exact: true });

export const activarResumen = (page: Page): Locator =>
  page.getByRole("button", { name: "Activar resumen", exact: true });

export const ahoraNo = (page: Page): Locator =>
  page.getByRole("button", { name: "Ahora no", exact: true });

/** `/baja`: el botón y el texto de resultado (el mismo con cualquier token). */
export const darmeDeBaja = (page: Page): Locator =>
  page.getByRole("button", { name: "Darme de baja", exact: true });

export const bajaListo = (page: Page): Locator =>
  page.getByText(
    "Listo. Si el enlace era válido, ya no recibirás este tipo de correo",
  );
