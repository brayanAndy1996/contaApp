/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 024 · T4 (rojo): atender mensajes. `POST /clientes/:clienteId/buzon/mensajes/:mensajeId/atencion` (individual) y
// `POST /buzon/atencion` (lote) (D-5 a D-8, D-13, U-1, U-2, U-3; CA-4 a CA-7, CA-12). Contrato fijado por estas pruebas (T8):
//  - Individual: cuerpo `atenderMensajeBodySchema` `{ accion: "marcar" | "deshacer", comentario? }` (`.strict()`), permiso `buzon.atender`.
//    200 `{ atencion: { estado, por: {id, nombre} | null, en, comentario } }` con el estado resultante (`atencionDetalleSchema`).
//    409 `{ codigo: "atencion_cambiada", atencion }` con el estado vigente si otra persona ya cambió el mensaje (marcar uno atendido,
//    deshacer uno que no lo está); 409 `cliente_archivado` (U-1: archivado = solo lectura); 400 `comentario_requerido` al marcar un
//    crítico sin comentario; 400 `solicitud_invalida` para cuerpo inválido; 404 `no_encontrado` igual al de un inexistente para cliente
//    no visible, de otro estudio, mensaje de otro cliente o inexistente; 403 `permiso_denegado` para Lectura.
//  - Lote: `{ mensajes: uuid[1..100] sin repetidos, comentario? }` (`.strict()`: solo marca, sin `accion`, U-3). 200 `{ atendidos, omitidos }`
//    (omitidos = ya atendidos); un id no visible, de otro estudio o inexistente = 404 a todo el lote sin cambios; 101 ids = 400;
//    un crítico sin comentario = 400 `comentario_requerido` a todo el lote; cliente archivado = 409 `cliente_archivado` sin cambios.
//  - Efectos: un evento en `buzon_atencion` y una fila de auditoría (`buzon.atendido` | `buzon.atencion_deshecha`, entidad `buzon_mensaje`,
//    actor usuario, `datos` = `{ mensajeId, clienteId, conComentario, lote }`, sin el texto). El leído en SUNAT no cambia. No se encola
//    ningún trabajo (el backend no llama a SUNAT) ni se crea ni marca ninguna notificación (D-14, CA-12). El comentario no sale en logs.
//  - Deshacer devuelve el mensaje a «pendiente» o, si es histórico, a «historico» (U-2).
// Rojo: las rutas no existen (404).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBandeja,
  cumple,
  FECHAS,
  sinPermiso,
  type Actor,
  type BancoBandeja,
  type Estudio,
} from "../../../test/soporte-bandeja.js";
import { capturarLogs, forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let b: BancoBandeja;
let E: Estudio;
let F: Estudio;
let dueno: Actor;
let admin: Actor;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let cliente: { id: string }; // visible para contador, asistente y lectura
let ajeno: { id: string }; // sin asignaciones: solo lo ven Dueño y Administrador
let archivado: { id: string }; // visible, archivado
let cliente2: { id: string }; // visible, activo (lotes grandes y cruces de cliente)
let deF: { id: string };

beforeAll(async () => {
  b = await abrirBancoBandeja();
  E = await b.estudio();
  F = await b.estudio();
  const p = b.v.b.c.p.b;
  dueno = E.titular;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  await b.nombrar(contador, "Carla Contador");
  await b.nombrar(asistente, "Aldo Asistente");
  await b.nombrar(dueno, "Dora Dueña");
  const cs = await b.clientesMasivos(E.tenantId, 4, { prefijo: "Atención", archivado: (i) => i === 2 });
  cliente = cs[0]!;
  ajeno = cs[1]!;
  archivado = cs[2]!;
  cliente2 = cs[3]!;
  for (const u of [contador, asistente, lectura]) {
    await b.asignarMasivo(E.tenantId, u.id, [cliente.id, archivado.id, cliente2.id], "colaborador");
  }
  deF = (await b.clientesMasivos(F.tenantId, 1, { prefijo: "Otro" }))[0]!;
});
afterAll(async () => {
  await b?.cerrar();
});

type Opc = { categoria?: string; leido?: boolean; historico?: boolean; atendidoPor?: string; en?: { id: string } };
/** Un mensaje nuevo (por omisión no crítico, pendiente, en `cliente`). */
async function mensaje(o: Opc = {}): Promise<string> {
  const [id] = await b.sembrarLote((o.en === deF ? F : E).tenantId, [
    {
      clienteId: (o.en ?? cliente).id,
      fecha: FECHAS[3]!,
      categoria: o.categoria ?? "otro",
      leido: o.leido ?? false,
      asunto: "Asunto de atención",
      ...(o.historico === undefined ? {} : { historico: o.historico }),
      ...(o.atendidoPor === undefined ? {} : { atendidoPor: o.atendidoPor }),
    },
  ]);
  return id!;
}
const ruta = (cl: { id: string }, m: string) => `/clientes/${cl.id}/buzon/mensajes/${m}/atencion`;
const atender = (a: Actor, m: string, cuerpo: unknown, cl: { id: string } = cliente) => b.llamar(a, "POST", ruta(cl, m), cuerpo);
const lote = (a: Actor, cuerpo: unknown) => b.llamar(a, "POST", "/buzon/atencion", cuerpo);
const marcar = (a: Actor, m: string, comentario?: string) => atender(a, m, comentario === undefined ? { accion: "marcar" } : { accion: "marcar", comentario });
const deshacer = (a: Actor, m: string, comentario?: string) => atender(a, m, comentario === undefined ? { accion: "deshacer" } : { accion: "deshacer", comentario });
const estadoEnLista = async (a: Actor, m: string): Promise<string | undefined> => {
  const r = await b.llamar(a, "GET", `/clientes/${cliente.id}/buzon/mensajes?limite=100`);
  expect(r.status, r.text).toBe(200);
  return r.body.mensajes.find((f: any) => f.id === m)?.atencion.estado;
};

describe("CA-4 · marcar como atendido", () => {
  it("sin comentario (no crítico): 200 con el estado, el usuario y la fecha; deja un evento y una auditoría sin texto", async () => {
    const m = await mensaje();
    const antes = await b.contadores(E.tenantId);
    const r = await marcar(contador, m);
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.atencion).toEqual({ estado: "atendido", por: { id: contador.id, nombre: "Carla Contador" }, en: expect.any(String), comentario: null });
    expect(cumple("atencionDetalleSchema", r.body.atencion)).toBe(true);
    expect(Math.abs(Date.now() - new Date(r.body.atencion.en).getTime())).toBeLessThan(60_000);
    const fila = await b.mensaje(m);
    expect(fila.atendido_por).toBe(contador.id);
    expect(fila.atendido_en).not.toBeNull();
    const ev = await b.eventos(m);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ accion: "atendido", comentario: null, usuario_id: contador.id, cliente_id: cliente.id, tenant_id: E.tenantId });
    const aud = (await b.auditoria(E.tenantId, "buzon.atendido")).filter((f) => f.entidad_id === m);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: contador.id, entidad: "buzon_mensaje", cliente_id: cliente.id });
    expect(aud[0].datos).toEqual({ mensajeId: m, clienteId: cliente.id, conComentario: false, lote: false });
    const despues = await b.contadores(E.tenantId);
    expect(despues.eventos).toBe(antes.eventos + 1);
    expect(despues.auditoria).toBe(antes.auditoria + 1);
  });

  it("con comentario: queda en el evento y en el detalle, y el mensaje sale de «Pendientes» y entra en «Atendidos»", async () => {
    const m = await mensaje();
    expect(await estadoEnLista(contador, m)).toBe("pendiente");
    const r = await marcar(asistente, m, "Se envió el escrito el 12/11");
    expect(r.status, r.text).toBe(200);
    expect(r.body.atencion).toMatchObject({ estado: "atendido", por: { id: asistente.id }, comentario: "Se envió el escrito el 12/11" });
    expect((await b.eventos(m))[0]).toMatchObject({ comentario: "Se envió el escrito el 12/11" });
    const aud = (await b.auditoria(E.tenantId, "buzon.atendido")).filter((f) => f.entidad_id === m);
    expect(aud[0].datos).toEqual({ mensajeId: m, clienteId: cliente.id, conComentario: true, lote: false });
    const pend = await b.llamar(dueno, "GET", `/clientes/${cliente.id}/buzon/mensajes?atencion=pendientes&limite=100`);
    const atend = await b.llamar(dueno, "GET", `/clientes/${cliente.id}/buzon/mensajes?atencion=atendidos&limite=100`);
    expect(pend.body.mensajes.map((f: any) => f.id)).not.toContain(m);
    expect(atend.body.mensajes.map((f: any) => f.id)).toContain(m);
    const global = await b.llamar(dueno, "GET", "/buzon/mensajes?atencion=pendientes&limite=100");
    expect(global.body.mensajes.map((f: any) => f.id)).not.toContain(m);
    const fila = atend.body.mensajes.find((f: any) => f.id === m);
    expect(fila.atencion).toEqual({ estado: "atendido", por: { id: asistente.id, nombre: "Aldo Asistente" }, en: expect.any(String) });
    expect(JSON.stringify(fila)).not.toContain("Se envió el escrito"); // el comentario solo viaja en el detalle
  });

  it("el comentario se recorta y se guarda como texto plano (tal cual, sin interpretar)", async () => {
    const m = await mensaje();
    const hostil = `<img src=x onerror=alert(1)> & <script>1</script>\nsegunda línea`;
    const r = await marcar(contador, m, `   ${hostil}  `);
    expect(r.status, r.text).toBe(200);
    expect(r.body.atencion.comentario).toBe(hostil);
    expect(String(r.headers["content-type"])).toMatch(/application\/json/);
    expect((await b.eventos(m))[0].comentario).toBe(hostil);
  });

  it("el leído en SUNAT no cambia (ni a leído ni a no leído) y no se llama a SUNAT: ningún trabajo ni notificación nuevos", async () => {
    const leido = await mensaje({ leido: true });
    const noLeido = await mensaje({ leido: false });
    const antes = await b.contadores(E.tenantId);
    const snap = await b.instantanea([leido, noLeido]);
    for (const m of [leido, noLeido]) expect((await marcar(contador, m)).status).toBe(200);
    const despues = await b.instantanea([leido, noLeido]);
    expect(despues.map((f) => f.leido_sunat)).toEqual(snap.map((f) => f.leido_sunat));
    expect(despues.map((f) => f.contenido_ruta)).toEqual(snap.map((f) => f.contenido_ruta));
    expect(despues.map((f) => f.ultima_captura_en)).toEqual(snap.map((f) => f.ultima_captura_en));
    const fin = await b.contadores(E.tenantId);
    expect(fin.trabajos).toBe(antes.trabajos);
    expect(fin.notificaciones).toBe(antes.notificaciones);
    expect(await b.trabajos(cliente.id, "sol.buzon.revisar")).toHaveLength(0);
    expect(await b.trabajos(cliente.id, "sol.buzon.abrir")).toHaveLength(0);
  });

  it("el backend no llama a SUNAT: ni los módulos de la bandeja ni la atención importan @contapp/sunat", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const fuentes = ["bandeja.controller.ts", "bandeja.service.ts", "atencion.service.ts", "cursor.ts"];
    for (const n of fuentes) {
      expect(existsSync(join(dir, n)), `${n} debe existir (T8)`).toBe(true);
      expect(readFileSync(join(dir, n), "utf8"), n).not.toMatch(/@contapp\/sunat|@contapp\/crypto/);
    }
  });
});

