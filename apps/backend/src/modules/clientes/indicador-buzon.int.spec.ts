/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 024 · T4 (rojo): indicador de mensajes nuevos en el listado de clientes, `GET /clientes` ampliado (D-9, D-12, CA-8).
// Contrato fijado por estas pruebas (T8, módulo `clientes`):
//  - Con `buzon.ver`, cada `ClienteDto` del listado trae `buzon: { nuevos, criticosNuevos }` (ceros si no hay): «nuevo» = pendiente,
//    es decir, no atendido y no histórico; `criticosNuevos` cuenta los críticos entre ellos. Se calcula solo para los clientes de la
//    respuesta y nunca con mensajes de otro estudio.
//  - Atender resta, deshacer suma (un histórico deshecho vuelve a «Históricos» y no suma).
//  - Filtro `conMensajesNuevos=1` (parámetro de `filtrosClientesSchema`): solo clientes con `nuevos > 0`; se combina con `q`,
//    `archivados`, `responsable`, `credencial` y el alcance. Sin `buzon.ver` da 403 `permiso_denegado`.
//  - Sin `buzon.ver` (rol simulado) el campo `buzon` no viaja y el listado sigue en 200.
// Rojo: el campo y el filtro aún no existen; la atención usa las rutas de T8 y las columnas de 0059 (T7).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBandeja,
  cumple,
  FECHAS,
  sinPermiso,
  type Actor,
  type BancoBandeja,
  type Estudio,
} from "../../../test/soporte-bandeja.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let b: BancoBandeja;
let E: Estudio;
let F: Estudio;
let dueno: Actor;
let contador: Actor;
let lectura: Actor;
let cl: Record<"A" | "B" | "C" | "D" | "E" | "G", { id: string; razonSocial: string }>;
let msgs: { A: string[]; B: string[] };
let faltaEsquema: string | null = null;

const lista = (a: Actor, query = "") => b.llamar(a, "GET", `/clientes${query ? `?${query}` : ""}`);
const fila = (r: { body: any }, id: string) => (r.body as any[]).find((x) => x.id === id);
const indicador = async (a: Actor, id: string) => {
  const r = await lista(a, "archivados=1");
  expect(r.status, r.text).toBe(200);
  return fila(r, id)?.buzon;
};

beforeAll(async () => {
  b = await abrirBancoBandeja();
  E = await b.estudio();
  F = await b.estudio();
  const p = b.v.b.c.p.b;
  dueno = E.titular;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  const cs = await b.clientesMasivos(E.tenantId, 6, { prefijo: "Indicador", archivado: (i) => i === 5 });
  cl = { A: cs[0]!, B: cs[1]!, C: cs[2]!, D: cs[3]!, E: cs[4]!, G: cs[5]! };
  // A: contador y lectura; B: contador; C (sin nuevos): contador y lectura; E: solo Dueño. G está archivado (contador).
  await b.asignarMasivo(E.tenantId, contador.id, [cl.A.id, cl.B.id, cl.C.id, cl.G.id], "colaborador");
  await b.asignarMasivo(E.tenantId, lectura.id, [cl.A.id, cl.C.id], "colaborador");
  const f = (c: { id: string }, categoria: string) => ({ clienteId: c.id, fecha: FECHAS[6]!, categoria });
  // A: 2 pendientes comunes + 1 pendiente crítico + 1 atendido + 1 histórico crítico + 1 histórico atendido.
  const a = await b.sembrarLote(E.tenantId, [f(cl.A, "otro"), f(cl.A, "otro"), f(cl.A, "coactiva"), f(cl.A, "otro"), f(cl.A, "resolucion_multa"), f(cl.A, "otro")]);
  // B: 1 pendiente y 3 críticos pendientes.
  const bb = await b.sembrarLote(E.tenantId, [f(cl.B, "otro"), f(cl.B, "coactiva"), f(cl.B, "resolucion_determinacion"), f(cl.B, "requerimiento_fiscalizacion")]);
  msgs = { A: a, B: bb };
  // C: solo un histórico y un atendido (cuenta 0). D: sin mensajes. E: un pendiente (solo el Dueño lo ve). G archivado: 2 pendientes.
  const c = await b.sembrarLote(E.tenantId, [f(cl.C, "coactiva"), f(cl.C, "otro")]);
  await b.sembrarLote(E.tenantId, [f(cl.E, "otro")]);
  await b.sembrarLote(E.tenantId, [f(cl.G, "coactiva"), f(cl.G, "otro")]);
  // Otro estudio con la misma forma: nunca debe sumar.
  const cF = await b.clientesMasivos(F.tenantId, 1, { prefijo: "Ajeno" });
  await b.sembrarLote(F.tenantId, [f(cF[0]!, "coactiva"), f(cF[0]!, "otro"), f(cF[0]!, "otro")]);
  // Estado de atención y de histórico: necesita las columnas de 0059 (T7). Si faltan, fallan las pruebas que lo usan.
  try {
    await b.fijarEstado([a[4]!, a[5]!, c[0]!], { historico: true });
    await b.fijarEstado([a[3]!, a[5]!, c[1]!], { atendidoPor: dueno.id });
  } catch (e) {
    faltaEsquema = e instanceof Error ? e.message : String(e);
  }
});
afterAll(async () => {
  await b?.cerrar();
});
const exigirEsquema = () => {
  if (faltaEsquema !== null) throw new Error(`falta el esquema de 0059 (T7): ${faltaEsquema}`);
};

