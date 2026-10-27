// Spec 005 (T2, rojo): repositorios de `acceso` contra la BD real (CA-5, CA-7, CA-8, CA-9, CA-10; D5, D18, D19).
// Se importan de `@contapp/db` por nombre (si faltan, la prueba dice cual); cada prueba crea sus estudios,
// usuarios y clientes (EscenarioAcceso) y los borra al final.
//
// Contrato que fija (T7, `packages/db/src/acceso/**`; todas reciben la `tx` de withTenant como primer argumento):
//   alcance:      type Alcance = { tipo: 'global' } | { tipo: 'asignado'; usuarioId: string }
//                 filtroAlcance(columnaClienteId, a): SQL de drizzle (global -> true; asignado -> EXISTS asignacion)
//                 clienteVisible(tx, clienteId, a): Promise<boolean>
//   clientes:     listarClientes(tx, a): [{ id, ruc, razonSocial, responsable: { usuarioId, nombre } | null }] por razon_social
//                 leerCliente(tx, clienteId): { id, ruc, razonSocial } | null
//   miembros:     miembroActual(tx, usuarioId): { usuarioId, rol } | null  (solo membresia ACTIVA)
//                 listarMiembros(tx): [{ usuarioId, nombre, correo, rol, activo }]  (activos y desactivados)
//                 bloquearMiembro(tx, usuarioId): { usuarioId, rol, activo } | null  (FOR UPDATE, incluye desactivados)
//                 cambiarRol(tx, usuarioId, rol) · desactivar(tx, usuarioId) (fija desactivada_en y BORRA sus asignaciones: D19)
//                 · reactivar(tx, usuarioId) (limpia desactivada_en; no devuelve asignaciones)
//   asignaciones: asignar(tx, { clienteId, usuarioId, tipo, anterior? }) · retirar(tx, { clienteId, usuarioId })
//                 asignarPorUsuario(tx, { usuarioId, clienteIds, tipo, anterior? }) · asignarPorCliente(tx, { clienteId, usuarioIds })
//                 `anterior` ('colaborador' | 'retirar') dice que hacer con el responsable previo al elegir uno nuevo;
//                 los lotes son todo o nada y se rechazan (lanzan o devuelven null) si algun cliente o usuario no es del
//                 estudio, o el usuario esta desactivado.
//   invitaciones: crearInvitacion(tx, { correo, rol, invitadoPor, tokenHash }) · listarInvitaciones(tx)
//                 reenviar(tx, invitacionId, tokenHashNuevo) · revocar(tx, invitacionId)   (null si no existe, es de otro
//                 estudio o ya esta aceptada/revocada). Elemento de lista: { id, correo, rol, invitadoPor: { usuarioId, nombre },
//                 creadaEn, venceEn, vencida } y NUNCA token ni hash.
//   errores:      AccesoRepoError con `codigo` = SQLSTATE y sin detail/where/constraint/table/column/cause.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso, sha256 } from "./acceso-soporte";
import { abrirAdmin, crearDb, exportado, llamar } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";

type Alcance = { tipo: "global" } | { tipo: "asignado"; usuarioId: string };
type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);

let admin: Pool;
let app: Pool;
let ea: EscenarioAcceso;
const dbs: ContappDb[] = [];
beforeAll(() => {
  admin = abrirAdmin(6);
  app = admin; // solo para llamar a funciones auth con `llamar` desde el pool administrativo (rol por SET LOCAL ROLE)
  ea = new EscenarioAcceso(admin);
});
afterAll(async () => {
  await ea?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await admin?.end();
});

const dbBackend = (max = 3): ContappDb => {
  const d = crearDb("contapp_backend", max);
  dbs.push(d);
  return d;
};
const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const GLOBAL: Alcance = { tipo: "global" };
const asignado = (usuarioId: string): Alcance => ({ tipo: "asignado", usuarioId });
const enTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>, db = dbBackend()) => db.withTenant({ tenantId }, fn);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const conteo = async (sql: string, v: unknown[]) => Number((await adm(sql, v))[0].n);

