// Apaga la pila al terminar la suite (spec 018, D-3): SIGTERM y SIGKILL a los 10 s, luego borra `contapp_e2e`
// (salvo E2E_CONSERVAR_BD=1) y el directorio temporal. Si la pila nunca arrancó, no hace nada.
import { rm } from "node:fs/promises";
import { borrarBd } from "./bd.js";
import { cargarDotenv, leerConfig } from "./entorno.js";
import { apagarProcesos, leerEstado } from "./procesos.js";

export default async function globalTeardown(): Promise<void> {
  const dir = process.env.E2E_PILA_DIR;
  if (dir === undefined) return;
  try {
    const estado = leerEstado(dir);
    if (estado !== undefined) {
      await apagarProcesos(estado.procesos);
      if (estado.bdCreada && !estado.conservarBd) {
        cargarDotenv();
        await borrarBd(leerConfig().urlMantenimiento);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.E2E_PILA_DIR;
  }
}
