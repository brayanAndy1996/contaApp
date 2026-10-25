// Ronda adversarial 2b (spec 003, T16b), sin BD: motivo con caracteres de control o inyección en logs y
// auditoría. Cada prueba afirma el comportamiento SEGURO esperado: si falla, es un hallazgo (tasks.md, T16b).
import { crearKeyUnwrapper } from "@contapp/crypto/descifrado";
import { describe, expect, it } from "vitest";
import { ENV_MOCK, dbProhibido, loggerEspia, uuid, volcado } from "../../test/soporte.js";
import { crearServicioCredenciales } from "./descifrar-credencial.js";

const MOTIVOS_HOSTILES: Array<[string, unknown]> = [
  ["salto de línea que falsea un campo", "job:1\nresultado=ok tenant=otro"],
  ["CRLF", "job:1\r\nINFO descifrado ok"],
  ["NUL", "job:1\u0000x"],
  ["separador de línea U+2028", "job:1 x"],
  ["secuencia ANSI", "job:1\u001b[2Kx"],
  ["tabulador", "job:1\tx"],
  ["espacio", "job 1"],
  ["comilla e inyección SQL", "job'; delete from auditoria_descifrado;--"],
  ["dígito de ancho completo", "job:１"],
  ["121 caracteres", "j".repeat(121)],
  ["vacío", ""],
  ["no string", { toString: () => "job:1" }],
];

describe("T16b · motivo hostil", () => {
  it.each(MOTIVOS_HOSTILES)(
    "%s: se rechaza antes de la BD, sin log y sin reflejar el valor en el error",
    async (_n, motivo) => {
      const prohibido = dbProhibido();
      const { logger, llamadas } = loggerEspia();
      const servicio = crearServicioCredenciales({
        db: prohibido.db as never,
        unwrapper: crearKeyUnwrapper(ENV_MOCK),
        logger: logger as never,
      });
      let error: unknown;
      try {
        await servicio.descifrarCredencial({ tenantId: uuid() }, uuid(), motivo as string);
      } catch (e) {
        error = e;
      }
      expect((error as { codigo?: string } | undefined)?.codigo).toBe("argumento_invalido");
      expect(prohibido.usos()).toBe(0);
      expect(llamadas).toEqual([]);
      if (typeof motivo === "string" && motivo.length > 3) {
        expect(volcado(error).includes(motivo)).toBe(false);
      }
    },
  );
});
