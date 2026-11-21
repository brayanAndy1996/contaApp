/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 025 (T6, rojo): permisos y alcance de las seis rutas de importación y candidatas (D-10; CA-7, CA-8).
// Contrato (plan 025 y 021; los permisos de rol no cambian: 025 no añade permisos):
//  - Leer (`GET …/importaciones/ultima`, `GET …/candidatas`): `reglas.ver`, que tienen los cinco roles.
//  - Escribir (`POST …/importaciones`, `…/candidatas/activar`, `…/candidatas/:id/reemplazar`, `…/candidatas/descartar`): `reglas.gestionar`,
//    que tienen Dueño, Administrador y Contador. Asistente y Lectura reciben 403 `permiso_denegado` ANTES de mirar el recurso, sin efectos.
//  - Alcance (ClienteScopeGuard): Dueño y Administrador son globales; el Contador solo ve sus clientes asignados (como responsable o
//    colaborador). Un cliente que no se ve, de otro estudio o inexistente: el mismo 404 `{codigo:"no_encontrado"}`. Una candidata del
//    cliente A en la ruta del cliente B (aunque el mismo usuario vea ambos) o de otro estudio: el mismo 404.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente. Las tablas son de T10.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoAprendizaje,
  inexistente,
  NO_ENCONTRADO,
  PERMISO_DENEGADO,
  rutaActivar,
  rutaCandidatas,
  rutaDescartar,
  rutaImportaciones,
  rutaReemplazar,
  rutaUltima,
  type Actor,
  type BancoAprendizaje,
  type CandidataSembrada,
  type Estudio,
} from "../../../test/soporte-aprendizaje.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

type Rol = "dueno" | "admin" | "contador" | "asistente" | "lectura";
const ROLES: readonly Rol[] = ["dueno", "admin", "contador", "asistente", "lectura"];
const GESTORES: readonly Rol[] = ["dueno", "admin", "contador"];

let v: BancoAprendizaje;
let E: Estudio;
let F: Estudio;
const actores = {} as Record<Rol, Actor>;
let contadorSinCliente: Actor; // contador del estudio sin ningún cliente asignado

beforeAll(async () => {
  v = await abrirBancoAprendizaje();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  actores.dueno = E.titular;
  for (const rol of ROLES) if (rol !== "dueno") actores[rol] = await p.miembro(E.tenantId, rol);
  contadorSinCliente = await p.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
interface Ctx {
  c: Cliente;
  p1: CandidataSembrada; // propuesta DNG sin regla
  dis: CandidataSembrada; // conflicto distinto con regla viva DG v3
  importacionId: string;
}
const doc = (n: number): string => `20700${String(n).padStart(6, "0")}`;

/** Un cliente de E que todos los roles ven (contador responsable; asistente y lectura colaboradores) con candidatas sembradas. */
async function preparar(o: { cliente?: Parameters<typeof v.cliente>[1] } = {}): Promise<Ctx> {
  const c = await v.cliente(E, { responsable: actores.contador.id, colaboradores: [actores.asistente.id, actores.lectura.id], ...(o.cliente ?? {}) });
  const importacionId = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: E.titular.id, candidatas: 2, solicitadaHace: "1 hour" });
  const [reglaDis] = await v.sembrarReglasVivas(E.tenantId, c.id, [{ docNumero: doc(2), destino: "DG", version: 3 }], E.titular.id);
  const [p1, dis] = await v.sembrarCandidatas(
    E.tenantId,
    c.id,
    importacionId,
    [
      { docNumero: doc(1), destinoPropuesto: "DNG" },
      { docNumero: doc(2), destinoPropuesto: "DNG" },
    ],
    E.titular.id,
  );
  void reglaDis;
  return { c, p1: p1!, dis: dis!, importacionId };
}

