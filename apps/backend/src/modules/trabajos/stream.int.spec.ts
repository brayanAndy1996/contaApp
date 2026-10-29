// T6 (008) · `GET /trabajos/stream` (SSE): CA-6 (sesión y estudio, evento en ≤ 2 s, revalidación del alcance en
// ≤ 10 s, máximo 3 por sesión), alcance de CA-5 y aislamiento entre estudios. PG y Redis reales; los cambios de estado
// los publica la prueba en `eventos:{tenantId}` como lo hace el worker (`publicarEvento` de `@contapp/queue`).
// Rojo: la ruta aún no existe (T11): hoy responde 404.
//
// Contrato fijado por estas pruebas (T11):
//  - `@SoloEstudio`. Sin sesión: 401 `sesion_invalida`; sin `X-Estudio` o con el de otro estudio: 409 `estudio_desfasado`
//    (JSON, no stream). El 200 es `text/event-stream`, con `Cache-Control` `no-store` o `no-cache`, y las CABECERAS SE
//    ENVÍAN DE INMEDIATO (flush, sin esperar al primer evento) y sin evento inicial: el panel se sincroniza con
//    `GET /trabajos` y el stream solo trae cambios posteriores.
//  - Cada mensaje de `eventos:{tenantId}` que cumple `eventoTrabajoSchema` sale como `event: trabajo` + `data: <JSON>`
//    en ≤ 2 s, solo con las claves de la vista (se descarta lo demás), y solo si el cliente es visible para el usuario
//    de la sesión (Dueño y Administrador: todos; los demás roles: asignados). Un mensaje que no cumple el esquema o no
//    es JSON se descarta sin cerrar el stream. Nunca llegan eventos de otro estudio.
//  - Máximo 3 streams abiertos por sesión: el cuarto es 429 `{codigo:"streams_excedidos"}`; otra sesión del mismo usuario
//    cuenta aparte; al cerrar uno se libera el cupo.
//  - Revalidación (≤ 10 s): tras desasignar el cliente, cambiar el rol, desactivar al miembro o cambiar de estudio, el
//    stream deja de enviar eventos del cliente retirado o se cierra.
//  - Latido: un comentario SSE (`: …`) cada 15 s.
import { eventoTrabajoSchema, type TrabajoVista } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  emitir,
  emitirCrudo,
  esEventoId,
  esperarSuscripcion,
  vistaCon,
  type BancoTrabajos,
  type ClienteSse,
} from "../../../test/soporte-trabajos.js";

const CLAVES_VISTA = [
  "clienteId",
  "creadoEn",
  "creadoPor",
  "estado",
  "id",
  "iniciadoEn",
  "intentos",
  "motivo",
  "posicion",
  "terminadoEn",
  "tipo",
];

let b: BancoTrabajos;
let E: Estudio;
let ajeno: Estudio;
let asistente: Actor; // asignado a c1 y c2
let lectura: Actor; // sin asignaciones
let c: string[];
let cAjeno: string;
let T: TrabajoVista[]; // un trabajo en_cola por cliente de E (c0..c5)
let TAjeno: TrabajoVista;

const abrir = (
  a: Pick<Actor, "cookie" | "tenantId">,
  extra: { estudio?: string | null } = {},
) =>
  abrirSse(b.h, {
    cookie: a.cookie,
    estudio: extra.estudio === undefined ? a.tenantId : extra.estudio,
  });
/** Abre el stream y exige 200 (si no, las demás aserciones no tienen sentido). */
const abrirOk = async (
  a: Pick<Actor, "cookie" | "tenantId">,
): Promise<ClienteSse> => {
  const s = await abrir(a);
  expect(s.status, JSON.stringify(s.cuerpo)).toBe(200);
  return s;
};
const emitirE = (v: TrabajoVista) => emitir(b.redis, b.prefijo, E.tenantId, v);
const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cambio = (
  t: TrabajoVista,
  estado: TrabajoVista["estado"],
): TrabajoVista =>
  vistaCon(t, {
    estado,
    intentos: estado === "ejecutando" ? 1 : t.intentos,
    iniciadoEn: new Date().toISOString(),
  });

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  E = await b.estudio();
  ajeno = await b.estudio();
  c = await b.clientes(E.tenantId, 6);
  [cAjeno] = (await b.clientes(ajeno.tenantId, 1)) as [string];
  asistente = await b.miembro(E.tenantId, "asistente");
  lectura = await b.miembro(E.tenantId, "lectura");
  await b.asignar(E.tenantId, c[1]!, asistente.id, "colaborador");
  await b.asignar(E.tenantId, c[2]!, asistente.id, "colaborador");
  T = [];
  for (const cl of c)
    T.push(await b.sembrar(E.tenantId, cl, { creadoPor: E.titular.id }));
  TAjeno = await b.sembrar(ajeno.tenantId, cAjeno, {
    creadoPor: ajeno.titular.id,
  });
});
afterAll(async () => {
  cerrarSseAbiertos();
  await b?.cerrar();
});

