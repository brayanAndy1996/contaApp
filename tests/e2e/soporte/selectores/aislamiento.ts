// Selectores de E-11 (spec 018, T8): el aviso de «no encontrado», el selector de estudio y el listado de clientes.
import type { Locator, Page } from "@playwright/test";

export const AVISO_NO_ENCONTRADO = "No se encontró lo que buscas.";

export const selectorDeEstudio = (page: Page): Locator =>
  page.getByRole("combobox", { name: /^Estudio/ });

export const tablaDeClientes = (page: Page): Locator => page.getByRole("table");