/** Ejecuta `fn` y devuelve { rechazo, error }: rechazo = lanzo o devolvio null/false (el contrato admite ambas). */
async function intentarLote(fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    return { rechazo: r === null || r === undefined || r === false, error: undefined as unknown };
  } catch (error) {
    return { rechazo: true, error };
  }
}

// =================================================================================================
describe("filtroAlcance, clienteVisible y listarClientes (D5, CA-5)", () => {
  async function preparar() {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const s = await ea.miembro(x.id, "asistente");
    const s2 = await ea.miembro(x.id, "asistente");
    const clientes = await ea.clientes(x.id, 120);
    const mios = clientes.slice(0, 15);
    await ea.asignar(x.id, mios[0]!, s.id, "responsable");
    for (const c of mios.slice(1)) await ea.asignar(x.id, c, s.id, "colaborador");
    const de2 = clientes.slice(15, 20);
    for (const c of de2) await ea.asignar(x.id, c, s2.id, "colaborador");
    const ajeno = await ea.cliente(y.id);
    return { x, y, s, s2, clientes, mios, de2, ajeno };
  }

  it("listarClientes global devuelve los 120 del estudio, ordenados por razon social, con RUC y razon social", async () => {
    const { x, clientes } = await preparar();
    const r = await enTenant(x.id, (tx) => f("listarClientes")(tx, GLOBAL));
    expect(ids(r)).toEqual(clientes);
    expect(Object.keys(r[0]).sort()).toEqual(["id", "razonSocial", "responsable", "ruc"]);
  });

  it("un asistente con 15 de 120 clientes asignados ve exactamente esos 15 (CA-5)", async () => {
    const { x, s, s2, mios, de2 } = await preparar();
    const r = await enTenant(x.id, (tx) => f("listarClientes")(tx, asignado(s.id)));
    expect(ids(r)).toEqual(mios);
    const r2 = await enTenant(x.id, (tx) => f("listarClientes")(tx, asignado(s2.id)));
    expect(ids(r2)).toEqual(de2);
  });

  it("sin asignaciones no ve nada; una asignacion del mismo usuario en OTRO estudio no cuenta", async () => {
    const { x, y } = await preparar();
    const solitario = await ea.miembro(x.id, "lectura");
    expect(await enTenant(x.id, (tx) => f("listarClientes")(tx, asignado(solitario.id)))).toEqual([]);
    // el mismo usuario con asignacion en Y: en el contexto de X sigue sin ver nada de X
    await ea.membresia(y.id, solitario.id, "lectura");
    const cy = await ea.cliente(y.id);
    await ea.asignar(y.id, cy, solitario.id, "colaborador");
    expect(await enTenant(x.id, (tx) => f("listarClientes")(tx, asignado(solitario.id)))).toEqual([]);
    expect(ids(await enTenant(y.id, (tx) => f("listarClientes")(tx, asignado(solitario.id))))).toEqual([cy]);
  });

  it("responsable: el nombre del responsable aparece en su cliente y es null en los colaborados o sin asignar", async () => {
    const { x, s, mios, clientes } = await preparar();
    const r = await enTenant(x.id, (tx) => f("listarClientes")(tx, GLOBAL));
    const porId = Object.fromEntries(r.map((c: any) => [c.id, c]));
    expect(porId[mios[0]!].responsable).toEqual({
      usuarioId: s.id,
      nombre: (await adm("select nombre from usuario where id = $1", [s.id]))[0].nombre,
    });
    expect(porId[mios[1]!].responsable).toBeNull();
    expect(porId[clientes[100]!].responsable).toBeNull();
  });

  it("clienteVisible: global ve los del estudio; asignado solo los asignados; inexistente y de otro estudio, nunca", async () => {
    const { x, s, mios, de2, clientes, ajeno } = await preparar();
    const visible = (id: string, a: Alcance) => enTenant(x.id, (tx) => f("clienteVisible")(tx, id, a)) as Promise<boolean>;
    expect(await visible(clientes[50]!, GLOBAL)).toBe(true);
    expect(await visible(mios[3]!, asignado(s.id))).toBe(true);
    expect(await visible(de2[0]!, asignado(s.id))).toBe(false); // de otro usuario
    expect(await visible(clientes[50]!, asignado(s.id))).toBe(false); // sin asignar
    expect(await visible(ajeno, GLOBAL)).toBe(false); // de otro estudio: la RLS lo oculta
    expect(await visible(ajeno, asignado(s.id))).toBe(false);
    expect(await visible("01920000-0000-7000-8000-00000000dead", GLOBAL)).toBe(false); // inexistente
    expect(await visible(mios[0]!, asignado("01920000-0000-7000-8000-00000000dead"))).toBe(false);
  });

  it("filtroAlcance como condicion de una consulta drizzle: global no filtra; asignado deja solo los asignados", async () => {
    const { x, s, mios } = await preparar();
    const schema = exportado<any>("schema");
    const filtroAlcance = f("filtroAlcance") as unknown as (col: unknown, a: Alcance) => unknown;
    const contar = (a: Alcance) =>
      enTenant(x.id, async (tx: any) => {
        const r = await tx.orm
          .select({ id: schema.cliente.id })
          .from(schema.cliente)
          .where(filtroAlcance(schema.cliente.id, a));
        return r.map((c: { id: string }) => c.id).sort();
      });
    expect(await contar(GLOBAL)).toHaveLength(120);
    expect(await contar(asignado(s.id))).toEqual([...mios].sort());
  });

  it("leerCliente devuelve id, RUC y razon social del cliente del estudio y nada del de otro estudio", async () => {
    const { x, clientes, ajeno } = await preparar();
    const c = await enTenant(x.id, (tx) => f("leerCliente")(tx, clientes[7]!));
    expect(c).toMatchObject({ id: clientes[7] });
    expect(Object.keys(c).sort()).toEqual(["id", "razonSocial", "ruc"]);
    expect(await enTenant(x.id, (tx) => f("leerCliente")(tx, ajeno))).toBeFalsy();
  });
});

