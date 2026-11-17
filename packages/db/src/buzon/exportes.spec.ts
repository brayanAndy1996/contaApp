// Spec 023 (T4, rojo): lo que `@contapp/db` exporta para los consumidores del buzon (backend y worker): repositorios, error y
// los cuatro repos del candado del ciclo. Las firmas las fijan los demas *.spec.ts de esta carpeta.
import { describe, expect, it } from "vitest";
import * as db from "../index";

const FUNCIONES = [
  "leerEstadoBuzon",
  "listarMensajesBuzon",
  "leerMensajeBuzon",
  "leerAdjuntoBuzon",
  "insertarMensajeBuzon",
  "conocidosBuzon",
  "actualizarConocidosBuzon",
  "guardarEstadoCapturaBuzon",
  "guardarContenidoBuzon",
  "auditarBuzon",
  "candidatosBuzon",
  "encolarBuzonProgramados",
  "elevarPrioridadBuzon",
  "estudiosBuzon",
  "tomarCiclo",
  "renovarCiclo",
  "soltarCiclo",
] as const;

describe("exportes de @contapp/db para el buzon", () => {
  it.each(FUNCIONES)("exporta %s", (nombre) => {
    expect(typeof (db as Record<string, unknown>)[nombre], nombre).toBe(
      "function",
    );
  });

  it("exporta BuzonRepoError con el SQLSTATE en `codigo`", () => {
    const E = (
      db as unknown as {
        BuzonRepoError?: new (c: string) => Error & { codigo: string };
      }
    ).BuzonRepoError;
    expect(typeof E).toBe("function");
    expect(new E!("23503").codigo).toBe("23503");
  });

  it("exporta las tablas del esquema drizzle del buzon", () => {
    for (const t of ["buzonEstadoCliente", "buzonMensaje", "buzonAdjunto"]) {
      expect((db as Record<string, unknown>)[t], t).toBeDefined();
    }
  });
});