describe("CA-4 · comentario obligatorio al marcar un crítico (D-7)", () => {
  it("un crítico sin comentario: 400 comentario_requerido y no cambia nada", async () => {
    const m = await mensaje({ categoria: "coactiva" });
    const antes = await b.contadores(E.tenantId);
    for (const cuerpo of [{ accion: "marcar" }, { accion: "marcar", comentario: undefined }]) {
      const r = await atender(contador, m, cuerpo);
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "comentario_requerido" });
    }
    expect((await b.mensaje(m)).atendido_por).toBeNull();
    expect(await b.eventos(m)).toHaveLength(0);
    expect(await b.contadores(E.tenantId)).toEqual(antes);
  });

  it("un crítico con comentario en blanco o solo espacios no vale (400)", async () => {
    const m = await mensaje({ categoria: "resolucion_multa" });
    for (const comentario of ["", "   ", "\n"]) {
      const r = await marcar(contador, m, comentario);
      expect(r.status, `«${comentario}»: ${r.text}`).toBe(400);
      expect(["comentario_requerido", "solicitud_invalida"]).toContain(r.body.codigo);
    }
    expect(await b.eventos(m)).toHaveLength(0);
  });

  it.each(["coactiva", "resolucion_determinacion", "resolucion_multa", "requerimiento_fiscalizacion"])("un crítico (%s) con comentario se marca", async (categoria) => {
    const m = await mensaje({ categoria });
    const r = await marcar(contador, m, "Revisado con el cliente");
    expect(r.status, r.text).toBe(200);
    expect(r.body.atencion.estado).toBe("atendido");
  });

  it("un no crítico no lo exige; deshacer un crítico tampoco", async () => {
    const m = await mensaje({ categoria: "coactiva" });
    expect((await marcar(contador, m, "Atendido")).status).toBe(200);
    const r = await deshacer(contador, m);
    expect(r.status, r.text).toBe(200);
    expect(r.body.atencion).toMatchObject({ estado: "pendiente", por: null, en: null, comentario: null });
  });
});

