// Spec 030 (T6) · lo que T1 dejó fuera: `revocarPendientesDe` (005 D8) con invitaciones a roles propios y el aviso de credencial
// inválida (U10) con roles propios en el estudio. Contra la BD real; cada prueba crea sus estudios (EscenarioRoles) y los borra.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import { EscenarioRoles, PERMISOS_ASIGNABLES } from "./roles-soporte";
import type { Tx } from "./soporte";

vi.setConfig({ testTimeout: 60_000 });

let admin: Pool;
let er: EscenarioRoles;
beforeAll(() => {
  admin = abrirAdmin(4);
  er = new EscenarioRoles(admin);
});
afterAll(async () => {
  await er?.limpiar();
  await er?.cerrar();
  await admin?.end();
});
const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;

type RolQueConserva = string | { rolId: string };
const revocarPendientesDe = () => exportado<(tx: Tx, usuarioId: string, roles: readonly RolQueConserva[]) => Promise<number>>("revocarPendientesDe");

describe("revocarPendientesDe con roles propios (005 D8, 030)", () => {
  it("conserva las de sistema y las propias cuyo id sigue en la lista; revoca las demás propias ('propio' a secas no conserva ninguna)", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const invitador = await er.miembro(x.id, "admin");
    const conservado = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const perdido = await er.rol(x.id, { permisos: ["clientes.ver", "sire.descargar"] });
    const iConservada = await er.invitacionPropia(x.id, conservado.id, invitador.id);
    const iPerdida = await er.invitacionPropia(x.id, perdido.id, invitador.id);
    const iLectura = await er.invitacion(x.id, { invitadoPor: invitador.id, rol: "lectura" });
    const iContador = await er.invitacion(x.id, { invitadoPor: invitador.id, rol: "contador" });
    const ajena = await er.invitacionPropia(x.id, perdido.id, d.id);
    const db = er.backend();
    const n = await db.withTenant({ tenantId: x.id, userId: d.id }, (tx) =>
      revocarPendientesDe()(tx, invitador.id, ["lectura", "propio", { rolId: conservado.id.toUpperCase() }]),
    );
    expect(n).toBe(2);
    const revocadas = (await adm("select id from invitacion where tenant_id = $1 and revocada_en is not null", [x.id])).map((r) => r.id).sort();
    expect(revocadas).toEqual([iPerdida.id, iContador.id].sort());
    for (const i of [iConservada, iLectura, ajena]) expect(revocadas).not.toContain(i.id);
  });

  it("desactivar (lista vacía) revoca también las de roles propios", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const rol = await er.rol(x.id, { permisos: ["clientes.ver"] });
    await er.invitacionPropia(x.id, rol.id, d.id);
    const db = er.backend();
    expect(await db.withTenant({ tenantId: x.id, userId: d.id }, (tx) => revocarPendientesDe()(tx, d.id, []))).toBe(1);
  });
});

describe("U10: el aviso de credencial inválida sigue solo para Dueño y Administrador", () => {
  async function escenario() {
    const x = await er.estudio();
    const dueno = await er.miembro(x.id, "dueno");
    const adminU = await er.miembro(x.id, "admin");
    const rolG = await er.rol(x.id, { alcance: "global", permisos: PERMISOS_ASIGNABLES });
    const propio = await er.miembroPropio(x.id, rolG.id);
    const cliente = await er.cliente(x.id);
    const cred = (
      await adm(
        `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
         values ($1, $2, 'sol', $3, $4, $5, $6, 'k1', 1) returning id`,
        [x.id, cliente, randomBytes(32), randomBytes(12), randomBytes(16), randomBytes(40)],
      )
    )[0].id as string;
    return { x, dueno, adminU, propio, cliente, cred };
  }
  const invalidar = (cred: string) => adm("update credencial set estado = 'invalida' where id = $1", [cred]);
  const avisados = async (tenant: string) =>
    (await adm("select usuario_id from notificacion where tenant_id = $1 and tipo = 'credencial_invalida' order by usuario_id", [tenant])).map(
      (r) => r.usuario_id as string,
    );

  it("cliente sin responsable: avisa a Dueño y Administrador, no al rol propio con todos los permisos", async () => {
    const e = await escenario();
    await invalidar(e.cred);
    expect(await avisados(e.x.id)).toEqual([e.dueno.id, e.adminU.id].sort());
  });

  it("si el rol propio es el responsable activo, el aviso va al responsable (regla del responsable intacta)", async () => {
    const e = await escenario();
    await er.asignar(e.x.id, e.cliente, e.propio.id, "responsable");
    await invalidar(e.cred);
    expect(await avisados(e.x.id)).toEqual([e.propio.id]);
  });
});
