// Spec 008 (T3, rojo): contrato de exportes de `@contapp/db` para trabajos y de `withSistema` (D18) sin BD.
import { afterEach, describe, expect, it } from "vitest";
import * as db from "../index";
import { createDb, type ContappDb } from "../client";
import { ConfiguracionDbError } from "../errores";

const URL_FALSA = "postgresql://contapp_app@localhost:1/contapp"; // sin contrasena; nunca se conecta
const abiertas: ContappDb[] = [];
afterEach(async () => {
  await Promise.all(abiertas.splice(0).map((d) => d.close()));
});
const crear = (rolApp: "contapp_backend" | "contapp_worker") => {
  const d = createDb({ rolApp, url: URL_FALSA });
  abiertas.push(d);
  return d;
};

const FUNCIONES = [
  "insertarTrabajo",
  "trabajoVivoPorClave",
  "contarPendientes",
  "siguienteDisponible",
  "transicionar",
  "leerTrabajo",
  "listarTrabajos",
  "posicion",
  "purgarTerminados",
  "revalidarEncolado",
  "marcarCredencialInvalida",
  "estadoCredencial",
  "leerConfig",
  "estudiosIds",
  "estudiosConTrabajos",
  "purgarAuth",
];

describe("exportes de @contapp/db (spec 008)", () => {
  it.each(FUNCIONES)("exporta %s como funcion", (nombre) => {
    expect(typeof (db as Record<string, unknown>)[nombre], nombre).toBe("function");
  });

  it("exporta TrabajosRepoError y mantiene los exportes de 002-005", () => {
    expect(typeof (db as Record<string, unknown>).TrabajosRepoError).toBe("function");
    for (const n of ["createDb", "guardarSobre", "reemplazarDekEnvuelta", "crearAuthRepo", "filtroAlcance", "SEED"]) {
      expect((db as Record<string, unknown>)[n], n).toBeDefined();
    }
    expect(db.WithTenantAnidadoError).toBeDefined();
    expect(db.ConfiguracionDbError).toBeDefined();
  });
});

describe("withSistema (D18): solo con rolApp = contapp_worker", () => {
  it("ContappDb del worker expone withSistema", () => {
    expect(typeof (crear("contapp_worker") as unknown as { withSistema?: unknown }).withSistema).toBe("function");
  });

  it("con rolApp = contapp_backend se rechaza con ConfiguracionDbError sin abrir conexion (el backend no enumera estudios)", async () => {
    const d = crear("contapp_backend") as unknown as { withSistema?: (fn: () => Promise<number>) => Promise<number> };
    expect(typeof d.withSistema).toBe("function");
    await expect(d.withSistema!(async () => 1)).rejects.toBeInstanceOf(ConfiguracionDbError);
  });
});