describe("CA-5 · deshacer (por otra persona), historial y auditoría", () => {
  it("lo deshace otra persona con el permiso: vuelve a «Pendientes», deja su evento y su auditoría, sin el texto", async () => {
    const m = await mensaje();
    expect((await marcar(asistente, m, "Primero")).status).toBe(200);
    const r = await deshacer(contador, m, "Se devolvió: faltaba un anexo");
    expect(r.status, r.text).toBe(200);
    expect(r.body.atencion).toEqual({ estado: "pendiente", por: null, en: null, comentario: null });
    expect(await estadoEnLista(dueno, m)).toBe("pendiente");
    const fila = await b.mensaje(m);
    expect(fila.atendido_por).toBeNull();
    expect(fila.atendido_en).toBeNull();
    const ev = await b.eventos(m);
    expect(ev.map((e) => [e.accion, e.usuario_id, e.comentario])).toEqual([
      ["atendido", asistente.id, "Primero"],
      ["deshecho", contador.id, "Se devolvió: faltaba un anexo"],
    ]);
    const aud = (await b.auditoria(E.tenantId, "buzon.atencion_deshecha")).filter((f) => f.entidad_id === m);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: contador.id, entidad: "buzon_mensaje" });
    expect(aud[0].datos).toEqual({ mensajeId: m, clienteId: cliente.id, conComentario: true, lote: false });
    expect(JSON.stringify(await b.auditoriaTodas(E.tenantId))).not.toContain("faltaba un anexo");
  });

  it("deshacer sin comentario es válido; marcar de nuevo después de deshacer también", async () => {
    const m = await mensaje();
    expect((await marcar(contador, m)).status).toBe(200);
    expect((await deshacer(contador, m)).status).toBe(200);
    expect((await marcar(contador, m, "Otra vez")).status).toBe(200);
    expect((await b.eventos(m)).map((e) => e.accion)).toEqual(["atendido", "deshecho", "atendido"]);
  });

  it("U-2: deshacer un histórico atendido lo devuelve a «Históricos», no a «Pendientes»", async () => {
    const m = await mensaje({ historico: true });
    expect(await estadoEnLista(contador, m)).toBe("historico");
    const a = await marcar(contador, m, "Era de la primera sincronización");
    expect(a.status, a.text).toBe(200);
    expect(a.body.atencion.estado).toBe("atendido");
    expect(await estadoEnLista(contador, m)).toBe("atendido");
    const d = await deshacer(contador, m);
    expect(d.status, d.text).toBe(200);
    expect(d.body.atencion).toMatchObject({ estado: "historico", por: null, en: null });
    expect(await estadoEnLista(contador, m)).toBe("historico");
    const pend = await b.llamar(contador, "GET", `/clientes/${cliente.id}/buzon/mensajes?atencion=pendientes&limite=100`);
    expect(pend.body.mensajes.map((f: any) => f.id)).not.toContain(m);
    expect((await b.mensaje(m)).historico).toBe(true);
  });
});

