// Spec 030 (T14): comportamiento público de los repositorios de acceso que `roles.spec.ts` no ejercita (tx falsa, sin BD): lecturas de
// definiciones, bloqueos, transiciones de miembro e invitaciones, y los valores por defecto ante filas ausentes. Cierra el 90 % por
// archivo de roles.ts, miembros.ts e invitaciones.ts medido solo con las suites de este paquete.
import { describe, expect, it } from "vitest";
import {
  nombreRolPropioDeInvitacion,
  reenviar,
  revocar,
  revocarPendientesDe,
} from "./invitaciones";
import {
  bloquearMiembro,
  bloquearMiembros,
  cambiarRol,
  definicionesDe,
  desactivar,
  listarMiembros,
  miembroActual,
  reactivar,
} from "./miembros";
import { bloquearRoles, guardarRol, impactoRol, leerRol, listarRoles, usoRol } from "./roles";
import { AccesoRepoError } from "./errores";

type Tx = Parameters<typeof miembroActual>[0];

const U1 = "01920000-0000-7000-8000-00000000d0a1";
const U2 = "01920000-0000-7000-8000-00000000D0A2";
const R1 = "01920000-0000-7000-8000-00000000d1a1";

/** Tx que responde con las filas dadas, una lista por consulta, y guarda lo que recibió. */
function tx(...respuestas: unknown[][]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  let i = 0;
  const falsa = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      const rows = respuestas[i++] ?? [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as Tx;
  return { tx: falsa, llamadas };
}

describe("definicionesDe", () => {
  it("sin ids no consulta y devuelve un mapa vacío", async () => {
    const { tx: t, llamadas } = tx();
    expect((await definicionesDe(t, [])).size).toBe(0);
    expect(llamadas).toHaveLength(0);
  });

  it("normaliza a minúsculas sin repetir y entrega rol de sistema sin definición y propio con permisos ordenados", async () => {
    const { tx: t, llamadas } = tx([
      { usuario_id: U1, rol: "contador", rol_id: R1, permisos: null, alcance: null },
      { usuario_id: U2.toLowerCase(), rol: "propio", rol_id: R1, permisos: ["clientes.ver", "buzon.ver"], alcance: "global" },
    ]);
    const m = await definicionesDe(t, [U1.toUpperCase(), U1, U2]);
    expect(llamadas[0]!.valores).toEqual([[U1, U2.toLowerCase()]]);
    expect(m.get(U1)).toEqual({ rol: "contador", rolId: null, propio: null });
    expect(m.get(U2.toLowerCase())).toEqual({
      rol: "propio",
      rolId: R1,
      propio: { permisos: ["buzon.ver", "clientes.ver"], alcance: "global" },
    });
  });

  it("un rol propio sin permisos agregados (NULL) se lee como sin permisos y sin rol_id como null", async () => {
    const { tx: t } = tx([{ usuario_id: U1, rol: "propio", rol_id: undefined, permisos: null, alcance: "asignado" }]);
    expect((await definicionesDe(t, [U1])).get(U1)).toEqual({
      rol: "propio",
      rolId: null,
      propio: { permisos: [], alcance: "asignado" },
    });
  });
});

describe("miembroActual y listarMiembros", () => {
  it("sin membresía activa devuelve null; con ella, el rol y la definición del propio", async () => {
    expect(await miembroActual(tx([]).tx, U1)).toBeNull();
    const { tx: t } = tx([{ usuario_id: U1, rol: "propio", rol_id: R1, permisos: ["buzon.ver"], alcance: "asignado" }]);
    expect(await miembroActual(t, U1)).toEqual({
      usuarioId: U1,
      rol: "propio",
      rolId: R1,
      propio: { permisos: ["buzon.ver"], alcance: "asignado" },
    });
  });

  it("listarMiembros mapea nombre, correo, estado y el rol propio; rol_id y nombre ausentes salen null", async () => {
    const { tx: t } = tx([
      { usuario_id: U1, nombre: "Ana", correo: "a@x.test", rol: "propio", activo: true, rol_id: R1, rol_nombre: "Revisor" },
      { usuario_id: U2, nombre: "Bruno", correo: "b@x.test", rol: "dueno", activo: false },
    ]);
    expect(await listarMiembros(t)).toEqual([
      { usuarioId: U1, nombre: "Ana", correo: "a@x.test", rol: "propio", activo: true, rolId: R1, rolNombre: "Revisor" },
      { usuarioId: U2, nombre: "Bruno", correo: "b@x.test", rol: "dueno", activo: false, rolId: null, rolNombre: null },
    ]);
  });
});

describe("bloqueos y transiciones de miembro", () => {
  it("bloquearMiembro: null si no es del estudio; con membresía, su estado", async () => {
    expect(await bloquearMiembro(tx([]).tx, U1)).toBeNull();
    const { tx: t } = tx([{ usuario_id: U1, rol: "contador", activo: false }]);
    expect(await bloquearMiembro(t, U1)).toEqual({ usuarioId: U1, rol: "contador", activo: false });
  });

  it("bloquearMiembros normaliza los ids y devuelve solo los del estudio", async () => {
    const { tx: t, llamadas } = tx([{ usuario_id: U1, rol: "dueno", activo: true }]);
    const m = await bloquearMiembros(t, [U1, U1.toUpperCase(), U2]);
    expect(llamadas[0]!.valores).toEqual([[U1, U2.toLowerCase()]]);
    expect([...m.keys()]).toEqual([U1]);
    expect(m.get(U1)).toEqual({ usuarioId: U1, rol: "dueno", activo: true });
  });

  it("cambiarRol a un rol de sistema ignora el rolId y no pasa responsables a colaborador sin pedirlo", async () => {
    const { tx: t, llamadas } = tx([{ usuario_id: U1, rol: "contador", activo: true }], []);
    expect(await cambiarRol(t, U1, "contador", undefined, R1)).toEqual({ usuarioId: U1, rol: "contador", activo: true });
    expect(llamadas[0]!.valores).toEqual([U1, "contador", null]);
    expect(llamadas[1]!.valores).toEqual([U1, false]);
  });

  it("cambiarRol de quien ya no es miembro devuelve null y nunca degrada responsables", async () => {
    const { tx: t, llamadas } = tx([], []);
    expect(await cambiarRol(t, U1, "propio", true, R1)).toBeNull();
    expect(llamadas[0]!.valores).toEqual([U1, "propio", R1]);
    expect(llamadas[1]!.valores).toEqual([U1, false]);
  });

  it("cambiarRol a propio sin rolId viaja con null (la BD lo rechaza)", async () => {
    const { tx: t, llamadas } = tx([], []);
    await cambiarRol(t, U1, "propio");
    expect(llamadas[0]!.valores).toEqual([U1, "propio", null]);
  });

  it("desactivar borra las asignaciones y reactivar devuelve el estado; ambos null si no es del estudio", async () => {
    const d = tx([{ usuario_id: U1, rol: "colaborador", activo: false }], []);
    expect(await desactivar(d.tx, U1)).toEqual({ usuarioId: U1, rol: "colaborador", activo: false });
    expect(d.llamadas).toHaveLength(2);
    expect(await desactivar(tx([], []).tx, U1)).toBeNull();
    expect(await reactivar(tx([{ usuario_id: U1, rol: "colaborador", activo: true }]).tx, U1)).toEqual({
      usuarioId: U1,
      rol: "colaborador",
      activo: true,
    });
    expect(await reactivar(tx([]).tx, U1)).toBeNull();
  });
});

describe("invitaciones: reenviar, revocar y conservar", () => {
  const fila = {
    id: R1,
    correo: "n@x.test",
    rol: "propio",
    rol_id: R1,
    rol_nombre: "Revisor",
    invitado_por: U1,
    invitado_por_nombre: "Ana",
    creada_en: new Date(0),
    vence_en: new Date(1),
    vencida: false,
  };

  it("reenviar y revocar devuelven la invitación con su rol propio, o null si ya no está viva", async () => {
    const esperada = {
      id: R1,
      correo: "n@x.test",
      rol: "propio",
      rolId: R1,
      rolNombre: "Revisor",
      invitadoPor: { usuarioId: U1, nombre: "Ana" },
      creadaEn: new Date(0),
      venceEn: new Date(1),
      vencida: false,
    };
    expect(await reenviar(tx([fila]).tx, R1, Buffer.alloc(32, 1))).toEqual(esperada);
    expect(await revocar(tx([fila]).tx, R1)).toEqual(esperada);
    expect(await reenviar(tx([]).tx, R1, Buffer.alloc(32, 1))).toBeNull();
    expect(await revocar(tx([]).tx, R1)).toBeNull();
  });

  it("una invitación de rol de sistema sale con rolId y rolNombre null", async () => {
    const r = await revocar(tx([{ ...fila, rol: "contador", rol_id: null, rol_nombre: null, vencida: true }]).tx, R1);
    expect(r).toMatchObject({ rol: "contador", rolId: null, rolNombre: null, vencida: true });
  });

  it("revocarPendientesDe pasa los roles de sistema tal cual y el rol propio por su id en minúsculas; cuenta las revocadas", async () => {
    const { tx: t, llamadas } = tx([{ id: "a" }, { id: "b" }]);
    expect(await revocarPendientesDe(t, U1, ["contador", { rolId: R1.toUpperCase() }])).toBe(2);
    expect(llamadas[0]!.valores).toEqual([U1, ["contador", R1]]);
    expect(await revocarPendientesDe(tx([]).tx, U1, [])).toBe(0);
  });

  it("nombreRolPropioDeInvitacion: el nombre vigente, o null sin invitación viva o sin nombre", async () => {
    const h = Buffer.alloc(32, 9);
    const { tx: t, llamadas } = tx([{ nombre: "Revisor" }]);
    expect(await nombreRolPropioDeInvitacion(t, h)).toBe("Revisor");
    expect(llamadas[0]!.valores).toEqual([h]);
    expect(await nombreRolPropioDeInvitacion(tx([]).tx, h)).toBeNull();
    expect(await nombreRolPropioDeInvitacion(tx([{ nombre: null }]).tx, h)).toBeNull();
  });
});

describe("roles: valores por defecto ante filas ausentes", () => {
  it("bloquearRoles toma el candado del estudio con una sola consulta", async () => {
    const { tx: t, llamadas } = tx([{}]);
    await bloquearRoles(t);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/pg_advisory_xact_lock/);
  });

  it("usoRol e impactoRol sin fila devuelven ceros", async () => {
    expect(await usoRol(tx([]).tx, R1)).toEqual({ miembros: 0, invitaciones: 0 });
    expect(await impactoRol(tx([]).tx, R1, { alcance: "global", permisos: [] })).toEqual({
      miembros: 0,
      clientesSinResponsable: 0,
      miembrosSinTotpExigidos: 0,
    });
  });

  it("los conteos llegan como texto de bigint y se vuelven número", async () => {
    expect(await usoRol(tx([{ miembros: "3", invitaciones: "2" }]).tx, R1)).toEqual({ miembros: 3, invitaciones: 2 });
  });

  it("listarRoles ordena los permisos y tolera permisos NULL; leerRol sin fila es null", async () => {
    const { tx: t } = tx([
      { id: R1, nombre: "A", alcance: "global", permisos: ["clientes.ver", "buzon.ver"], miembros: "1", invitaciones: null },
      { id: U1, nombre: "B", alcance: "asignado", permisos: null, miembros: 0, invitaciones: 0 },
    ]);
    expect(await listarRoles(t)).toEqual([
      { id: R1, nombre: "A", alcance: "global", permisos: ["buzon.ver", "clientes.ver"], miembros: 1, invitaciones: 0 },
      { id: U1, nombre: "B", alcance: "asignado", permisos: [], miembros: 0, invitaciones: 0 },
    ]);
    expect(await leerRol(tx([]).tx, R1)).toBeNull();
  });

  it("guardarRol sin id devuelto es un fallo sin detalles (SQLSTATE desconocido)", async () => {
    const e = await guardarRol(tx([]).tx, { nombre: "N", alcance: "global", permisos: [] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e).toMatchObject({ codigo: "desconocido" });
  });
});
