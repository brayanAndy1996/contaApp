// Spec 031 (T1, rojo): consulta de auditoria con filtros y alcance en SQL. CA-1 (cada filtro, solo y combinado, contra una consulta de
// referencia), CA-2 (cursor entre ramas, bordes de ms), CA-4 (alcance en ambas ramas y falla cerrado), CA-5 (dos estudios), CA-8 (la firma de
// 017 ya no existe, grants) y D-6 (opciones). La referencia es JS puro sobre un volcado de las dos tablas (`auditoria-consulta-soporte.ts`).
// Fallan por: `auditoria_descifrado_listar` aun con 3 argumentos (falta 0088), filtros y alcance que `listarAuditoria` ignora, y
// `opcionesAuditoria` sin exportar.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES_017, abrirAdmin, exportado } from "./auditoria-soporte";
import {
  COLUMNAS_FUNCION,
  D1,
  D2,
  EscenarioConsulta,
  H,
  SIN_FILTROS,
  filtros,
  type Alcance,
  type FilaRef,
  type Filtros,
} from "./auditoria-consulta-soporte";
import { intentar, type Tx } from "./soporte";

let admin: Pool;
let ec: EscenarioConsulta;
let X: string;
let Y: string;
let u1: string; // asignado a c1 (responsable) y c2 (colaborador)
let u2: string; // responsable de c2
let uSin: string; // miembro sin asignaciones
let uAmbos: string; // miembro de X (asignado a c1) y de Y (asignado a cy1)
let uy: string;
let c1: string;
let c2: string;
let c3: string;
let cy1: string;
let cy2: string;
const R: Record<string, string> = {}; // filas de auditoria sembradas por nombre
const Dz: Record<string, string> = {}; // descifrados sembrados por nombre
let volX: FilaRef[];
let volY: FilaRef[];
let asigX: Map<string, Set<string>>;
let asigY: Map<string, Set<string>>;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioConsulta(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  u1 = (await ec.miembro(X)).id;
  u2 = (await ec.miembro(X)).id;
  uSin = (await ec.miembro(X)).id;
  uAmbos = (await ec.miembro(X)).id;
  await ec.ea.membresia(Y, uAmbos, "contador");
  uy = (await ec.miembro(Y)).id;
  c1 = (await ec.cliente(X)).id;
  c2 = (await ec.cliente(X)).id;
  c3 = (await ec.cliente(X)).id;
  cy1 = (await ec.cliente(Y)).id;
  cy2 = (await ec.cliente(Y)).id;
  await ec.asignar(X, c1, u1, "responsable");
  await ec.asignar(X, c2, u1, "colaborador");
  await ec.asignar(X, c2, u2, "responsable");
  await ec.asignar(X, c1, uAmbos, "colaborador");
  await ec.asignar(Y, cy1, uy, "responsable");
  await ec.asignar(Y, cy1, uAmbos, "colaborador");

  // ---- Estudio X: bordes de dia de Lima, empates de ms entre las dos ramas, actores y filas sin cliente ----------------------------
  R.antes = await ec.audit(X, { ms: D1 - 1, accion: "cliente.creado", usuario: u1, cliente: c1 }); // 23:59:59.999 del dia anterior
  R.desde = await ec.audit(X, { ms: D1, accion: "cliente.editado", usuario: u1, cliente: c1 }); // 00:00 exacto
  R.empate = await ec.audit(X, { ms: D1 + H, accion: "cliente.editado", usuario: u2, cliente: c2 });
  Dz.empate = await ec.descifrado(X, { en: D1 + H, cliente: c1 }); // mismo ms que R.empate, ramas distintas
  R.periodo = await ec.audit(X, { ms: D1 + 2 * H, accion: "periodo.estado_cambiado", usuario: u1, cliente: c1 });
  Dz.c2 = await ec.descifrado(X, { en: D1 + 2 * H, cliente: c2 });
  R.trabajoConUsuario = await ec.audit(X, { ms: D1 + 3 * H, accion: "archivo.generado", usuario: u1, trabajo: randomUUID(), cliente: c1 });
  Dz.sinCliente = await ec.descifrado(X, { en: D1 + 3 * H });
  R.trabajoSinUsuario = await ec.audit(X, { ms: D1 + 4 * H, accion: "xml.subido", trabajo: randomUUID(), cliente: c2 });
  R.sinCliente1 = await ec.audit(X, { ms: D1 + 5 * H, accion: "miembro.rol_cambiado", usuario: u1 });
  R.sinCliente2 = await ec.audit(X, { ms: D1 + 6 * H, accion: "sesion.ingreso", usuario: u2 });
  R.credencial = await ec.audit(X, { ms: D1 + 7 * H, accion: "credencial.guardada", usuario: u1, cliente: c3 });
  R.finDia = await ec.audit(X, { ms: D2 - 1, accion: "asignacion.tipo_cambiado", usuario: u1, cliente: c2 }); // 23:59:59.999 de Lima
  R.sigDia = await ec.audit(X, { ms: D2, accion: "cliente.editado", usuario: u2, cliente: c3 }); // 00:00 del dia siguiente
  R.sigDia1 = await ec.audit(X, { ms: D2 + 1, accion: "compra.operacion", usuario: u2, cliente: c3 });
  Dz.finDia = await ec.descifrado(X, { en: D2 - 1, cliente: c1 });
  Dz.exactoD2 = await ec.descifrado(X, { en: D2, cliente: c1 });
  Dz.microFin = await ec.descifrado(X, { en: "2026-03-11T04:59:59.999900Z", cliente: c1 }); // trunca a D2-1 ms: entra
  Dz.microSig = await ec.descifrado(X, { en: "2026-03-11T05:00:00.000400Z", cliente: c1 }); // trunca a D2: no entra
  Dz.microAntes = await ec.descifrado(X, { en: "2026-03-10T04:59:59.999900Z", cliente: c1 }); // trunca a D1-1 ms: no entra con desde = D1
  Dz.microDesde = await ec.descifrado(X, { en: "2026-03-10T05:00:00.000900Z", cliente: c1 }); // trunca a D1: entra
  // Relleno con muchos empates de ms (varias paginas): 30 filas de auditoria y 6 descifrados al mismo ms que alguna de ellas.
  const acciones = ["cliente.editado", "compra.operacion", "periodo.estado_cambiado", "xml.subido"];
  const clientes = [c1, c2, c3, null];
  for (let k = 0; k < 30; k++) {
    const ms = D1 + 10 * H + Math.floor(k / 3);
    await ec.audit(X, { ms, accion: acciones[k % 4]!, usuario: k % 2 ? u1 : u2, cliente: clientes[k % 4]! });
    if (k % 5 === 0) await ec.descifrado(X, { en: ms, cliente: k % 2 ? c1 : c2 });
  }

  // ---- Estudio Y: filas propias que no deben verse desde X (y viceversa) -------------------------------------------------------------
  R.y1 = await ec.audit(Y, { ms: D1 + H, accion: "cliente.editado", usuario: uy, cliente: cy1 });
  R.y2 = await ec.audit(Y, { ms: D1 + 2 * H, accion: "cliente.editado", usuario: uAmbos, cliente: cy2 });
  Dz.y1 = await ec.descifrado(Y, { en: D1 + H, cliente: cy1, motivo: "MOTIVO-Y-031" });
  Dz.y2 = await ec.descifrado(Y, { en: D1 + 2 * H, cliente: cy2, motivo: "MOTIVO-Y-031" });

  volX = await ec.volcado(X);
  volY = await ec.volcado(Y);
  asigX = await ec.asignaciones(X);
  asigY = await ec.asignaciones(Y);
}, 120_000);

afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
});

const ref = (f: Filtros, a: Alcance): string[] => ec.referencia(volX, asigX, f, a);
const global: Alcance = { tipo: "global" };
const asignado = (usuarioId: string): Alcance => ({ tipo: "asignado", usuarioId });
const D1d = (): Date => new Date(D1);
const D2d = (): Date => new Date(D2);
const DESCIFRADA = "credencial.descifrada";

// =================================================================================================
describe("la siembra de esta suite no es vacua", () => {
  it("el volcado trae filas de las dos ramas, empates de ms entre ellas y mas de 50 filas (varias paginas)", () => {
    expect(volX.filter((r) => r.descifrado).length).toBeGreaterThan(10);
    expect(volX.filter((r) => !r.descifrado).length).toBeGreaterThan(40);
    const porMs = new Map<number, Set<boolean>>();
    for (const r of volX) porMs.set(r.ms, (porMs.get(r.ms) ?? new Set()).add(r.descifrado));
    expect([...porMs.values()].filter((s) => s.size === 2).length, "ms con auditoria y descifrado a la vez").toBeGreaterThanOrEqual(3);
    expect(volX.length).toBeGreaterThan(50);
  });
});

// =================================================================================================
describe("CA-1 · cada filtro, solo y combinado, iguala a la consulta de referencia (recorriendo las paginas de a 7)", () => {
  interface Caso {
    nombre: string;
    f: () => Filtros;
    vacio?: true;
  }
  const CASOS: Caso[] = [
    { nombre: "sin filtros", f: () => SIN_FILTROS },
    { nombre: "usuario u1", f: () => filtros({ usuarioId: u1 }) },
    { nombre: "usuario u2", f: () => filtros({ usuarioId: u2 }) },
    { nombre: "usuario de otro estudio", f: () => filtros({ usuarioId: uy }), vacio: true },
    { nombre: "usuario inexistente", f: () => filtros({ usuarioId: randomUUID() }), vacio: true },
    { nombre: "cliente c1", f: () => filtros({ clienteId: c1 }) },
    { nombre: "cliente c2", f: () => filtros({ clienteId: c2 }) },
    { nombre: "cliente c3", f: () => filtros({ clienteId: c3 }) },
    { nombre: "cliente de otro estudio", f: () => filtros({ clienteId: cy1 }), vacio: true },
    { nombre: "una accion", f: () => filtros({ acciones: ["cliente.editado"] }) },
    { nombre: "dos acciones", f: () => filtros({ acciones: ["cliente.editado", "periodo.estado_cambiado"] }) },
    { nombre: "solo credencial.descifrada", f: () => filtros({ acciones: [DESCIFRADA] }) },
    { nombre: "credencial.descifrada y otra accion", f: () => filtros({ acciones: [DESCIFRADA, "cliente.editado"] }) },
    { nombre: "accion sin filas", f: () => filtros({ acciones: ["sunat.envio"] }), vacio: true },
    { nombre: "desde", f: () => filtros({ desde: D1d() }) },
    { nombre: "hasta (exclusivo)", f: () => filtros({ hastaExclusivo: D2d() }) },
    { nombre: "desde y hasta (un dia de Lima)", f: () => filtros({ desde: D1d(), hastaExclusivo: D2d() }) },
    { nombre: "rango vacio", f: () => filtros({ desde: new Date(D1 + 100 * H), hastaExclusivo: new Date(D1 + 101 * H) }), vacio: true },
    { nombre: "usuario u1 + cliente c1", f: () => filtros({ usuarioId: u1, clienteId: c1 }) },
    { nombre: "usuario u2 + cliente c1", f: () => filtros({ usuarioId: u2, clienteId: c1 }) },
    { nombre: "usuario + credencial.descifrada (los descifrados no guardan actor)", f: () => filtros({ usuarioId: u1, acciones: [DESCIFRADA] }), vacio: true },
    { nombre: "cliente c1 + acciones + rango", f: () => filtros({ clienteId: c1, acciones: [DESCIFRADA, "cliente.editado"], desde: D1d(), hastaExclusivo: D2d() }) },
    { nombre: "usuario u1 + accion + rango", f: () => filtros({ usuarioId: u1, acciones: ["cliente.editado", "compra.operacion"], desde: D1d(), hastaExclusivo: new Date(D1 + 24 * H) }) },
    { nombre: "todos los filtros", f: () => filtros({ usuarioId: u1, clienteId: c1, acciones: ["cliente.editado", "periodo.estado_cambiado", "archivo.generado"], desde: D1d(), hastaExclusivo: D2d() }) },
  ];

  it.each(CASOS)("alcance global · $nombre", async ({ f, vacio }) => {
    const esperado = ref(f(), global);
    if (vacio) expect(esperado).toEqual([]);
    else expect(esperado.length, "la referencia no puede ser vacia").toBeGreaterThan(0);
    const real = await ec.recorrer(X, u1, { alcance: global, filtros: f() }, 7);
    expect(real).toEqual(esperado);
  });

  it("P-6: con usuarioId salen las filas del trabajo que el usuario lanzo (usuario_id = creado_por) y no las del trabajo sin usuario", async () => {
    const real = await ec.recorrer(X, u1, { alcance: global, filtros: filtros({ usuarioId: u1 }) }, 50);
    expect(real).toContain(R.trabajoConUsuario);
    expect(real).not.toContain(R.trabajoSinUsuario);
    expect(real.some((id) => Object.values(Dz).includes(id)), "nunca descifrados con usuarioId (D-4)").toBe(false);
  });

  it("filtro de accion con credencial.descifrada incluye los descifrados de 003 con su cliente; sin ella, ninguno", async () => {
    const con = await ec.recorrer(X, u1, { alcance: global, filtros: filtros({ acciones: [DESCIFRADA], clienteId: c1 }) }, 50);
    expect(con).toEqual(expect.arrayContaining([Dz.empate, Dz.finDia, Dz.exactoD2]));
    const sin = await ec.recorrer(X, u1, { alcance: global, filtros: filtros({ acciones: ["cliente.editado"], clienteId: c1 }) }, 50);
    expect(sin.some((id) => Object.values(Dz).includes(id))).toBe(false);
  });
});

