// Selectores y textos del área de acceso (spec 018, T4): alta, login, invitación y roles (E-01, E-02).
// Los localizadores salen por rol y nombre accesible; aquí solo viven los que piden un filtro compuesto y los
// textos de `apps/frontend/lib/{acceso,registro}.ts` y de las pantallas públicas, para que los dos flujos no
// repitan literales.
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";

export const TEXTOS = {
  credencialesInvalidas: "Correo o contraseña incorrectos.",
  revisaCorreo: "Revisa tu correo para continuar con el registro.",
  registroCreado: "Tu estudio fue creado. Ya puedes iniciar sesión.",
  registroInvalido:
    "El enlace no es válido o venció. Solicita un registro nuevo.",
  rucInvalido: "El RUC debe tener 11 dígitos.",
  contrasenaLongitud: "La contraseña debe tener entre 12 y 128 caracteres.",
  invitacionEnviada: "Invitación enviada.",
  invitacionInvalida:
    "La invitación no es válida o venció. Pide una nueva al estudio.",
  cuentaCreada: "Tu cuenta fue creada. Ya puedes iniciar sesión.",
  sinPermiso: "No tienes permiso para realizar esta acción.",
  noEncontrado: "No se encontró lo que buscas.",
} as const;

export const ASUNTO_REGISTRO = "confirma tu registro";
export const ASUNTO_INVITACION = "te invitaron a un estudio";

/** Contraseña válida (12 a 128 caracteres, nada común) y distinta en cada prueba. */
export function contrasenaNueva(): string {
  return `Clave-E2E-${randomUUID().slice(0, 12)}`;
}

/** Un nombre de estudio único por prueba. */
export function nombreDeEstudio(): string {
  return `Estudio Alta ${randomUUID().slice(0, 8)}`;
}

/** La fila de una tabla (miembros, invitaciones, clientes) que contiene ese texto. */
export function fila(page: Page, texto: string): Locator {
  return page.getByRole("row").filter({ hasText: texto });
}

/** Escribe correo y contraseña en `/login` y envía el formulario. */
export async function ingresar(
  page: Page,
  correo: string,
  contrasena: string,
): Promise<void> {
  await page.getByLabel("Correo", { exact: true }).fill(correo);
  await page.getByLabel("Contraseña", { exact: true }).fill(contrasena);
  await page.getByRole("button", { name: "Ingresar" }).click();
}
