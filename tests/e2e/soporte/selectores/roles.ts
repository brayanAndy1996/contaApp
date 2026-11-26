// Selectores y textos de «Equipo → Roles» (spec 030, T5, ajustados a la pantalla real en T15; `apps/frontend/app/(app)/usuarios/roles/`):
//  - El menú principal trae el enlace «Roles» (solo con `roles.gestionar`) que lleva a `/usuarios/roles` (encabezado «Roles»).
//  - El botón «Crear rol» y, por rol propio, «Editar» abren el formulario: campo «Nombre», lista «Alcance» (valores `global` y `asignado`)
//    y una casilla por permiso cuyo nombre accesible es el código (por ejemplo `clientes.ver`).
//  - «Guardar» envía el formulario y un `role="status"` confirma «Rol creado.» o «Rol guardado.».
//  - Al editar un rol en uso, «Guardar» abre el aviso de impacto (U6, U8: «Afecta a N miembros.», «N miembros deberán activar el segundo
//    factor (TOTP).») y «Confirmar» aplica el cambio.
//  - El selector de rol de la invitación lista los roles propios por su nombre (la opción contiene «Practicante»).
import { expect, type Locator, type Page } from "@playwright/test";

export const RUTA_ROLES = "/usuarios/roles";

export const TEXTOS = {
  rolCreado: "Rol creado.",
  rolGuardado: "Rol guardado.",
  nombreInvalido: "El nombre tiene espacios o caracteres no permitidos.",
  impactoMiembros: "Afecta a 1 miembros.",
  aviso2fa: /1 miembros deberán activar el segundo factor \(TOTP\)\./,
} as const;

export const enlaceRoles = (page: Page): Locator =>
  page.getByRole("link", { name: "Roles", exact: true });
export const encabezadoRoles = (page: Page): Locator =>
  page.getByRole("heading", { name: "Roles", exact: true });

const boton = (donde: Page | Locator, nombre: string | RegExp): Locator =>
  donde
    .getByRole("button", { name: nombre })
    .or(donde.getByRole("link", { name: nombre }));

export const nuevoRol = (page: Page): Locator => boton(page, "Crear rol");
export const guardarRol = (page: Page): Locator =>
  page.getByRole("button", { name: "Guardar", exact: true });
export const confirmarRol = (page: Page): Locator =>
  page.getByRole("button", { name: "Confirmar", exact: true });
export const campoNombre = (page: Page): Locator =>
  page.getByLabel("Nombre", { exact: true });
export const campoAlcance = (page: Page): Locator => page.getByLabel("Alcance");
export const casillaPermiso = (page: Page, permiso: string): Locator =>
  page.getByRole("checkbox", { name: permiso, exact: true });

/** La fila (o ítem de lista) del rol con ese nombre. */
export const filaRol = (page: Page, nombre: string): Locator =>
  page
    .getByRole("row")
    .or(page.getByRole("listitem"))
    .filter({ hasText: nombre });
export const editarRol = (page: Page, nombre: string): Locator =>
  boton(filaRol(page, nombre).first(), /^Editar/);

/** Crea un rol propio como lo haría el Dueño: «Roles» → «Crear rol» → nombre, alcance y permisos → «Guardar». */
export async function crearRolPorPantalla(
  page: Page,
  rol: {
    nombre: string;
    alcance: "global" | "asignado";
    permisos: readonly string[];
  },
): Promise<void> {
  await irARoles(page);
  await abrirNuevoRol(page);
  await campoNombre(page).fill(rol.nombre);
  await campoAlcance(page).selectOption(rol.alcance);
  for (const permiso of rol.permisos) {
    await casillaPermiso(page, permiso).check();
  }
  await guardarRol(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: TEXTOS.rolCreado }),
  ).toBeVisible();
  await expect(filaRol(page, rol.nombre).first()).toBeVisible();
}

/** Desde `/usuarios`: el enlace «Roles» del menú y el formulario «Crear rol» abierto y vacío. */
export async function abrirNuevoRol(page: Page): Promise<void> {
  await nuevoRol(page).click();
  await expect(campoNombre(page)).toBeVisible();
}

/** Lleva a «Roles» por el menú (desde `/usuarios`) y espera el encabezado. */
export async function irARoles(page: Page): Promise<void> {
  await page.goto("/usuarios");
  await enlaceRoles(page).click();
  await expect(page).toHaveURL(new RegExp(`${RUTA_ROLES}$`));
  await expect(encabezadoRoles(page)).toBeVisible();
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
