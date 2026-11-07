// Spec 013 (T6, rojo): aislamiento entre estudios, alcance por cliente y cliente archivado en TODAS las rutas de ventas
// (D5; CA-4). Tabla de las 12 rutas bajo /clientes/:clienteId/periodos/:periodo/ventas del plan:
//   GET '' · GET /resumen · GET /correlatividad · GET /propuestas · GET /propuestas/:id/diferencias ·
//   POST /descargar · POST '' (agregar) · DELETE /:ventaId · POST /saltos-justificados · DELETE /saltos-justificados/:id ·
//   POST /importar/vista-previa · POST /importar/confirmar
// Contrato:
//  - Otro estudio, cliente no asignado e inexistente dan el MISMO 404 `{ codigo: "no_encontrado" }` (mismo estado, cuerpo y
//    cabeceras) en todas, aun con ids reales de venta, salto y propuesta del cliente ajeno en la ruta; no cambia nada.
//  - Cliente archivado: toda escritura (descargar, agregar, quitar, justificar, revertir, importar/confirmar) da 409
//    `cliente_archivado` sin cambiar nada; las lecturas siguen respondiendo 200.
//  - Control: el dueño legítimo recorre las 12 rutas con éxito (así los 404 de arriba no son rutas inexistentes).
// Rojo: el módulo `ventas` aún no existe (T13).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  csvVentas,
  cuerpoVenta,
  fila,
  type Actor,
  type BancoVentas,
  type Estudio,
} from "../../../test/soporte-ventas.js";

// Siembras de miles de filas, archivos de decenas de MB y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let F: Estudio;
let contador: Actor;

interface Ids {
  ventaId: string;
  saltoId: string;
  propuestaId: string;
}
interface Ruta {
  nombre: string;
  metodo: "GET" | "POST" | "DELETE";
  ruta: (ids: Ids) => string;
  cuerpo?: unknown;
  bin?: Uint8Array;
  /** Escribe (para la tabla del cliente archivado). */
  escribe: boolean;
}

const CSV = csvVentas([fila("B001", 295)]);
const RUTAS: Ruta[] = [
  { nombre: "GET ventas", metodo: "GET", ruta: () => "", escribe: false },
  {
    nombre: "GET resumen",
    metodo: "GET",
    ruta: () => "/resumen",
    escribe: false,
  },
  {
    nombre: "GET correlatividad",
    metodo: "GET",
    ruta: () => "/correlatividad",
    escribe: false,
  },
  {
    nombre: "GET propuestas",
    metodo: "GET",
    ruta: () => "/propuestas",
    escribe: false,
  },
  {
    nombre: "GET diferencias",
    metodo: "GET",
    ruta: (i) => `/propuestas/${i.propuestaId}/diferencias`,
    escribe: false,
  },
  {
    nombre: "POST descargar",
    metodo: "POST",
    ruta: () => "/descargar",
    escribe: true,
  },
  {
    nombre: "POST agregar",
    metodo: "POST",
    ruta: () => "",
    cuerpo: cuerpoVenta("B001", 291),
    escribe: true,
  },
  {
    nombre: "DELETE venta",
    metodo: "DELETE",
    ruta: (i) => `/${i.ventaId}`,
    escribe: true,
  },
  {
    nombre: "POST justificar",
    metodo: "POST",
    ruta: () => "/saltos-justificados",
    cuerpo: {
      tipo: "03",
      serie: "B001",
      desde: 291,
      hasta: 291,
      comentario: "Anulada",
    },
    escribe: true,
  },
  {
    nombre: "DELETE justificación",
    metodo: "DELETE",
    ruta: (i) => `/saltos-justificados/${i.saltoId}`,
    escribe: true,
  },
  {
    nombre: "POST importar vista previa",
    metodo: "POST",
    ruta: () => "/importar/vista-previa",
    bin: CSV,
    escribe: false,
  },
  {
    nombre: "POST importar confirmar",
    metodo: "POST",
    ruta: () => "/importar/confirmar",
    bin: CSV,
    escribe: true,
  },
];

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  F = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

