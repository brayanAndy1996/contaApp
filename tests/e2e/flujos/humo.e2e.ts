// Humo de la pila (spec 018, tabla de flujos): si la pila levanta, /login muestra el formulario y la
// sesión, sin haber entrado, responde 401. Es la primera prueba que el resto de la suite da por buena.
import { expect, test } from "@playwright/test";

test("la pila levanta: /login muestra el formulario y la sesión sin entrar responde 401", async ({
  page,
  request,
}) => {
  const sesion = await request.get("/api/auth/sesion");
  expect(sesion.status()).toBe(401);

  const respuesta = await page.goto("/login");
  expect(respuesta?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Ingresar a ContApp" }),
  ).toBeVisible();
  await expect(page.getByLabel("Correo", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ingresar", exact: true }),
  ).toBeVisible();
});