// =================================================================================================
describe("CA-2 · cursor sin repetir ni saltar entre ramas, y bordes de milisegundo", () => {
  const FILTROS_CURSOR: [string, () => Filtros][] = [
    ["sin filtros", () => SIN_FILTROS],
    ["cliente c1", () => filtros({ clienteId: c1 })],
    ["dos acciones con descifrados", () => filtros({ acciones: [DESCIFRADA, "cliente.editado"] })],
    ["rango de un dia", () => filtros({ desde: D1d(), hastaExclusivo: D2d() })],
  ];

  describe.each([1, 2, 3, 7, 50])("paginas de %i", (limite) => {
    it.each(FILTROS_CURSOR)("%s: la union de las paginas es exactamente la referencia, sin repetidas", async (_n, f) => {
      const esperado = ref(f(), global);
      const real = await ec.recorrer(X, u1, { alcance: global, filtros: f() }, limite);
      expect(new Set(real).size, "sin repetidas").toBe(real.length);
      expect(real).toEqual(esperado);
    });
  });

  it("las filas de ramas distintas con el mismo ms se desempatan por id (no se pierde ninguna entre paginas de 1)", async () => {
    const f = filtros({ desde: new Date(D1 + H), hastaExclusivo: new Date(D1 + H + 1) });
    const real = await ec.recorrer(X, u1, { alcance: global, filtros: f }, 1);
    expect(new Set(real)).toEqual(new Set([R.empate, Dz.empate]));
    expect(real).toEqual([Dz.empate, R.empate].sort().reverse()); // id descendente
  });

  it("hasta exclusivo: 23:59:59.999 de Lima entra y el 00:00 del dia siguiente no, en las dos ramas (con microsegundos truncados)", async () => {
    const real = await ec.recorrer(X, u1, { alcance: global, filtros: filtros({ desde: D1d(), hastaExclusivo: D2d() }) }, 50);
    expect(real).toEqual(expect.arrayContaining([R.finDia, Dz.finDia, Dz.microFin]));
    for (const fuera of [R.sigDia, R.sigDia1, Dz.exactoD2, Dz.microSig]) expect(real, "fuera del dia").not.toContain(fuera);
  });

  it("desde inclusivo: el ms exacto de las 00:00 entra y el anterior no (auditoria y descifrados con microsegundos)", async () => {
    const real = await ec.recorrer(X, u1, { alcance: global, filtros: filtros({ desde: D1d(), hastaExclusivo: D2d() }) }, 50);
    expect(real).toEqual(expect.arrayContaining([R.desde, Dz.microDesde]));
    expect(real).not.toContain(R.antes);
    expect(real).not.toContain(Dz.microAntes);
  });

  it("el cursor viaja con filtros: la segunda pagina respeta los mismos filtros y empieza justo despues de la primera", async () => {
    const f = filtros({ clienteId: c1, acciones: [DESCIFRADA, "cliente.editado"] });
    const esperado = ref(f, global);
    expect(esperado.length).toBeGreaterThan(4);
    const p1 = await ec.pagina(X, u1, { alcance: global, filtros: f, limite: 3 });
    const ult = p1[p1.length - 1]!;
    const p2 = await ec.pagina(X, u1, { alcance: global, filtros: f, limite: 3, antes: { en: new Date(ult.ocurridaEn), id: ult.id } });
    expect([...p1, ...p2].map((x) => x.id)).toEqual(esperado.slice(0, 6));
    expect([...p1, ...p2].every((x) => x.clienteId === c1)).toBe(true);
  });

  it("la pagina es de 50 filas a lo sumo aunque se pida mas y haya mas filas con el filtro", async () => {
    expect(ref(SIN_FILTROS, global).length).toBeGreaterThan(50);
    const p = await ec.pagina(X, u1, { alcance: global, filtros: SIN_FILTROS, limite: 5000 });
    expect(p).toHaveLength(50);
  });
});