interface Caso {
  nombre: string;
  /** Roles que reciben 2xx (el resto, 403 permiso_denegado). */
  permitidos: readonly Rol[];
  pedir: (x: Ctx) => { metodo: "GET" | "POST"; ruta: string; cuerpo?: unknown };
  /** Estado esperado de un éxito. */
  exito: number;
}
const CASOS: Caso[] = [
  { nombre: "POST …/reglas/importaciones", permitidos: GESTORES, exito: 202, pedir: (x) => ({ metodo: "POST", ruta: rutaImportaciones(x.c.id), cuerpo: {} }) },
  { nombre: "GET …/reglas/importaciones/ultima", permitidos: ROLES, exito: 200, pedir: (x) => ({ metodo: "GET", ruta: rutaUltima(x.c.id) }) },
  { nombre: "GET …/reglas/candidatas", permitidos: ROLES, exito: 200, pedir: (x) => ({ metodo: "GET", ruta: `${rutaCandidatas(x.c.id)}?grupo=propuestas` }) },
  {
    nombre: "POST …/candidatas/activar",
    permitidos: GESTORES,
    exito: 200,
    pedir: (x) => ({ metodo: "POST", ruta: rutaActivar(x.c.id), cuerpo: { items: [{ id: x.p1.id }] } }),
  },
  {
    nombre: "POST …/candidatas/:candidataId/reemplazar",
    permitidos: GESTORES,
    exito: 200,
    pedir: (x) => ({ metodo: "POST", ruta: rutaReemplazar(x.c.id, x.dis.id), cuerpo: { versionRegla: 3 } }),
  },
  {
    nombre: "POST …/candidatas/descartar",
    permitidos: GESTORES,
    exito: 200,
    pedir: (x) => ({ metodo: "POST", ruta: rutaDescartar(x.c.id), cuerpo: { ids: [x.p1.id] } }),
  },
];

describe("CA-8 · matriz de roles × rutas de 025 (D-10)", () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const observado: Record<string, number> = {};
    const esperado: Record<string, number> = {};
    for (const rol of ROLES) {
      const x = await preparar();
      const antes = await v.fotoAprendizaje(E.tenantId, x.c.id);
      const p = caso.pedir(x);
      const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
      observado[rol] = r.status;
      esperado[rol] = caso.permitidos.includes(rol) ? caso.exito : 403;
      if (!caso.permitidos.includes(rol)) {
        expect(r.body, `${rol}: ${r.text}`).toEqual(PERMISO_DENEGADO);
        expect(await v.fotoAprendizaje(E.tenantId, x.c.id), `${rol}: sin efectos`).toEqual(antes);
      }
    }
    expect(observado).toEqual(esperado);
  });

  it("Dueño, Administrador y Contador asignado importan y activan (CA-8); Asistente y Lectura no ven efectos de su intento", async () => {
    for (const rol of ROLES) {
      const x = await preparar();
      const i = await v.http(actores[rol], "POST", rutaImportaciones(x.c.id), {});
      const a = await v.http(actores[rol], "POST", rutaActivar(x.c.id), { items: [{ id: x.p1.id }] });
      if (GESTORES.includes(rol)) {
        expect(i.status, `${rol}: ${i.text}`).toBe(202);
        expect(a.status, `${rol}: ${a.text}`).toBe(200);
        expect(a.body.activadas).toEqual([x.p1.id]);
      } else {
        expect(i.status, `${rol}: ${i.text}`).toBe(403);
        expect(a.status, `${rol}: ${a.text}`).toBe(403);
        expect(await v.trabajosImportar(E.tenantId, x.c.id)).toEqual([]);
        expect((await v.reglasConOrigen(x.c.id)).filter((r) => r.origen === "importacion")).toEqual([]);
      }
    }
  });
});

