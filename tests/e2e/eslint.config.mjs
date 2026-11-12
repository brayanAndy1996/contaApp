// Lint de tests/e2e: la configuración de la raíz más las salidas de Playwright.
import raiz from "../../eslint.config.mjs";

export default [
  ...raiz,
  { ignores: ["playwright-report/**", "test-results/**"] },
];
