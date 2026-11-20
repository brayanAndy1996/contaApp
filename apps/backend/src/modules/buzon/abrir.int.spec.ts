/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 023 · T6 (rojo): POST /clientes/:clienteId/buzon/mensajes/:mensajeId/abrir (D-8, P-1; CA-4, CA-9, CA-10, CA-13).
// Contrato fijado por estas pruebas (módulo `buzon` de T13; errores `{codigo}`, `Cache-Control: no-store`):
//  - Permiso `buzon.marcar_leido` (Lectura recibe 403 `permiso_denegado`; Asistente, Contador, Administrador y Dueño pasan), con el
//    alcance por cliente de `ClienteScopeGuard`. Solo encola: el backend nunca llama a SUNAT ni baja el contenido.
//  - 202 `{ trabajo: TrabajoVista }` nuevo: fila `sol.buzon.abrir` (cola y canal `sol`, prioridad `interactivo`, parámetros EXACTOS
//    `{ mensajeId }` tomados de la ruta, `creado_por` = quien pulsó), pista en Redis tras el commit y auditoría
//    `buzon.apertura_solicitada` (actor usuario, entidad `buzon_mensaje`, datos `{ mensajeId }`).
//  - Dedupe por mensaje: con un trabajo vivo del mismo mensaje devuelve 200 `{ trabajo }` con ese mismo id (sin fila nueva); otro mensaje
//    del mismo cliente es otro trabajo; un trabajo terminado con error no bloquea uno nuevo.
//  - 200 `{ trabajo: null }` si el contenido ya se obtuvo (`contenido_ruta`): nada que encolar ni auditar.
//  - 409 `cliente_archivado` | `credencial_no_configurada` | `credencial_invalida` como `revisar`; no encola ni audita.
//  - Sin enfriamiento: pedir «Abrir» justo tras «Revisar ahora» no da 429.
//  - Mensaje inexistente, mal formado, de otro cliente, de otro estudio o de un cliente no asignado: el mismo 404 `no_encontrado`.
// Rojo: el módulo `buzon` aún no existe (T13): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  cumple,
  DESPLAZAMIENTO_PROGRAMADO,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const ABRIR = "sol.buzon.abrir";
let b: BancoBuzon;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  const p = b.v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await b?.cerrar();
});

const ruta = (clienteId: string, mensajeId: string): string =>
  `/clientes/${clienteId}/buzon/mensajes/${mensajeId}/abrir`;
const abrir = (
  a: Actor,
  clienteId: string,
  mensajeId: string,
  cuerpo?: unknown,
) => b.llamar(a, "POST", ruta(clienteId, mensajeId), cuerpo);
const nuevo = (o: Parameters<BancoBuzon["cliente"]>[1] = {}, e: Estudio = E) =>
  b.cliente(e, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
    ...o,
  });
/** Cliente con un mensaje sin contenido. */
const conMensaje = async (o: Parameters<BancoBuzon["cliente"]>[1] = {}) => {
  const c = await nuevo(o);
  const m = await b.sembrarMensaje(E.tenantId, c.id, {
    critico: true,
    asunto: "Resolución de Intendencia N° 0150140012345",
  });
  return { c, m };
};
const auditoriaApertura = async (mensajeId: string) =>
  (await b.auditoria(E.tenantId, "buzon.apertura_solicitada")).filter(
    (f) => f.entidad_id === mensajeId,
  );