// =================================================================================================
describe("miembros: lectura, rol, desactivar y reactivar (CA-6, CA-9, D3, D19)", () => {
  it("miembroActual devuelve el rol de la membresia activa y null si esta desactivada, es de otro estudio o no existe", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const activo = await ea.miembro(x.id, "asistente");
    const inactivo = await ea.miembro(x.id, "contador", { desactivada: true });
    const deY = await ea.miembro(y.id, "contador");
    const actual = (u: string) => enTenant(x.id, (tx) => f("miembroActual")(tx, u));
    expect(await actual(activo.id)).toMatchObject({ usuarioId: activo.id, rol: "asistente" });
    expect(await actual(inactivo.id)).toBeNull();
    expect(await actual(deY.id)).toBeNull();
    expect(await actual("01920000-0000-7000-8000-00000000dead")).toBeNull();
  });

  it("listarMiembros devuelve activos y desactivados del estudio (nunca de otro) con rol y estado", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const a = await ea.miembro(x.id, "admin");
    const i = await ea.miembro(x.id, "lectura", { desactivada: true });
    await ea.miembro(y.id, "dueno");
    const r = await enTenant(x.id, (tx) => f("listarMiembros")(tx));
    const porId = Object.fromEntries(r.map((m: any) => [m.usuarioId, m]));
    expect(Object.keys(porId).sort()).toEqual([d.id, a.id, i.id].sort());
    expect(porId[d.id]).toMatchObject({ rol: "dueno", activo: true, correo: d.correo });
    expect(porId[a.id]).toMatchObject({ rol: "admin", activo: true });
    expect(porId[i.id]).toMatchObject({ rol: "lectura", activo: false });
    expect(Object.keys(porId[d.id]).sort()).toEqual(["activo", "correo", "nombre", "rol", "usuarioId"]);
  });

  it("bloquearMiembro encuentra tambien a los desactivados y devuelve null para uno de otro estudio", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const inactivo = await ea.miembro(x.id, "contador", { desactivada: true });
    const deY = await ea.miembro(y.id, "contador");
    expect(await enTenant(x.id, (tx) => f("bloquearMiembro")(tx, inactivo.id))).toMatchObject({
      usuarioId: inactivo.id,
      rol: "contador",
      activo: false,
    });
    expect(await enTenant(x.id, (tx) => f("bloquearMiembro")(tx, deY.id))).toBeNull();
  });

  it("cambiarRol modifica el rol de la membresia y solo la del estudio del contexto", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.cuenta();
    await ea.membresia(x.id, u.id, "asistente");
    await ea.membresia(y.id, u.id, "asistente");
    await enTenant(x.id, (tx) => f("cambiarRol")(tx, u.id, "contador"));
    const roles = await adm("select tenant_id, rol from membresia where usuario_id = $1 order by rol", [u.id]);
    expect(roles).toEqual(
      [
        { tenant_id: x.id, rol: "contador" },
        { tenant_id: y.id, rol: "asistente" },
      ].sort((p, q) => p.rol.localeCompare(q.rol)),
    );
  });

  it("desactivar marca la membresia, BORRA todas sus asignaciones (responsable y colaborador) y conserva al usuario (CA-9, D19)", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "contador");
    const otro = await ea.miembro(x.id, "contador");
    const [c1, c2, c3] = await ea.clientes(x.id, 3);
    await ea.asignar(x.id, c1!, u.id, "responsable");
    await ea.asignar(x.id, c2!, u.id, "colaborador");
    await ea.asignar(x.id, c3!, otro.id, "colaborador");
    await enTenant(x.id, (tx) => f("desactivar")(tx, u.id));
    const m = (await adm("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [x.id, u.id]))[0];
    expect(m.rol).toBe("contador");
    expect(m.desactivada_en).toBeInstanceOf(Date);
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(0);
    // las ajenas siguen y el cliente de la responsable queda "sin responsable"
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [otro.id])).toBe(1);
    expect(await conteo("select count(*)::int as n from asignacion where cliente_id = $1 and tipo = 'responsable'", [c1])).toBe(0);
    expect(await conteo("select count(*)::int as n from usuario where id = $1", [u.id])).toBe(1);
  });

  it("reactivar devuelve el acceso con su rol pero NO restituye las asignaciones (D19)", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "asistente");
    const c = await ea.cliente(x.id);
    await ea.asignar(x.id, c, u.id, "colaborador");
    await enTenant(x.id, (tx) => f("desactivar")(tx, u.id));
    await enTenant(x.id, (tx) => f("reactivar")(tx, u.id));
    const m = (await adm("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [x.id, u.id]))[0];
    expect(m).toEqual({ rol: "asistente", desactivada_en: null });
    expect(await enTenant(x.id, (tx) => f("miembroActual")(tx, u.id))).toMatchObject({ usuarioId: u.id, rol: "asistente" });
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(0);
  });

  it("desactivar al unico Dueño falla con AccesoRepoError (SQLSTATE P0001) y no borra sus asignaciones ni marca nada (CA-10)", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const c = await ea.cliente(x.id);
    await ea.asignar(x.id, c, d.id, "colaborador");
    const AccesoRepoError = exportado<new (...a: any[]) => Error & { codigo: string }>("AccesoRepoError");
    const e: any = await enTenant(x.id, (tx) => f("desactivar")(tx, d.id)).catch((q: unknown) => q);
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("P0001");
    for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) expect(e).not.toHaveProperty(campo);
    expect((await adm("select desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [x.id, d.id]))[0].desactivada_en).toBeNull();
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [d.id])).toBe(1);
  });
});

