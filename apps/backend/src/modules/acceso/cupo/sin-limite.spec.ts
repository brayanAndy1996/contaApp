import { describe, expect, it } from "vitest";
import type { AuthRepo, Tx } from "@contapp/db";
import { CupoSinLimite } from "./sin-limite.js";

// T11 de 006 (cobertura): `CupoSinLimite` ya no lo usa la app (006 aporta `CupoUsuariosPlanes`); queda como doble de
// pruebas del puerto `CupoUsuarios` y su contrato es no limitar ni tocar la BD.
describe("CupoSinLimite", () => {
  const tx = { query: () => Promise.reject(new Error("no debe tocar la BD")) } as unknown as Tx;
  const auth = new Proxy({}, { get: () => () => Promise.reject(new Error("no debe tocar la BD")) }) as AuthRepo;

  it("alInvitar, alReactivar y alAceptar resuelven sin error y sin consultar nada", async () => {
    const cupo = new CupoSinLimite();
    await expect(cupo.alInvitar()).resolves.toBeUndefined();
    await expect(cupo.alReactivar()).resolves.toBeUndefined();
    await expect(cupo.alAceptar()).resolves.toBeUndefined();
    // Con los argumentos del puerto tampoco consulta.
    const puerto: import("./cupo-usuarios.js").CupoUsuarios = cupo;
    await expect(puerto.alInvitar(tx, "t")).resolves.toBeUndefined();
    await expect(puerto.alReactivar(tx, "t")).resolves.toBeUndefined();
    await expect(puerto.alAceptar(auth, "t")).resolves.toBeUndefined();
  });
});