describe("CA-4 · abrir encola sol.buzon.abrir con el mensaje de la ruta y nada más", () => {
  it("202 { trabajo }: fila en cola con { mensajeId }, creada por quien pulsó y publicada en Redis", async () => {
    const { c, m } = await conMensaje();
    const r = await abrir(asistente, c.id, m.id);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajo"]);
    expect(cumple("abrirMensajeRespuestaSchema", r.body)).toBe(true);
    expect(r.body.trabajo).toMatchObject({
      tipo: ABRIR,
      clienteId: c.id,
      estado: "en_cola",
      intentos: 0,
      creadoPor: { usuarioId: asistente.id },
    });
    expect(r.ms).toBeLessThan(3000); // nada espera a SUNAT
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const filas = await b.trabajos(c.id, ABRIR);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: r.body.trabajo.id,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: ABRIR,
      cola: "sol",
      canal: "sol",
      prioridad: "interactivo",
      estado: "en_cola",
      creado_por: asistente.id,
      ruc: c.ruc,
    });
    expect(filas[0].parametros).toEqual({ mensajeId: m.id });
    const puntaje = await b.puntaje(E.tenantId, r.body.trabajo.id);
    expect(puntaje).not.toBeNull();
    expect(puntaje).toBeLessThan(DESPLAZAMIENTO_PROGRAMADO);
    const panel = await b.llamar(asistente, "GET", "/trabajos");
    expect(
      (panel.body as any[]).find((t) => t.id === r.body.trabajo.id),
    ).toMatchObject({ tipo: ABRIR, clienteId: c.id });
  });

  it("deja en la auditoría la solicitud con el usuario y el mensaje, sin asunto, RUC ni contenido", async () => {
    const { c, m } = await conMensaje();
    expect((await abrir(contador, c.id, m.id)).status).toBe(202);
    const filas = await auditoriaApertura(m.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: contador.id,
      entidad: "buzon_mensaje",
      cliente_id: c.id,
    });
    expect(filas[0].datos).toEqual({ mensajeId: m.id });
    expect(JSON.stringify(filas[0])).not.toMatch(/Intendencia|0150140012345/);
    expect(JSON.stringify(filas[0])).not.toContain(c.ruc);
  });

  it("solo encola: no escribe contenido, adjuntos ni la marca de lectura (eso es del worker)", async () => {
    const { c, m } = await conMensaje();
    expect((await abrir(contador, c.id, m.id)).status).toBe(202);
    const fila = (
      await b.v.b.sql(
        "select contenido_ruta, contenido_bytes, contenido_obtenido_en, leido_sunat from buzon_mensaje where id = $1",
        [m.id],
      )
    )[0];
    expect(fila).toEqual({
      contenido_ruta: null,
      contenido_bytes: null,
      contenido_obtenido_en: null,
      leido_sunat: false,
    });
    expect(
      await b.v.b.sql("select 1 from buzon_adjunto where mensaje_id = $1", [
        m.id,
      ]),
    ).toHaveLength(0);
    expect(await b.trabajos(c.id, "sol.buzon.revisar")).toHaveLength(0);
  });

  it("el cuerpo se ignora: los parámetros del trabajo salen de la ruta, nunca del cuerpo", async () => {
    const { c, m } = await conMensaje();
    const otro = await b.sembrarMensaje(E.tenantId, c.id);
    const r = await abrir(contador, c.id, m.id, {
      mensajeId: otro.id,
      clienteId: randomUUID(),
      parametros: { x: 1 },
    });
    expect(r.status, r.text).toBe(202);
    const filas = await b.trabajos(c.id, ABRIR);
    expect(filas).toHaveLength(1);
    expect(filas[0].parametros).toEqual({ mensajeId: m.id });
  });

  it("no hay enfriamiento: abrir justo tras «Revisar ahora» es 202, no 429", async () => {
    const { c, m } = await conMensaje();
    expect(
      (await b.llamar(contador, "POST", `/clientes/${c.id}/buzon/revisar`))
        .status,
    ).toBe(202);
    const r = await abrir(contador, c.id, m.id);
    expect(r.status, r.text).toBe(202);
  });
});

describe("CA-4 · permiso buzon.marcar_leido: el rol Lectura recibe 403", () => {
  it("Lectura: 403 permiso_denegado, sin trabajo y sin auditoría", async () => {
    const { c, m } = await conMensaje();
    const r = await abrir(lectura, c.id, m.id);
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(0);
    expect(await auditoriaApertura(m.id)).toHaveLength(0);
  });

  it("Dueño, contador y asistente asignados abren", async () => {
    for (const a of [E.titular, contador, asistente]) {
      const { c, m } = await conMensaje();
      const r = await abrir(a, c.id, m.id);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(202);
    }
  });

  it("sin sesión: 401 y no se encola nada", async () => {
    const { c, m } = await conMensaje();
    expect((await abrir(contador, c.id, m.id)).status).toBe(202); // control: la ruta existe
    const r = await b.sinSesion("POST", ruta(c.id, m.id));
    expect(r.status, r.text).toBe(401);
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(1); // solo el del control
  });
});