describe("CA-7 · 409 atencion_cambiada y concurrencia", () => {
  it("marcar uno ya atendido: 409 con el estado vigente y sin un segundo evento", async () => {
    const m = await mensaje();
    expect((await marcar(asistente, m, "Lo hizo Aldo")).status).toBe(200);
    const r = await marcar(contador, m, "Yo también");
    expect(r.status, r.text).toBe(409);
    expect(r.body.codigo).toBe("atencion_cambiada");
    expect(r.body.atencion).toMatchObject({ estado: "atendido", por: { id: asistente.id, nombre: "Aldo Asistente" } });
    expect(await b.eventos(m)).toHaveLength(1);
    expect((await b.mensaje(m)).atendido_por).toBe(asistente.id);
  });

  it("deshacer uno que no está atendido: 409 atencion_cambiada con el estado vigente (pendiente) y sin evento", async () => {
    const m = await mensaje();
    const r = await deshacer(contador, m);
    expect(r.status, r.text).toBe(409);
    expect(r.body.codigo).toBe("atencion_cambiada");
    expect(r.body.atencion).toMatchObject({ estado: "pendiente", por: null });
    const h = await mensaje({ historico: true });
    const rh = await deshacer(contador, h);
    expect(rh.status, rh.text).toBe(409);
    expect(rh.body.atencion.estado).toBe("historico");
    expect(await b.eventos(m)).toHaveLength(0);
  });

  it("dos personas marcan a la vez: una recibe 200, la otra 409 atencion_cambiada, y queda un solo evento", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const m = await mensaje();
      const [x, y] = await Promise.all([marcar(contador, m, "Carla"), marcar(asistente, m, "Aldo")]);
      expect([x.status, y.status].sort(), `${x.text} | ${y.text}`).toEqual([200, 409]);
      const perdedora = x.status === 409 ? x : y;
      expect(perdedora.body.codigo).toBe("atencion_cambiada");
      expect(await b.eventos(m)).toHaveLength(1);
      expect((await b.auditoria(E.tenantId, "buzon.atendido")).filter((f) => f.entidad_id === m)).toHaveLength(1);
    }
  });

  it("dos lotes solapados con ids en distinto orden no se interbloquean: ambos responden y cada mensaje se atiende una vez", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await mensaje());
    const [x, y] = await Promise.all([lote(contador, { mensajes: ids }), lote(asistente, { mensajes: [...ids].reverse() })]);
    expect([x.status, y.status], `${x.text} | ${y.text}`).toEqual([200, 200]);
    expect(x.body.atendidos.length + y.body.atendidos.length).toBe(6);
    expect(x.body.omitidos.length + y.body.omitidos.length).toBe(6);
    for (const m of ids) expect(await b.eventos(m)).toHaveLength(1);
  });
});

