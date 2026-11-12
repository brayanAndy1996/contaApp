// Configuración de las pruebas E2E de R1 (spec 018, D-7). La pila la levanta el globalSetup (D-2),
// no un webServer: la BD tiene que existir antes que el backend, y el worker no abre puerto.
import { defineConfig, devices } from "@playwright/test";
import { URL_FRONTEND } from "./soporte/pila/entorno.js";

const CI = !!process.env.CI;

// Mismo contexto para el proyecto y el nivel superior: 1440×900, es-PE, America/Lima (D-7).
const contexto = {
  baseURL: URL_FRONTEND,
  viewport: { width: 1440, height: 900 },
  locale: "es-PE",
  timezoneId: "America/Lima",
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  video: "off" as const,
};

export default defineConfig({
  testDir: "./flujos",
  testMatch: "**/*.e2e.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  workers: CI ? 2 : 4,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  globalSetup: "./soporte/pila/global-setup.ts",
  globalTeardown: "./soporte/pila/global-teardown.ts",
  use: contexto,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...contexto },
    },
  ],
});