describe("CA-8 · números por cliente en el listado", () => {
  beforeEach(exigirEsquema);
  it("cada cliente trae nuevos y críticos nuevos; los atendidos y los históricos no cuentan", async () => {
    const r = await lista(dueno, "archivados=1");
    expect(r.status, r.text).toBe(200);
    expect(fila(r, cl.A.id).buzon).toEqual({ nuevos: 3, criticosNuevos: 1 });
    expect(fila(r, cl.B.id).buzon).toEqual({ nuevos: 4, criticosNuevos: 3 });
    expect(fila(r, cl.C.id).buzon).toEqual({ nuevos: 0, criticosNuevos: 0 }); // solo histórico y atendido
    expect(fila(r, cl.D.id).buzon).toEqual({ nuevos: 0, criticosNuevos: 0 }); // sin mensajes: ceros, no ausente
    expect(fila(r, cl.E.id).buzon).toEqual({ nuevos: 1, criticosNuevos: 0 });
    expect(fila(r, cl.G.id).buzon).toEqual({ nuevos: 2, criticosNuevos: 1 }); // archivado con archivados=1
    for (const x of r.body as any[]) expect(cumple("indicadorBuzonSchema", x.buzon), x.razonSocial).toBe(true);
  });

  it("los mensajes del otro estudio no suman ni aparecen", async () => {
    const r = await lista(dueno, "archivados=1");
    expect(r.text).not.toContain("Ajeno");
    const total = (r.body as any[]).reduce((n, x) => n + x.buzon.nuevos, 0);
    expect(total).toBe(3 + 4 + 0 + 0 + 1 + 2);
  });

  it("el listado sigue trayendo el ClienteDto de 007a y no filtra asuntos, contenido ni comentarios", async () => {
    const r = await lista(dueno);
    const a = fila(r, cl.A.id);
    expect(a).toMatchObject({ ruc: expect.any(String), razonSocial: cl.A.razonSocial, archivado: false, credenciales: expect.any(Object) });
    expect(Object.keys(a.buzon).sort()).toEqual(["criticosNuevos", "nuevos"]);
    expect(r.text).not.toContain("Asunto de prueba");
    expect(r.body.some((x: any) => x.id === cl.G.id)).toBe(false); // el archivado sigue fuera sin `archivados=1`
  });

  it("respeta el alcance: el Contador solo ve (y cuenta) sus clientes", async () => {
    const r = await lista(contador, "archivados=1");
    expect(r.status, r.text).toBe(200);
    expect((r.body as any[]).map((x) => x.id).sort()).toEqual([cl.A.id, cl.B.id, cl.C.id, cl.G.id].sort());
    expect(fila(r, cl.A.id).buzon).toEqual({ nuevos: 3, criticosNuevos: 1 });
    expect(fila(r, cl.C.id).buzon).toEqual({ nuevos: 0, criticosNuevos: 0 });
    expect(fila(r, cl.E.id)).toBeUndefined();
  });

  it("atender resta y deshacer suma; el histórico deshecho vuelve a «Históricos» y no suma", async () => {
    const [pend1, pend2, critico] = msgs.A as [string, string, string];
    const m = (id: string) => `/clientes/${cl.A.id}/buzon/mensajes/${id}/atencion`;
    expect(await indicador(dueno, cl.A.id)).toEqual({ nuevos: 3, criticosNuevos: 1 });
    expect((await b.llamar(contador, "POST", m(pend1), { accion: "marcar" })).status).toBe(200);
    expect(await indicador(dueno, cl.A.id)).toEqual({ nuevos: 2, criticosNuevos: 1 });
    expect((await b.llamar(contador, "POST", m(critico), { accion: "marcar", comentario: "Atendida" })).status).toBe(200);
    expect(await indicador(dueno, cl.A.id)).toEqual({ nuevos: 1, criticosNuevos: 0 });
    expect((await b.llamar(contador, "POST", `/buzon/atencion`, { mensajes: [pend2] })).status).toBe(200);
    expect(await indicador(contador, cl.A.id)).toEqual({ nuevos: 0, criticosNuevos: 0 });
    expect((await b.llamar(dueno, "POST", m(critico), { accion: "deshacer" })).status).toBe(200);
    expect((await b.llamar(dueno, "POST", m(pend1), { accion: "deshacer" })).status).toBe(200);
    expect(await indicador(dueno, cl.A.id)).toEqual({ nuevos: 2, criticosNuevos: 1 });
    // el histórico atendido (último de la siembra) se deshace y NO vuelve a contar
    const historicoAtendido = msgs.A[5]!;
    expect((await b.llamar(dueno, "POST", m(historicoAtendido), { accion: "deshacer" })).status).toBe(200);
    expect(await indicador(dueno, cl.A.id)).toEqual({ nuevos: 2, criticosNuevos: 1 });
    // y un histórico sin atender, al atenderlo y deshacerlo, tampoco cambia nada
    const historico = msgs.A[4]!;
    expect((await b.llamar(dueno, "POST", m(historico), { accion: "marcar", comentario: "Era histórico" })).status).toBe(200);
    expect((await b.llamar(dueno, "POST", m(historico), { accion: "deshacer" })).status).toBe(200);
    expect(await indicador(dueno, cl.A.id)).toEqual({ nuevos: 2, criticosNuevos: 1 });
  });

  it("un mensaje que entra por la captura (pendiente) suma uno", async () => {
    const antes = await indicador(dueno, cl.D.id);
    expect(antes).toEqual({ nuevos: 0, criticosNuevos: 0 });
    await b.sembrarLote(E.tenantId, [{ clienteId: cl.D.id, fecha: FECHAS[7]!, categoria: "resolucion_determinacion" }]);
    expect(await indicador(dueno, cl.D.id)).toEqual({ nuevos: 1, criticosNuevos: 1 });
  });
});