// =================================================================================================
describe("CA-4 · alcance asignado en las dos ramas, con y sin filtros (D-3, P-5)", () => {
  const ALCANCES: [string, () => Alcance][] = [
    ["u1 (c1, c2)", () => asignado(u1)],
    ["u2 (c2)", () => asignado(u2)],
    ["uAmbos (c1 en X)", () => asignado(uAmbos)],
    ["uSin (sin asignaciones)", () => asignado(uSin)],
    ["usuario sin membresia", () => asignado(randomUUID())],
    ["usuario de otro estudio (uy)", () => asignado(uy)],
  ];
  const CON_FILTROS: [string, () => Filtros][] = [
    ["sin filtros", () => SIN_FILTROS],
    ["cliente c1", () => filtros({ clienteId: c1 })],
    ["cliente c3 (no asignado a u1 ni u2)", () => filtros({ clienteId: c3 })],
    ["usuario u1", () => filtros({ usuarioId: u1 })],
    ["acciones con descifrados", () => filtros({ acciones: [DESCIFRADA, "cliente.editado"] })],
    ["rango de un dia", () => filtros({ desde: D1d(), hastaExclusivo: D2d() })],
  ];

  describe.each(ALCANCES)("%s", (_n, al) => {
    it.each(CON_FILTROS)("%s: iguala a la referencia con el alcance", async (_m, f) => {
      const esperado = ref(f(), al());
      const real = await ec.recorrer(X, u1, { alcance: al(), filtros: f() }, 7);
      expect(real).toEqual(esperado);
    });
  });

  it("u1 ve solo c1 y c2 en ambas ramas; ninguna fila de c3, ninguna sin cliente, ningun descifrado sin cliente (P-5)", async () => {
    const real = await ec.recorrer(X, u1, { alcance: asignado(u1) }, 50);
    const porId = new Map(volX.map((r) => [r.id, r]));
    expect(real.length).toBeGreaterThan(10);
    for (const id of real) expect([c1, c2], id).toContain(porId.get(id)!.clienteId);
    expect(real.some((id) => porId.get(id)!.descifrado), "descifrados de sus clientes").toBe(true);
    for (const fuera of [R.credencial, R.sinCliente1, R.sinCliente2, R.sigDia, Dz.sinCliente]) expect(real).not.toContain(fuera);
  });

  it("sin asignaciones: vacio, con y sin filtros", async () => {
    expect(await ec.recorrer(X, uSin, { alcance: asignado(uSin) }, 50)).toEqual([]);
    expect(await ec.recorrer(X, uSin, { alcance: asignado(uSin), filtros: filtros({ acciones: [DESCIFRADA] }) }, 50)).toEqual([]);
  });

  it("un clienteId no asignado con alcance asignado da vacio (la pagina no filtra de mas aunque el servicio ya diera 404)", async () => {
    expect(await ec.recorrer(X, u2, { alcance: asignado(u2), filtros: filtros({ clienteId: c3 }) }, 50)).toEqual([]);
    expect(await ec.recorrer(X, u2, { alcance: asignado(u2), filtros: filtros({ clienteId: c1 }) }, 50)).toEqual([]);
  });

  it("el alcance global del Dueño o Administrador ve todo el estudio, incluidas las filas sin cliente", async () => {
    const real = await ec.recorrer(X, u1, { alcance: global }, 50);
    expect(real).toEqual(ref(SIN_FILTROS, global));
    expect(real).toEqual(expect.arrayContaining([R.sinCliente1, R.sinCliente2, Dz.sinCliente]));
  });
});

// =================================================================================================
describe("CA-5 · dos estudios: ni ids ajenos ni la sesion de A devuelven filas de B", () => {
  const todosLosFiltros = (): Filtros[] => [
    SIN_FILTROS,
    filtros({ clienteId: c1 }),
    filtros({ clienteId: cy1 }),
    filtros({ usuarioId: uy }),
    filtros({ usuarioId: uAmbos }),
    filtros({ acciones: [DESCIFRADA] }),
    filtros({ desde: D1d(), hastaExclusivo: D2d() }),
  ];

  it("con la sesion de X, ninguna combinacion (ni con ids de Y) devuelve filas de Y", async () => {
    const idsY = new Set(volY.map((r) => r.id));
    for (const f of todosLosFiltros()) {
      for (const al of [global, asignado(u1), asignado(uAmbos), asignado(uy)]) {
        const real = await ec.recorrer(X, u1, { alcance: al, filtros: f }, 50);
        expect(real.filter((id) => idsY.has(id)), JSON.stringify([f, al])).toEqual([]);
      }
    }
  });

  it("con la sesion de Y, ninguna combinacion devuelve filas de X, tampoco con los ids de X", async () => {
    const idsX = new Set(volX.map((r) => r.id));
    for (const f of [SIN_FILTROS, filtros({ clienteId: c1 }), filtros({ usuarioId: u1 }), filtros({ acciones: [DESCIFRADA] })]) {
      for (const al of [global, asignado(uAmbos), asignado(u1)]) {
        const real = await ec.recorrer(Y, uy, { alcance: al, filtros: f }, 50);
        expect(real.filter((id) => idsX.has(id)), JSON.stringify([f, al])).toEqual([]);
      }
    }
    expect(await ec.recorrer(Y, uy, { alcance: global, filtros: filtros({ clienteId: c1 }) }, 50)).toEqual([]);
  });

  it("cada estudio ve lo suyo completo", async () => {
    expect(await ec.recorrer(Y, uy, { alcance: global }, 50)).toEqual(ec.referencia(volY, asigY, SIN_FILTROS, global));
    expect(await ec.recorrer(Y, uy, { alcance: asignado(uAmbos) }, 50)).toEqual(ec.referencia(volY, asigY, SIN_FILTROS, asignado(uAmbos)));
  });

  it("un usuario miembro de los dos estudios y asignado en ambos ve en cada sesion solo los clientes de ese estudio", async () => {
    const enX = await ec.recorrer(X, uAmbos, { alcance: asignado(uAmbos) }, 50);
    const enY = await ec.recorrer(Y, uAmbos, { alcance: asignado(uAmbos) }, 50);
    expect(enX).toEqual(ref(SIN_FILTROS, asignado(uAmbos)));
    expect(enY).toEqual(ec.referencia(volY, asigY, SIN_FILTROS, asignado(uAmbos)));
    const idsY = new Set(volY.map((r) => r.id));
    expect(enX.some((id) => idsY.has(id))).toBe(false);
    expect(enY.some((id) => !idsY.has(id))).toBe(false);
    expect(enX.length).toBeGreaterThan(0);
    expect(enY.length).toBeGreaterThan(0);
  });

  it("el motivo de un descifrado de Y no aparece en ninguna respuesta de X", async () => {
    const todo = await ec.comoBackend(X, u1, async (tx) => {
      const listar = exportado<(t: Tx, o: unknown) => Promise<unknown[]>>("listarAuditoria");
      return listar(tx, { alcance: global, limite: 50, filtros: filtros({ acciones: [DESCIFRADA] }) });
    });
    expect(JSON.stringify(todo)).not.toContain("MOTIVO-Y-031");
  });
});