describe("CA-6 · permiso buzon.atender y alcance", () => {
  it.each([
    ["Asistente", () => asistente],
    ["Contador", () => contador],
    ["Administrador", () => admin],
    ["Dueño", () => dueno],
  ])("%s marca y deshace", async (_n, quien) => {
    const m = await mensaje();
    const a = await marcar(quien(), m, "Hecho");
    expect(a.status, a.text).toBe(200);
    const d = await deshacer(quien(), m);
    expect(d.status, d.text).toBe(200);
  });

  it("Lectura: 403 permiso_denegado al marcar, deshacer y en lote; no cambia nada", async () => {
    const m = await mensaje();
    const antes = await b.contadores(E.tenantId);
    for (const r of [await marcar(lectura, m), await deshacer(lectura, m), await lote(lectura, { mensajes: [m] })]) {
      expect(r.status, r.text).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    expect(await b.contadores(E.tenantId)).toEqual(antes);
    expect((await b.mensaje(m)).atendido_por).toBeNull();
    expect((await b.llamar(lectura, "GET", `/clientes/${cliente.id}/buzon/mensajes/${m}`)).status).toBe(200); // control: leer sí puede
  });

  it("sin el permiso (rol simulado) el Asistente tampoco puede, y al volver puede", async () => {
    const m = await mensaje();
    await sinPermiso("asistente", "buzon.atender", async () => {
      const r = await marcar(asistente, m);
      expect(r.status, r.text).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    });
    expect((await marcar(asistente, m)).status).toBe(200);
  });

  it("sin sesión: 401", async () => {
    const m = await mensaje();
    expect((await b.sinSesion("POST", ruta(cliente, m))).status).toBe(401);
    expect((await b.sinSesion("POST", "/buzon/atencion")).status).toBe(401);
  });

  it("cliente no visible, de otro estudio, mensaje cruzado o inexistente: el mismo 404 no_encontrado y nada cambia", async () => {
    const delAjeno = await mensaje({ en: ajeno });
    const propio = await mensaje();
    const delOtroEstudio = await mensaje({ en: deF });
    const antes = await b.contadores(E.tenantId);
    const antesF = await b.contadores(F.tenantId);
    const inexistente = await atender(contador, randomUUID(), { accion: "marcar" }, { id: randomUUID() });
    expect(inexistente.status, inexistente.text).toBe(404);
    expect(inexistente.body).toEqual({ codigo: "no_encontrado" });
    const casos: [string, Awaited<ReturnType<typeof atender>>][] = [
      ["cliente no asignado", await atender(contador, delAjeno, { accion: "marcar" }, ajeno)],
      ["mensaje de un cliente no visible bajo un cliente visible", await atender(contador, delAjeno, { accion: "marcar" })],
      ["mensaje propio bajo otro cliente visible", await atender(contador, propio, { accion: "marcar" }, cliente2)],
      ["cliente de otro estudio", await atender(contador, delOtroEstudio, { accion: "marcar" }, deF)],
      ["mensaje de otro estudio bajo un cliente propio", await atender(contador, delOtroEstudio, { accion: "marcar" })],
      ["Dueño de otro estudio con cliente y mensaje de E", await atender(F.titular, propio, { accion: "marcar" })],
      ["Dueño de E sobre el cliente de F", await atender(dueno, delOtroEstudio, { accion: "deshacer" }, deF)],
      ["mensajeId mal formado", await atender(contador, "no-es-uuid", { accion: "marcar" })],
      ["clienteId mal formado", await atender(contador, propio, { accion: "marcar" }, { id: "no-es-uuid" })],
    ];
    for (const [nombre, r] of casos) {
      expect(r.status, `${nombre}: ${r.text}`).toBe(404);
      expect(forma(r), nombre).toEqual(forma(inexistente));
    }
    expect((await atender(dueno, delAjeno, { accion: "marcar" }, ajeno)).status).toBe(200); // control: el Dueño sí ve ese cliente
    expect(await b.eventos(delOtroEstudio)).toHaveLength(0);
    expect((await b.mensaje(propio)).atendido_por).toBeNull();
    expect((await b.contadores(F.tenantId)).eventos).toBe(antesF.eventos);
    expect((await b.contadores(E.tenantId)).eventos).toBe(antes.eventos + 1); // solo el control
  });

  it("el cuerpo no puede cambiar el alcance: `clienteId`, `tenantId` o `usuarioId` en el cuerpo son 400", async () => {
    const m = await mensaje();
    for (const extra of [{ clienteId: ajeno.id }, { tenantId: F.tenantId }, { usuarioId: dueno.id }, { lote: true }]) {
      const r = await atender(contador, m, { accion: "marcar", ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await b.eventos(m)).toHaveLength(0);
  });
});

describe("U-1 · un cliente archivado es solo lectura", () => {
  it("marcar y deshacer sobre un mensaje de un cliente archivado dan 409 cliente_archivado sin cambios", async () => {
    const pendiente = await mensaje({ en: archivado });
    const atendido = await mensaje({ en: archivado, atendidoPor: dueno.id });
    const antes = await b.contadores(E.tenantId);
    for (const r of [await atender(contador, pendiente, { accion: "marcar" }, archivado), await atender(contador, atendido, { accion: "deshacer" }, archivado), await atender(dueno, pendiente, { accion: "marcar", comentario: "x" }, archivado)]) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "cliente_archivado" });
    }
    expect(await b.contadores(E.tenantId)).toEqual(antes);
    expect(await b.eventos(pendiente)).toHaveLength(0);
    // La lectura sigue: el detalle y la bandeja fijada responden 200.
    expect((await b.llamar(contador, "GET", `/clientes/${archivado.id}/buzon/mensajes/${pendiente}`)).status).toBe(200);
    expect((await b.llamar(contador, "GET", `/clientes/${archivado.id}/buzon/mensajes`)).status).toBe(200);
  });
});

