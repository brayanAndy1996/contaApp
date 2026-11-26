/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (030) · CA-4 (permiso efectivo): prueba de tabla por permiso con un rol propio que SOLO lo tiene (más sus requisitos de U3) y otro que
// tiene todo MENOS él, sobre un endpoint representativo (2xx o 403 `permiso_denegado`); alcance asignado: cliente no asignado da 404 (HU-08);
// editar el rol o el rol del miembro aplica en la siguiente petición (005 D3); puede ser responsable quien tiene `sire.clasificar` (D18).
// Cubre: `guards/permiso.guard.ts`, `guards/cliente-scope.guard.ts`, `yo.controller.ts`, `acceso/roles/roles.service.ts`.
// Rojo: la asignación de roles propios (T8), `/roles` (T9) y las tablas de la 0082 (T6) aún no existen.
// Sondas: donde hay una lectura segura se exige 200; en las escrituras el cuerpo es inválido a propósito (el guard de permiso va antes
// que la validación: 403 si falta el permiso, y cualquier otro estado < 500 si lo tiene). Sin sonda (no hay ruta aún): estudio.configurar,
// sire.aprobar_generar, ajustes.crear y ajustes.generar, que se prueban por `/acceso/yo`.
import { PERMISOS, type Permiso } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import {
  ASIGNABLES,
  asignar,
  asignarSistema,
  cerrar,
  crearOk,
  editar,
  eliminar,
  membresiaDe,
  nombreUnico,
  ordenados,
  rolConMiembro,
  todosMenos,
  uuidInexistente,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
let T: Actor; // Dueño
let M: Actor; // miembro con sesión viva al que se le rota el rol
let cliente: string;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  T = E.titular;
  M = await b.miembro(E.tenantId, "lectura");
  [cliente] = (await b.clientes(E.tenantId, 1)) as [string];
});
afterAll(async () => {
  await b?.cerrar();
});

interface Peticion {
  metodo: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  ruta: string;
  cuerpo?: unknown;
}
interface Sonda {
  /** Cuándo es 2xx de verdad (lectura segura): el estado exacto. Si falta, basta con pasar el guard (≠ 403, < 500). */
  exacto?: number;
  pedir: () => Peticion;
}
const periodoMalo = "invalido";
const SONDAS: Partial<Record<Permiso, Sonda>> = {
  "usuarios.ver": { exacto: 200, pedir: () => ({ metodo: "GET", ruta: "/usuarios" }) },
  "usuarios.gestionar": { pedir: () => ({ metodo: "PATCH", ruta: `/usuarios/${M.id}/rol`, cuerpo: { rol: "no-existe" } }) },
  "roles.gestionar": { exacto: 200, pedir: () => ({ metodo: "GET", ruta: "/roles" }) },
  "clientes.ver": { exacto: 200, pedir: () => ({ metodo: "GET", ruta: "/clientes" }) },
  "clientes.crear": { pedir: () => ({ metodo: "POST", ruta: "/clientes", cuerpo: {} }) },
  "clientes.editar": { pedir: () => ({ metodo: "PATCH", ruta: `/clientes/${cliente}`, cuerpo: {} }) },
  "clientes.archivar": { pedir: () => ({ metodo: "POST", ruta: `/clientes/${cliente}/reactivar`, cuerpo: {} }) },
  "clientes.asignar": { exacto: 200, pedir: () => ({ metodo: "GET", ruta: `/clientes/${cliente}/asignaciones` }) },
  "credenciales.editar": { pedir: () => ({ metodo: "PUT", ruta: `/clientes/${cliente}/credenciales/sol`, cuerpo: {} }) },
  "sire.descargar": { pedir: () => ({ metodo: "POST", ruta: `/clientes/${cliente}/periodos/${periodoMalo}/compras/descargar`, cuerpo: {} }) },
  "sire.clasificar": { pedir: () => ({ metodo: "POST", ruta: `/clientes/${cliente}/periodos/${periodoMalo}/compras/deshacer`, cuerpo: {} }) },
  "buzon.ver": { pedir: () => ({ metodo: "GET", ruta: "/buzon/mensajes" }) },
  "buzon.marcar_leido": { pedir: () => ({ metodo: "POST", ruta: `/clientes/${cliente}/buzon/mensajes/${uuidInexistente()}/abrir`, cuerpo: {} }) },
  "buzon.atender": { pedir: () => ({ metodo: "POST", ruta: "/buzon/atencion", cuerpo: {} }) },
  "reglas.ver": { pedir: () => ({ metodo: "GET", ruta: `/clientes/${cliente}/reglas` }) },
  "reglas.gestionar": { pedir: () => ({ metodo: "DELETE", ruta: `/clientes/${cliente}/reglas/${uuidInexistente()}` }) },
  "prorrata.ver": { pedir: () => ({ metodo: "GET", ruta: `/clientes/${cliente}/prorrata` }) },
  "prorrata.gestionar": { pedir: () => ({ metodo: "PUT", ruta: `/clientes/${cliente}/prorrata/meses/${periodoMalo}`, cuerpo: {} }) },
  "auditoria.ver": { exacto: 200, pedir: () => ({ metodo: "GET", ruta: "/auditoria" }) },
};
const SIN_RUTA: readonly Permiso[] = ["estudio.configurar", "sire.aprobar_generar", "ajustes.crear", "ajustes.generar"];
const CON_SONDA = Object.keys(SONDAS) as Permiso[];