describe("CA-8 · quién ve el cliente (alcance) en las seis rutas", () => {
  it("un Contador que es colaborador (no responsable) del cliente también importa y activa", async () => {
    const x = await preparar({ cliente: { responsable: undefined, colaboradores: [actores.contador.id] } as any });
    const i = await v.http(actores.contador, "POST", rutaImportaciones(x.c.id), {});
    expect(i.status, i.text).toBe(202);
    const a = await v.http(actores.contador, "POST", rutaActivar(x.c.id), { items: [{ id: x.p1.id }] });
    expect(a.status, a.text).toBe(200);
  });

  it("Dueño y Administrador (alcance global) operan un cliente sin asignaciones; el Contador no lo ve: 404", async () => {
    const x = await preparar({ cliente: { responsable: undefined, colaboradores: [] } as any });
    for (const rol of ["dueno", "admin"] as const) {
      const r = await v.http(actores[rol], "GET", rutaUltima(x.c.id));
      expect(r.status, `${rol}: ${r.text}`).toBe(200);
    }
    const i = await v.http(actores.admin, "POST", rutaImportaciones(x.c.id), {});
    expect(i.status, i.text).toBe(202);
    for (const caso of CASOS) {
      const p = caso.pedir(x);
      const r = await v.http(actores.contador, p.metodo, p.ruta, p.cuerpo);
      expect(r.status, `${caso.nombre}: ${r.text}`).toBe(404);
      expect(r.body).toEqual(NO_ENCONTRADO);
    }
  });

  it("un Contador sin el cliente asignado, de otro estudio o inexistente: el mismo 404 en las seis rutas", async () => {
    const x = await preparar();
    const ajeno = await v.cliente(F, {});
    // Control: el responsable sí ve el cliente (si no, los 404 de abajo serían los de la ruta que falta).
    expect((await v.http(actores.contador, "GET", rutaUltima(x.c.id))).status).toBe(200);
    for (const caso of CASOS) {
      const referencia = caso.pedir({ ...x, c: { id: inexistente(), ruc: "" } });
      const noExiste = await v.http(actores.contador, referencia.metodo, referencia.ruta, referencia.cuerpo);
      expect(noExiste.status, `${caso.nombre}: ${noExiste.text}`).toBe(404);
      expect(noExiste.body).toEqual(NO_ENCONTRADO);
      const noAsignado = caso.pedir(x);
      const a = await v.http(contadorSinCliente, noAsignado.metodo, noAsignado.ruta, noAsignado.cuerpo);
      expect(a.status, `${caso.nombre} (no asignado): ${a.text}`).toBe(404);
      expect(a.text).toBe(noExiste.text);
      const deOtroEstudio = caso.pedir({ ...x, c: ajeno });
      const o = await v.http(actores.dueno, deOtroEstudio.metodo, deOtroEstudio.ruta, deOtroEstudio.cuerpo);
      expect(o.status, `${caso.nombre} (otro estudio): ${o.text}`).toBe(404);
      expect(o.text).toBe(noExiste.text);
    }
    expect(await v.importacionesBd(ajeno.id)).toEqual([]);
    expect(await v.trabajosImportar(F.tenantId, ajeno.id)).toEqual([]);
  });

  it("Asistente y Lectura que no tienen el cliente asignado: lectura 404 (no lo ven) y escritura 403 (el permiso se mira antes)", async () => {
    const x = await preparar({ cliente: { responsable: actores.contador.id, colaboradores: [] } });
    for (const rol of ["asistente", "lectura"] as const) {
      for (const caso of CASOS) {
        const p = caso.pedir(x);
        const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
        const escritura = p.metodo === "POST";
        expect(r.status, `${rol} · ${caso.nombre}: ${r.text}`).toBe(escritura ? 403 : 404);
        expect(r.body).toEqual(escritura ? PERMISO_DENEGADO : NO_ENCONTRADO);
      }
    }
  });

  it("una candidata del cliente A en la ruta del cliente B del mismo estudio (aunque el usuario vea ambos): 404 igual al de una inexistente, sin efectos", async () => {
    const a = await preparar();
    const b = await preparar();
    const antesA = await v.fotoAprendizaje(E.tenantId, a.c.id);
    const antesB = await v.fotoAprendizaje(E.tenantId, b.c.id);
    const cruzadas = [
      { metodo: "POST" as const, ruta: rutaActivar(b.c.id), cuerpo: { items: [{ id: a.p1.id }] }, vacia: { items: [{ id: inexistente() }] } },
      { metodo: "POST" as const, ruta: rutaReemplazar(b.c.id, a.dis.id), cuerpo: { versionRegla: 3 }, vacia: null },
      { metodo: "POST" as const, ruta: rutaDescartar(b.c.id), cuerpo: { ids: [a.p1.id] }, vacia: { ids: [inexistente()] } },
    ];
    for (const rol of GESTORES) {
      for (const p of cruzadas) {
        const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
        expect(r.status, `${rol} ${p.ruta}: ${r.text}`).toBe(404);
        expect(r.body).toEqual(NO_ENCONTRADO);
        const ref =
          p.vacia === null
            ? await v.http(actores[rol], p.metodo, rutaReemplazar(b.c.id, inexistente()), p.cuerpo)
            : await v.http(actores[rol], p.metodo, p.ruta, p.vacia);
        expect(r.text).toBe(ref.text);
      }
    }
    expect(await v.fotoAprendizaje(E.tenantId, a.c.id)).toEqual(antesA);
    expect(await v.fotoAprendizaje(E.tenantId, b.c.id)).toEqual(antesB);
    // Control: la candidata de A en la ruta de A sí se activa.
    expect((await v.http(actores.contador, "POST", rutaActivar(a.c.id), { items: [{ id: a.p1.id }] })).status).toBe(200);
  });

  it("sin sesión: 401 en las seis rutas", async () => {
    const x = await preparar();
    for (const caso of CASOS) {
      const p = caso.pedir(x);
      const r = await v.sinSesion(p.metodo, p.ruta, p.cuerpo);
      expect(r.status, `${caso.nombre}: ${r.text}`).toBe(401);
    }
  });
});