describe("CA-4 · cuerpo inválido (400 solicitud_invalida)", () => {
  const MALOS: [string, unknown][] = [
    ["sin cuerpo", undefined],
    ["acción desconocida", { accion: "archivar" }],
    ["sin acción", { comentario: "x" }],
    ["acción con mayúsculas", { accion: "Marcar" }],
    ["comentario que no es texto", { accion: "marcar", comentario: 5 }],
    ["comentario de 501 caracteres", { accion: "marcar", comentario: "a".repeat(501) }],
    ["comentario con NUL", { accion: "marcar", comentario: "a\u0000b" }],
    ["comentario con retorno de carro", { accion: "marcar", comentario: "a\rb" }],
    ["comentario con carácter bidi", { accion: "marcar", comentario: "pago‮atras" }],
    ["comentario vacío", { accion: "marcar", comentario: "" }],
    ["comentario nulo", { accion: "marcar", comentario: null }],
    ["clave desconocida", { accion: "marcar", foo: 1 }],
    ["arreglo", [{ accion: "marcar" }]],
  ];
  it.each(MALOS)("%s", async (_n, cuerpo) => {
    const m = await mensaje();
    const r = await atender(contador, m, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await b.eventos(m)).toHaveLength(0);
  });

  it("500 caracteres exactos y el salto de línea son válidos", async () => {
    const m = await mensaje();
    const r = await marcar(contador, m, `${"a".repeat(250)}\n${"b".repeat(249)}`);
    expect(r.status, r.text).toBe(200);
  });
});