const pedir = (a: Actor, s: Sonda) => {
  const p = s.pedir();
  return b.llamar(a, p.metodo, p.ruta, p.cuerpo);
};
function pasa(r: { status: number; body: any; text: string }, s: Sonda, etiqueta: string): void {
  if (s.exacto !== undefined) expect(r.status, `${etiqueta}: ${r.text}`).toBe(s.exacto);
  else {
    expect(r.status, `${etiqueta}: ${r.text}`).not.toBe(403);
    expect(r.status, `${etiqueta}: ${r.text}`).toBeLessThan(500);
  }
}
const deniega = (r: { status: number; body: any; text: string }, etiqueta: string): void => {
  expect(r.status, `${etiqueta}: ${r.text}`).toBe(403);
  expect(r.body, etiqueta).toEqual({ codigo: "permiso_denegado" });
};

describe("CA-4 · la tabla cubre todo el catálogo", () => {
  it("cada permiso asignable tiene sonda o se prueba por /acceso/yo, y plan.gestionar no se asigna", () => {
    const cubiertos = new Set<string>([...CON_SONDA, ...SIN_RUTA, "plan.gestionar"]);
    expect(PERMISOS.filter((p) => !cubiertos.has(p))).toEqual([]);
    expect(ordenados([...CON_SONDA, ...SIN_RUTA])).toEqual(ordenados(ASIGNABLES));
  });
});

describe("CA-4 · /acceso/yo informa los permisos efectivos de un rol propio, sin añadir ni quitar", () => {
  it.each(ASIGNABLES.map((p) => [p] as const))("solo %s (más sus requisitos de U3)", async (p) => {
    const rol = await crearOk(b, T, { nombre: nombreUnico(`Yo ${p}`), permisos: cerrar([p]), alcance: "global" });
    expect((await asignar(b, T, M.id, rol.id)).status).toBe(200);
    const r = await b.llamar(M, "GET", "/acceso/yo");
    expect(r.status, r.text).toBe(200);
    expect(ordenados(r.body.permisos)).toEqual(ordenados(cerrar([p])));
    expect(r.body).toMatchObject({ rol: "propio", alcance: "global", rolPropio: { id: rol.id } });
    expect(r.body.permisos).not.toContain("plan.gestionar");
    expect((await asignarSistema(b, T, M.id, "lectura")).status).toBe(200);
    expect((await eliminar(b, T, rol.id)).status).toBe(204);
  });
});

describe("CA-4 · tabla por permiso: rol que solo lo tiene (2xx) frente a rol que tiene todo menos él (403)", () => {
  it.each(CON_SONDA.map((p) => [p] as const))("%s", async (p) => {
    const sonda = SONDAS[p]!;
    const requisitos = cerrar([p]);
    const solo = await crearOk(b, T, { nombre: nombreUnico(`Solo ${p}`), permisos: requisitos, alcance: "global" });
    const sin = await crearOk(b, T, { nombre: nombreUnico(`Sin ${p}`), permisos: todosMenos(p), alcance: "global" });
    try {
      // Con el permiso (y solo con lo que U3 exige junto a él).
      expect((await asignar(b, T, M.id, solo.id)).status).toBe(200);
      pasa(await pedir(M, sonda), sonda, `${p} con rol que solo lo tiene`);
      // Todo lo demás, denegado: cualquier otra sonda cuyo permiso no esté en lo que se concedió.
      for (const q of CON_SONDA.filter((x) => !requisitos.includes(x))) {
        deniega(await pedir(M, SONDAS[q]!), `solo ${p} en la sonda de ${q}`);
      }
      // Sin el permiso: 403, aunque tenga todos los demás.
      expect((await asignar(b, T, M.id, sin.id)).status).toBe(200);
      deniega(await pedir(M, sonda), `${p} con rol que tiene todo menos él`);
    } finally {
      await asignarSistema(b, T, M.id, "lectura");
      await eliminar(b, T, solo.id);
      await eliminar(b, T, sin.id);
    }
  });
});

