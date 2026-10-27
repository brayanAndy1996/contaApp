// Spec 005 (T2, rojo): contrato común de los repositorios de `acceso` sin BD (tx falsa). El comportamiento contra la
// BD real (alcance, lotes, desactivar, invitaciones) está en tests/aislamiento/acceso-repos.spec.ts. Aquí se fija:
//  - SQL estático y parametrizado: ningún valor de entrada se interpola en el texto y todos viajan como parámetros;
//  - todo error de pg sale como AccesoRepoError con solo el SQLSTATE (CA-14), sin rastro del error original;
//  - las lecturas de una fila devuelven null con cero filas.
// Firmas (todas con la `tx` de withTenant como primer argumento) en el encabezado de acceso-repos.spec.ts.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { clienteVisible, type Alcance } from "./alcance";
import { asignar, asignarPorCliente, asignarPorUsuario, retirar } from "./asignaciones";
import { leerCliente, listarClientes } from "./clientes";
import { AccesoRepoError } from "./errores";
import { crearInvitacion, listarInvitaciones, reenviar, revocar } from "./invitaciones";
import { bloquearMiembro, cambiarRol, desactivar, listarMiembros, miembroActual, reactivar } from "./miembros";

type TxFalsa = Parameters<typeof miembroActual>[0];

const U1 = "01920000-0000-7000-8000-00000000c0a1";
const U2 = "01920000-0000-7000-8000-00000000c0a2";
const C1 = "01920000-0000-7000-8000-00000000c1a1";
const C2 = "01920000-0000-7000-8000-00000000c1a2";
const I1 = "01920000-0000-7000-8000-00000000c2a1";
const H1 = Buffer.alloc(32, 9);
const CORREO = "canario.invitado@ejemplo.test";
const GLOBAL: Alcance = { tipo: "global" };
const ASIGNADO: Alcance = { tipo: "asignado", usuarioId: U2 };

interface Caso {
  nombre: string;
  llamar: (tx: TxFalsa) => Promise<unknown>;
  /** Valores de entrada: viajan como parámetros y nunca dentro del texto SQL (los arreglos se aplanan). */
  entradas: unknown[];
}

const casos: Caso[] = [
  { nombre: "miembroActual", llamar: (tx) => miembroActual(tx, U1), entradas: [U1] },
  { nombre: "listarMiembros", llamar: (tx) => listarMiembros(tx), entradas: [] },
  { nombre: "bloquearMiembro", llamar: (tx) => bloquearMiembro(tx, U1), entradas: [U1] },
  { nombre: "cambiarRol", llamar: (tx) => cambiarRol(tx, U1, "contador"), entradas: [U1, "contador"] },
  { nombre: "desactivar", llamar: (tx) => desactivar(tx, U1), entradas: [U1] },
  { nombre: "reactivar", llamar: (tx) => reactivar(tx, U1), entradas: [U1] },
  {
    nombre: "crearInvitacion",
    llamar: (tx) => crearInvitacion(tx, { correo: CORREO, rol: "asistente", invitadoPor: U1, tokenHash: H1 }),
    entradas: [CORREO, "asistente", U1, H1],
  },
  { nombre: "listarInvitaciones", llamar: (tx) => listarInvitaciones(tx), entradas: [] },
  { nombre: "reenviar", llamar: (tx) => reenviar(tx, I1, H1), entradas: [I1, H1] },
  { nombre: "revocar", llamar: (tx) => revocar(tx, I1), entradas: [I1] },
  {
    nombre: "asignar",
    llamar: (tx) => asignar(tx, { clienteId: C1, usuarioId: U1, tipo: "responsable", anterior: "colaborador" }),
    entradas: [C1, U1, "responsable"],
  },
  { nombre: "retirar", llamar: (tx) => retirar(tx, { clienteId: C1, usuarioId: U1 }), entradas: [C1, U1] },
  {
    nombre: "asignarPorUsuario",
    llamar: (tx) => asignarPorUsuario(tx, { usuarioId: U1, clienteIds: [C1, C2], tipo: "colaborador" }),
    entradas: [U1, C1, C2, "colaborador"],
  },
  {
    nombre: "asignarPorCliente",
    llamar: (tx) => asignarPorCliente(tx, { clienteId: C1, usuarioIds: [U1, U2] }),
    entradas: [C1, U1, U2],
  },
  { nombre: "listarClientes (global)", llamar: (tx) => listarClientes(tx, GLOBAL), entradas: [] },
  { nombre: "listarClientes (asignado)", llamar: (tx) => listarClientes(tx, ASIGNADO), entradas: [U2] },
  { nombre: "leerCliente", llamar: (tx) => leerCliente(tx, C1), entradas: [C1] },
  { nombre: "clienteVisible (global)", llamar: (tx) => clienteVisible(tx, C1, GLOBAL), entradas: [C1] },
  { nombre: "clienteVisible (asignado)", llamar: (tx) => clienteVisible(tx, C1, ASIGNADO), entradas: [C1, U2] },
];