// =================================================================================================
describe("auditoria_descifrado_listar (0088): firma, grants y salida", () => {
  const funcion = async () =>
    (
      await admin.query(
        `select p.oid, p.pronargs, p.oid::regprocedure::text as firma, p.prosecdef as secdef, pg_get_userbyid(p.proowner) as dueno,
                p.proconfig as config
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
          where p.proname = 'auditoria_descifrado_listar'`,
      )
    ).rows;

  it("existe UNA sola firma, de 8 argumentos; la de 017 (3 argumentos) ya no existe (CA-8)", async () => {
    const f = await funcion();
    expect(f.map((x) => x.pronargs)).toEqual([8]);
    expect(f[0].firma).toContain("auditoria_descifrado_listar(timestamp with time zone,uuid,integer,uuid,timestamp with time zone,timestamp with time zone,boolean,uuid)");
    const r = await intentar(ec.backend, { tenantId: X, userId: u1 }, "select * from auditoria_descifrado_listar(null, null, 50)");
    expect(r.ok ? "ok" : r.code).toBe("42883");
  });

  it("SECURITY DEFINER de contapp_migrator con search_path fijo, EXECUTE solo para contapp_backend y no para PUBLIC", async () => {
    const [f] = await funcion();
    expect(f).toMatchObject({ secdef: true, dueno: "contapp_migrator" });
    expect((f.config as string[]).join(" ")).toMatch(/search_path=pg_catalog, pg_temp/);
    const quien: Record<string, boolean> = {};
    for (const rol of ROLES_017) {
      quien[rol] = (await admin.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as v", [rol, f.oid])).rows[0].v;
    }
    expect(quien).toEqual({ contapp_backend: true, contapp_worker: false, contapp_app: false, contapp_platform: false });
    expect((await admin.query("select has_function_privilege('public', $1::oid, 'EXECUTE') as v", [f.oid])).rows[0].v).toBe(false);
  });

  it("003 no cambia: la app sigue sin SELECT sobre auditoria_descifrado", async () => {
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      expect((await admin.query("select has_table_privilege($1, 'public.auditoria_descifrado', 'SELECT') as v", [rol])).rows[0].v, rol).toBe(false);
    }
  });

  it("devuelve solo (id, cliente_id, tipo, motivo, resultado, created_at): nada de la credencial", async () => {
    const f = await ec.funcion(X, u1, { global: true });
    expect(f.length).toBeGreaterThan(0);
    expect(Object.keys(f[0]!).sort()).toEqual([...COLUMNAS_FUNCION].sort());
  });
});

