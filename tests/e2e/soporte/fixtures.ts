// Fixtures de la E2E (spec 018, plan «Soporte que usan los flujos»): extiende `test` de Playwright con la
// siembra por SQL, las sesiones por API, las acciones por API, el correo y la vigilancia de canarios (D-8).
// Los flujos importan `test` y `expect` de aquí, nunca de `@playwright/test`.
//
//   siembra     (worker)  estudio({plan}) · miembro(tenantId, rol) · membresia · cliente · asignar · comprasPorSql
//   sesiones              entrar(usuario, tenantId?) -> Sesion · paginaDe(usuario, tenantId?) -> { page, context, sesion }
//   api                   api(sesion) -> Api (credenciales, descarga, esperar trabajo, generar archivo, ZIP)
//   correo                enlaceDe(destinatario, asunto) · ultimo · cuantos
//   vigilancia  (auto)    permitirError(regex); falla la prueba con un centinela, `window.__pwn` o error de consola
//
// Cada contexto del navegador lleva su propio `X-Forwarded-For` (D-4): ninguna prueba comparte cupo de IP.
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { Api } from "./api.js";
import { Correo } from "./correo.js";
import { leerConfig } from "./pila/entorno.js";
import {
  abrirPagina,
  entrar,
  ipUnica,
  type PaginaAbierta,
  type Sesion,
} from "./sesiones.js";
import { Siembra, type Usuario } from "./siembra.js";
import { Vigilancia } from "./vigilancia.js";

export { CREDENCIALES_FIXTURE } from "./api.js";
export { RUCS } from "./siembra.js";
export { CENTINELAS } from "./vigilancia.js";
export type { Api } from "./api.js";
export type { Sesion } from "./sesiones.js";
export type { Cliente, Estudio, PlanCodigo, Rol, Usuario } from "./siembra.js";

/** Periodo de las propuestas de fixture del contribuyente de prueba (`fixtures/sire/*-202610.json`). */
export const PERIODO = "202610";

const PESOS_RUC = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** Dígito verificador módulo 11 de un RUC de 10 dígitos (el mismo de `validarRuc`). */
function digitoRuc(base: string): number {
  const suma = PESOS_RUC.reduce((s, p, i) => s + p * Number(base[i]), 0);
  return (11 - (suma % 11)) % 10;
}

/**
 * Un RUC válido (prefijo 20, dígito verificador correcto) que termina en el centinela pedido de los mocks:
 * 7 transitorio, 8 datos inválidos, 9 credencial rechazada. `variante` da RUC distintos para el mismo dígito.
 */
export function rucCentinela(ultimo: 7 | 8 | 9, variante = 0): string {
  let hallados = 0;
  for (let n = 0; n < 1_000_000; n += 1) {
    const base = `20800${String(n).padStart(5, "0")}`;
    if (digitoRuc(base) !== ultimo) continue;
    if (hallados === variante) return `${base}${ultimo}`;
    hallados += 1;
  }
  throw new Error("No hay RUC para ese centinela.");
}

/**
 * Un aviso por rol y texto. Los `<p role="alert">` y `role="status"` no tienen nombre accesible desde su
 * contenido, así que se buscan con `filter({ hasText })`, no con `getByRole(rol, { name })`.
 */
export function aviso(
  page: Page,
  rol: "alert" | "status",
  texto: string | RegExp,
): Locator {
  return page.getByRole(rol).filter({ hasText: texto });
}
export const alerta = (page: Page, texto: string | RegExp): Locator =>
  aviso(page, "alert", texto);
export const estado = (page: Page, texto: string | RegExp): Locator =>
  aviso(page, "status", texto);

export interface Sesiones {
  /** Sesión por API (cookie, CSRF, IP propia) para `api(sesion)` o para armar un `storageState`. */
  entrar(usuario: Usuario, tenantId?: string): Promise<Sesion>;
  /** Contexto nuevo del navegador ya con la sesión de ese usuario; se cierra solo al terminar la prueba. */
  paginaDe(usuario: Usuario, tenantId?: string): Promise<PaginaAbierta>;
}

interface FixturesDePrueba {
  vigilancia: Vigilancia;
  sesiones: Sesiones;
  api: (sesion: Sesion) => Api;
  correo: Correo;
}

interface FixturesDeWorker {
  siembra: Siembra;
}

export const test = base.extend<FixturesDePrueba, FixturesDeWorker>({
  siembra: [
    async ({}, use) => {
      const url = process.env.MIGRATIONS_DATABASE_URL;
      if (url === undefined) {
        throw new Error(
          "Falta MIGRATIONS_DATABASE_URL (la fija el globalSetup).",
        );
      }
      const siembra = new Siembra(url);
      await use(siembra);
      await siembra.cerrar();
    },
    { scope: "worker" },
  ],

  vigilancia: [
    async ({}, use) => {
      const vigilancia = new Vigilancia();
      await use(vigilancia);
      await vigilancia.verificar();
    },
    { auto: true },
  ],

  // IP propia por prueba para el contexto por defecto (E-01 registra y entra por la UI).
  extraHTTPHeaders: async ({}, use) => {
    await use({ "X-Forwarded-For": ipUnica() });
  },

  // El contexto por defecto también queda vigilado; su DOM final se mira antes de cerrarlo.
  context: async ({ context, vigilancia }, use) => {
    await vigilancia.observarContexto(context);
    await use(context);
    await vigilancia.revisarContexto(context);
  },

  sesiones: async ({ browser, vigilancia }, use) => {
    const abiertas: PaginaAbierta[] = [];
    await use({
      entrar: (usuario, tenantId) => entrar(usuario, tenantId),
      paginaDe: async (usuario, tenantId) => {
        const abierta = await abrirPagina(
          browser,
          usuario,
          tenantId,
          vigilancia,
        );
        abiertas.push(abierta);
        return abierta;
      },
    });
    for (const { context } of abiertas) {
      await vigilancia.revisarContexto(context);
      await context.close();
    }
  },

  api: async ({ vigilancia }, use) => {
    await use((sesion) => new Api(sesion, vigilancia));
  },

  correo: async ({}, use) => {
    const config = leerConfig();
    await use(new Correo(config.modoCorreo, config.mailpitUiPort));
  },
});

export { expect };