describe("CA-4 · el contenido se pide una vez por mensaje: dedupe y 200 si ya se obtuvo", () => {
  it("pedir dos veces con el trabajo vivo devuelve el mismo trabajo (202 y 200) y una sola fila", async () => {
    const { c, m } = await conMensaje();
    const a = await abrir(contador, c.id, m.id);
    const o = await abrir(asistente, c.id, m.id);
    expect([a.status, o.status], `${a.text} ${o.text}`).toEqual([202, 200]);
    expect(cumple("abrirMensajeRespuestaSchema", o.body)).toBe(true);
    expect(o.body.trabajo.id).toBe(a.body.trabajo.id);
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(1);
  });

  it("20 pedidos simultáneos dejan UN trabajo: un 202, 19 × 200", async () => {
    const { c, m } = await conMensaje();
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        abrir(i % 2 === 0 ? contador : asistente, c.id, m.id),
      ),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([
      ...Array(19).fill(200),
      202,
    ]);
    expect(new Set(rs.map((r) => r.body.trabajo?.id)).size).toBe(1);
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(1);
  });

  it("otro mensaje del mismo cliente es otro trabajo", async () => {
    const { c, m } = await conMensaje();
    const otro = await b.sembrarMensaje(E.tenantId, c.id);
    const a = await abrir(contador, c.id, m.id);
    const o = await abrir(contador, c.id, otro.id);
    expect([a.status, o.status], `${a.text} ${o.text}`).toEqual([202, 202]);
    expect(o.body.trabajo.id).not.toBe(a.body.trabajo.id);
    expect(
      (await b.trabajos(c.id, ABRIR)).map((f) => f.parametros.mensajeId).sort(),
    ).toEqual([m.id, otro.id].sort());
  });

  it("un trabajo anterior terminado con error no bloquea pedirlo de nuevo", async () => {
    const { c, m } = await conMensaje();
    const a = await abrir(contador, c.id, m.id);
    expect(a.status, a.text).toBe(202);
    await b.terminar(a.body.trabajo.id, "error");
    const o = await abrir(contador, c.id, m.id);
    expect(o.status, o.text).toBe(202);
    expect(o.body.trabajo.id).not.toBe(a.body.trabajo.id);
  });

  it("contenido ya obtenido: 200 { trabajo: null }, sin fila nueva ni auditoría de apertura", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      contenido: "Texto ya bajado.",
    });
    const r = await abrir(contador, c.id, m.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ trabajo: null });
    expect(cumple("abrirMensajeRespuestaSchema", r.body)).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(0);
    expect(await auditoriaApertura(m.id)).toHaveLength(0);
  });

  it("tras obtener el contenido, quien tenga buzon.ver lo lee sin encolar nada más (Lectura incluido)", async () => {
    const c = await nuevo();
    // El worker (T12) deja el contenido guardado: aquí se siembra ese resultado.
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      contenido: "Contenido obtenido por el worker.",
    });
    const ya = await abrir(contador, c.id, m.id);
    expect(ya.status, ya.text).toBe(200);
    expect(ya.body).toEqual({ trabajo: null });
    const lee = await b.llamar(
      lectura,
      "GET",
      `/clientes/${c.id}/buzon/mensajes/${m.id}`,
    );
    expect(lee.status, lee.text).toBe(200);
    expect(lee.body.contenido).toBe("Contenido obtenido por el worker.");
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(0); // leer no encola
  });
});

