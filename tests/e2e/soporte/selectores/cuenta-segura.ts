// Selectores y textos de la cuenta segura (spec 029, T11): paso de código del login, «Mi cuenta → Seguridad» y los avisos de
// `packages/correo/src/seguridad.ts` y `apps/frontend/lib/seguridad.ts`. Aquí solo viven los literales y los pasos repetidos.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { MensajeLeido } from "../correo.js";
import { Autenticador } from "../totp.js";

export const ASUNTOS = {
  activado: "Activaste la verificación en dos pasos en ContApp",
  desactivado: "Desactivaste la verificación en dos pasos en ContApp",
  recuperacionUsada: "Se usó un código de recuperación en tu cuenta de ContApp",
  restablecido:
    "Se restableció la verificación en dos pasos de tu cuenta de ContApp",
} as const;

export const TEXTOS = {
  codigoIncorrecto: "El código no es correcto.",
  exigidoAviso:
    "Tu cuenta exige la verificación en dos pasos. Actívala para continuar.",
  desactivada: "Verificación en dos pasos desactivada.",
  activa: "La verificación en dos pasos está activa.",
} as const;

export const pasoDeCodigo = (page: Page): Locator =>
  page.getByRole("heading", { name: "Verificación en dos pasos" });
export const campoCodigoLogin = (page: Page): Locator =>
  page.getByLabel("Código de verificación");
export const campoCodigoRecuperacion = (page: Page): Locator =>
  page.getByLabel("Código de recuperación");
export const verificar = (page: Page): Locator =>
  page.getByRole("button", { name: "Verificar" });
export const usarRecuperacion = (page: Page): Locator =>
  page.getByRole("button", { name: "Usar un código de recuperación" });
export const activarTotp = (page: Page): Locator =>
  page.getByRole("button", { name: "Activar la verificación en dos pasos" });
export const desactivarTotp = (page: Page): Locator =>
  page.getByRole("button", { name: "Desactivar la verificación en dos pasos" });
export const codigosListados = (page: Page): Locator =>
  page.locator("ul li code");
export const yaGuarde = (page: Page): Locator =>
  page.getByRole("button", { name: "Ya guardé mis códigos" });
export const sesionesFilas = (page: Page): Locator =>
  page.getByRole("listitem").filter({ hasText: "Último uso" });
export const revocarUna = (page: Page): Locator =>
  page.getByRole("button", { name: /^Revocar la sesión de/ });
export const revocarOtras = (page: Page): Locator =>
  page.getByRole("button", { name: "Revocar las demás sesiones" });

export interface Enrolada {
  readonly autenticador: Autenticador;
  readonly codigos: readonly string[];
  /** `Cache-Control` de la respuesta que trae el URI (debe ser `no-store`). */
  readonly cacheControl: string;
}

/**
 * «Mi cuenta → Seguridad» como lo haría una persona: contraseña → QR → código → los 10 códigos de recuperación → «Ya guardé».
 * El URI `otpauth://` se lee de la respuesta de `/auth/totp/enrolar` (el QR solo lo lleva dibujado).
 */
export async function activarPorPantalla(
  page: Page,
  contrasena: string,
): Promise<Enrolada> {
  await activarTotp(page).click();
  await page.getByLabel("Contraseña actual").fill(contrasena);
  const enrolar = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/totp/enrolar") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Continuar" }).click();
  const respuesta = await enrolar;
  expect(respuesta.status()).toBe(200);
  const { uri } = (await respuesta.json()) as { uri: string };
  const autenticador = new Autenticador(uri);
  await expect(
    page.getByRole("img", {
      name: "Código QR para la aplicación de autenticación",
    }),
  ).toBeVisible();
  await campoCodigoLogin(page).fill(await autenticador.siguiente());
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(codigosListados(page)).toHaveCount(10);
  const codigos = (await codigosListados(page).allTextContents()).map((c) =>
    c.trim(),
  );
  await yaGuarde(page).click();
  await expect(codigosListados(page)).toHaveCount(0);
  await expect(page.getByText(TEXTOS.activa)).toBeVisible();
  return {
    autenticador,
    codigos,
    cacheControl: respuesta.headers()["cache-control"] ?? "",
  };
}

/** Lo que un aviso de seguridad nunca debe traer (CA-6, CA-10): códigos, secreto, URI ni enlaces. */
export function verificarAvisoLimpio(
  mensaje: MensajeLeido,
  prohibidos: readonly string[],
): void {
  const cuerpos = [mensaje.texto, mensaje.html ?? "", mensaje.asunto];
  for (const cuerpo of cuerpos) {
    expect(cuerpo).not.toMatch(/https?:\/\//i);
    expect(cuerpo).not.toContain("otpauth");
    for (const valor of prohibidos) {
      if (valor !== "") expect(cuerpo).not.toContain(valor);
    }
  }
}

/** Los logs del backend y del worker de la pila (para buscar canarios); vacío si la prueba no corre sobre una pila. */
export async function logsDeLaPila(): Promise<string> {
  const dir = process.env.E2E_PILA_DIR;
  if (dir === undefined) return "";
  const partes: string[] = [];
  for (const archivo of ["backend.log", "worker.log", "frontend.log"]) {
    partes.push(await readFile(join(dir, archivo), "utf8").catch(() => ""));
  }
  return partes.join("\n");
}