describe("CA-4 · alcance asignado: el cliente no asignado da 404 (HU-08); editar el rol cambia el alcance en la siguiente petición", () => {
  it("lista solo lo asignado, 404 en el resto (lectura y escritura); global lo abre y volver a asignado lo cierra", async () => {
    const [c1, c2, c3] = (await b.clientes(E.tenantId, 3)) as [string, string, string];
    const { rol, miembro } = await rolConMiembro(b, T, ["clientes.ver", "clientes.editar", "buzon.ver"], "asignado");
    await b.asignar(E.tenantId, c1, miembro.id, "colaborador");

    const lista = await b.llamar(miembro, "GET", "/clientes");
    expect(lista.status, lista.text).toBe(200);
    expect(lista.body.map((x: any) => x.id)).toEqual([c1]);
    expect((await b.llamar(miembro, "GET", `/clientes/${c1}`)).status).toBe(200);
    for (const [metodo, ruta, cuerpo] of [
      ["GET", `/clientes/${c2}`, undefined],
      ["PATCH", `/clientes/${c2}`, {}],
      ["GET", `/clientes/${c3}/reglas`, undefined],
    ] as const) {
      const r = await b.llamar(miembro, metodo, ruta, cuerpo);
      expect(r.status, `${metodo} ${ruta}`).toBe(404);
    }
    expect((await b.llamar(miembro, "GET", "/acceso/yo")).body.alcance).toBe("asignado");

    expect((await editar(b, T, rol.id, { alcance: "global" })).status).toBe(200);
    const abierta = await b.llamar(miembro, "GET", "/clientes");
    expect(abierta.body.map((x: any) => x.id)).toEqual(expect.arrayContaining([c1, c2, c3]));
    expect((await b.llamar(miembro, "GET", `/clientes/${c2}`)).status).toBe(200);
    expect((await b.llamar(miembro, "GET", "/acceso/yo")).body.alcance).toBe("global");

    expect((await editar(b, T, rol.id, { alcance: "asignado" })).status).toBe(200);
    expect((await b.llamar(miembro, "GET", `/clientes/${c2}`)).status).toBe(404);
    expect((await b.llamar(miembro, "GET", "/clientes")).body.map((x: any) => x.id)).toEqual([c1]);
  });

  it("un rol propio de alcance asignado sin clientes asignados ve la lista vacía, no un 403", async () => {
    const { miembro } = await rolConMiembro(b, T, ["clientes.ver"], "asignado");
    const r = await b.llamar(miembro, "GET", "/clientes");
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe("CA-4 · editar el rol aplica en la siguiente petición (005 D3), con la sesión viva", () => {
  it("quitar y devolver clientes.crear: 403 y de nuevo pasa el guard; /acceso/yo lo acompaña", async () => {
    const { rol, miembro } = await rolConMiembro(b, T, ["clientes.crear"], "global");
    const crear = () => b.llamar(miembro, "POST", "/clientes", {});
    expect((await crear()).status).not.toBe(403);
    expect((await editar(b, T, rol.id, { permisos: ["clientes.ver"] })).status).toBe(200);
    deniega(await crear(), "tras quitar clientes.crear");
    expect((await b.llamar(miembro, "GET", "/acceso/yo")).body.permisos).toEqual(["clientes.ver"]);
    expect((await editar(b, T, rol.id, { permisos: ["clientes.ver", "clientes.crear"] })).status).toBe(200);
    expect((await crear()).status).not.toBe(403);
    expect(ordenados((await b.llamar(miembro, "GET", "/acceso/yo")).body.permisos)).toEqual(["clientes.crear", "clientes.ver"]);
  });

  it("cambiar al miembro de un rol propio a uno de sistema (y de vuelta) cambia lo que puede hacer en la siguiente petición", async () => {
    const { rol, miembro } = await rolConMiembro(b, T, ["clientes.crear"], "global");
    expect((await b.llamar(miembro, "POST", "/clientes", {})).status).not.toBe(403);
    expect((await asignarSistema(b, T, miembro.id, "lectura")).status).toBe(200);
    deniega(await b.llamar(miembro, "POST", "/clientes", {}), "lectura no crea clientes");
    expect((await asignar(b, T, miembro.id, rol.id)).status).toBe(200);
    expect((await b.llamar(miembro, "POST", "/clientes", {})).status).not.toBe(403);
    expect(await membresiaDe(b, E.tenantId, miembro.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
  });

  it("desactivar al miembro con rol propio: la siguiente petición ya no tiene estudio (403 estudio_requerido)", async () => {
    const { miembro } = await rolConMiembro(b, T, ["clientes.ver"], "global");
    expect((await b.llamar(miembro, "GET", "/clientes")).status).toBe(200);
    expect((await b.llamar(T, "POST", `/usuarios/${miembro.id}/desactivar`)).status).toBe(200);
    const r = await b.llamar(miembro, "GET", "/clientes");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "estudio_requerido" });
  });
});

describe("D18 · puede ser responsable de un cliente quien tiene sire.clasificar", () => {
  it("con sire.clasificar: 200 como responsable; sin él: 409 miembro_no_asignable, pero sí como colaborador", async () => {
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    const { miembro: con } = await rolConMiembro(b, T, ["sire.clasificar"], "asignado");
    const { miembro: sin } = await rolConMiembro(b, T, ["sire.descargar"], "asignado");
    const poner = (m: Actor, tipo: string) => b.llamar(T, "PUT", `/clientes/${c}/asignaciones/${m.id}`, { tipo });
    expect((await poner(sin, "colaborador")).status).toBe(200);
    const no = await poner(sin, "responsable");
    expect(no.status, no.text).toBe(409);
    expect(no.body).toEqual({ codigo: "miembro_no_asignable" });
    expect((await poner(con, "responsable")).status).toBe(200);
    const lista = await b.llamar(T, "GET", "/clientes");
    expect(lista.body.find((x: any) => x.id === c).responsable).not.toBeNull();
  });
});