// =================================================================================================
describe("asignaciones individuales (CA-7)", () => {
  it("asignar crea la asignacion con el tipo pedido; repetirla no duplica filas", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "contador");
    const c = await ea.cliente(x.id);
    await enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: c, usuarioId: u.id, tipo: "colaborador" }));
    await enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: c, usuarioId: u.id, tipo: "colaborador" }));
    const r = await adm("select tipo from asignacion where cliente_id = $1 and usuario_id = $2", [c, u.id]);
    expect(r).toEqual([{ tipo: "colaborador" }]);
  });

  it("elegir un responsable nuevo con anterior='colaborador' deja al previo como colaborador y un solo responsable", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const a = await ea.miembro(x.id, "contador");
    const b = await ea.miembro(x.id, "contador");
    const c = await ea.cliente(x.id);
    await ea.asignar(x.id, c, a.id, "responsable");
    await enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: c, usuarioId: b.id, tipo: "responsable", anterior: "colaborador" }));
    const r = await adm("select usuario_id, tipo from asignacion where cliente_id = $1", [c]);
    expect(Object.fromEntries(r.map((q) => [q.usuario_id, q.tipo]))).toEqual({ [a.id]: "colaborador", [b.id]: "responsable" });
  });

  it("elegir un responsable nuevo con anterior='retirar' elimina al previo", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const a = await ea.miembro(x.id, "contador");
    const b = await ea.miembro(x.id, "contador");
    const c = await ea.cliente(x.id);
    await ea.asignar(x.id, c, a.id, "responsable");
    await enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: c, usuarioId: b.id, tipo: "responsable", anterior: "retirar" }));
    const r = await adm("select usuario_id, tipo from asignacion where cliente_id = $1", [c]);
    expect(r).toEqual([{ usuario_id: b.id, tipo: "responsable" }]);
  });

  it("DOS CONEXIONES eligiendo responsable para el mismo cliente a la vez dejan exactamente un responsable", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const a = await ea.miembro(x.id, "contador");
    const b = await ea.miembro(x.id, "contador");
    const c = await ea.cliente(x.id);
    const poner = (u: string) =>
      enTenant(
        x.id,
        async (tx) => {
          await f("asignar")(tx, { clienteId: c, usuarioId: u, tipo: "responsable", anterior: "colaborador" });
          await tx.query("select pg_sleep(0.4)"); // mantiene abierta la transaccion para forzar el solape
        },
        dbBackend(1),
      );
    const r = await Promise.allSettled([poner(a.id), poner(b.id)]);
    expect(r.some((q) => q.status === "fulfilled")).toBe(true);
    for (const q of r.filter((z): z is PromiseRejectedResult => z.status === "rejected")) {
      expect(["23505", "40001", "40P01"]).toContain((q.reason as { codigo?: string; code?: string }).codigo ?? (q.reason as any).code);
    }
    expect(await conteo("select count(*)::int as n from asignacion where cliente_id = $1 and tipo = 'responsable'", [c])).toBe(1);
  });

  it("asignar un usuario o un cliente de otro estudio se rechaza y no deja nada", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "contador");
    const deY = await ea.miembro(y.id, "contador");
    const c = await ea.cliente(x.id);
    const cy = await ea.cliente(y.id);
    const a1 = await intentarLote(() => enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: c, usuarioId: deY.id, tipo: "colaborador" })));
    const a2 = await intentarLote(() => enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: cy, usuarioId: u.id, tipo: "colaborador" })));
    expect(a1.rechazo).toBe(true);
    expect(a2.rechazo).toBe(true);
    expect(await conteo("select count(*)::int as n from asignacion where tenant_id = any($1::uuid[])", [[x.id, y.id]])).toBe(0);
  });

  it("asignar a un miembro desactivado se rechaza (miembro_no_asignable)", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const inactivo = await ea.miembro(x.id, "contador", { desactivada: true });
    const c = await ea.cliente(x.id);
    const r = await intentarLote(() => enTenant(x.id, (tx) => f("asignar")(tx, { clienteId: c, usuarioId: inactivo.id, tipo: "colaborador" })));
    expect(r.rechazo).toBe(true);
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [inactivo.id])).toBe(0);
  });

  it("retirar elimina solo esa asignacion", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "contador");
    const [c1, c2] = await ea.clientes(x.id, 2);
    await ea.asignar(x.id, c1!, u.id, "colaborador");
    await ea.asignar(x.id, c2!, u.id, "colaborador");
    await enTenant(x.id, (tx) => f("retirar")(tx, { clienteId: c1, usuarioId: u.id }));
    const r = await adm("select cliente_id from asignacion where usuario_id = $1", [u.id]);
    expect(r).toEqual([{ cliente_id: c2 }]);
  });
});