// =================================================================================================
describe("auditoria_descifrado_listar: filtros, alcance en la funcion y falla cerrado (D-3, D-7)", () => {
  const descX = (): FilaRef[] => volX.filter((r) => r.descifrado);
  const esperadosFuncion = (f: Partial<Filtros>, a: Alcance): string[] => ec.referencia(descX(), asigX, filtros(f), a);

  it("p_global = true: todos los descifrados del estudio, incluso sin cliente, de la mas nueva a la mas vieja", async () => {
    const real = await ec.funcion(X, u1, { global: true });
    expect(real.map((r) => r.id)).toEqual(esperadosFuncion({}, global));
    expect(real.map((r) => r.id)).toContain(Dz.sinCliente);
    for (let i = 1; i < real.length; i++) {
      const a = real[i - 1]!;
      const b = real[i]!;
      expect(a.created_at.getTime() > b.created_at.getTime() || (a.created_at.getTime() === b.created_at.getTime() && a.id > b.id), `orden en ${i}`).toBe(true);
    }
  });

  it("p_global = true ignora p_usuario (aunque sea hostil: otro estudio, inexistente)", async () => {
    const todo = esperadosFuncion({}, global);
    for (const usuario of [uy, randomUUID(), uSin, null]) {
      expect((await ec.funcion(X, u1, { global: true, usuario })).map((r) => r.id), String(usuario)).toEqual(todo);
    }
  });

  it("p_global = false con p_usuario: solo los descifrados de los clientes asignados a ese usuario en este estudio", async () => {
    for (const u of [u1, u2, uAmbos, uSin]) {
      const real = await ec.funcion(X, u1, { global: false, usuario: u });
      expect(real.map((r) => r.id), `usuario ${u}`).toEqual(esperadosFuncion({}, asignado(u)));
    }
    const u1ve = await ec.funcion(X, u1, { global: false, usuario: u1 });
    expect(u1ve.length).toBeGreaterThan(0);
    expect(u1ve.every((r) => r.cliente_id === c1 || r.cliente_id === c2)).toBe(true);
    expect(u1ve.map((r) => r.id)).not.toContain(Dz.sinCliente);
  });

  it.each([
    ["p_global null con usuario", { global: null, usuario: "u1" }],
    ["p_global null sin usuario", { global: null, usuario: null }],
    ["p_global false sin usuario", { global: false, usuario: null }],
    ["p_global false con usuario sin asignaciones", { global: false, usuario: "uSin" }],
    ["p_global false con usuario inexistente", { global: false, usuario: "azar" }],
    ["p_global false con el usuario de otro estudio", { global: false, usuario: "uy" }],
  ])("falla cerrado: %s no devuelve nada", async (_n, a) => {
    const usuario = a.usuario === null ? null : ({ u1, uSin, uy, azar: randomUUID() } as Record<string, string>)[a.usuario]!;
    expect(await ec.funcion(X, u1, { global: a.global, usuario })).toEqual([]);
  });

  it("un usuario asignado en AMBOS estudios solo ve, con la sesion de cada uno, los clientes de ese estudio", async () => {
    const enX = await ec.funcion(X, uAmbos, { global: false, usuario: uAmbos });
    const enY = await ec.funcion(Y, uAmbos, { global: false, usuario: uAmbos });
    expect(enX.map((r) => r.id)).toEqual(esperadosFuncion({}, asignado(uAmbos)));
    expect(enY.map((r) => r.id)).toEqual(ec.referencia(volY.filter((r) => r.descifrado), asigY, SIN_FILTROS, asignado(uAmbos)));
    expect(enX.every((r) => r.cliente_id === c1)).toBe(true);
    expect(enY.every((r) => r.cliente_id === cy1)).toBe(true);
    expect(enX.length).toBeGreaterThan(0);
    expect(enY.length).toBeGreaterThan(0);
  });

  it("p_cliente_id filtra; con alcance asignado un cliente no asignado da vacio", async () => {
    expect((await ec.funcion(X, u1, { global: true, clienteId: c1 })).map((r) => r.id)).toEqual(esperadosFuncion({ clienteId: c1 }, global));
    expect((await ec.funcion(X, u1, { global: true, clienteId: c3 })).map((r) => r.id)).toEqual(esperadosFuncion({ clienteId: c3 }, global));
    expect(await ec.funcion(X, u2, { global: false, usuario: u2, clienteId: c1 })).toEqual([]);
    expect((await ec.funcion(X, u1, { global: false, usuario: u1, clienteId: c1 })).map((r) => r.id)).toEqual(
      esperadosFuncion({ clienteId: c1 }, asignado(u1)),
    );
  });

  it("p_cliente_id de otro estudio, con cualquier combinacion de alcance, no devuelve nada", async () => {
    for (const a of [{ global: true }, { global: false, usuario: u1 }, { global: false, usuario: uAmbos }]) {
      expect(await ec.funcion(X, u1, { ...a, clienteId: cy1 })).toEqual([]);
    }
  });

  it("p_desde inclusivo y p_hasta exclusivo, sobre milisegundos truncados (microsegundos incluidos)", async () => {
    const real = (await ec.funcion(X, u1, { global: true, desde: D1d(), hasta: D2d() })).map((r) => r.id);
    expect(real).toEqual(esperadosFuncion({ desde: D1d(), hastaExclusivo: D2d() }, global));
    expect(real).toEqual(expect.arrayContaining([Dz.finDia, Dz.microFin, Dz.microDesde]));
    for (const fuera of [Dz.exactoD2, Dz.microSig, Dz.microAntes]) expect(real).not.toContain(fuera);
    expect((await ec.funcion(X, u1, { global: true, desde: D1d() })).map((r) => r.id)).toEqual(esperadosFuncion({ desde: D1d() }, global));
    expect((await ec.funcion(X, u1, { global: true, hasta: D2d() })).map((r) => r.id)).toEqual(esperadosFuncion({ hastaExclusivo: D2d() }, global));
  });

  it("combina cliente, fechas y alcance (AND)", async () => {
    const real = await ec.funcion(X, u1, { global: false, usuario: u1, clienteId: c1, desde: D1d(), hasta: D2d() });
    expect(real.map((r) => r.id)).toEqual(esperadosFuncion({ clienteId: c1, desde: D1d(), hastaExclusivo: D2d() }, asignado(u1)));
    expect(real.length).toBeGreaterThan(0);
  });

  it("el cursor (p_antes, p_antes_id) recorre los descifrados sin repetir ni saltar, con filtros y alcance, paginas de 2", async () => {
    const esperado = esperadosFuncion({ desde: D1d() }, asignado(u1));
    expect(esperado.length).toBeGreaterThan(4);
    const vistos: string[] = [];
    let antes: Date | null = null;
    let antesId: string | null = null;
    for (let i = 0; i < 100; i++) {
      const p = await ec.funcion(X, u1, { global: false, usuario: u1, desde: D1d(), limite: 2, antes, antesId });
      if (p.length === 0) break;
      expect(p.length).toBeLessThanOrEqual(2);
      vistos.push(...p.map((r) => r.id));
      antes = p[p.length - 1]!.created_at;
      antesId = p[p.length - 1]!.id;
    }
    expect(vistos).toEqual(esperado);
  });

  it("p_limite: 0 no devuelve filas y uno enorme se recorta a 50 (el alcance se aplica ANTES del limite)", async () => {
    expect(await ec.funcion(X, u1, { global: true, limite: 0 })).toEqual([]);
    expect(await ec.funcion(X, u1, { global: true, limite: 3 })).toHaveLength(3);
    // 60 descifrados sin cliente en un estudio propio, mas nuevos que todo, y 2 de un cliente asignado, mas viejos: con el alcance DENTRO de la
    // funcion el asignado ve sus 2; si el limite se aplicara antes del alcance veria 0.
    const Z = (await ec.estudio()).id;
    const uz = (await ec.miembro(Z)).id;
    const cz = (await ec.cliente(Z)).id;
    await ec.asignar(Z, cz, uz, "colaborador");
    await admin.query(
      `insert into auditoria_descifrado (tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
       select $1, gen_random_uuid(), null, 'sol', 'verificar', 'ok', $2::timestamptz + g * interval '1 second' from generate_series(1, 60) g`,
      [Z, new Date(D1 + 40 * H).toISOString()],
    );
    await admin.query(
      `insert into auditoria_descifrado (tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
       select $1, gen_random_uuid(), $2, 'sol', 'verificar', 'ok', $3::timestamptz + g * interval '1 second' from generate_series(1, 2) g`,
      [Z, cz, new Date(D1).toISOString()],
    );
    expect(await ec.funcion(Z, uz, { global: true, limite: 5000 })).toHaveLength(50);
    const propios = await ec.funcion(Z, uz, { global: false, usuario: uz, limite: 50 });
    expect(propios).toHaveLength(2);
    expect(propios.every((r) => r.cliente_id === cz)).toBe(true);
  });

  it("sin estudio en la sesion (solo usuario) la funcion no devuelve nada, ni con p_global = true", async () => {
    const r = await ec.backend.withUsuario({ userId: u1 }, async (tx) =>
      (
        await tx.query(
          "select * from auditoria_descifrado_listar(null, null, 50, null, null, null, true, null)",
        )
      ).rows,
    );
    expect(r).toEqual([]);
  });

  it("con la sesion de Y no sale ningun descifrado de X, con ningun p_global ni p_usuario", async () => {
    const idsDescX = new Set(descX().map((r) => r.id));
    for (const a of [{ global: true }, { global: false, usuario: u1 }, { global: false, usuario: uAmbos }]) {
      const real = await ec.funcion(Y, uy, a);
      expect(real.filter((r) => idsDescX.has(r.id)), JSON.stringify(a)).toEqual([]);
    }
  });
});