describe("CA-8 · filtro «con mensajes nuevos»", () => {
  it("deja solo los clientes con nuevos > 0, ordenados como el listado", async () => {
    exigirEsquema();
    const r = await lista(dueno, "conMensajesNuevos=1");
    expect(r.status, r.text).toBe(200);
    const todos = (await lista(dueno)).body as any[];
    const esperado = todos.filter((x) => x.buzon.nuevos > 0).map((x) => x.id);
    expect((r.body as any[]).map((x) => x.id)).toEqual(esperado);
    expect(esperado).toEqual(expect.arrayContaining([cl.A.id, cl.B.id, cl.E.id]));
    expect(esperado).not.toContain(cl.C.id); // solo históricos y atendidos
    expect((r.body as any[]).every((x) => x.buzon.nuevos > 0)).toBe(true);
  });

  it("se combina con archivados, q y el alcance", async () => {
    exigirEsquema();
    const conArchivados = await lista(dueno, "conMensajesNuevos=1&archivados=1");
    expect((conArchivados.body as any[]).map((x) => x.id)).toContain(cl.G.id);
    expect((await lista(dueno, "conMensajesNuevos=1")).body.map((x: any) => x.id)).not.toContain(cl.G.id);
    const q = await lista(dueno, `conMensajesNuevos=1&q=${encodeURIComponent("Indicador 0002")}`);
    expect((q.body as any[]).map((x) => x.id)).toEqual([cl.B.id]);
    // C existe pero no tiene nuevos: aparece sin el filtro y no con él.
    expect((await lista(dueno, `q=${encodeURIComponent("Indicador 0003")}`)).body.map((x: any) => x.id)).toEqual([cl.C.id]);
    expect((await lista(dueno, `conMensajesNuevos=1&q=${encodeURIComponent("Indicador 0003")}`)).body).toEqual([]);
    const delContador = await lista(contador, "conMensajesNuevos=1&archivados=1");
    expect((delContador.body as any[]).map((x) => x.id).sort()).toEqual([cl.A.id, cl.B.id, cl.G.id].sort());
    expect((await lista(lectura)).body.map((x: any) => x.id).sort()).toEqual([cl.A.id, cl.C.id].sort());
    expect((await lista(lectura, "conMensajesNuevos=1")).body.map((x: any) => x.id)).toEqual([cl.A.id]);
  });

  it("al atender todo lo nuevo de un cliente, sale del filtro", async () => {
    exigirEsquema();
    const r = await lista(dueno, "conMensajesNuevos=1");
    expect((r.body as any[]).map((x) => x.id)).toContain(cl.E.id);
    const [m] = (await b.sql("select id from buzon_mensaje where cliente_id = $1", [cl.E.id])) as { id: string }[];
    expect((await b.llamar(dueno, "POST", `/clientes/${cl.E.id}/buzon/mensajes/${m!.id}/atencion`, { accion: "marcar" })).status).toBe(200);
    const despues = await lista(dueno, "conMensajesNuevos=1");
    expect((despues.body as any[]).map((x) => x.id)).not.toContain(cl.E.id);
  });

  it.each(["conMensajesNuevos=0", "conMensajesNuevos=true", "conMensajesNuevos=", "conMensajesNuevos=2", "conMensajesNuevos=1&conMensajesNuevos=1"])(
    "%s es 400 solicitud_invalida",
    async (query) => {
      const r = await lista(dueno, query);
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    },
  );
});

describe("CA-8 · sin buzon.ver el indicador no viaja (rol simulado)", () => {
  it("el listado sigue en 200 sin el campo `buzon` y el filtro da 403 permiso_denegado", async () => {
    const con = await lista(lectura);
    expect(con.status, con.text).toBe(200);
    expect(fila(con, cl.A.id).buzon).toBeDefined(); // control: con el permiso sí viaja
    await sinPermiso("lectura", "buzon.ver", async () => {
      const r = await lista(lectura);
      expect(r.status, r.text).toBe(200);
      expect(r.body.length).toBeGreaterThan(0);
      for (const x of r.body as any[]) expect(x, x.razonSocial).not.toHaveProperty("buzon");
      expect(r.text).not.toContain("criticosNuevos");
      const filtro = await lista(lectura, "conMensajesNuevos=1");
      expect(filtro.status, filtro.text).toBe(403);
      expect(filtro.body).toEqual({ codigo: "permiso_denegado" });
    });
    expect(fila(await lista(lectura), cl.A.id).buzon).toBeDefined(); // la matriz se restauró
  });
});