describe("CA-7 · lote", () => {
  it("marca varios mensajes de varios clientes con un mismo comentario: una auditoría por mensaje, con lote=true", async () => {
    const ids = [await mensaje(), await mensaje({ en: cliente2 }), await mensaje({ categoria: "coactiva" }), await mensaje({ en: cliente2, categoria: "resolucion_multa" })];
    const clienteDe = new Map([[ids[0]!, cliente.id], [ids[1]!, cliente2.id], [ids[2]!, cliente.id], [ids[3]!, cliente2.id]]);
    const r = await lote(contador, { mensajes: ids, comentario: "Revisado en reunión semanal" });
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(cumple("respuestaLoteSchema", r.body)).toBe(true);
    expect([...r.body.atendidos].sort()).toEqual([...ids].sort());
    expect(r.body.omitidos).toEqual([]);
    for (const m of ids) {
      const ev = await b.eventos(m);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ accion: "atendido", comentario: "Revisado en reunión semanal", usuario_id: contador.id });
      const aud = (await b.auditoria(E.tenantId, "buzon.atendido")).filter((f) => f.entidad_id === m);
      expect(aud).toHaveLength(1);
      expect(aud[0].datos).toEqual({ mensajeId: m, clienteId: clienteDe.get(m), conComentario: true, lote: true });
    }
  });

  it("sin comentario y sin críticos: vale", async () => {
    const ids = [await mensaje(), await mensaje()];
    const r = await lote(asistente, { mensajes: ids });
    expect(r.status, r.text).toBe(200);
    expect(r.body.atendidos).toHaveLength(2);
    expect((await b.eventos(ids[0]!))[0].comentario).toBeNull();
  });

  it("un lote de 100 se acepta", async () => {
    const filas = Array.from({ length: 100 }, () => ({ clienteId: cliente2.id, fecha: FECHAS[4]!, categoria: "otro" }));
    const ids = await b.sembrarLote(E.tenantId, filas);
    const r = await lote(contador, { mensajes: ids });
    expect(r.status, r.text).toBe(200);
    expect(r.body.atendidos).toHaveLength(100);
    expect((await b.contadores(E.tenantId)).eventos).toBeGreaterThanOrEqual(100);
  });

  it("un lote de 100 con un id ajeno (cliente no visible) da 404 a todo el lote y no cambia nada", async () => {
    const filas = Array.from({ length: 99 }, () => ({ clienteId: cliente2.id, fecha: FECHAS[4]!, categoria: "otro" }));
    const ids = await b.sembrarLote(E.tenantId, filas);
    const intruso = await mensaje({ en: ajeno });
    const antes = await b.contadores(E.tenantId);
    const r = await lote(contador, { mensajes: [...ids, intruso] });
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await b.contadores(E.tenantId)).toEqual(antes);
    expect((await b.mensaje(ids[0]!)).atendido_por).toBeNull();
    expect((await b.mensaje(intruso)).atendido_por).toBeNull();
    // Control: sin el id ajeno el mismo lote de 99 se atiende (la ruta existe y atiende de verdad).
    const sinIntruso = await lote(contador, { mensajes: ids });
    expect(sinIntruso.status, sinIntruso.text).toBe(200);
    expect(sinIntruso.body.atendidos).toHaveLength(99);
    expect((await b.mensaje(ids[0]!)).atendido_por).toBe(contador.id);
  });

  it("un id de otro estudio, uno inexistente o uno mal formado: 404 (los dos primeros) o 400 (el mal formado), sin cambios y sin filtrar cuál falló", async () => {
    const propio = await mensaje();
    const deOtro = await mensaje({ en: deF });
    const antes = await b.contadores(E.tenantId);
    const antesF = await b.contadores(F.tenantId);
    const r1 = await lote(contador, { mensajes: [propio, deOtro] });
    const r2 = await lote(contador, { mensajes: [propio, randomUUID()] });
    const r3 = await lote(dueno, { mensajes: [propio, deOtro] });
    for (const r of [r1, r2, r3]) {
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(forma(r1)).toEqual(forma(r2));
    const r4 = await lote(contador, { mensajes: [propio, "no-es-uuid"] });
    expect(r4.status).toBe(400);
    expect(await b.contadores(E.tenantId)).toEqual(antes);
    expect(await b.contadores(F.tenantId)).toEqual(antesF);
  });

  it("101 ids, ninguno, repetidos o claves de más: 400 solicitud_invalida y nada cambia", async () => {
    const filas = Array.from({ length: 101 }, () => ({ clienteId: cliente2.id, fecha: FECHAS[4]!, categoria: "otro" }));
    const ids = await b.sembrarLote(E.tenantId, filas);
    const uno = ids[0]!;
    const antes = await b.contadores(E.tenantId);
    const malos: [string, unknown][] = [
      ["101 ids", { mensajes: ids }],
      ["ninguno", { mensajes: [] }],
      ["sin la clave", {}],
      ["repetidos", { mensajes: [uno, uno] }],
      ["no es lista", { mensajes: uno }],
      ["con `accion` (U-3: no se deshace en lote)", { mensajes: [uno], accion: "deshacer" }],
      ["con `clienteId`", { mensajes: [uno], clienteId: cliente.id }],
      ["comentario vacío", { mensajes: [uno], comentario: "" }],
      ["comentario de 501", { mensajes: [uno], comentario: "a".repeat(501) }],
    ];
    for (const [nombre, cuerpo] of malos) {
      const r = await lote(contador, cuerpo);
      expect(r.status, `${nombre}: ${r.text}`).toBe(400);
      expect(r.body, nombre).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await b.contadores(E.tenantId)).toEqual(antes);
  });

  it("con mensajes ya atendidos: los informa como omitidos, atiende los demás y deja eventos solo de los nuevos", async () => {
    const ya = await mensaje();
    expect((await marcar(asistente, ya, "Antes")).status).toBe(200);
    const nuevo = await mensaje();
    const r = await lote(contador, { mensajes: [ya, nuevo], comentario: "En lote" });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ atendidos: [nuevo], omitidos: [ya] });
    expect(await b.eventos(ya)).toHaveLength(1);
    expect((await b.eventos(ya))[0].usuario_id).toBe(asistente.id);
    expect(await b.eventos(nuevo)).toHaveLength(1);
    const todosYa = await lote(contador, { mensajes: [ya, nuevo] });
    expect(todosYa.status, todosYa.text).toBe(200);
    expect(todosYa.body).toEqual({ atendidos: [], omitidos: expect.arrayContaining([ya, nuevo]) });
  });

  it("un crítico sin comentario da 400 comentario_requerido a todo el lote y no cambia nada (tampoco los no críticos)", async () => {
    const comun = await mensaje();
    const critico = await mensaje({ categoria: "resolucion_determinacion" });
    const antes = await b.contadores(E.tenantId);
    const r = await lote(contador, { mensajes: [comun, critico] });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "comentario_requerido" });
    expect(await b.contadores(E.tenantId)).toEqual(antes);
    expect((await b.mensaje(comun)).atendido_por).toBeNull();
    const ok = await lote(contador, { mensajes: [comun, critico], comentario: "Con comentario sí" });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.atendidos).toHaveLength(2);
  });

  it("un lote con un mensaje de un cliente archivado da 409 cliente_archivado y no cambia nada", async () => {
    const comun = await mensaje();
    const enArchivado = await mensaje({ en: archivado });
    const antes = await b.contadores(E.tenantId);
    const r = await lote(contador, { mensajes: [comun, enArchivado] });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await b.contadores(E.tenantId)).toEqual(antes);
  });

  it("el Contador no puede atender por lote mensajes de clientes que no ve, aunque el Dueño sí", async () => {
    const delAjeno = await mensaje({ en: ajeno });
    const prueba = await lote(contador, { mensajes: [delAjeno] });
    expect(prueba.status, prueba.text).toBe(404);
    const dueno1 = await lote(dueno, { mensajes: [delAjeno] });
    expect(dueno1.status, dueno1.text).toBe(200);
  });
});