function txEspia(rows: unknown[] = []) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxFalsa;
  return { tx, llamadas };
}

const igual = (a: unknown, b: unknown) =>
  Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

describe("repositorios de acceso: SQL estático y parametrizado", () => {
  it.each(casos)("$nombre: consulta con parámetros y no interpola ningún valor en el texto", async (c) => {
    const { tx, llamadas } = txEspia([]);
    await c.llamar(tx).catch(() => undefined); // con cero filas un repositorio puede devolver null o lanzar: aquí importa el SQL
    expect(llamadas.length).toBeGreaterThan(0);
    const parametros = llamadas.flatMap((l) => l.valores.flat());
    // Con cero filas un repositorio de varios pasos puede cortar en el primero: basta con que lo que SÍ consultó
    // lleve la entrada como parámetro, y que ninguna entrada aparezca nunca dentro del texto SQL.
    if (c.entradas.length > 0) {
      expect(
        c.entradas.some((e) => parametros.some((p) => igual(p, e))),
        "alguna entrada debe viajar como parámetro",
      ).toBe(true);
    }
    for (const entrada of c.entradas) {
      // Los literales cortos del dominio (roles, tipos) pueden estar en el texto; los ids y el correo, nunca.
      if (typeof entrada === "string" && entrada.length > 12) {
        for (const l of llamadas) expect(l.texto, "el texto SQL no lleva valores").not.toContain(entrada);
      }
    }
    for (const l of llamadas) expect(l.texto).toMatch(/\$1/);
  });
});

describe("repositorios de acceso: errores de pg -> AccesoRepoError con solo el SQLSTATE (CA-14)", () => {
  const CANARIO = "CANARIO-ACCESO-3d9b";
  const errorPg = () =>
    Object.assign(new Error(`violación ${CANARIO}`), {
      code: "23503",
      detail: `Key (cliente_id)=(${CANARIO})`,
      where: CANARIO,
      constraint: CANARIO,
      table: CANARIO,
      column: CANARIO,
    });
  const txQueFalla = () =>
    ({
      query: async () => {
        throw errorPg();
      },
    }) as unknown as TxFalsa;

  it.each(casos)("$nombre: relanza AccesoRepoError con codigo y sin rastro del error original", async (c) => {
    const e = (await c.llamar(txQueFalla()).catch((x: unknown) => x)) as Error & { codigo: string };
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("23503");
    for (const campo of ["detail", "where", "constraint", "table", "column", "cause"]) {
      expect(e, campo).not.toHaveProperty(campo);
    }
    const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
    expect(volcado).not.toContain(CANARIO);
  });

  it("un error sin SQLSTATE válido da codigo 'desconocido'", async () => {
    const tx = {
      query: async () => {
        throw new Error("x");
      },
    } as unknown as TxFalsa;
    const e = (await miembroActual(tx, U1).catch((x: unknown) => x)) as Error & { codigo: string };
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("desconocido");
  });
});

describe("repositorios de acceso: cero filas", () => {
  it.each([
    ["miembroActual", (tx: TxFalsa) => miembroActual(tx, U1)],
    ["bloquearMiembro", (tx: TxFalsa) => bloquearMiembro(tx, U1)],
    ["leerCliente", (tx: TxFalsa) => leerCliente(tx, C1)],
  ])("%s devuelve null", async (_n, llamar) => {
    const { tx } = txEspia([]);
    expect(await llamar(tx)).toBeNull();
  });

  it.each([
    ["listarMiembros", (tx: TxFalsa) => listarMiembros(tx)],
    ["listarInvitaciones", (tx: TxFalsa) => listarInvitaciones(tx)],
    ["listarClientes", (tx: TxFalsa) => listarClientes(tx, GLOBAL)],
  ])("%s devuelve una lista vacía", async (_n, llamar) => {
    const { tx } = txEspia([]);
    expect(await llamar(tx)).toEqual([]);
  });
});
