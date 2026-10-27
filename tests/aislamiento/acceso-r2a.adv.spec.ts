// Spec 005 · T16a · ronda adversarial 2a (regresión), capa de BD: la revalidación del invitador de 0015
// (H-005-1b-1, decisión del usuario) por una vía que T15 no prueba: el invitador con autoridad solo en OTRO estudio.
// Solo afirma el comportamiento seguro; estudios, usuarios e invitaciones propios (EscenarioAcceso, borrados al
// final). Los efectos de `auth.*` (si los hubiera) los borra la limpieza.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso } from "./acceso-soporte";
import { abrirAdmin, abrirApp, hashFalso, llamar } from "./auth-soporte";

let app: Pool;
let admin: Pool;
let ea: EscenarioAcceso;

beforeAll(() => {
  app = abrirApp(4);
  admin = abrirAdmin(4);
  ea = new EscenarioAcceso(admin);
});
afterAll(async () => {
  await ea?.limpiar();
  await app?.end();
  await admin?.end();
});

describe("T16a · invitador con autoridad solo en otro estudio (0015)", () => {
  // Un invitador sin membresía en A es imposible por la FK (tenant_id, invitado_por) -> membresia.
  it("una invitación dueno de A firmada por un Dueño de B que en A es Administrador o está desactivado no vale", async () => {
    const a = await ea.estudio();
    const bEst = await ea.estudio();
    await ea.miembro(a.id, "dueno");
    const adminEnA = await ea.miembro(bEst.id, "dueno");
    await ea.membresia(a.id, adminEnA.id, "admin");
    const desactivadoEnA = await ea.miembro(bEst.id, "dueno");
    await ea.membresia(a.id, desactivadoEnA.id, "dueno", { desactivada: true });

    const vistos: Record<string, string> = {};
    for (const [k, invitador] of Object.entries({ adminEnA, desactivadoEnA })) {
      const inv = await ea.invitacion(a.id, { invitadoPor: invitador.id, rol: "dueno" });
      const v = await llamar(app, "select * from auth.invitacion_vigente($1)", [inv.tokenHash]);
      const n = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [
        inv.tokenHash,
        "Invitado r2a",
        hashFalso(),
      ]);
      const m = await admin.query(
        "select count(*)::int as n from membresia mm join usuario u on u.id = mm.usuario_id where mm.tenant_id = $1 and u.email = $2",
        [a.id, inv.correo],
      );
      vistos[k] = `${v.ok ? v.rows.length : "error"}/${n.ok ? n.rows[0].r : "error"}/${m.rows[0].n}`;
    }
    // Valor: "<filas de vigente>/<resultado de aceptar_nueva>/<membresías creadas en A>".
    expect(vistos).toEqual({ adminEnA: "0/invalida/0", desactivadoEnA: "0/invalida/0" });
  });
});