describe("CA-12 · atender no toca SUNAT, notificaciones ni la campana", () => {
  it("una serie de marcas, deshacer y lote no crea ni marca notificaciones ni trabajos", async () => {
    const crit = await mensaje({ categoria: "coactiva" });
    const a = await mensaje();
    const antes = await b.contadores(E.tenantId);
    const noLeidasAntes = await b.v.b.sql("select count(*)::int n from notificacion where tenant_id = $1 and leida_en is not null", [E.tenantId]);
    expect((await marcar(contador, crit, "Hecho")).status).toBe(200);
    expect((await deshacer(dueno, crit)).status).toBe(200);
    expect((await lote(contador, { mensajes: [a, crit], comentario: "Lote" })).status).toBe(200);
    const despues = await b.contadores(E.tenantId);
    expect(despues.notificaciones).toBe(antes.notificaciones);
    expect(despues.trabajos).toBe(antes.trabajos);
    const noLeidasDespues = await b.v.b.sql("select count(*)::int n from notificacion where tenant_id = $1 and leida_en is not null", [E.tenantId]);
    expect(noLeidasDespues[0].n).toBe(noLeidasAntes[0].n);
  });
});

describe("D-7 · el comentario no sale por logs, auditoría, trabajos ni notificaciones", () => {
  it("con un canario en el comentario, solo lo contiene el historial (y el detalle que lo lee)", async () => {
    const canario = "CANARIO-comentario-atencion-9f3";
    const m1 = await mensaje();
    const m2 = await mensaje({ categoria: "coactiva" });
    const m3 = await mensaje();
    const { resultado: estados, logs } = await capturarLogs(async () => [
      (await marcar(contador, m1, canario)).status,
      (await lote(contador, { mensajes: [m2, m3], comentario: `${canario}-lote` })).status,
      (await deshacer(asistente, m1, `${canario}-deshacer`)).status,
      (await marcar(contador, m1, "x".repeat(501))).status, // 400: tampoco se loguea el cuerpo rechazado
      (await atender(contador, m2, { accion: "marcar", comentario: canario }, ajeno)).status, // 404
    ]);
    expect(estados).toEqual([200, 200, 200, 400, 404]);
    expect(logs).not.toContain(canario);
    expect(logs).not.toContain("CANARIO-comentario");
    expect(JSON.stringify(await b.auditoriaTodas(E.tenantId))).not.toContain("CANARIO-comentario");
    const trabajos = await b.v.b.sql("select to_jsonb(j) j from job_registro j where tenant_id = $1", [E.tenantId]);
    expect(JSON.stringify(trabajos)).not.toContain("CANARIO-comentario");
    const notificaciones = await b.v.b.sql("select to_jsonb(n) j from notificacion n where tenant_id = $1", [E.tenantId]);
    expect(JSON.stringify(notificaciones)).not.toContain("CANARIO-comentario");
    // Control: sí está en el historial, que es donde debe vivir.
    expect((await b.eventos(m1)).map((e) => e.comentario)).toEqual([canario, `${canario}-deshacer`]);
  });
});
