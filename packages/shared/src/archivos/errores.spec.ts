import { describe, expect, it } from "vitest";
import { CODIGOS_ERROR_ARCHIVO, codigoErrorArchivoSchema } from "./index.js";

// Spec 012b · T2 (rojo). Códigos de error `{codigo}` de archivos y de excluir/restaurar ventas (plan, Contratos: HTTP).
// Contrato: CODIGOS_ERROR_ARCHIVO es la lista cerrada (en este orden) y codigoErrorArchivoSchema es su z.enum.
// `solicitud_invalida` y los 403/404 genéricos no se repiten aquí: ya existen en 005/007.
const ESPERADOS = [
  "prevalidacion_fallida",
  "formato_no_oficial",
  "resumen_cambiado",
  "estado_invalido",
  "periodo_generado",
  "periodo_revisado",
  "cliente_archivado",
  "archivo_alterado",
  "no_excluible",
  "ya_excluida",
  "no_excluida",
] as const;

describe("códigos de error de archivos", () => {
  it("la lista cerrada trae exactamente los once códigos del plan", () => {
    expect([...CODIGOS_ERROR_ARCHIVO]).toEqual([...ESPERADOS]);
  });

  it("el esquema acepta cada código y rechaza cualquier otro", () => {
    for (const c of ESPERADOS) expect(codigoErrorArchivoSchema.safeParse(c).success).toBe(true);
    for (const c of ["solicitud_invalida", "PERIODO_GENERADO", "", " ya_excluida", null, 1]) {
      expect(codigoErrorArchivoSchema.safeParse(c).success).toBe(false);
    }
  });
});