describe("D-6 · 409 por cliente archivado o credencial SOL no lista", () => {
  const sinEfectos = async (
    c: { id: string },
    m: { id: string },
  ): Promise<void> => {
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(0);
    expect(await auditoriaApertura(m.id)).toHaveLength(0);
  };

  it("cliente archivado: 409 cliente_archivado", async () => {
    const { c, m } = await conMensaje({ archivado: true });
    const r = await abrir(contador, c.id, m.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    await sinEfectos(c, m);
  });

  it("credencial SOL no configurada: 409 credencial_no_configurada", async () => {
    const { c, m } = await conMensaje({ sol: "no_configurada" });
    const r = await abrir(contador, c.id, m.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_no_configurada" });
    await sinEfectos(c, m);
  });

  it("credencial SOL inválida: 409 credencial_invalida", async () => {
    const { c, m } = await conMensaje({ sol: "invalida" });
    const r = await abrir(contador, c.id, m.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_invalida" });
    await sinEfectos(c, m);
  });

  it("el cuerpo del 409 cumple errorBuzonSchema", async () => {
    const { c, m } = await conMensaje({ archivado: true });
    const r = await abrir(contador, c.id, m.id);
    expect(r.status, r.text).toBe(409);
    expect(cumple("errorBuzonSchema", r.body)).toBe(true);
  });
});

describe("CA-9 · aislamiento: el mismo 404 para ajeno, no asignado, cruzado o inexistente", () => {
  it("el contador no asignado recibe el mismo 404 que ante un cliente inexistente y no se encola nada", async () => {
    const ajeno = await b.cliente(E); // sin responsable
    const m = await b.sembrarMensaje(E.tenantId, ajeno.id);
    const r = await abrir(contador, ajeno.id, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(
      forma(await abrir(contador, randomUUID(), randomUUID())),
    );
    expect(await b.trabajos(ajeno.id, ABRIR)).toHaveLength(0);
    expect((await abrir(E.titular, ajeno.id, m.id)).status).toBe(202); // control: la ruta existe
  });

  it("otro estudio: el Dueño de F no abre el mensaje de un cliente de E", async () => {
    const F = await b.estudio();
    const { c, m } = await conMensaje();
    expect((await abrir(E.titular, c.id, m.id)).status).toBe(202); // control: la ruta existe
    const r = await abrir(F.titular, c.id, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(
      forma(await abrir(F.titular, randomUUID(), randomUUID())),
    );
    expect(await b.trabajos(c.id, ABRIR)).toHaveLength(1); // solo el del control
    expect(await auditoriaApertura(m.id)).toHaveLength(1);
  });

  it("ids cruzados: el mensaje de un cliente bajo otro cliente del mismo estudio es un 404", async () => {
    const a = await nuevo();
    const { c: otro, m } = await conMensaje();
    expect((await abrir(contador, otro.id, m.id)).status).toBe(202); // control: bajo su cliente sí
    const r = await abrir(contador, a.id, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await b.trabajos(a.id, ABRIR)).toHaveLength(0);
    expect(await b.trabajos(otro.id, ABRIR)).toHaveLength(1); // solo el del control
  });

  it("ids cruzados entre estudios: el mensaje de E bajo un cliente propio de F es un 404", async () => {
    const F = await b.estudio();
    const cF = await b.cliente(F);
    const { c, m } = await conMensaje();
    expect((await abrir(contador, c.id, m.id)).status).toBe(202); // control: bajo su cliente sí
    const r = await abrir(F.titular, cF.id, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await b.trabajos(cF.id, ABRIR)).toHaveLength(0);
  });

  it.each(["no-es-uuid", "..%2F..", "0", "%00"])(
    "el mensajeId «%s» es un 404 igual que un inexistente",
    async (mal) => {
      const c = await nuevo();
      const valido = await b.sembrarMensaje(E.tenantId, c.id);
      expect((await abrir(contador, c.id, valido.id)).status).toBe(202); // control: la ruta existe
      const r = await abrir(contador, c.id, mal);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
      expect(forma(r)).toEqual(
        forma(await abrir(contador, c.id, randomUUID())),
      );
      expect(await b.trabajos(c.id, ABRIR)).toHaveLength(1); // solo el del control
    },
  );

  it("un cliente inexistente y uno ajeno dan lo mismo aunque el mensaje exista", async () => {
    const { c, m } = await conMensaje();
    expect((await abrir(contador, c.id, m.id)).status).toBe(202); // control: bajo su cliente sí
    const r = await abrir(contador, randomUUID(), m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
  });
});