// =================================================================================================
describe("asignacion masiva: todo o nada (CA-8)", () => {
  async function preparar() {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "contador");
    const clientes = await ea.clientes(x.id, 8);
    const ajeno = await ea.cliente(y.id);
    return { x, y, u, clientes, ajeno };
  }

  it("asignarPorUsuario aplica todos los clientes del lote con el tipo pedido", async () => {
    const { x, u, clientes } = await preparar();
    await enTenant(x.id, (tx) => f("asignarPorUsuario")(tx, { usuarioId: u.id, clienteIds: clientes, tipo: "colaborador" }));
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1 and tipo = 'colaborador'", [u.id])).toBe(8);
  });

  it("asignarPorUsuario con UN cliente de otro estudio no aplica nada", async () => {
    const { x, u, clientes, ajeno } = await preparar();
    const lote = [...clientes.slice(0, 5), ajeno, ...clientes.slice(5)];
    const r = await intentarLote(() =>
      enTenant(x.id, (tx) => f("asignarPorUsuario")(tx, { usuarioId: u.id, clienteIds: lote, tipo: "colaborador" })),
    );
    expect(r.rechazo).toBe(true);
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(0);
  });

  it("asignarPorUsuario con un cliente inexistente no aplica nada", async () => {
    const { x, u, clientes } = await preparar();
    const lote = [...clientes, "01920000-0000-7000-8000-00000000dead"];
    const r = await intentarLote(() =>
      enTenant(x.id, (tx) => f("asignarPorUsuario")(tx, { usuarioId: u.id, clienteIds: lote, tipo: "colaborador" })),
    );
    expect(r.rechazo).toBe(true);
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(0);
  });

  it("asignarPorUsuario a un usuario de otro estudio o desactivado no aplica nada", async () => {
    const { x, y, clientes } = await preparar();
    const deY = await ea.miembro(y.id, "contador");
    const inactivo = await ea.miembro(x.id, "contador", { desactivada: true });
    for (const u of [deY, inactivo]) {
      const r = await intentarLote(() =>
        enTenant(x.id, (tx) => f("asignarPorUsuario")(tx, { usuarioId: u.id, clienteIds: clientes, tipo: "colaborador" })),
      );
      expect(r.rechazo).toBe(true);
      expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(0);
    }
  });

  it("asignarPorCliente aplica a todos los usuarios como colaboradores y, con uno ajeno, no aplica nada", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const us = await Promise.all([1, 2, 3, 4].map(() => ea.miembro(x.id, "asistente")));
    const ajeno = await ea.miembro(y.id, "asistente");
    const [c, c2] = await ea.clientes(x.id, 2);
    await enTenant(x.id, (tx) => f("asignarPorCliente")(tx, { clienteId: c, usuarioIds: us.map((u) => u.id) }));
    expect(await conteo("select count(*)::int as n from asignacion where cliente_id = $1 and tipo = 'colaborador'", [c])).toBe(4);
    const r = await intentarLote(() =>
      enTenant(x.id, (tx) => f("asignarPorCliente")(tx, { clienteId: c2, usuarioIds: [...us.map((u) => u.id), ajeno.id] })),
    );
    expect(r.rechazo).toBe(true);
    expect(await conteo("select count(*)::int as n from asignacion where cliente_id = $1", [c2])).toBe(0);
  });

  it("asignarPorCliente con un cliente de otro estudio no aplica nada", async () => {
    const { x, u, ajeno } = await preparar();
    const r = await intentarLote(() => enTenant(x.id, (tx) => f("asignarPorCliente")(tx, { clienteId: ajeno, usuarioIds: [u.id] })));
    expect(r.rechazo).toBe(true);
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(0);
  });

  it("un lote de 500 clientes se aplica completo en una sola operacion", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const u = await ea.miembro(x.id, "contador");
    const clientes = await ea.clientes(x.id, 500);
    await enTenant(x.id, (tx) => f("asignarPorUsuario")(tx, { usuarioId: u.id, clienteIds: clientes, tipo: "colaborador" }));
    expect(await conteo("select count(*)::int as n from asignacion where usuario_id = $1", [u.id])).toBe(500);
    const visibles = await enTenant(x.id, (tx) => f("listarClientes")(tx, asignado(u.id)));
    expect(visibles).toHaveLength(500);
  }, 30_000);
});