/** Cliente de E con la propuesta de B001-290 y 292, una venta manual (B001-300) y una justificación (B009, 301 a 301). */
async function conDatos(o: Parameters<BancoVentas["cliente"]>[1] = {}) {
  const c = await v.cliente(E, o);
  const u = E.titular.id;
  await v.sembrarVentas(
    E.tenantId,
    c.id,
    [fila("B001", 290), fila("B001", 292)],
    { usuarioId: u },
  );
  const [ventaId] = await v.sembrarVentas(
    E.tenantId,
    c.id,
    [fila("B001", 300)],
    {
      usuarioId: u,
      origen: "manual",
    },
  );
  const saltoId = await v.sembrarSalto(E.tenantId, c.id, {
    usuarioId: u,
    desde: 301,
    hasta: 301,
    serie: "B009",
  });
  const [propuesta] = await v.propuestas(c.id);
  return {
    c,
    ids: {
      ventaId: ventaId!,
      saltoId,
      propuestaId: propuesta.id as string,
    } satisfies Ids,
  };
}

async function llamar(
  a: Actor,
  r: Ruta,
  clienteId: string,
  ids: Ids,
  periodo = "202610",
) {
  const url = `${base(clienteId, periodo)}${r.ruta(ids)}`;
  if (r.bin !== undefined) {
    const x = await v.bin(a, "POST", url, r.bin);
    return { status: x.status, body: x.json, cabeceras: x.headers };
  }
  const x = await v.llamar(a, r.metodo, url, r.cuerpo);
  return { status: x.status, body: x.body, cabeceras: x.headers };
}
const sinFecha = (h: Record<string, unknown>) => {
  const { date: _d, ...resto } = h;
  void _d;
  return resto;
};

/** Foto de todo lo que 013 guarda de un cliente (para comprobar que un intento rechazado no cambió nada). */
async function foto(clienteId: string) {
  return {
    conteo: await v.conteo(clienteId),
    ventas: await v.ventas(clienteId),
    saltos: await v.saltos(clienteId),
    propuestas: await v.propuestas(clienteId),
    trabajos: (await v.trabajos(clienteId)).length,
  };
}

/**
 * Prueba que la ruta existe para el dueño legítimo: con un periodo mal formado responde 400 (no un 404 de ruta
 * inexistente). Los DELETE se prueban en el control de abajo, donde el id es real.
 */
async function existe(r: Ruta, clienteId: string, ids: Ids): Promise<void> {
  if (r.metodo === "DELETE") return;
  const x = await llamar(E.titular, r, clienteId, ids, "2026-10");
  expect(x.status, `${r.nombre} existe`).toBe(400);
}

