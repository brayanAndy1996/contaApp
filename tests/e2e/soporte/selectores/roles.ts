// Selectores y textos de «Equipo → Roles» (spec 030, T5). La pantalla la construye T10 y aún no existe: aquí vive TODO lo que el flujo
// supone de ella, para que T15 lo ajuste en un solo lugar si T10 eligió otros nombres. Lo que se supone:
//  - `/usuarios` trae un enlace «Roles» que lleva a `/usuarios/roles` (encabezado «Roles»).
//  - Un botón (o enlace) «Nuevo rol» y, por rol propio, «Editar» abren el formulario: campo «Nombre», lista desplegable «Alcance» con
//    valores `global` y `asignado`, y una casilla por permiso con `value="<permiso>"` (por ejemplo `clientes.ver`).
//  - «Guardar rol» envía el formulario y un `role="status"` confirma «Rol guardado.»; la lista muestra una fila (o ítem) por rol.
//  - Al editar, un aviso de impacto (U6, U8) menciona la verificación en dos pasos antes de guardar.
//  - El selector de rol de la invitación lista los roles propios por su nombre (la opción contiene «Practicante»).
import { expect, type Locator, type Page } from "@playwright/test";

export const RUTA_ROLES = "/usuarios/roles";

export const TEXTOS = {
  rolGuardado: "Rol guardado.",
  aviso2fa: /verificación en dos pasos/i,
} as const;

export const enlaceRoles = (page: Page): Locator =>
  page.getByRole("link", { name: "Roles", exact: true });
export const encabezadoRoles = (page: Page): Locator =>
  page.getByRole("heading", { name: "Roles", exact: true });

const boton = (donde: Page | Locator, nombre: string | RegExp): Locator =>
  donde
    .getByRole("button", { name: nombre })
    .or(donde.getByRole("link", { name: nombre }));

export const nuevoRol = (page: Page): Locator => boton(page, "Nuevo rol");
export const guardarRol = (page: Page): Locator =>
  page.getByRole("button", { name: /^Guardar/ });
export const campoNombre = (page: Page): Locator =>
  page.getByLabel("Nombre", { exact: true });
export const campoAlcance = (page: Page): Locator => page.getByLabel("Alcance");
export const casillaPermiso = (page: Page, permiso: string): Locator =>
  page.locator(`input[type="checkbox"][value="${permiso}"]`);

/** La fila (o ítem de lista) del rol con ese nombre. */
export const filaRol = (page: Page, nombre: string): Locator =>
  page
    .getByRole("row")
    .or(page.getByRole("listitem"))
    .filter({ hasText: nombre });
export const editarRol = (page: Page, nombre: string): Locator =>
  boton(filaRol(page, nombre).first(), /^Editar/);

/** Crea un rol propio como lo haría el Dueño: «Roles» → «Nuevo rol» → nombre, alcance y permisos → «Guardar rol». */
export async function crearRolPorPantalla(
  page: Page,
  rol: {
    nombre: string;
    alcance: "global" | "asignado";
    permisos: readonly string[];
  },
): Promise<void> {
  await page.goto("/usuarios");
  await enlaceRoles(page).click();
  await expect(page).toHaveURL(new RegExp(`${RUTA_ROLES}$`));
  await expect(encabezadoRoles(page)).toBeVisible();
  await nuevoRol(page).click();
  await campoNombre(page).fill(rol.nombre);
  await campoAlcance(page).selectOption(rol.alcance);
  for (const permiso of rol.permisos) {
    await casillaPermiso(page, permiso).check();
  }
  await guardarRol(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: TEXTOS.rolGuardado }),
  ).toBeVisible();
  await expect(filaRol(page, rol.nombre).first()).toBeVisible();
}

/** Elige en el selector «Rol» de la invitación la opción de un rol propio por su nombre (sin suponer cómo se rotula el resto). */
export async function elegirRolPropio(
  page: Page,
  nombre: string,
): Promise<void> {
  const combo = page.getByRole("combobox", { name: /^Rol/ });
  const opcion = combo.locator("option", { hasText: nombre }).first();
  await expect(opcion).toBeAttached();
  const valor = await opcion.getAttribute("value");
  if (valor === null) throw new Error("La opción del rol no trae valor.");
  await combo.selectOption(valor);
}