// =================================================================================================
describe("invitaciones: repositorio (CA-2, CA-14)", () => {
  const VIGENTE = "select correo from auth.invitacion_vigente($1::bytea)";
  const vigente = async (h: Buffer) => {
    const r = await llamar(app, VIGENTE, [h]);
    return r.ok ? r.rows : [];
  };
  const fila = async (id: string) => (await adm("select * from invitacion where id = $1", [id]))[0];

  it("crearInvitacion guarda solo el hash, vence a las 72 h y la invitacion queda pendiente", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const correo = ea.esc.correoNuevo();
    const token = Buffer.from("canario-token-invitacion-t2-0123456789ab");
    const tokenHash = sha256(token);
    const inv = await enTenant(x.id, (tx) =>
      f("crearInvitacion")(tx, { correo, rol: "asistente", invitadoPor: d.id, tokenHash }),
    );
    expect(inv).toMatchObject({ correo, rol: "asistente" });
    const fl = await fila(inv.id);
    expect(Buffer.from(fl.token_hash).equals(tokenHash)).toBe(true);
    expect(fl.aceptada_en).toBeNull();
    expect(fl.revocada_en).toBeNull();
    expect(fl.invitado_por).toBe(d.id);
    const horas = (new Date(fl.vence_en).getTime() - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(71.9);
    expect(horas).toBeLessThanOrEqual(72.01);
    // ni la fila ni la respuesta guardan el token en claro
    expect(Object.keys(inv).join()).not.toMatch(/token|hash/i);
    expect(JSON.stringify(inv)).not.toContain(token.toString());
    expect(JSON.stringify(inv)).not.toContain(token.toString("hex"));
    expect(JSON.stringify(inv)).not.toContain(tokenHash.toString("hex"));
    expect(await vigente(tokenHash)).toHaveLength(1);
  });

  it("crearInvitacion con un correo que ya tiene una invitacion pendiente viva falla con 23505; con una VENCIDA la revoca y crea la nueva", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const correo = ea.esc.correoNuevo();
    const h1 = sha256(Buffer.from("t2-h1"));
    const h2 = sha256(Buffer.from("t2-h2"));
    const h3 = sha256(Buffer.from("t2-h3"));
    await enTenant(x.id, (tx) => f("crearInvitacion")(tx, { correo, rol: "lectura", invitadoPor: d.id, tokenHash: h1 }));
    const e: any = await enTenant(x.id, (tx) =>
      f("crearInvitacion")(tx, { correo, rol: "admin", invitadoPor: d.id, tokenHash: h2 }),
    ).catch((q: unknown) => q);
    expect(e?.codigo).toBe("23505");
    // vencida: se revoca y se emite la nueva
    await adm("update invitacion set vence_en = now() - interval '1 hour' where tenant_id = $1 and correo = $2", [x.id, correo]);
    const nueva = await enTenant(x.id, (tx) => f("crearInvitacion")(tx, { correo, rol: "admin", invitadoPor: d.id, tokenHash: h3 }));
    expect(nueva).toMatchObject({ correo, rol: "admin" });
    const todas = await adm("select rol, revocada_en from invitacion where tenant_id = $1 and correo = $2 order by creada_en", [x.id, correo]);
    expect(todas).toHaveLength(2);
    expect(todas[0].revocada_en).toBeInstanceOf(Date);
    expect(todas[1].revocada_en).toBeNull();
    expect(await vigente(h3)).toHaveLength(1);
  });

  it("reenviar invalida el token anterior, activa el nuevo y renueva el vencimiento a 72 h", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const viejo = await ea.invitacion(x.id, { invitadoPor: d.id });
    await adm("update invitacion set vence_en = now() + interval '1 hour' where id = $1", [viejo.id]);
    const nuevoHash = sha256(Buffer.from("t2-reenvio"));
    const r = await enTenant(x.id, (tx) => f("reenviar")(tx, viejo.id, nuevoHash));
    expect(r).toMatchObject({ id: viejo.id, correo: viejo.correo });
    expect(await vigente(viejo.tokenHash)).toHaveLength(0);
    expect(await vigente(nuevoHash)).toHaveLength(1);
    const horas = (new Date((await fila(viejo.id)).vence_en).getTime() - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(71.9);
  });

  it("revocar anula el token; reenviar o revocar una aceptada, revocada, inexistente o de otro estudio devuelve null", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const dy = await ea.miembro(y.id, "dueno");
    const viva = await ea.invitacion(x.id, { invitadoPor: d.id });
    expect(await enTenant(x.id, (tx) => f("revocar")(tx, viva.id))).toMatchObject({ id: viva.id });
    expect(await vigente(viva.tokenHash)).toHaveLength(0);
    expect((await fila(viva.id)).revocada_en).toBeInstanceOf(Date);

    const aceptada = await ea.invitacion(x.id, { invitadoPor: d.id, aceptada: true });
    const revocada = await ea.invitacion(x.id, { invitadoPor: d.id, revocada: true });
    const deY = await ea.invitacion(y.id, { invitadoPor: dy.id });
    const hNuevo = () => sha256(Buffer.from(Math.random().toString()));
    for (const id of [aceptada.id, revocada.id, deY.id, "01920000-0000-7000-8000-00000000dead"]) {
      expect(await enTenant(x.id, (tx) => f("reenviar")(tx, id, hNuevo())), `reenviar ${id}`).toBeNull();
      expect(await enTenant(x.id, (tx) => f("revocar")(tx, id)), `revocar ${id}`).toBeNull();
    }
    expect((await fila(deY.id)).revocada_en).toBeNull(); // la de otro estudio no se tocó
    expect((await fila(aceptada.id)).revocada_en).toBeNull();
  });

  it("listarInvitaciones devuelve las pendientes del estudio (vencidas con vencida=true), con quien invita y SIN token ni hash", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const dy = await ea.miembro(y.id, "dueno");
    const viva = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "contador" });
    const vencida = await ea.invitacion(x.id, { invitadoPor: d.id, vencida: true });
    await ea.invitacion(x.id, { invitadoPor: d.id, aceptada: true });
    await ea.invitacion(x.id, { invitadoPor: d.id, revocada: true });
    await ea.invitacion(y.id, { invitadoPor: dy.id });
    const r = await enTenant(x.id, (tx) => f("listarInvitaciones")(tx));
    expect(r.map((i: any) => i.id).sort()).toEqual([viva.id, vencida.id].sort());
    const porId = Object.fromEntries(r.map((i: any) => [i.id, i]));
    const nombreD = (await adm("select nombre from usuario where id = $1", [d.id]))[0].nombre;
    expect(porId[viva.id]).toMatchObject({
      correo: viva.correo,
      rol: "contador",
      invitadoPor: { usuarioId: d.id, nombre: nombreD },
      vencida: false,
    });
    expect(porId[vencida.id].vencida).toBe(true);
    for (const i of r) {
      expect(Object.keys(i).sort()).toEqual(["correo", "creadaEn", "id", "invitadoPor", "rol", "venceEn", "vencida"]);
      const volcado = JSON.stringify(i);
      expect(volcado).not.toContain(viva.token.toString("hex"));
      expect(volcado).not.toContain(viva.tokenHash.toString("hex"));
      expect(volcado.toLowerCase()).not.toContain("token");
    }
  });
});