describe("CA-4 · otro estudio, cliente no asignado e inexistente: el mismo 404 en las 12 rutas", () => {
  it.each(RUTAS)("otro estudio · $nombre", async (r) => {
    const { c, ids } = await conDatos({ responsable: contador.id });
    await existe(r, c.id, ids);
    const antes = await foto(c.id);
    const ajeno = await llamar(F.titular, r, c.id, ids);
    const inexistente = await llamar(F.titular, r, randomUUID(), ids);
    expect(ajeno.status).toBe(404);
    expect(ajeno.body).toEqual({ codigo: "no_encontrado" });
    expect(ajeno.status).toBe(inexistente.status);
    expect(ajeno.body).toEqual(inexistente.body);
    expect(sinFecha(ajeno.cabeceras)).toEqual(sinFecha(inexistente.cabeceras));
    expect(await foto(c.id)).toEqual(antes);
  });

  it.each(RUTAS)("contador no asignado · $nombre", async (r) => {
    const { c, ids } = await conDatos(); // sin responsable ni colaboradores
    await existe(r, c.id, ids);
    const antes = await foto(c.id);
    const ajeno = await llamar(contador, r, c.id, ids);
    const inexistente = await llamar(contador, r, randomUUID(), ids);
    expect(ajeno.status).toBe(404);
    expect(ajeno.body).toEqual({ codigo: "no_encontrado" });
    expect(ajeno.status).toBe(inexistente.status);
    expect(ajeno.body).toEqual(inexistente.body);
    expect(sinFecha(ajeno.cabeceras)).toEqual(sinFecha(inexistente.cabeceras));
    expect(await foto(c.id)).toEqual(antes);
  });

  it("el otro estudio no ve nada: su cliente del mismo periodo y serie está vacío y los datos de E no se cuelan en ninguna lectura", async () => {
    const { c } = await conDatos();
    const cf = await v.cliente(F);
    const lista = await v.llamar(
      F.titular,
      "GET",
      `${base(cf.id)}?tamano=todas`,
    );
    expect(lista.status, lista.text).toBe(200);
    expect(lista.body).toMatchObject({ filas: [], total: 0 });
    const corr = await v.llamar(
      F.titular,
      "GET",
      `${base(cf.id)}/correlatividad`,
    );
    expect(corr.body).toEqual({ series: [] });
    const res = await v.llamar(F.titular, "GET", `${base(cf.id)}/resumen`);
    expect(res.body.total.cantidad).toBe(0);
    expect(
      (await v.llamar(F.titular, "GET", `${base(cf.id)}/propuestas`)).body,
    ).toEqual([]);
    // El Dueño de E tampoco ve lo de F por el id de E.
    expect((await v.llamar(E.titular, "GET", `${base(cf.id)}`)).status).toBe(
      404,
    );
    expect(c.id).not.toBe(cf.id);
  });
});

describe("CA-4 · cliente archivado: 409 cliente_archivado en toda escritura y las lecturas siguen", () => {
  it.each(RUTAS.filter((r) => r.escribe))("$nombre", async (r) => {
    const { c, ids } = await conDatos({
      responsable: contador.id,
      archivado: true,
    });
    const antes = await foto(c.id);
    const x = await llamar(contador, r, c.id, ids);
    expect(x.status).toBe(409);
    expect(x.body).toEqual({ codigo: "cliente_archivado" });
    expect(await foto(c.id)).toEqual(antes);
  });

  it.each(RUTAS.filter((r) => !r.escribe && r.metodo === "GET"))(
    "$nombre se puede leer",
    async (r) => {
      const { c, ids } = await conDatos({
        responsable: contador.id,
        archivado: true,
      });
      const x = await llamar(contador, r, c.id, ids);
      expect(x.status).toBe(200);
    },
  );
});

describe("control · el dueño legítimo recorre las 12 rutas con éxito (los 404 de arriba no son rutas inexistentes)", () => {
  it("lecturas 200, descargar 202, justificar y revertir 201 y 204, agregar y quitar 201 y 204, vista previa 200 y confirmar 201", async () => {
    const { c, ids } = await conDatos({ responsable: contador.id });
    const ok = async (
      nombre: string,
      esperado: number | number[],
      a = E.titular,
    ) => {
      const r = RUTAS.find((x) => x.nombre === nombre)!;
      const x = await llamar(a, r, c.id, ids);
      expect(
        [esperado].flat(),
        `${nombre}: ${JSON.stringify(x.body)}`,
      ).toContain(x.status);
      return x;
    };
    await ok("GET ventas", 200);
    await ok("GET resumen", 200);
    await ok("GET correlatividad", 200);
    await ok("GET propuestas", 200);
    await ok("GET diferencias", 200);
    await ok("POST descargar", 202);
    const j = await ok("POST justificar", 201);
    expect(typeof j.body.id).toBe("string");
    await ok("DELETE justificación", 204); // la sembrada (B009)
    const a = await ok("POST agregar", 201);
    expect(typeof a.body.id).toBe("string");
    await ok("DELETE venta", 204); // la manual sembrada (B001-300)
    await ok("POST importar vista previa", 200);
    await ok("POST importar confirmar", 201);
    // El contador asignado también tiene alcance sobre su cliente.
    expect(
      (await v.llamar(contador, "GET", `${base(c.id)}/resumen`)).status,
    ).toBe(200);
  });
});