describe("CA-6 · el stream exige sesión y estudio activo", () => {
  it("sin sesión es 401 sesion_invalida", async () => {
    const s = await abrirSse(b.h, { estudio: E.tenantId });
    expect(s.status).toBe(401);
    expect(s.cuerpo).toEqual({ codigo: "sesion_invalida" });
  });

  it("sin X-Estudio o con el de otro estudio es 409 estudio_desfasado", async () => {
    for (const estudio of [null, ajeno.tenantId]) {
      const s = await abrir(E.titular, { estudio });
      expect(s.status).toBe(409);
      expect(s.cuerpo).toEqual({ codigo: "estudio_desfasado" });
    }
  });

  it("con sesión y estudio responde 200 text/event-stream al instante y sin eventos iniciales", async () => {
    const t0 = Date.now();
    const s = await abrirOk(E.titular);
    expect(s.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(String(s.headers["cache-control"])).toMatch(/no-(store|cache)/);
    await pausa(400);
    expect(s.eventos).toEqual([]);
    expect(s.cerrado).toBe(false);
    s.cerrar();
  });
});

describe("CA-6 · un evento por cambio de estado en ≤ 2 s", () => {
  it("el Dueño recibe el evento publicado, con la forma de eventoTrabajoSchema y en menos de 2 s", async () => {
    const s = await abrirOk(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const v = cambio(T[0]!, "ejecutando");
    const t0 = Date.now();
    await emitirE(v);
    const e = await s.esperar(esEventoId(v.id), 2000);
    expect(e, "no llegó el evento en 2 s").not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(e!.evento).toBe("trabajo");
    expect(eventoTrabajoSchema.safeParse(e!.json).success).toBe(true);
    expect(e!.json).toEqual(v);
    expect(Object.keys(e!.json).sort()).toEqual(CLAVES_VISTA);
    s.cerrar();
  });

  it("cada cambio de estado llega una vez y en orden", async () => {
    const s = await abrirOk(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const t = T[3]!;
    await emitirE(cambio(t, "ejecutando"));
    await emitirE(
      vistaCon(t, {
        estado: "completado",
        intentos: 1,
        terminadoEn: new Date().toISOString(),
      }),
    );
    const fin = await s.esperar(
      (e) => e.json?.id === t.id && e.json.estado === "completado",
      2000,
    );
    expect(fin).not.toBeNull();
    await pausa(300);
    expect(
      s.eventos.filter((e) => e.json?.id === t.id).map((e) => e.json.estado),
    ).toEqual(["ejecutando", "completado"]);
    s.cerrar();
  });

  it("dos streams de la misma sesión reciben el mismo evento", async () => {
    const a = await abrirOk(E.titular);
    const bb = await abrirOk(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const v = cambio(T[4]!, "ejecutando");
    await emitirE(v);
    expect(await a.esperar(esEventoId(v.id), 2000)).not.toBeNull();
    expect(await bb.esperar(esEventoId(v.id), 2000)).not.toBeNull();
    a.cerrar();
    bb.cerrar();
  });
});

describe("CA-5 / CA-6 · el alcance del usuario filtra los eventos", () => {
  it("el asistente recibe solo los eventos de sus clientes (c1 y c2), en orden", async () => {
    const s = await abrirOk(asistente);
    const dueno = await abrirOk(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const orden = [T[0]!, T[1]!, T[3]!, T[2]!, T[5]!];
    for (const t of orden) await emitirE(cambio(t, "ejecutando"));
    expect(await s.esperar(esEventoId(T[2]!.id), 2000)).not.toBeNull();
    await dueno.esperar(esEventoId(T[5]!.id), 2000); // el Dueño ya los vio todos: nada más puede estar en camino
    await pausa(200);
    expect(s.eventos.map((e) => e.json.id)).toEqual([T[1]!.id, T[2]!.id]);
    expect(dueno.eventos.map((e) => e.json.id)).toEqual(orden.map((t) => t.id));
    s.cerrar();
    dueno.cerrar();
  });

  it("lectura sin asignaciones no recibe ningún evento", async () => {
    const s = await abrirOk(lectura);
    const dueno = await abrirOk(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const v = vistaCon(T[1]!, {
      estado: "completado",
      terminadoEn: new Date().toISOString(),
    });
    await emitirE(v);
    expect(await dueno.esperar(esEventoId(v.id), 2000)).not.toBeNull();
    await pausa(500);
    expect(s.eventos).toEqual([]);
    s.cerrar();
    dueno.cerrar();
  });

  it("los eventos de otro estudio nunca llegan: cada estudio recibe solo su canal", async () => {
    const mio = await abrirOk(E.titular);
    const suyo = await abrirOk(ajeno.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    await esperarSuscripcion(b.redis, b.prefijo, ajeno.tenantId);
    const vAjeno = cambio(TAjeno, "ejecutando");
    await emit(ajeno.tenantId, vAjeno);
    const vMio = cambio(T[2]!, "completado");
    await emitirE(vMio);
    expect(await suyo.esperar(esEventoId(vAjeno.id), 2000)).not.toBeNull();
    expect(await mio.esperar(esEventoId(vMio.id), 2000)).not.toBeNull();
    await pausa(300);
    expect(
      mio.eventos.some(
        (e) => e.json.id === vAjeno.id || e.json.clienteId === cAjeno,
      ),
    ).toBe(false);
    expect(suyo.eventos.some((e) => e.json.id === vMio.id)).toBe(false);
    mio.cerrar();
    suyo.cerrar();
  });

  it("un mensaje que no es JSON o no cumple el esquema se descarta sin cerrar el stream; los campos de más se quitan", async () => {
    const s = await abrirOk(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    await emitirCrudo(b.redis, b.prefijo, E.tenantId, "esto no es json");
    await emitirCrudo(
      b.redis,
      b.prefijo,
      E.tenantId,
      JSON.stringify({ id: "no-es-uuid", estado: "xyz" }),
    );
    await emitirCrudo(
      b.redis,
      b.prefijo,
      E.tenantId,
      JSON.stringify({ ...cambio(T[0]!, "completado"), estado: "inventado" }),
    );
    const sucio = {
      ...cambio(T[5]!, "ejecutando"),
      ruc: "20999999991",
      tenantId: E.tenantId,
      parametros: { rango: "x" },
    };
    await emitirCrudo(b.redis, b.prefijo, E.tenantId, JSON.stringify(sucio));
    const e = await s.esperar(esEventoId(sucio.id), 2000);
    expect(
      e,
      "el stream murió o descartó el mensaje válido con campos de más",
    ).not.toBeNull();
    expect(Object.keys(e!.json).sort()).toEqual(CLAVES_VISTA);
    expect(s.cerrado).toBe(false);
    expect(s.eventos.map((x) => x.json?.id)).toEqual([sucio.id]); // los tres inválidos no salieron
    s.cerrar();
  });
});

/** Publica en el canal de otro estudio. */
const emit = (tenantId: string, v: TrabajoVista) =>
  emitir(b.redis, b.prefijo, tenantId, v);

describe("CA-6 · máximo 3 streams abiertos por sesión", () => {
  it("el cuarto es 429 streams_excedidos; otra sesión cuenta aparte; al cerrar uno se libera el cupo", async () => {
    const u = await b.miembro(E.tenantId, "contador");
    const abiertos: ClienteSse[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await abrirOk(u);
      abiertos.push(s);
    }
    const cuarto = await abrir(u);
    expect(cuarto.status).toBe(429);
    expect(cuarto.cuerpo).toEqual({ codigo: "streams_excedidos" });

    const otra = await b.sesion(u, E.tenantId); // segundo inicio de sesión del mismo usuario
    const deOtra = await abrir({ ...otra, tenantId: E.tenantId });
    expect(deOtra.status).toBe(200);

    abiertos[0]!.cerrar();
    let liberado: ClienteSse | null = null;
    for (let i = 0; i < 10 && liberado === null; i++) {
      await pausa(300);
      const intento = await abrir(u);
      if (intento.status === 200) liberado = intento;
    }
    expect(
      liberado,
      "al cerrar un stream no se liberó el cupo en 3 s",
    ).not.toBeNull();
    for (const s of [...abiertos, deOtra]) s.cerrar();
    liberado?.cerrar();
  });
});

describe("CA-6 · latido", () => {
  it("manda un comentario SSE cada 15 s (llega uno al menos 10 s después de abrir, antes de 17 s)", async () => {
    const s = await abrirOk(E.titular);
    const fin = Date.now() + 17_000;
    while (
      Date.now() < fin &&
      !s.tComentarios.some((t) => t - s.abiertoEn >= 10_000)
    )
      await pausa(250);
    expect(s.tComentarios.some((t) => t - s.abiertoEn >= 10_000)).toBe(true);
    expect(s.comentarios.every((l) => l.startsWith(":"))).toBe(true);
    expect(s.eventos).toEqual([]); // el latido no es un evento
    s.cerrar();
  }, 30_000);
});

describe("CA-6 · el alcance se revalida en ≤ 10 s", () => {
  // Cuatro usuarios con el stream abierto; a la vez se les retira el acceso al cliente c4 (desasignar, bajar de
  // Administrador a Contador, desactivar, cambiar de estudio). A los 10,5 s se publica un evento de c4: no puede llegar.
  // Los que conservan c5 reciben además un evento de control (o el stream se cerró).
  let uDesasignado: Actor;
  let uRol: Actor;
  let uDesactivado: Actor;
  let uEstudio: Actor;
  let streams: Record<string, ClienteSse>;
  let tPublicado = 0;
  const previo: Record<string, boolean> = {};
  const vistoC4 = (s: ClienteSse) =>
    s.eventos.filter((e) => e.t >= tPublicado && e.json?.clienteId === c[4]);

  beforeAll(async () => {
    uDesasignado = await b.miembro(E.tenantId, "contador");
    uRol = await b.miembro(E.tenantId, "admin");
    uDesactivado = await b.miembro(E.tenantId, "contador");
    uEstudio = await b.miembro(E.tenantId, "contador");
    const E2 = await b.estudio();
    await b.sql(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')",
      [E2.tenantId, uEstudio.id],
    );
    for (const u of [uDesasignado, uDesactivado, uEstudio])
      await b.asignar(E.tenantId, c[4]!, u.id, "colaborador");
    await b.asignar(E.tenantId, c[5]!, uDesasignado.id, "colaborador");
    await b.asignar(E.tenantId, c[5]!, uRol.id, "colaborador"); // la conserva al bajar a Contador

    streams = {
      desasignado: await abrirOk(uDesasignado),
      rol: await abrirOk(uRol),
      desactivado: await abrirOk(uDesactivado),
      estudio: await abrirOk(uEstudio),
    };
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);

    // Control antes del retiro: los cuatro ven los eventos de c4.
    const v0 = cambio(T[4]!, "ejecutando");
    await emitirE(v0);
    for (const [nombre, s] of Object.entries(streams))
      previo[nombre] = (await s.esperar(esEventoId(v0.id), 2000)) !== null;

    const t0 = Date.now();
    const d = await b.llamar(
      E.titular,
      "DELETE",
      `/clientes/${c[4]}/asignaciones/${uDesasignado.id}`,
    );
    const r = await b.llamar(E.titular, "PATCH", `/usuarios/${uRol.id}/rol`, {
      rol: "contador",
    });
    const x = await b.llamar(
      E.titular,
      "POST",
      `/usuarios/${uDesactivado.id}/desactivar`,
    );
    const e = await b.llamar(uEstudio, "POST", "/auth/estudio", {
      tenantId: E2.tenantId,
    });
    expect([d.status, r.status, x.status, e.status]).toEqual([
      204, 200, 200, 200,
    ]);

    await pausa(Math.max(0, t0 + 10_500 - Date.now()));
    tPublicado = Date.now();
    await emitirE(
      vistaCon(T[4]!, {
        estado: "completado",
        intentos: 1,
        terminadoEn: new Date().toISOString(),
      }),
    );
    await emitirE(cambio(T[5]!, "ejecutando")); // control: quien conserva c5 lo recibe
    await pausa(2500);
  }, 60_000);

  it("antes del retiro los cuatro streams recibían los eventos de c4 (la prueba no es vacía)", () => {
    expect(previo).toEqual({
      desasignado: true,
      rol: true,
      desactivado: true,
      estudio: true,
    });
  });

  it("desasignado el cliente: a los 10,5 s ya no llegan eventos de c4 (o el stream está cerrado)", () => {
    expect(vistoC4(streams.desasignado!)).toEqual([]);
    const control = streams.desasignado!.eventos.some(
      (e) => e.t >= tPublicado && e.json?.clienteId === c[5],
    );
    expect(
      control || streams.desasignado!.cerrado,
      "ni el control de c5 ni cierre",
    ).toBe(true);
  });

  it("bajado de Administrador a Contador: pierde el alcance global (ya no ve c4) y conserva c5", () => {
    expect(vistoC4(streams.rol!)).toEqual([]);
    const control = streams.rol!.eventos.some(
      (e) => e.t >= tPublicado && e.json?.clienteId === c[5],
    );
    expect(
      control || streams.rol!.cerrado,
      "ni el control de c5 ni cierre",
    ).toBe(true);
  });

  it("miembro desactivado: no recibe nada después de los 10 s", () => {
    expect(
      streams.desactivado!.eventos.filter((e) => e.t >= tPublicado),
    ).toEqual([]);
  });

  it("cambio de estudio de la sesión: el stream viejo no recibe nada del estudio anterior", () => {
    expect(streams.estudio!.eventos.filter((e) => e.t >= tPublicado)).toEqual(
      [],
    );
  });
});
