// Ronda adversarial 2a (spec 003, T16a), caja blanca sin BD: reintenta por otra vía el hallazgo F1 de la
// ronda 1 (llave `mock` como activa en la rotación). Cada prueba afirma el comportamiento SEGURO esperado:
// si falla, es un hallazgo (ver tasks.md, T16a). No usa llaves reales.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContappDb } from "@contapp/db";
import { main } from "./cli/kek-rotar.js";

describe("T16a · F1 por otra vía: kek:rotar con el entorno por defecto (KEY_PROVIDER=mock)", () => {
  it("no consulta la BD y sale con error antes de re-envolver nada con la llave del fixture", async () => {
    let consultas = 0;
    const db = {
      withTenant: async () => {
        consultas += 1;
        throw new Error("no debería consultar la BD");
      },
    } as unknown as ContappDb;
    const salida: string[] = [];
    const codigo = await main(
      ["--desde", "r2a-k1", "--privada-anterior", "no-existe.pem", "--tenant", randomUUID().toLowerCase()],
      { KEY_PROVIDER: "mock", KEK_ID: "mock", NODE_ENV: "test" },
      {
        db: db as Pick<ContappDb, "withTenant">,
        escribir: (linea) => salida.push(linea),
        escribirError: (linea) => salida.push(linea),
      },
    );
    expect(codigo, "kek:rotar terminó bien con la llave mock").not.toBe(0);
    expect(consultas, "la CLI consultó la BD antes de rechazar la llave mock").toBe(0);
    expect(salida.join("\n")).toContain("rotacion_mock");
  });
});