// =================================================================================================
describe("indices de D-7: usuario y accion en auditoria; descifrados por fecha en ms y por cliente", () => {
  let defs: { tablename: string; indexdef: string }[];
  beforeAll(async () => {
    defs = (
      await admin.query(
        "select tablename, indexdef from pg_indexes where schemaname = 'public' and tablename in ('auditoria', 'auditoria_descifrado')",
      )
    ).rows;
  });
  const hay = (tabla: string, re: RegExp): boolean => defs.some((d) => d.tablename === tabla && re.test(d.indexdef));

  it("auditoria (tenant_id, usuario_id, ocurrida_en DESC, id DESC)", () => {
    expect(hay("auditoria", /\(tenant_id, usuario_id, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/)).toBe(true);
  });
  it("auditoria (tenant_id, accion, ocurrida_en DESC, id DESC)", () => {
    expect(hay("auditoria", /\(tenant_id, accion, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/)).toBe(true);
  });
  it("auditoria_descifrado (tenant_id, <ms inmutable>, id DESC): la expresion es la misma que la funcion usa en WHERE y ORDER BY", () => {
    expect(hay("auditoria_descifrado", /\(tenant_id, (?!cliente_id)(?!created_at).*created_at.*, id DESC(?: NULLS (?:LAST|FIRST))?\)/)).toBe(true);
  });
  it("auditoria_descifrado (tenant_id, cliente_id, <ms inmutable>, id DESC)", () => {
    expect(hay("auditoria_descifrado", /\(tenant_id, cliente_id, (?!created_at).*created_at.*, id DESC(?: NULLS (?:LAST|FIRST))?\)/)).toBe(true);
  });
  it("los indices de 017 siguen (fecha y cliente de auditoria)", () => {
    expect(hay("auditoria", /\(tenant_id, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/)).toBe(true);
    expect(hay("auditoria", /\(tenant_id, cliente_id, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/)).toBe(true);
  });
});

// =================================================================================================
describe("opciones del selector (D-6): miembros y clientes visibles, con el alcance", () => {
  interface Opciones {
    miembros: { id: string; nombre: string; activo: boolean }[];
    clientes: { id: string; ruc: string; razonSocial: string; archivado: boolean }[];
  }
  const opciones = (tenantId: string, userId: string, o: { q?: string | null; clienteId?: string | null; alcance: Alcance }): Promise<Opciones> => {
    const f = exportado<(tx: Tx, a: unknown) => Promise<Opciones>>("opcionesAuditoria");
    return ec.comoBackend(tenantId, userId, (tx) => f(tx, { q: o.q ?? null, clienteId: o.clienteId ?? null, alcance: o.alcance }));
  };

  let O: string;
  let P: string; // otro estudio con nombres parecidos
  let uo: string;
  let mAna: string;
  let mBeto: string;
  let mInactivo: string;
  let cNormal: string;
  let cArchivado: string;
  let cPct: string;
  let cGuion: string;
  let cOculto: string; // no asignado a uAsig
  let rucNormal: string;
  let uAsig: string;

  beforeAll(async () => {
    O = (await ec.estudio()).id;
    P = (await ec.estudio()).id;
    const nombrar = (id: string, nombre: string) => admin.query("update usuario set nombre = $2 where id = $1", [id, nombre]);
    mAna = (await ec.miembro(O)).id;
    mBeto = (await ec.miembro(O)).id;
    mInactivo = (await ec.miembro(O, "contador", { desactivada: true })).id;
    uAsig = (await ec.miembro(O)).id;
    await nombrar(mAna, "A1 Ana Opciones");
    await nombrar(mBeto, "B2 Beto Opciones");
    await nombrar(mInactivo, "C3 Carla Inactiva");
    await nombrar(uAsig, "D4 Dario Asignado");
    uo = mAna;
    const ajeno = (await ec.miembro(P)).id;
    await nombrar(ajeno, "A9 Miembro Ajeno");
    const mk = (t: string, razon: string) => ec.ea.cliente(t, razon);
    cNormal = await mk(O, "Alfa Normal SAC");
    cArchivado = await mk(O, "Alfa Archivada SAC");
    await admin.query("update cliente set archivado_at = now() where id = $1", [cArchivado]);
    cPct = await mk(O, "%Promo SAC");
    cGuion = await mk(O, "_Guion SAC");
    cOculto = await mk(O, "Beta Oculto SAC");
    await mk(P, "Alfa Ajena SAC");
    rucNormal = (await admin.query("select ruc from cliente where id = $1", [cNormal])).rows[0].ruc as string;
    await ec.ea.clientes(O, 25); // "Cliente T2 ..." x 25: el tope de 20
    await ec.asignar(O, cNormal, uAsig, "colaborador");
    await ec.asignar(O, cPct, uAsig, "colaborador");
  }, 60_000);

  const ids = (o: Opciones): string[] => o.clientes.map((c) => c.id);

  it("miembros: todos los del estudio, activos e inactivos, por nombre; los de otro estudio no salen", async () => {
    const o = await opciones(O, uo, { alcance: global });
    expect(o.miembros).toEqual([
      { id: mAna, nombre: "A1 Ana Opciones", activo: true },
      { id: mBeto, nombre: "B2 Beto Opciones", activo: true },
      { id: mInactivo, nombre: "C3 Carla Inactiva", activo: false },
      { id: uAsig, nombre: "D4 Dario Asignado", activo: true },
    ]);
    expect(JSON.stringify(o)).not.toContain("Miembro Ajeno");
  });

  it("miembros no depende del alcance: un asignado tambien ve a todos los miembros (el filtro de usuario no es por cliente)", async () => {
    const o = await opciones(O, uAsig, { alcance: asignado(uAsig) });
    expect(o.miembros.map((m) => m.id)).toEqual([mAna, mBeto, mInactivo, uAsig]);
  });

  it("clientes por razon social ILIKE (sin distinguir mayusculas), con archivados marcados", async () => {
    const o = await opciones(O, uo, { q: "alfa", alcance: global });
    expect(new Set(ids(o))).toEqual(new Set([cNormal, cArchivado]));
    expect(o.clientes.find((c) => c.id === cArchivado)).toMatchObject({ archivado: true, razonSocial: "Alfa Archivada SAC" });
    expect(o.clientes.find((c) => c.id === cNormal)).toMatchObject({ archivado: false, ruc: rucNormal, razonSocial: "Alfa Normal SAC" });
  });

  it("clientes por prefijo de RUC", async () => {
    const o = await opciones(O, uo, { q: rucNormal, alcance: global });
    expect(ids(o)).toEqual([cNormal]);
  });

  it("q con % o _ se toma literal (comodines escapados): '%' solo trae '%Promo SAC' y '_' solo '_Guion SAC'", async () => {
    expect(ids(await opciones(O, uo, { q: "%", alcance: global }))).toEqual([cPct]);
    expect(ids(await opciones(O, uo, { q: "_", alcance: global }))).toEqual([cGuion]);
    expect(ids(await opciones(O, uo, { q: "%Promo", alcance: global }))).toEqual([cPct]);
    expect(ids(await opciones(O, uo, { q: "\\", alcance: global }))).toEqual([]);
  });

  it("q hostil (comillas, ;) no altera la consulta: devuelve vacio y no falla", async () => {
    const o = await opciones(O, uo, { q: "x'; drop table cliente; --", alcance: global });
    expect(o.clientes).toEqual([]);
    expect(ids(await opciones(O, uo, { q: "alfa", alcance: global })).length).toBe(2);
  });

  it("maximo 20 clientes por busqueda aunque coincidan 25", async () => {
    const o = await opciones(O, uo, { q: "Cliente T2", alcance: global });
    expect(o.clientes).toHaveLength(20);
  });

  it("con alcance asignado solo salen los clientes asignados (los demas, ni por razon social ni por RUC)", async () => {
    const al = asignado(uAsig);
    expect(new Set(ids(await opciones(O, uAsig, { q: "alfa", alcance: al })))).toEqual(new Set([cNormal]));
    expect(ids(await opciones(O, uAsig, { q: "beta", alcance: al }))).toEqual([]);
    const rucOculto = (await admin.query("select ruc from cliente where id = $1", [cOculto])).rows[0].ruc as string;
    expect(ids(await opciones(O, uAsig, { q: rucOculto, alcance: al }))).toEqual([]);
    expect(ids(await opciones(O, uSin, { q: "alfa", alcance: asignado(uSin) }))).toEqual([]); // uSin no es de O: sin asignaciones
  });

  it("clienteId agrega ese cliente si es visible (para pintarlo al recargar) y no agrega uno no visible", async () => {
    expect(ids(await opciones(O, uo, { clienteId: cOculto, alcance: global }))).toContain(cOculto);
    expect(ids(await opciones(O, uAsig, { clienteId: cNormal, alcance: asignado(uAsig) }))).toContain(cNormal);
    expect(ids(await opciones(O, uAsig, { clienteId: cOculto, alcance: asignado(uAsig) }))).not.toContain(cOculto);
    expect(ids(await opciones(O, uo, { clienteId: cy1, alcance: global }))).not.toContain(cy1); // de otro estudio
  });

  it("con la sesion de otro estudio no sale ningun miembro ni cliente de O", async () => {
    const o = await opciones(P, (await ec.miembro(P)).id, { q: "alfa", alcance: global });
    expect(JSON.stringify(o)).not.toContain("Alfa Normal SAC");
    expect(o.miembros.map((m) => m.id)).not.toEqual(expect.arrayContaining([mAna]));
    const mia = await opciones(P, (await ec.miembro(P)).id, { q: "alfa", alcance: global });
    expect(mia.clientes.map((c) => c.razonSocial)).toEqual(["Alfa Ajena SAC"]);
  });
});
