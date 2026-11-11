/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T5 (005) · CA-12 / HU-40 por API: dos estudios (A y B), cada uno con un Dueño y un asistente.
// Un usuario de A llama a TODAS las rutas registradas de 004 y 005 con IDs de B (cliente, usuario,
// membresía, invitación, asignación) en URL, cuerpo y lotes mezclados con IDs propios: siempre 404/403
// o listas sin datos de B, y la BD de B queda intacta. Simétrica (B contra A). La lista de rutas sale de
// las rutas registradas en Express: una ruta nueva sin caso hace fallar la prueba "toda ruta tiene caso".
// Rojo: las rutas, tablas y roles de 005 aún no existen (T7 a T11).
//
// 008 (T6) agrega las 3 rutas de `/trabajos` (lista, stream SSE y cancelar) con los IDs del otro estudio: cada estudio
// tiene un trabajo en cola por cliente (sembrado con `encolar` de `@contapp/queue`); un trabajo, un cliente o un canal
// de eventos de B desde A dan 404/409 (o 200 sin datos de B), nunca un dato ni un efecto en B. El stream se prueba con
// `node:http` y mensajes reales en `eventos:{tenantId}` (Redis base 15, prefijo propio). Rojo hasta T11.
//
// 017 (T5) agrega las 5 rutas de notificaciones y auditoría (`GET /notificaciones`, `GET /notificaciones/no-leidas`,
// `POST /notificaciones/leidas`, `POST /notificaciones/:id/leida` y `GET /auditoria`): cada estudio tiene sus notificaciones (del Dueño y
// de la asistente), su auditoría y un descifrado sembrados por SQL; los ids de B y sus razones sociales son marcas de fuga. Un usuario
// de A, con los ids, el usuarioId o el tenantId de B en URL, consulta o cuerpo, recibe 404/400/403 o su propia lista, y las notificaciones
// y la auditoría de B quedan intactas. Rojo hasta T10 (rutas) y T7 (tablas): hasta entonces los casos nuevos fallan, los demás no.
// 006 (T3) agrega los casos de `/registro/*`, `GET /plan/uso` y las 6 rutas `/plataforma/*` (CA-8): los usuarios de A
// (ninguno super-admin) con IDs, tokens y correos de B. Rojo hasta T7 (uso), T8 (registro) y T9 (plataforma).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import {
  abrirSse,
  cerrarSseAbiertos,
  conectarRedis,
  emitir,
  esEventoId,
  esperarSuscripcion,
  limpiarPrefijo,
  nuevoPrefijo,
  sembrarTrabajo,
  urlRedisPrueba,
  vistaCon,
  type RedisPrueba,
} from "../../test/soporte-trabajos.js";
import { rucConPrefijo, xlsxConDatos } from "../../test/soporte-importacion.js";
import {
  borrarPorId,
  type OpcionesNotif,
  sembrarAuditoria,
  sembrarDescifrado,
  sembrarNotificacion,
} from "../../test/soporte-notificaciones.js";
import { csvVentas, fila as filaVenta } from "../../test/soporte-ventas.js";
import {
  abrirHarness,
  COOKIE,
  cookieSesion,
  nombreTenant,
  PWD,
  seedAuth,
  type Harness,
  type Peticion,
  type Resp,
} from "../../test/soporte.js";

/* ---------------------------------- Tipos ---------------------------------- */
interface Actor {
  rol: "dueno" | "asistente";
  id: string;
  correo: string;
  contrasena: string;
  nombre: string;
  membresiaId: string;
}
interface Recursos {
  tenantId: string;
  nombre: string;
  dueno: Actor;
  asistente: Actor;
  /** Clientes creados por la prueba (la asistente es responsable del primero). */
  clientes: [string, string];
  /** Un trabajo en cola por cliente, creado por el Dueño (008). */
  trabajos: [TrabajoVista, TrabajoVista];
  /** Marcadores de datos propios de este estudio que no deben verse desde el otro. */
  ids: string[];
  correos: string[];
  otros: string[];
  asignacionId: string;
  invitacionId: string;
  invitacionCorreo: string;
  tokenHash: Buffer;
}
interface Sesion {
  cookie: string;
  csrf: string;
}
interface Pet {
  metodo?: Peticion["metodo"];
  ruta: string;
  cuerpo?: unknown;
  /** Cuerpo binario crudo (importación de 007b). */
  binario?: Uint8Array;
}
interface Esperado {
  dueno: number[];
  asistente: number[];
}
interface Contexto {
  yo: Actor;
  mio: Recursos;
  ajeno: Recursos;
  /** Sesión del actor (null en rutas públicas). */
  sesion: Sesion | null;
  pedir(p: Pet, o?: { estudio?: string | null }): Promise<Resp>;
}
interface Caso {
  /** `METODO /ruta/:param`, igual que la ruta registrada en Express. */
  ruta: string;
  esperado: Esperado;
  /** Sin sesión, cookie ni `X-Estudio` (rutas `@Publico`). */
  publica?: boolean;
  /** La respuesta repite lo que el atacante envió (correo): no cuenta como fuga. */
  eco?: boolean;
  construir(c: Contexto): Pet[];
  /** Preparación asíncrona previa a las peticiones (p. ej. tomar una instantánea de lo que no debe cambiar). */
  antes?(c: Contexto): Promise<void>;
  /** Comprobaciones propias del caso, tras las peticiones. */
  extra?(c: Contexto, respuestas: Resp[]): Promise<void>;
  /** Limpieza propia del caso (se ejecuta siempre). */
  despues?(c: Contexto): Promise<void>;
}

/* --------------------------------- Estado ---------------------------------- */
let h: Harness;
let A: Recursos;
let B: Recursos;
let registradas: string[] = [];
const sufijo = randomBytes(4).toString("hex");
/** Clientes creados, registrados al instante para limpiarlos aunque el arranque falle a mitad. */
const clientesCreados: string[] = [];
/** Redis de las pruebas de `/trabajos`: base 15 y prefijo propio (la app recibe la misma URL y prefijo). */
const prefijoRedis = nuevoPrefijo();
let redis: RedisPrueba;
/** 017: lo que se sembró en cada estudio (notificaciones, auditoría y descifrado) y el error de la siembra, si falló. */
interface SembradoAvisos {
  notifDueno: string[];
  notifAsistente: string[];
  auditoria: string[];
  descifrado: string[];
}
const sembradoAvisos = new Map<string, SembradoAvisos>();
let falloSiembraAvisos: string | null = null;

const todos = (...n: number[]): Esperado => ({ dueno: n, asistente: n });
const E404: Esperado = { dueno: [404], asistente: [403, 404] };
const ELISTA: Esperado = { dueno: [200], asistente: [200, 403] };

/* ----------------------------- Rutas registradas ---------------------------- */
function enumerarRutas(): string[] {
  const instancia: any = h.app.getHttpAdapter().getInstance();
  const pila: any[] = instancia.router?.stack ?? instancia._router?.stack ?? [];
  const salida = new Set<string>();
  for (const capa of pila) {
    const ruta = capa.route;
    if (!ruta) continue;
    for (const [metodo, activo] of Object.entries<boolean>(
      ruta.methods ?? {},
    )) {
      if (activo && !["head", "options", "_all"].includes(metodo)) {
        salida.add(`${metodo.toUpperCase()} ${String(ruta.path)}`);
      }
    }
  }
  return [...salida].sort();
}

/* ------------------------------- Preparación -------------------------------- */
const hex = () => randomBytes(5).toString("hex");

async function prepararEstudio(
  tenantId: string,
  etiqueta: "A" | "B",
): Promise<Recursos> {
  const nombre = nombreTenant(tenantId);
  const crear = async (rol: Actor["rol"]): Promise<Actor> => {
    const u = await h.crearUsuario({ estudios: [] });
    const nom = `HU40 ${etiqueta} ${rol} ${sufijo}`;
    await h.sql("update usuario set nombre = $2 where id = $1", [u.id, nom]);
    const m = await h.sql(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3) returning id",
      [tenantId, u.id, rol],
    );
    return {
      rol,
      id: u.id,
      correo: u.correo,
      contrasena: u.contrasena,
      nombre: nom,
      membresiaId: m[0].id,
    };
  };
  const dueno = await crear("dueno");
  const asistente = await crear("asistente");

  const clientes: string[] = [];
  for (const n of [1, 2]) {
    const razon = `HU40 ${etiqueta} cliente ${n} ${sufijo}`;
    const ruc = `2${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`;
    const f = await h.sql(
      "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id",
      [tenantId, ruc, razon],
    );
    clientesCreados.push(f[0].id);
    clientes.push(f[0].id);
  }
  const asig = await h.sql(
    "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable') returning id",
    [tenantId, clientes[0], asistente.id],
  );
  const trabajos: TrabajoVista[] = [];
  for (const cl of clientes) {
    trabajos.push(
      await sembrarTrabajo(h, tenantId, cl!, { creadoPor: dueno.id }),
    );
  }
  const tokenHash = createHash("sha256").update(randomBytes(32)).digest();
  const invitacionCorreo = `inv${hex()}@hu40-${etiqueta.toLowerCase()}.contapp.test`;
  const inv = await h.sql(
    `insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash, vence_en)
     values ($1, $2, 'lectura', $3, $4, now() + interval '72 hours') returning id`,
    [tenantId, invitacionCorreo, dueno.id, tokenHash],
  );
  return {
    tenantId,
    nombre,
    dueno,
    asistente,
    clientes: [clientes[0]!, clientes[1]!],
    trabajos: [trabajos[0]!, trabajos[1]!],
    ids: [],
    correos: [],
    otros: [],
    asignacionId: asig[0].id,
    invitacionId: inv[0].id,
    invitacionCorreo,
    tokenHash,
  };
}

/**
 * 017: siembra por SQL las notificaciones (del Dueño y de la asistente, con y sin cliente, una de un cliente que la asistente no tiene
 * asignado), la auditoría (de usuario, de trabajo y de sistema) y un descifrado del estudio. Sus ids pasan a ser marcas de fuga.
 */
async function sembrarAvisos(r: Recursos): Promise<SembradoAvisos> {
  const q = (texto: string, valores?: unknown[]) => h.sql(texto, valores);
  const notif = async (usuarioId: string, o: Omit<OpcionesNotif, "tenantId" | "usuarioId">) =>
    (await sembrarNotificacion(q, { tenantId: r.tenantId, usuarioId, ...o })).id;
  const notifDueno = [
    await notif(r.dueno.id, { tipo: "credencial_invalida", clienteId: r.clientes[0], hace: 600 }),
    await notif(r.dueno.id, { tipo: "plan_limite", hace: 500 }),
    await notif(r.dueno.id, { tipo: "trabajo_terminado", clienteId: r.clientes[1], hace: 400 }),
  ];
  const notifAsistente = [
    await notif(r.asistente.id, { tipo: "credencial_invalida", clienteId: r.clientes[0], hace: 300 }),
    await notif(r.asistente.id, { tipo: "trabajo_terminado", clienteId: r.clientes[0], hace: 200 }),
    await notif(r.asistente.id, { tipo: "credencial_invalida", clienteId: r.clientes[1], hace: 100 }), // cliente que no tiene asignado
  ];
  const auditoria = [
    (await sembrarAuditoria(q, { tenantId: r.tenantId, usuarioId: r.dueno.id, clienteId: r.clientes[0], accion: "cliente.editado", datos: { cambios: { razon_social: ["VIEJA SAC", "NUEVA SAC"] } }, hace: 900 })).id,
    (await sembrarAuditoria(q, { tenantId: r.tenantId, actorTipo: "trabajo", usuarioId: r.asistente.id, clienteId: r.clientes[0], accion: "propuesta.cargada", entidad: "propuesta", entidadId: randomUUID(), datos: { libro: "compras", periodo: "202610", fuente: "sire", filasRecibidas: 3 }, hace: 800 })).id,
    (await sembrarAuditoria(q, { tenantId: r.tenantId, accion: "miembro.alta", entidad: "membresia", datos: { rol: "asistente", via: "otro" }, hace: 700 })).id,
  ];
  const descifrado = [(await sembrarDescifrado(q, { tenantId: r.tenantId, clienteId: r.clientes[0], hace: 850 })).id];
  const sembrado = { notifDueno, notifAsistente, auditoria, descifrado };
  sembradoAvisos.set(r.tenantId, sembrado);
  r.ids.push(...notifDueno, ...notifAsistente, ...auditoria, ...descifrado);
  return sembrado;
}

/** Marcadores: todo lo que existe en `de` y no en `contra` (los usuarios de ambos, como uAB, no cuentan). */
async function calcularMarcadores(
  de: Recursos,
  contra: Recursos,
): Promise<void> {
  const clientesDe = await h.sql(
    "select id, ruc, razon_social from cliente where tenant_id = $1",
    [de.tenantId],
  );
  const rucsContra = new Set(
    (
      await h.sql("select ruc from cliente where tenant_id = $1", [
        contra.tenantId,
      ])
    ).map((f) => f.ruc),
  );
  const usuariosDe = await h.sql(
    `select u.id, u.email, u.nombre from usuario u join membresia m on m.usuario_id = u.id
      where m.tenant_id = $1
        and not exists (select 1 from membresia x where x.usuario_id = u.id and x.tenant_id = $2)`,
    [de.tenantId, contra.tenantId],
  );
  const invitaciones = await h.sql(
    "select id, correo from invitacion where tenant_id = $1",
    [de.tenantId],
  );
  const ids = new Set<string>([
    de.tenantId,
    de.dueno.membresiaId,
    de.asistente.membresiaId,
    de.asignacionId,
    ...de.trabajos.map((t) => t.id),
  ]);
  const correos = new Set<string>([de.invitacionCorreo]);
  const otros = new Set<string>([de.nombre]);
  for (const f of clientesDe) {
    ids.add(f.id);
    otros.add(f.razon_social);
    if (!rucsContra.has(f.ruc)) otros.add(f.ruc);
  }
  for (const f of usuariosDe) {
    ids.add(f.id);
    correos.add(f.email);
    // Solo los nombres propios de la prueba: los del seed ("Usuario A") son subcadena de otros ("Usuario AB").
    if (String(f.nombre).startsWith("HU40")) otros.add(f.nombre);
  }
  for (const f of invitaciones) {
    ids.add(f.id);
    correos.add(f.correo);
  }
  de.ids = [...ids];
  de.correos = [...correos];
  de.otros = [...otros].filter((x) => typeof x === "string" && x.length >= 4);
}

/* -------------------------------- Instantáneas ------------------------------ */
/** Estado de la BD de un estudio, limitado a lo que creó esta prueba (robusto ante otras suites). */
async function instantanea(
  r: Recursos,
  completo: boolean,
): Promise<Record<string, unknown>> {
  const uids = [r.dueno.id, r.asistente.id];
  const q = async (texto: string, valores: unknown[]) =>
    (await h.sql(texto, valores)).map((f) => f.j);
  const s: Record<string, unknown> = {
    membresia: await q(
      "select to_jsonb(m) j from membresia m where tenant_id = $1 and usuario_id = any($2::uuid[]) order by id",
      [r.tenantId, uids],
    ),
    cliente: await q(
      "select to_jsonb(c) j from cliente c where tenant_id = $1 and id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ),
    asignacion: await q(
      `select to_jsonb(a) j from asignacion a
        where tenant_id = $1 and (cliente_id = any($2::uuid[]) or usuario_id = any($3::uuid[])) order by id`,
      [r.tenantId, r.clientes, uids],
    ),
    job_registro: await q(
      "select to_jsonb(j) j from job_registro j where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ),
  };
  if (completo) {
    s.usuario = await q(
      "select to_jsonb(u) j from usuario u where id = any($1::uuid[]) order by id",
      [uids],
    );
    s.invitacion = await q(
      "select to_jsonb(i) j from invitacion i where tenant_id = $1 and (id = $2 or invitado_por = any($3::uuid[])) order by id",
      [r.tenantId, r.invitacionId, uids],
    );
    s.sesion = await q(
      "select to_jsonb(s) j from auth.sesion s where usuario_id = any($1::uuid[]) order by id",
      [uids],
    );
  }
  return s;
}

/* --------------------------------- Sesiones --------------------------------- */
async function abrirSesion(u: Actor, tenantId: string): Promise<Sesion> {
  await h.reiniciarIntentos(u.correo);
  const s = await h.entrar(u);
  const e = await h.pedir({
    ruta: "/auth/estudio",
    cuerpo: { tenantId },
    cookie: s.cookie,
    csrf: s.csrf,
  });
  if (e.status !== 200)
    throw new Error(`no se pudo elegir el estudio de prueba: HTTP ${e.status}`);
  const cookie = `${COOKIE}=${cookieSesion(e)!.valor}`;
  const ses = await h.pedir({ ruta: "/auth/sesion", cookie });
  if (ses.status !== 200)
    throw new Error(`GET /auth/sesion fallido: HTTP ${ses.status}`);
  return { cookie, csrf: ses.body.csrf };
}

/** Fugas de datos del otro estudio en una respuesta (ids, correos, nombres, razones sociales, RUC). */
function fugas(r: Resp, ajeno: Recursos, caso: Caso): string[] {
  return fugasTexto(`${r.text}\n${JSON.stringify(r.body)}`, ajeno, caso);
}
function fugasTexto(crudo: string, ajeno: Recursos, caso: Caso): string[] {
  const texto = crudo.toLowerCase();
  const marcas = [
    ...ajeno.ids,
    ...(caso.eco ? [] : ajeno.correos),
    ...ajeno.otros,
  ];
  return marcas.filter((m) => texto.includes(m.toLowerCase()));
}

const lista = (r: Resp): any[] => (Array.isArray(r.body) ? r.body : []);
/** Caso mínimo para buscar fugas en el texto del stream (los correos de B sí cuentan como fuga). */
const CASO_STREAM = { ruta: "GET /trabajos/stream" } as Caso;

/* ------------------------------- Casos por ruta ----------------------------- */
const base64url = (b: Buffer) => b.toString("base64url");
const idsDeUsuario = (a: Recursos) => [
  a.dueno.id,
  a.asistente.id,
  a.asistente.membresiaId,
  a.asignacionId,
];
const idsDeCliente = (a: Recursos) => [
  ...a.clientes,
  a.asignacionId,
  a.invitacionId,
];
const tokensDeB = (a: Recursos) => [
  a.tokenHash.toString("hex"),
  base64url(a.tokenHash),
  a.invitacionId,
];
const contrasenaMala = "incorrecta-HU40-aaaaaaaa";

/** RUC del último archivo de `POST /clientes/importacion/confirmar` (para comprobar que no se creó). */
let rucImportado = "";


/**
 * 014 (T10): las 23 rutas de compras. El estudio sale de la sesión y `:clienteId` pasa por `ClienteScopeGuard`: un cliente de B
 * (o un id de otra cosa de B) desde A da 404 antes de leer, escribir o encolar. Las lecturas no devuelven nada de B; las
 * escrituras no dejan compra, versión, operación, estado de periodo ni trabajo en B. Los ids de compra y de propuesta son al
 * azar: la ruta se resuelve por el cliente, antes que por ellos. Una ruta nueva de compras sin caso rompe «toda ruta tiene caso».
 * Rojo: el módulo `compras` aún no existe (T15 a T17).
 */
function casosCompras(): Caso[] {
  const sinEfectosEnB = async (c: Contexto): Promise<void> => {
    const f = await h.sql(
      `select (select count(*)::int from compra where cliente_id = any($1::uuid[])) as compras,
              (select count(*)::int from compra_version v join compra x on x.id = v.compra_id where x.cliente_id = any($1::uuid[])) as versiones,
              (select count(*)::int from compra_operacion where cliente_id = any($1::uuid[])) as operaciones,
              (select count(*)::int from compra_periodo where cliente_id = any($1::uuid[])) as periodos,
              (select count(*)::int from propuesta where cliente_id = any($1::uuid[])) as propuestas,
              (select count(*)::int from documento_xml where cliente_id = any($1::uuid[])) as xml,
              (select count(*)::int from documento_xml_obtencion where cliente_id = any($1::uuid[])) as obtenciones,
              (select count(*)::int from job_registro where cliente_id = any($1::uuid[]) and tipo = 'xml.obtener') as "trabajosXml"`,
      [c.ajeno.clientes],
    );
    expect(f[0]).toEqual({ compras: 0, versiones: 0, operaciones: 0, periodos: 0, propuestas: 0, xml: 0, obtenciones: 0, trabajosXml: 0 });
  };
  const caso = (
    metodo: "GET" | "POST",
    sufijo: string,
    real: (id: string) => string,
    cuerpo?: (c: Contexto) => unknown,
    escribe = metodo === "POST",
    xml = false,
  ): Caso => ({
    ruta: `${metodo} /clientes/:clienteId/periodos/:periodo/compras${sufijo}`,
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ...(metodo === "POST" ? { metodo: "POST" as const } : {}),
        ruta: `/clientes/${id}/periodos/202610/compras${real(id)}`,
        ...(cuerpo ? { cuerpo: cuerpo(c) } : {}),
        // 016: las rutas con XML reciben el cuerpo crudo (un UBL mínimo; nunca llega a leerse).
        ...(xml ? { binario: new TextEncoder().encode('<?xml version="1.0"?><Invoice/>') } : {}),
      })),
    ...(escribe ? { extra: sinEfectosEnB } : {}),
  });
  const compra = () => randomUUID();
  const items = () => [{ compraId: randomUUID(), versionBase: 1 }];
  return [
    caso("GET", "", () => "?limite=5000"),
    caso("POST", "", () => "", (c) => ({
      tipo: "01",
      serie: "F001",
      numero: "9999",
      proveedor: { tipo: "6", numero: "20700000099", razonSocial: "Intruso HU40" },
      fecha: "2026-10-05",
      moneda: "PEN",
      montos: { biDg: "100.00", igvDg: "18.00" },
      tenantId: c.ajeno.tenantId,
    })),
    caso("POST", "/descargar", () => "/descargar"),
    caso("GET", "/resumen", () => "/resumen"),
    caso("GET", "/exportar.xlsx", () => "/exportar.xlsx"),
    caso("GET", "/propuestas", () => "/propuestas"),
    caso("GET", "/propuestas/:propuestaId/diferencias", () => `/propuestas/${randomUUID()}/diferencias`),
    caso("GET", "/:compraId", () => `/${compra()}`),
    caso("POST", "/:compraId/clasificar", () => `/${compra()}/clasificar`, () => ({ versionBase: 1, destino: "DNG" })),
    caso("POST", "/:compraId/editar", () => `/${compra()}/editar`, () => ({ versionBase: 1, cambios: { biDg: "1.00" } })),
    caso("POST", "/:compraId/calcular", () => `/${compra()}/calcular`, () => ({ cambios: { biDg: "1.00" } }), false),
    caso("POST", "/:compraId/sugerencias/aceptar", () => `/${compra()}/sugerencias/aceptar`, () => ({ versionBase: 1, regla: "R-ISC", confirmar: true })),
    caso("POST", "/:compraId/excluir", () => `/${compra()}/excluir`, () => ({ versionBase: 1 })),
    caso("POST", "/:compraId/restaurar", () => `/${compra()}/restaurar`, () => ({ versionBase: 2 })),
    caso("POST", "/:compraId/descartar", () => `/${compra()}/descartar`, () => ({ versionBase: 1 })),
    caso("POST", "/masivas/clasificar", () => "/masivas/clasificar", () => ({ items: items(), destino: "DNG" })),
    caso("POST", "/masivas/aceptar", () => "/masivas/aceptar", () => ({ items: items(), regla: "R-RED" })),
    caso("POST", "/masivas/excluir", () => "/masivas/excluir", () => ({ items: items() })),
    caso("POST", "/masivas/restaurar", () => "/masivas/restaurar", () => ({ items: items() })),
    caso("POST", "/deshacer", () => "/deshacer", () => ({})),
    caso("POST", "/rehacer", () => "/rehacer", () => ({})),
    caso("POST", "/estado/revisar", () => "/estado/revisar", () => ({})),
    caso("POST", "/estado/reabrir", () => "/estado/reabrir", () => ({ estadoVisto: "revisado" })), // DU-23
    // 016 (T7): lupa y XML. Mismo 404 desde otro estudio; ninguna deja XML, obtención ni trabajo en B.
    caso("GET", "/:compraId/detalle", () => `/${compra()}/detalle`, undefined, true),
    caso("GET", "/:compraId/xml", () => `/${compra()}/xml`, undefined, true),
    caso("POST", "/:compraId/xml", () => `/${compra()}/xml`, undefined, true, true),
    caso("POST", "/:compraId/xml/obtener", () => `/${compra()}/xml/obtener`, () => ({})),
    caso("POST", "/desde-xml/vista-previa", () => "/desde-xml/vista-previa", undefined, true, true),
    caso("POST", "/desde-xml", () => "/desde-xml?destino=DG", undefined, true, true),
  ];
}

/**
 * 012b (T6): las 12 rutas nuevas: las cuatro de archivos por libro (previo, generar, versiones y descarga del ZIP), las dos de
 * estado de ventas (revisar y reabrir) y las dos de excluir y restaurar ventas. El estudio sale de la sesión y `:clienteId` pasa
 * por `ClienteScopeGuard`: un cliente de B (o un id de otra cosa de B) desde A da 404 antes de leer, escribir o encolar. Los ids de
 * archivo y de venta son al azar: la ruta se resuelve por el cliente, antes que por ellos. Ninguna deja versión, exclusión, estado
 * de ventas ni trabajo `archivo.generar` en B. Una ruta nueva de archivos o de estado de ventas sin caso rompe «toda ruta tiene
 * caso». Rojo: el módulo `archivos`, las rutas de estado y de exclusión de ventas y las tablas de 012b aún no existen (T10, T12, T13).
 */
function casosArchivos(): Caso[] {
  const sinEfectosEnB = async (c: Contexto): Promise<void> => {
    const f = await h.sql(
      `select (select count(*)::int from archivo_generado where cliente_id = any($1::uuid[])) as versiones,
              (select count(*)::int from venta_exclusion where cliente_id = any($1::uuid[])) as exclusiones,
              (select count(*)::int from venta_periodo where cliente_id = any($1::uuid[])) as periodos,
              (select count(*)::int from job_registro where cliente_id = any($1::uuid[]) and tipo = 'archivo.generar') as trabajos`,
      [c.ajeno.clientes],
    );
    expect(f[0]).toEqual({ versiones: 0, exclusiones: 0, periodos: 0, trabajos: 0 });
  };
  const caso = (
    metodo: "GET" | "POST",
    libro: "compras" | "ventas",
    sufijo: string,
    real: () => string,
    cuerpo?: () => unknown,
  ): Caso => ({
    ruta: `${metodo} /clientes/:clienteId/periodos/:periodo/${libro}${sufijo}`,
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ...(metodo === "POST" ? { metodo: "POST" as const } : {}),
        ruta: `/clientes/${id}/periodos/202610/${libro}${real()}`,
        ...(cuerpo ? { cuerpo: cuerpo() } : {}),
      })),
    extra: sinEfectosEnB,
  });
  const generar = () => ({ estadoVisto: "abierto", huella: "a".repeat(64) });
  const delLibro = (libro: "compras" | "ventas"): Caso[] => [
    caso("GET", libro, "/archivos/previo", () => "/archivos/previo"),
    caso("POST", libro, "/archivos", () => "/archivos", generar),
    caso("GET", libro, "/archivos", () => "/archivos"),
    caso("GET", libro, "/archivos/:archivoId/zip", () => `/archivos/${randomUUID()}/zip`),
  ];
  return [
    ...delLibro("compras"),
    ...delLibro("ventas"),
    caso("POST", "ventas", "/estado/revisar", () => "/estado/revisar", () => ({})),
    caso("POST", "ventas", "/estado/reabrir", () => "/estado/reabrir", () => ({ estadoVisto: "revisado" })),
    caso("POST", "ventas", "/:ventaId/excluir", () => `/${randomUUID()}/excluir`, () => ({ motivo: "Intruso HU40" })),
    caso("POST", "ventas", "/:ventaId/restaurar", () => `/${randomUUID()}/restaurar`, () => ({})),
  ];
}


/**
 * 017 (T5): las 5 rutas de notificaciones y auditoría. El estudio y el usuario salen de la sesión: ningún `usuarioId`, `tenantId` ni id
 * de B en la URL, la consulta o el cuerpo cambia lo que se ve o se toca. Las notificaciones de B (de su Dueño y de su asistente) y la
 * auditoría de B (con un descifrado) están sembradas y sus ids y razones sociales son marcas de fuga: desde A no aparecen nunca. Las
 * rutas con ids ajenos dan el mismo 404 (y la de otro usuario del propio estudio también); la consulta y el cuerpo estrictos dan 400; la
 * auditoría exige `auditoria.ver` (la asistente recibe 403 antes de cualquier validación). Las notificaciones de otros usuarios y la
 * auditoría de ambos estudios quedan como estaban. Una ruta nueva de estas sin caso rompe «toda ruta tiene caso».
 * Rojo: las rutas (T10) y las tablas (T7) aún no existen.
 */
function casosNotificaciones(): Caso[] {
  const futuro = () => new Date(Date.now() + 3_600_000).toISOString();
  const ESTRICTO: Esperado = { dueno: [200, 400], asistente: [200, 400] };
  /** Notificaciones de ambos estudios que NO son del actor: ni su estado ni su existencia cambian. */
  const fotoDeOtros = async (c: Contexto): Promise<string> =>
    JSON.stringify(
      await h.sql(
        `select id, usuario_id, leida_en::text as leida_en from notificacion
          where tenant_id = any($1::uuid[]) and usuario_id <> $2 order by id`,
        [[c.mio.tenantId, c.ajeno.tenantId], c.yo.id],
      ),
    );
  const conteoAuditoria = async (c: Contexto): Promise<string> =>
    JSON.stringify(
      await h.sql("select tenant_id, count(*)::int as n from auditoria where tenant_id = any($1::uuid[]) group by tenant_id order by tenant_id", [
        [c.mio.tenantId, c.ajeno.tenantId],
      ]),
    );
  let fotoAntes = "";
  let auditoriaAntes = "";
  const registrarAntes = async (c: Contexto): Promise<void> => {
    fotoAntes = await fotoDeOtros(c);
    auditoriaAntes = await conteoAuditoria(c);
  };
  const intactas = async (c: Contexto): Promise<void> => {
    expect(await fotoDeOtros(c), "las notificaciones de otros usuarios cambiaron").toBe(fotoAntes);
    expect(await conteoAuditoria(c), "la auditoría cambió").toBe(auditoriaAntes);
  };
  const estados = (rs: Resp[]) => rs.map((r) => r.status);
  const ajenos = (c: Contexto): SembradoAvisos => sembradoAvisos.get(c.ajeno.tenantId)!;
  const propios = (c: Contexto): SembradoAvisos => sembradoAvisos.get(c.mio.tenantId)!;

  return [
    {
      ruta: "GET /notificaciones",
      esperado: ESTRICTO,
      construir: (c) => [
        { ruta: "/notificaciones" },
        { ruta: `/notificaciones?tenantId=${c.ajeno.tenantId}` },
        { ruta: `/notificaciones?usuarioId=${c.ajeno.dueno.id}&clienteId=${c.ajeno.clientes[0]}` },
        { ruta: `/notificaciones?cursor=${c.ajeno.dueno.id}` },
      ],
      antes: registrarAntes,
      extra: async (c, respuestas) => {
        expect(falloSiembraAvisos, "la siembra de 017 falló (¿tablas de T7?)").toBeNull();
        expect(estados(respuestas)).toEqual([200, 400, 400, 400]);
        const ids = (respuestas[0]!.body.items as any[]).map((x) => x.id);
        expect(ids.filter((id) => ajenos(c).notifDueno.includes(id) || ajenos(c).notifAsistente.includes(id))).toEqual([]);
        // Solo las del actor: ni las del otro usuario de su propio estudio.
        const delOtro = c.yo.rol === "dueno" ? propios(c).notifAsistente : propios(c).notifDueno;
        expect(ids.filter((id) => delOtro.includes(id))).toEqual([]);
        await intactas(c);
      },
    },
    {
      ruta: "GET /notificaciones/no-leidas",
      esperado: ESTRICTO,
      construir: (c) => [
        { ruta: "/notificaciones/no-leidas" },
        { ruta: `/notificaciones/no-leidas?tenantId=${c.ajeno.tenantId}` },
        { ruta: `/notificaciones/no-leidas?usuarioId=${c.ajeno.asistente.id}` },
      ],
      antes: registrarAntes,
      extra: async (c, respuestas) => {
        expect(estados(respuestas)).toEqual([200, 400, 400]);
        // La cuenta es la de SUS no leídas visibles (el asistente solo ve el cliente que tiene asignado), nunca la de B.
        const f = await h.sql(
          `select count(*)::int as n from notificacion
            where tenant_id = $1 and usuario_id = $2 and leida_en is null
              and ($3::boolean or cliente_id is null or cliente_id = $4)`,
          [c.mio.tenantId, c.yo.id, c.yo.rol === "dueno", c.mio.clientes[0]],
        );
        expect(respuestas[0]!.body).toEqual({ noLeidas: Math.min(f[0].n, 100) });
        await intactas(c);
      },
    },
    {
      ruta: "POST /notificaciones/leidas",
      esperado: ESTRICTO,
      construir: (c) => [
        { metodo: "POST", ruta: "/notificaciones/leidas", cuerpo: { hasta: futuro() } },
        { metodo: "POST", ruta: "/notificaciones/leidas", cuerpo: { hasta: futuro(), usuarioId: c.ajeno.dueno.id, tenantId: c.ajeno.tenantId } },
        { metodo: "POST", ruta: "/notificaciones/leidas", cuerpo: { hasta: futuro(), usuarioId: c.ajeno.asistente.id } },
        { metodo: "POST", ruta: "/notificaciones/leidas", cuerpo: { hasta: futuro(), clienteId: c.ajeno.clientes[0] } },
      ],
      antes: registrarAntes,
      extra: async (c, respuestas) => {
        expect(estados(respuestas)).toEqual([200, 400, 400, 400]);
        // Solo marca las suyas: ninguna de las demás (B ni el otro usuario de su estudio) cambia.
        const f = await h.sql(
          "select count(*)::int as n from notificacion where tenant_id = $1 and usuario_id = $2 and leida_en is null and ($3::boolean or cliente_id is null or cliente_id = $4)",
          [c.mio.tenantId, c.yo.id, c.yo.rol === "dueno", c.mio.clientes[0]],
        );
        expect(f[0].n).toBe(0);
        await intactas(c);
      },
    },
    {
      ruta: "POST /notificaciones/:id/leida",
      esperado: todos(404),
      construir: (c) => {
        const delOtro = c.yo.rol === "dueno" ? propios(c).notifAsistente : propios(c).notifDueno;
        return [
          ...ajenos(c).notifDueno,
          ...ajenos(c).notifAsistente,
          ...delOtro, // de otro usuario del propio estudio: el mismo 404
          randomUUID(),
        ].map((id) => ({ metodo: "POST" as const, ruta: `/notificaciones/${id}/leida`, cuerpo: {} }));
      },
      antes: registrarAntes,
      extra: async (c, respuestas) => {
        expect(falloSiembraAvisos, "la siembra de 017 falló (¿tablas de T7?)").toBeNull();
        for (const r of respuestas) expect(r.body).toEqual({ codigo: "no_encontrado" });
        await intactas(c);
      },
    },
    {
      ruta: "GET /auditoria",
      esperado: { dueno: [200, 400], asistente: [403] },
      construir: (c) => [
        { ruta: "/auditoria" },
        { ruta: `/auditoria?tenantId=${c.ajeno.tenantId}` },
        { ruta: `/auditoria?usuarioId=${c.ajeno.dueno.id}&clienteId=${c.ajeno.clientes[0]}` },
        { ruta: `/auditoria?cursor=${c.ajeno.tenantId}` },
      ],
      antes: registrarAntes,
      extra: async (c, respuestas) => {
        expect(falloSiembraAvisos, "la siembra de 017 falló (¿tablas de T7?)").toBeNull();
        if (c.yo.rol === "asistente") {
          // Sin `auditoria.ver`: 403 antes de validar nada y sin datos.
          expect(estados(respuestas)).toEqual([403, 403, 403, 403]);
          for (const r of respuestas) expect(r.body).toEqual({ codigo: "permiso_denegado" });
        } else {
          expect(estados(respuestas)).toEqual([200, 400, 400, 400]);
          const ids = (respuestas[0]!.body.items as any[]).map((x) => x.id);
          expect(ids.filter((id) => ajenos(c).auditoria.includes(id) || ajenos(c).descifrado.includes(id))).toEqual([]);
        }
        await intactas(c);
      },
    },
  ];
}

const CASOS: Caso[] = [
  /* ---------- 004 ---------- */
  {
    ruta: "POST /auth/login",
    publica: true,
    esperado: todos(401),
    construir: (c) => [
      {
        ruta: "/auth/login",
        cuerpo: { correo: c.ajeno.dueno.correo, contrasena: contrasenaMala },
      },
    ],
    despues: async (c) => h.reiniciarIntentos(c.ajeno.dueno.correo),
  },
  {
    ruta: "POST /auth/logout",
    esperado: todos(204),
    construir: () => [{ metodo: "POST", ruta: "/auth/logout" }],
  },
  {
    ruta: "GET /auth/sesion",
    esperado: todos(200),
    construir: () => [{ ruta: "/auth/sesion" }],
    extra: async (c, [r]) => {
      expect(r?.body.usuario.id).toBe(c.yo.id);
      expect(r?.body.estudioActivo?.id).toBe(c.mio.tenantId);
    },
  },
  {
    ruta: "GET /auth/estudios",
    esperado: todos(200),
    construir: () => [{ ruta: "/auth/estudios" }],
    extra: async (c, [r]) =>
      expect(lista(r!).map((e) => e.id)).toEqual([c.mio.tenantId]),
  },
  {
    ruta: "POST /auth/estudio",
    esperado: todos(403, 404),
    construir: (c) => [
      { ruta: "/auth/estudio", cuerpo: { tenantId: c.ajeno.tenantId } },
    ],
    extra: async (c) => {
      // La sesión sigue en el estudio propio: el intento no la movió.
      const r = await c.pedir({ ruta: "/estudio/actual" });
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(c.mio.tenantId);
    },
  },
  {
    ruta: "POST /auth/sesiones/cerrar-todas",
    esperado: todos(204),
    construir: () => [{ metodo: "POST", ruta: "/auth/sesiones/cerrar-todas" }],
  },
  {
    ruta: "POST /auth/recuperar",
    publica: true,
    esperado: todos(202),
    construir: (c) => [
      { ruta: "/auth/recuperar", cuerpo: { correo: c.ajeno.dueno.correo } },
    ],
    extra: async (c, [r]) => {
      // Misma respuesta que para un correo inexistente: no revela quién es miembro de otro estudio.
      const inexistente = await c.pedir({
        ruta: "/auth/recuperar",
        cuerpo: { correo: h.correoInexistente() },
      });
      expect({ status: r!.status, body: r!.body }).toEqual({
        status: inexistente.status,
        body: inexistente.body,
      });
    },
  },
  {
    ruta: "POST /auth/recuperar/restablecer",
    publica: true,
    esperado: todos(400),
    construir: (c) => [
      {
        ruta: "/auth/recuperar/restablecer",
        cuerpo: { token: base64url(randomBytes(32)), contrasena: PWD },
      },
      {
        ruta: "/auth/recuperar/restablecer",
        cuerpo: { token: c.ajeno.tokenHash.toString("hex"), contrasena: PWD },
      },
    ],
  },
  {
    ruta: "POST /auth/contrasena",
    esperado: todos(400, 401, 403),
    construir: (c) => [
      {
        ruta: "/auth/contrasena",
        cuerpo: {
          actual: contrasenaMala,
          nueva: "Otra-Contrasena-HU40-ñ-1",
          usuarioId: c.ajeno.dueno.id,
        },
      },
    ],
    despues: async (c) => h.reiniciarIntentos(c.yo.correo),
  },
  {
    ruta: "GET /estudio/actual",
    esperado: todos(200),
    construir: () => [{ ruta: "/estudio/actual" }],
    extra: async (c, [r]) => expect(r?.body.id).toBe(c.mio.tenantId),
  },

  /* ---------- 005 ---------- */
  {
    ruta: "GET /acceso/yo",
    esperado: todos(200),
    construir: () => [{ ruta: "/acceso/yo" }],
    extra: async (c, [r]) => expect(r?.body.rol).toBe(c.yo.rol),
  },
  {
    ruta: "GET /usuarios",
    esperado: ELISTA,
    construir: (c) => [
      { ruta: "/usuarios" },
      {
        ruta: `/usuarios?tenantId=${c.ajeno.tenantId}&estudio=${c.ajeno.tenantId}`,
      },
    ],
  },
  {
    ruta: "PATCH /usuarios/:usuarioId/rol",
    esperado: E404,
    construir: (c) =>
      idsDeUsuario(c.ajeno).map((id) => ({
        metodo: "PATCH" as const,
        ruta: `/usuarios/${id}/rol`,
        cuerpo: { rol: "lectura", tenantId: c.ajeno.tenantId },
      })),
  },
  {
    ruta: "POST /usuarios/:usuarioId/desactivar",
    esperado: E404,
    construir: (c) =>
      idsDeUsuario(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/usuarios/${id}/desactivar`,
      })),
  },
  {
    ruta: "POST /usuarios/:usuarioId/reactivar",
    esperado: E404,
    construir: (c) =>
      idsDeUsuario(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/usuarios/${id}/reactivar`,
      })),
  },
  {
    ruta: "GET /invitaciones",
    esperado: ELISTA,
    construir: (c) => [
      { ruta: "/invitaciones" },
      { ruta: `/invitaciones?tenantId=${c.ajeno.tenantId}` },
    ],
  },
  {
    // Invitar a un correo que está en B (miembro o con invitación pendiente en B) responde igual que a
    // cualquier otro: sin 409 que delate a B. El correo enviado se repite en la respuesta (eco).
    ruta: "POST /invitaciones",
    esperado: { dueno: [201], asistente: [403] },
    eco: true,
    construir: (c) => [
      {
        ruta: "/invitaciones",
        cuerpo: {
          correo: c.ajeno.dueno.correo,
          rol: "lectura",
          tenantId: c.ajeno.tenantId,
          invitadoPor: c.ajeno.dueno.id,
        },
      },
      {
        ruta: "/invitaciones",
        cuerpo: {
          correo: c.ajeno.invitacionCorreo,
          rol: "lectura",
          tenantId: c.ajeno.tenantId,
        },
      },
    ],
    despues: async (c) => {
      // Borra lo que la propia prueba creó en el estudio atacante (invitaciones por correo del otro).
      await h.sql(
        "delete from invitacion where tenant_id = $1 and invitado_por = $2 and id <> $3",
        [c.mio.tenantId, c.mio.dueno.id, c.mio.invitacionId],
      );
    },
  },
  {
    ruta: "POST /invitaciones/:invitacionId/reenviar",
    esperado: E404,
    construir: (c) =>
      [
        c.ajeno.invitacionId,
        c.ajeno.asistente.membresiaId,
        c.ajeno.asignacionId,
      ].map((id) => ({
        metodo: "POST" as const,
        ruta: `/invitaciones/${id}/reenviar`,
      })),
  },
  {
    ruta: "POST /invitaciones/:invitacionId/revocar",
    esperado: E404,
    construir: (c) =>
      [
        c.ajeno.invitacionId,
        c.ajeno.asistente.membresiaId,
        c.ajeno.asignacionId,
      ].map((id) => ({
        metodo: "POST" as const,
        ruta: `/invitaciones/${id}/revocar`,
      })),
  },
  {
    ruta: "POST /invitaciones/consultar",
    publica: true,
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/invitaciones/consultar",
        cuerpo: { token },
      })),
  },
  {
    ruta: "POST /invitaciones/aceptar",
    publica: true,
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/invitaciones/aceptar",
        cuerpo: {
          token,
          nombre: "Intruso HU40",
          contrasena: PWD,
          tenantId: c.ajeno.tenantId,
          rol: "dueno",
        },
      })),
    extra: async () => {
      const f = await h.sql(
        "select count(*)::int n from usuario where nombre = 'Intruso HU40'",
      );
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "POST /invitaciones/aceptar-con-sesion",
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/invitaciones/aceptar-con-sesion",
        cuerpo: { token, tenantId: c.ajeno.tenantId },
      })),
    extra: async (c) => {
      const f = await h.sql(
        "select count(*)::int n from membresia where usuario_id = $1",
        [c.yo.id],
      );
      expect(f[0].n).toBe(1); // sigue con su única membresía
    },
  },
  {
    ruta: "GET /clientes",
    esperado: todos(200),
    construir: (c) => [
      { ruta: "/clientes" },
      { ruta: `/clientes?tenantId=${c.ajeno.tenantId}` },
    ],
  },
  {
    ruta: "GET /clientes/:clienteId",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}` })),
  },
  {
    // 007a: el estudio sale de la sesión y el responsable debe ser de ese estudio. Todas dan 404 antes de escribir
    // (la instantánea del estudio propio no cambia).
    ruta: "POST /clientes",
    esperado: E404,
    construir: (c) =>
      [c.ajeno.asistente.id, c.ajeno.dueno.id, c.ajeno.asistente.membresiaId, c.ajeno.asignacionId].map(
        (responsableId) => ({
          metodo: "POST" as const,
          ruta: "/clientes",
          cuerpo: { ruc: "20100070970", razonSocial: "Intruso HU40", responsableId, tenantId: c.ajeno.tenantId },
        }),
      ),
  },
  {
    ruta: "PATCH /clientes/:clienteId",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "PATCH" as const,
        ruta: `/clientes/${id}`,
        cuerpo: { razonSocial: "Intruso HU40", tenantId: c.ajeno.tenantId },
      })),
  },
  {
    ruta: "POST /clientes/:clienteId/archivar",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({ metodo: "POST" as const, ruta: `/clientes/${id}/archivar` })),
  },
  {
    ruta: "POST /clientes/:clienteId/reactivar",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({ metodo: "POST" as const, ruta: `/clientes/${id}/reactivar` })),
  },
  {
    // 007b (T4): credenciales. El estudio sale de la sesión; un cliente de B (o un id de otra cosa de B) desde A da 404
    // antes de leer, escribir o encolar: ni sobre en B, ni estado visible, ni trabajo en B.
    ruta: "PUT /clientes/:clienteId/credenciales/:tipo",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).flatMap((id) => [
        {
          metodo: "PUT" as const,
          ruta: `/clientes/${id}/credenciales/sol`,
          cuerpo: { usuario: "intruso-hu40", clave: "clave-hu40", tenantId: c.ajeno.tenantId },
        },
        {
          metodo: "PUT" as const,
          ruta: `/clientes/${id}/credenciales/sire_api`,
          cuerpo: { clientId: "intruso-hu40", clientSecret: "secreto-hu40", tenantId: c.ajeno.tenantId },
        },
      ]),
    extra: async (c) => {
      const f = await h.sql("select count(*)::int n from credencial where cliente_id = any($1::uuid[])", [c.ajeno.clientes]);
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "GET /clientes/:clienteId/credenciales",
    esperado: E404,
    construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/credenciales` })),
  },
  {
    ruta: "POST /clientes/:clienteId/credenciales/:tipo/verificar",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).flatMap((id) => [
        { metodo: "POST" as const, ruta: `/clientes/${id}/credenciales/sol/verificar` },
        { metodo: "POST" as const, ruta: `/clientes/${id}/credenciales/sire_api/verificar` },
      ]),
    extra: async (c) => {
      const f = await h.sql(
        "select count(*)::int n from job_registro where cliente_id = any($1::uuid[]) and tipo like 'credencial.%'",
        [c.ajeno.clientes],
      );
      expect(f[0].n).toBe(0);
    },
  },
  {
    // 013 (T13): ventas del periodo. El estudio sale de la sesión y `:clienteId` pasa por `ClienteScopeGuard`: un cliente de B
    // (o un id de otra cosa de B) desde A da 404 antes de leer, escribir o encolar. Las lecturas no devuelven nada de B; las
    // escrituras no dejan trabajo, venta ni justificación en B. Los ids de venta, justificación y propuesta son al azar: la
    // ruta se resuelve por el cliente, antes que por ellos.
    ruta: "POST /clientes/:clienteId/periodos/:periodo/ventas/descargar",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas/descargar`,
      })),
    extra: async (c) => {
      const f = await h.sql(
        "select count(*)::int n from job_registro where cliente_id = any($1::uuid[]) and tipo = 'sire.propuesta.descargar'",
        [c.ajeno.clientes],
      );
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "GET /clientes/:clienteId/periodos/:periodo/ventas",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/periodos/202610/ventas?tamano=todas`,
      })),
  },
  {
    ruta: "GET /clientes/:clienteId/periodos/:periodo/ventas/resumen",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/periodos/202610/ventas/resumen`,
      })),
  },
  {
    ruta: "GET /clientes/:clienteId/periodos/:periodo/ventas/correlatividad",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/periodos/202610/ventas/correlatividad`,
      })),
  },
  {
    ruta: "GET /clientes/:clienteId/periodos/:periodo/ventas/propuestas",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/periodos/202610/ventas/propuestas`,
      })),
  },
  {
    ruta: "GET /clientes/:clienteId/periodos/:periodo/ventas/propuestas/:propuestaId/diferencias",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/periodos/202610/ventas/propuestas/${randomUUID()}/diferencias`,
      })),
  },
  {
    ruta: "POST /clientes/:clienteId/periodos/:periodo/ventas",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas`,
        cuerpo: {
          tipo: "03",
          serie: "B001",
          numero: "291",
          fechaEmision: "2026-10-05",
          moneda: "PEN",
          docContraparte: "-",
          baseGravada: "100.00",
          igv: "18.00",
          exonerada: "0.00",
          inafecta: "0.00",
          isc: "0.00",
          icbper: "0.00",
          otros: "0.00",
          total: "118.00",
          tenantId: c.ajeno.tenantId,
        },
      })),
    extra: async (c) => {
      const f = await h.sql("select count(*)::int n from venta where cliente_id = any($1::uuid[])", [c.ajeno.clientes]);
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "DELETE /clientes/:clienteId/periodos/:periodo/ventas/:ventaId",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "DELETE" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas/${randomUUID()}`,
      })),
  },
  {
    ruta: "POST /clientes/:clienteId/periodos/:periodo/ventas/saltos-justificados",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas/saltos-justificados`,
        cuerpo: {
          tipo: "03",
          serie: "B001",
          desde: 291,
          hasta: 291,
          comentario: "Intruso HU40",
          tenantId: c.ajeno.tenantId,
        },
      })),
    extra: async (c) => {
      const f = await h.sql("select count(*)::int n from venta_salto_justificado where cliente_id = any($1::uuid[])", [
        c.ajeno.clientes,
      ]);
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "DELETE /clientes/:clienteId/periodos/:periodo/ventas/saltos-justificados/:justificacionId",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "DELETE" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas/saltos-justificados/${randomUUID()}`,
      })),
  },
  {
    // 013 (T14): importación de la propuesta de ventas. El archivo llega crudo y el estudio sale de la sesión; un cliente de B
    // desde A da 404 antes de leer el archivo y no deja propuesta ni venta en B.
    ruta: "POST /clientes/:clienteId/periodos/:periodo/ventas/importar/vista-previa",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas/importar/vista-previa`,
        binario: csvVentas([filaVenta("B001", 290)]),
      })),
    extra: async (c) => {
      const f = await h.sql("select count(*)::int n from propuesta where cliente_id = any($1::uuid[])", [
        c.ajeno.clientes,
      ]);
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "POST /clientes/:clienteId/periodos/:periodo/ventas/importar/confirmar",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        metodo: "POST" as const,
        ruta: `/clientes/${id}/periodos/202610/ventas/importar/confirmar`,
        binario: csvVentas([filaVenta("B001", 290)]),
      })),
    extra: async (c) => {
      const f = await h.sql(
        `select (select count(*)::int from propuesta where cliente_id = any($1::uuid[])) as propuestas,
                (select count(*)::int from venta where cliente_id = any($1::uuid[])) as ventas`,
        [c.ajeno.clientes],
      );
      expect(f[0]).toEqual({ propuestas: 0, ventas: 0 });
    },
  },
  ...casosCompras(),
  ...casosArchivos(),
  ...casosNotificaciones(),
  {
    // 007b (T4): importación. La plantilla no lleva datos de nadie; la vista previa y la confirmación toman el estudio de la
    // sesión: un responsable de B en el archivo no existe para A y no se crea nada.
    ruta: "GET /clientes/importacion/plantilla",
    esperado: { dueno: [200], asistente: [403] },
    construir: () => [{ ruta: "/clientes/importacion/plantilla" }],
  },
  {
    ruta: "POST /clientes/importacion/vista-previa",
    esperado: { dueno: [200], asistente: [403] },
    eco: true,
    construir: (c) => [
      {
        metodo: "POST" as const,
        ruta: "/clientes/importacion/vista-previa",
        binario: xlsxConDatos([
          { ruc: rucConPrefijo("20", 7_000_000 + Math.floor(Math.random() * 900_000)), responsable: c.ajeno.dueno.correo },
        ]),
      },
    ],
    extra: async (c, respuestas) => {
      if (c.yo.rol !== "dueno") return;
      const r = respuestas[0]!;
      expect(r.body.filas?.[0]?.motivos).toEqual(["responsable_inexistente"]);
      expect(r.body).toMatchObject({ validas: 0, conError: 1 });
    },
  },
  {
    ruta: "POST /clientes/importacion/confirmar",
    esperado: { dueno: [200], asistente: [403] },
    eco: true,
    construir: (c) => {
      rucImportado = rucConPrefijo("20", 7_000_000 + Math.floor(Math.random() * 900_000));
      return [
        {
          metodo: "POST" as const,
          ruta: "/clientes/importacion/confirmar",
          binario: xlsxConDatos([{ ruc: rucImportado, responsable: c.ajeno.dueno.correo }]),
        },
      ];
    },
    extra: async (c, respuestas) => {
      if (c.yo.rol !== "dueno") return;
      expect(respuestas[0]!.body.creadas).toBe(0);
      expect(respuestas[0]!.body.noImportadas?.[0]?.motivo).toBe("responsable_inexistente");
      // Ni un cliente nuevo, en ninguno de los dos estudios, por esta ruta.
      const f = await h.sql("select count(*)::int n from cliente where ruc = $1", [rucImportado]);
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "GET /clientes/:clienteId/asignaciones",
    esperado: E404,
    construir: (c) =>
      idsDeCliente(c.ajeno).map((id) => ({
        ruta: `/clientes/${id}/asignaciones`,
      })),
  },
  {
    ruta: "PUT /clientes/:clienteId/asignaciones/:usuarioId",
    esperado: E404,
    construir: (c) => {
      const cuerpo = { tipo: "colaborador", tenantId: c.ajeno.tenantId };
      const combos: [string, string][] = [
        [c.ajeno.clientes[0], c.yo.id], // cliente ajeno, usuario propio
        [c.mio.clientes[1], c.ajeno.asistente.id], // cliente propio, usuario ajeno
        [c.ajeno.clientes[0], c.ajeno.asistente.id], // todo ajeno
        [c.ajeno.clientes[1], c.ajeno.dueno.id],
        [c.mio.clientes[1], c.ajeno.asistente.membresiaId], // id de membresía en vez de usuario
        [c.mio.clientes[1], c.ajeno.asignacionId], // id de asignación en vez de usuario
      ];
      return [
        ...combos.map(([cl, us]) => ({
          metodo: "PUT" as const,
          ruta: `/clientes/${cl}/asignaciones/${us}`,
          cuerpo,
        })),
        {
          metodo: "PUT" as const,
          ruta: `/clientes/${c.mio.clientes[1]}/asignaciones/${c.ajeno.dueno.id}`,
          cuerpo: { tipo: "responsable", anterior: "retirar" },
        },
      ];
    },
  },
  {
    ruta: "DELETE /clientes/:clienteId/asignaciones/:usuarioId",
    esperado: E404,
    construir: (c) => {
      const combos: [string, string][] = [
        [c.ajeno.clientes[0], c.ajeno.asistente.id], // la asignación real de B
        [c.ajeno.clientes[0], c.yo.id],
        [c.mio.clientes[0], c.ajeno.asistente.id],
        [c.mio.clientes[0], c.ajeno.asignacionId],
        [c.ajeno.asignacionId, c.ajeno.asistente.id],
      ];
      return combos.map(([cl, us]) => ({
        metodo: "DELETE" as const,
        ruta: `/clientes/${cl}/asignaciones/${us}`,
      }));
    },
  },
  {
    ruta: "POST /asignaciones/por-usuario",
    esperado: E404,
    construir: (c) => {
      const p = (usuarioId: string, clienteIds: string[]): Pet => ({
        metodo: "POST",
        ruta: "/asignaciones/por-usuario",
        cuerpo: {
          usuarioId,
          clienteIds,
          tipo: "colaborador",
          tenantId: c.ajeno.tenantId,
        },
      });
      return [
        p(c.mio.asistente.id, [c.mio.clientes[1], c.ajeno.clientes[0]]), // lote mezclado: nada se aplica
        p(c.mio.asistente.id, [c.ajeno.clientes[0], c.ajeno.clientes[1]]),
        p(c.ajeno.asistente.id, [c.mio.clientes[0], c.mio.clientes[1]]), // usuario ajeno
        p(c.ajeno.asistente.id, [c.ajeno.clientes[0]]),
        p(c.mio.dueno.id, [c.mio.clientes[1], c.ajeno.asignacionId]), // id de asignación en el lote
        p(c.ajeno.asistente.membresiaId, [c.mio.clientes[1]]), // id de membresía como usuario
      ];
    },
  },
  {
    ruta: "POST /asignaciones/por-cliente",
    esperado: E404,
    construir: (c) => {
      const p = (clienteId: string, usuarioIds: string[]): Pet => ({
        metodo: "POST",
        ruta: "/asignaciones/por-cliente",
        cuerpo: { clienteId, usuarioIds, tenantId: c.ajeno.tenantId },
      });
      return [
        p(c.mio.clientes[1], [c.mio.dueno.id, c.ajeno.asistente.id]), // lote mezclado: nada se aplica
        p(c.ajeno.clientes[0], [c.mio.asistente.id]),
        p(c.ajeno.clientes[0], [c.ajeno.asistente.id, c.ajeno.dueno.id]),
        p(c.mio.clientes[1], [
          c.ajeno.asistente.membresiaId,
          c.ajeno.asignacionId,
        ]),
      ];
    },
  },

  /* ---------- 008 ---------- */
  {
    // Lista: ni `tenantId` en la query ni un `clienteId` del otro estudio abren datos de B; el filtro por un cliente de
    // B es 404 igual que uno inexistente. Cada rol ve solo lo suyo: el Dueño sus 2 trabajos, la asistente el de su cliente.
    ruta: "GET /trabajos",
    esperado: { dueno: [200, 404], asistente: [200, 404] },
    construir: (c) => [
      { ruta: "/trabajos" },
      {
        ruta: `/trabajos?tenantId=${c.ajeno.tenantId}&usuarioId=${c.ajeno.dueno.id}`,
      },
      { ruta: `/trabajos?clienteId=${c.ajeno.clientes[0]}` },
      { ruta: `/trabajos?clienteId=${c.ajeno.clientes[1]}&estado=en_cola` },
    ],
    extra: async (c, r) => {
      expect(r.map((x) => x.status)).toEqual([200, 200, 404, 404]);
      const propios = c.mio.trabajos.map((t) => t.id);
      const esperados = c.yo.rol === "dueno" ? propios : [propios[0]];
      for (const x of [r[0]!, r[1]!])
        expect(
          lista(x)
            .map((t) => t.id)
            .sort(),
        ).toEqual([...esperados].sort());
      expect(r[2]!.body).toEqual({ codigo: "no_encontrado" });
      expect(r[3]!.body).toEqual({ codigo: "no_encontrado" });
    },
  },
  {
    // 007b (T18a, D-1) · Resumen: cuenta TODOS los trabajos visibles por tipo y estado, con el mismo alcance que la lista.
    // Ni `tenantId`/`usuarioId`/`clienteId` en la query abren datos de B: el Dueño cuenta solo sus 2 trabajos en cola
    // y la asistente el de su cliente (los de B nunca suman); solo trae `{tipo, estado, total}`, sin IDs.
    ruta: "GET /trabajos/resumen",
    esperado: { dueno: [200, 404], asistente: [200, 404] },
    construir: (c) => [
      { ruta: "/trabajos/resumen" },
      {
        ruta: `/trabajos/resumen?tenantId=${c.ajeno.tenantId}&usuarioId=${c.ajeno.dueno.id}`,
      },
      { ruta: `/trabajos/resumen?clienteId=${c.ajeno.clientes[0]}` },
    ],
    extra: async (c, r) => {
      expect(r.map((x) => x.status)).toEqual([200, 200, 200]);
      const total = c.yo.rol === "dueno" ? 2 : 1;
      for (const x of r) {
        expect(x.body).toEqual([
          { tipo: "prueba.eco", estado: "en_cola", total },
        ]);
        const crudo = JSON.stringify(x.body);
        for (const t of [...c.ajeno.trabajos, ...c.mio.trabajos])
          expect(crudo).not.toContain(t.id);
        expect(crudo).not.toContain(c.ajeno.tenantId);
      }
    },
  },
  {
    // Stream: con el X-Estudio del otro estudio es 409 (JSON, no stream); en el propio recibe solo los eventos de su
    // canal y de su alcance, aunque se publiquen antes los eventos de B.
    ruta: "GET /trabajos/stream",
    esperado: todos(200),
    construir: () => [],
    extra: async (c) => {
      const desfasado = await abrirSse(h, {
        cookie: c.sesion!.cookie,
        estudio: c.ajeno.tenantId,
      });
      expect(desfasado.status).toBe(409);
      expect(desfasado.cuerpo).toEqual({ codigo: "estudio_desfasado" });
      expect(fugasTexto(desfasado.texto, c.ajeno, CASO_STREAM)).toEqual([]);

      const s = await abrirSse(h, {
        cookie: c.sesion!.cookie,
        estudio: c.mio.tenantId,
      });
      try {
        expect(s.status).toBe(200);
        await esperarSuscripcion(redis, prefijoRedis, c.mio.tenantId);
        const cambia = (t: TrabajoVista) =>
          vistaCon(t, {
            estado: "ejecutando",
            intentos: 1,
            iniciadoEn: new Date().toISOString(),
          });
        // Primero lo de B: en su canal, y también (forzado) con los IDs de B dentro del canal propio no hay camino: solo el canal.
        for (const t of c.ajeno.trabajos)
          await emitir(redis, prefijoRedis, c.ajeno.tenantId, cambia(t));
        await emitir(
          redis,
          prefijoRedis,
          c.mio.tenantId,
          cambia(c.mio.trabajos[1]),
        );
        await emitir(
          redis,
          prefijoRedis,
          c.mio.tenantId,
          cambia(c.mio.trabajos[0]),
        );
        expect(
          await s.esperar(esEventoId(c.mio.trabajos[0].id), 2000),
          "no llegó el evento propio",
        ).not.toBeNull();
        await new Promise((r) => setTimeout(r, 200));
        const esperados =
          c.yo.rol === "dueno"
            ? [c.mio.trabajos[1].id, c.mio.trabajos[0].id]
            : [c.mio.trabajos[0].id];
        expect(s.eventos.map((e) => e.json.id)).toEqual(esperados);
        expect(fugasTexto(s.texto, c.ajeno, CASO_STREAM)).toEqual([]);
      } finally {
        s.cerrar();
      }
    },
  },
  {
    // Cancelar: IDs de trabajo del otro estudio (y de cliente, asignación e invitación de B, o inexistentes) son 404; el
    // trabajo de B queda en_cola (la instantánea compara job_registro, incluido `actualizado_en`).
    ruta: "POST /trabajos/:trabajoId/cancelar",
    esperado: todos(404),
    construir: (c) =>
      [
        ...c.ajeno.trabajos.map((t) => t.id),
        ...idsDeCliente(c.ajeno),
        c.ajeno.dueno.membresiaId,
        randomUUID(),
      ].map((id) => ({
        metodo: "POST" as const,
        ruta: `/trabajos/${id}/cancelar`,
        cuerpo: { tenantId: c.ajeno.tenantId, estado: "cancelado" },
      })),
    extra: async (c, respuestas) => {
      for (const r of respuestas)
        expect(r.body).toEqual({ codigo: "no_encontrado" });
      const filas = await h.sql(
        "select estado from job_registro where id = any($1::uuid[])",
        [c.ajeno.trabajos.map((t) => t.id)],
      );
      expect(filas.map((f) => f.estado)).toEqual(["en_cola", "en_cola"]);
    },
  },
  /* ---------- 006 (T3) · registro, uso del plan y plataforma (CA-8) ---------- */
  // Los usuarios de A (Dueño y asistente, ninguno super-admin) llaman con IDs, tokens y correos de B: nunca un dato
  // ni un efecto en B. Las rutas de plataforma dan 403 a quien no está en `admin_plataforma`; `/plan/uso` solo
  // devuelve el plan propio. Rojo hasta T7 (uso), T8 (registro) y T9 (plataforma).
  {
    ruta: "POST /registro",
    publica: true,
    esperado: todos(202),
    construir: (c) => [
      {
        ruta: "/registro",
        cuerpo: {
          estudio: "Estudio HU40 006",
          nombre: "Intruso HU40",
          correo: c.ajeno.dueno.correo,
          tenantId: c.ajeno.tenantId,
        },
      },
    ],
    extra: async (c, [r]) => {
      // Misma respuesta que para un correo inexistente: no revela quién es miembro de otro estudio.
      const inexistente = await c.pedir({
        ruta: "/registro",
        cuerpo: { estudio: "Estudio HU40 006", nombre: "Intruso HU40", correo: h.correoInexistente() },
      });
      expect({ status: r!.status, body: r!.body }).toEqual({ status: inexistente.status, body: inexistente.body });
      const n = await h.sql("select count(*)::int n from tenant where nombre = 'Estudio HU40 006'");
      expect(n[0].n).toBe(0); // el estudio solo se crea al confirmar
    },
    despues: async () => {
      await h.sql("delete from auth.registro_pendiente where nombre_estudio = 'Estudio HU40 006'");
    },
  },
  {
    ruta: "POST /registro/consultar",
    publica: true,
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/registro/consultar",
        cuerpo: { token },
      })),
  },
  {
    ruta: "POST /registro/confirmar",
    publica: true,
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/registro/confirmar",
        cuerpo: { token, contrasena: PWD, tenantId: c.ajeno.tenantId },
      })),
    extra: async () => {
      const f = await h.sql("select count(*)::int n from tenant where nombre = 'Estudio HU40 006'");
      expect(f[0].n).toBe(0);
    },
  },
  {
    ruta: "POST /registro/confirmar-con-sesion",
    esperado: todos(400),
    construir: (c) =>
      tokensDeB(c.ajeno).map((token) => ({
        ruta: "/registro/confirmar-con-sesion",
        cuerpo: { token, tenantId: c.ajeno.tenantId },
      })),
    extra: async (c) => {
      const f = await h.sql("select count(*)::int n from membresia where usuario_id = $1", [c.yo.id]);
      expect(f[0].n).toBe(1); // sigue con su única membresía
    },
  },
  {
    ruta: "GET /plan/uso",
    esperado: todos(200),
    construir: (c) => [
      { ruta: "/plan/uso" },
      { ruta: `/plan/uso?tenantId=${c.ajeno.tenantId}&estudioId=${c.ajeno.tenantId}` },
    ],
    extra: async (c, respuestas) => {
      for (const r of respuestas) {
        expect(r.body.plan.codigo).toBe("corporativo"); // el seed pone a A y B en corporativo: es el propio
        expect(r.text).not.toMatch(/precio/i);
      }
      const propio = await h.sql("select count(*)::int n from cliente where tenant_id = $1", [c.mio.tenantId]);
      expect(respuestas[1]!.body.rucs.usados).toBe(propio[0].n); // el uso es el del estudio de la sesión
    },
  },
  {
    ruta: "GET /plataforma/yo",
    esperado: todos(403),
    construir: () => [{ ruta: "/plataforma/yo" }],
  },
  {
    ruta: "GET /plataforma/planes",
    esperado: todos(403),
    construir: () => [{ ruta: "/plataforma/planes" }],
  },
  {
    ruta: "POST /plataforma/planes",
    esperado: todos(403),
    construir: (c) => [
      {
        ruta: "/plataforma/planes",
        cuerpo: {
          codigo: `hu40_${sufijo}`,
          nombre: "Plan HU40",
          precioMensual: "1.00",
          precioAnual: null,
          maxRucs: 10,
          maxUsuarios: null,
          precioRucExtra: "0",
          maxRucsExtra: 0,
          frecuenciaBuzonMin: 60,
          features: {},
          tenantId: c.ajeno.tenantId,
        },
      },
    ],
    extra: async () => {
      expect(await h.sql("select 1 from plan where codigo = $1", [`hu40_${sufijo}`])).toHaveLength(0);
    },
  },
  {
    ruta: "PUT /plataforma/planes/:planId",
    esperado: todos(403),
    construir: (c) =>
      [c.ajeno.tenantId, ...c.ajeno.clientes].map((id) => ({
        metodo: "PUT" as const,
        ruta: `/plataforma/planes/${id}`,
        cuerpo: {
          codigo: "corporativo",
          nombre: "Intruso",
          precioMensual: "0",
          precioAnual: null,
          maxRucs: 1,
          maxUsuarios: 1,
          precioRucExtra: "0",
          maxRucsExtra: 0,
          frecuenciaBuzonMin: 1,
          features: {},
          activo: false,
        },
      })),
    extra: async () => {
      const f = await h.sql("select nombre, max_rucs, activo from plan where codigo = 'corporativo'");
      expect(f[0]).toMatchObject({ max_rucs: 600, activo: true });
    },
  },
  {
    ruta: "GET /plataforma/estudios",
    esperado: todos(403),
    construir: (c) => [
      { ruta: "/plataforma/estudios" },
      { ruta: `/plataforma/estudios?tenantId=${c.ajeno.tenantId}` },
    ],
  },
  {
    ruta: "PUT /plataforma/estudios/:tenantId/suscripcion",
    esperado: todos(403),
    construir: (c) =>
      [c.ajeno.tenantId, c.mio.tenantId].map((t) => ({
        metodo: "PUT" as const,
        ruta: `/plataforma/estudios/${t}/suscripcion`,
        cuerpo: { planId: randomUUID(), rucsExtraContratados: 99, tenantId: c.ajeno.tenantId },
      })),
    extra: async (c) => {
      for (const t of [c.ajeno.tenantId, c.mio.tenantId]) {
        const f = await h.sql(
          "select p.codigo, s.rucs_extra_contratados from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1",
          [t],
        );
        expect(f).toEqual([{ codigo: "corporativo", rucs_extra_contratados: 0 }]);
      }
    },
  },
];

const POR_RUTA = new Map(CASOS.map((c) => [c.ruta, c]));

/* ---------------------------------- Pruebas --------------------------------- */
beforeAll(async () => {
  redis = conectarRedis();
  h = await abrirHarness({
    redis: { url: urlRedisPrueba(), prefijo: prefijoRedis },
  });
  const s = seedAuth();
  A = await prepararEstudio(s.tenantA, "A");
  B = await prepararEstudio(s.tenantB, "B");
  await calcularMarcadores(A, B);
  await calcularMarcadores(B, A);
  // 017: si las tablas de T7 aún no existen, la siembra falla y solo fallan los casos nuevos (los demás no la necesitan).
  try {
    await sembrarAvisos(A);
    await sembrarAvisos(B);
  } catch (e) {
    falloSiembraAvisos = e instanceof Error ? e.message : String(e);
  }
  registradas = enumerarRutas();
});

async function limpiar(): Promise<void> {
  if (!h) return;
  // 017: los estudios del seed no se borran; se quitan las filas sembradas (la auditoría solo cede en modo `replica`).
  const todos = [...sembradoAvisos.values()];
  await borrarPorId("notificacion", todos.flatMap((x) => [...x.notifDueno, ...x.notifAsistente]));
  await borrarPorId("auditoria", todos.flatMap((x) => x.auditoria));
  await borrarPorId("auditoria_descifrado", todos.flatMap((x) => x.descifrado));
  const filas = await h
    .sql("select id from usuario where nombre like $1", [`HU40 _ % ${sufijo}`])
    .catch(() => [] as { id: string }[]);
  const usuarios = filas.map((f) => f.id);
  await h
    .sql("delete from invitacion where invitado_por = any($1::uuid[])", [
      usuarios,
    ])
    .catch(() => undefined);
  await h
    .sql(
      "delete from asignacion where usuario_id = any($1::uuid[]) or cliente_id = any($2::uuid[])",
      [usuarios, clientesCreados],
    )
    .catch(() => undefined);
  // job_registro referencia cliente y membresía: sus filas van antes.
  await h
    .sql("delete from job_registro where cliente_id = any($1::uuid[])", [
      clientesCreados,
    ])
    .catch(() => undefined);
  await h
    .sql("delete from cliente where id = any($1::uuid[])", [clientesCreados])
    .catch(() => undefined);
  cerrarSseAbiertos();
  await limpiarPrefijo(redis, prefijoRedis).catch(() => undefined);
}

afterAll(async () => {
  if (!h) return;
  await limpiar();
  await h.cerrar();
  redis?.disconnect();
});

describe("HU-40 por API · cobertura de rutas (CA-12)", () => {
  it("la enumeración de rutas registradas funciona (incluye las de 004)", () => {
    expect(registradas.length).toBeGreaterThan(0);
    expect(registradas).toContain("POST /auth/login");
    expect(registradas).toContain("GET /estudio/actual");
  });

  it("toda ruta registrada tiene un caso (una ruta nueva sin caso rompe la prueba)", () => {
    expect(registradas.filter((r) => !POR_RUTA.has(r))).toEqual([]);
  });

  it("todo caso apunta a una ruta registrada (las rutas de 005 existen)", () => {
    expect(
      CASOS.map((c) => c.ruta).filter((r) => !registradas.includes(r)),
    ).toEqual([]);
  });
});

describe("HU-40 por API · las pruebas no son vacías (controles con datos propios)", () => {
  it("el Dueño de cada estudio ve sus clientes, usuarios e invitaciones, y la asistente solo su cliente asignado", async () => {
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const pedir = (ruta: string) =>
        h.pedir({
          ruta,
          cookie: d.cookie,
          csrf: d.csrf,
          estudio: mio.tenantId,
        });
      const clientes = await pedir("/clientes");
      expect(clientes.status).toBe(200);
      expect(lista(clientes).map((x) => x.id)).toEqual(
        expect.arrayContaining(mio.clientes),
      );
      expect(lista(clientes).map((x) => x.id)).not.toEqual(
        expect.arrayContaining(ajeno.clientes),
      );
      expect((await pedir(`/clientes/${mio.clientes[0]}`)).status).toBe(200);
      expect(
        (await pedir(`/clientes/${mio.clientes[0]}/asignaciones`)).status,
      ).toBe(200);
      const usuarios = await pedir("/usuarios");
      expect(usuarios.status).toBe(200);
      expect(lista(usuarios).map((x) => x.usuarioId)).toEqual(
        expect.arrayContaining([mio.dueno.id, mio.asistente.id]),
      );
      const invitaciones = await pedir("/invitaciones");
      expect(invitaciones.status).toBe(200);
      expect(lista(invitaciones).map((x) => x.id)).toContain(mio.invitacionId);

      // 008: el Dueño ve sus 2 trabajos (y no los de B); la asistente solo el de su cliente.
      const trabajos = await pedir("/trabajos");
      expect(trabajos.status).toBe(200);
      expect(
        lista(trabajos)
          .map((x) => x.id)
          .sort(),
      ).toEqual(mio.trabajos.map((t) => t.id).sort());
      expect(JSON.stringify(trabajos.body)).not.toContain(ajeno.trabajos[0].id);

      // 007b T18a: el resumen del Dueño cuenta sus 2 trabajos y no los de B.
      const resumen = await pedir("/trabajos/resumen");
      expect(resumen.status).toBe(200);
      expect(resumen.body).toEqual([
        { tipo: "prueba.eco", estado: "en_cola", total: mio.trabajos.length },
      ]);

      const a = await abrirSesion(mio.asistente, mio.tenantId);
      const suyosTrabajos = await h.pedir({
        ruta: "/trabajos",
        cookie: a.cookie,
        csrf: a.csrf,
        estudio: mio.tenantId,
      });
      expect(suyosTrabajos.status).toBe(200);
      expect(lista(suyosTrabajos).map((x) => x.id)).toEqual([
        mio.trabajos[0].id,
      ]);
      const suyoResumen = await h.pedir({
        ruta: "/trabajos/resumen",
        cookie: a.cookie,
        csrf: a.csrf,
        estudio: mio.tenantId,
      });
      expect(suyoResumen.status).toBe(200);
      expect(suyoResumen.body).toEqual([
        { tipo: "prueba.eco", estado: "en_cola", total: 1 },
      ]);
      const suyos = await h.pedir({
        ruta: "/clientes",
        cookie: a.cookie,
        csrf: a.csrf,
        estudio: mio.tenantId,
      });
      expect(suyos.status).toBe(200);
      expect(lista(suyos).map((x) => x.id)).toEqual([mio.clientes[0]]);
    }
  });
});

describe("HU-40 por API · 017 · las pruebas no son vacías (notificaciones y auditoría propias)", () => {
  it("cada estudio ve sus notificaciones y su auditoría, nunca las del otro; la asistente ve las suyas y no la auditoría", async () => {
    expect(falloSiembraAvisos, "la siembra de 017 falló (¿tablas de T7?)").toBeNull();
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const propio = sembradoAvisos.get(mio.tenantId)!;
      const ajenoSembrado = sembradoAvisos.get(ajeno.tenantId)!;
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const pedir = (s: Sesion, ruta: string) => h.pedir({ ruta, cookie: s.cookie, csrf: s.csrf, estudio: mio.tenantId });

      const notif = await pedir(d, "/notificaciones");
      expect(notif.status, notif.text).toBe(200);
      const ids = (notif.body.items as any[]).map((x) => x.id);
      expect(ids).toEqual(expect.arrayContaining(propio.notifDueno)); // las suyas, también la de un cliente que no tiene asignado
      expect(ids.filter((id) => propio.notifAsistente.includes(id))).toEqual([]);
      expect(ids.filter((id) => ajenoSembrado.notifDueno.includes(id) || ajenoSembrado.notifAsistente.includes(id))).toEqual([]);
      expect((await pedir(d, "/notificaciones/no-leidas")).body.noLeidas).toBeGreaterThanOrEqual(propio.notifDueno.length);

      // Auditoría: recorre las páginas hasta hallar todo lo sembrado. Las sesiones del arnés engrosan `sesion.ingreso` (miles en
      // una base local reutilizada) y lo sembrado es más viejo, así que no se fija un número de páginas: se pagina hasta
      // encontrarlo, con un tope alto que falla con mensaje claro si el cursor no avanza o la lista no termina.
      const esperados = new Set([...propio.auditoria, ...propio.descifrado]);
      const TOPE_PAGINAS = 400; // 400 x 50 = 20.000 filas
      let cursor: string | null = null;
      const vistos: string[] = [];
      const vistosSet = new Set<string>();
      let paginas = 0;
      do {
        const r: Resp = await pedir(d, `/auditoria${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.status, r.text).toBe(200);
        const ids = (r.body.items as any[]).map((x) => x.id as string);
        vistos.push(...ids);
        ids.forEach((id) => vistosSet.add(id));
        cursor = r.body.siguiente;
        paginas++;
      } while (cursor && paginas < TOPE_PAGINAS && ![...esperados].every((id) => vistosSet.has(id)));
      expect(
        [...esperados].filter((id) => !vistosSet.has(id)),
        `filas sembradas no halladas tras ${paginas} páginas (${vistos.length} filas; ${cursor ? "quedaban más" : "lista agotada"})`,
      ).toEqual([]);
      expect(vistos.length, "el cursor no repite filas").toBe(vistosSet.size);
      expect(vistos.filter((id) => ajenoSembrado.auditoria.includes(id) || ajenoSembrado.descifrado.includes(id))).toEqual([]);

      const a = await abrirSesion(mio.asistente, mio.tenantId);
      const suyas = await pedir(a, "/notificaciones");
      expect(suyas.status, suyas.text).toBe(200);
      const idsA = (suyas.body.items as any[]).map((x) => x.id);
      expect(idsA).toEqual(expect.arrayContaining(propio.notifAsistente.slice(0, 2))); // las de su cliente asignado
      expect(idsA).not.toContain(propio.notifAsistente[2]); // la del cliente que no tiene asignado
      expect(idsA.filter((id) => propio.notifDueno.includes(id))).toEqual([]);
      const aud = await pedir(a, "/auditoria");
      expect(aud.status).toBe(403);
      expect(aud.body).toEqual({ codigo: "permiso_denegado" });
    }
  });
});

const COMBOS = [
  {
    nombre: "Dueño de A contra B",
    rol: "dueno" as const,
    mio: () => A,
    ajeno: () => B,
  },
  {
    nombre: "asistente de A contra B",
    rol: "asistente" as const,
    mio: () => A,
    ajeno: () => B,
  },
  {
    nombre: "Dueño de B contra A",
    rol: "dueno" as const,
    mio: () => B,
    ajeno: () => A,
  },
  {
    nombre: "asistente de B contra A",
    rol: "asistente" as const,
    mio: () => B,
    ajeno: () => A,
  },
];
const ESTATUS_X_ESTUDIO_AJENO = [403, 404, 409];

for (const combo of COMBOS) {
  describe(`HU-40 por API · ${combo.nombre}`, () => {
    for (const caso of CASOS) {
      it(caso.ruta, async () => {
        // Sin esto, un 404 por ruta inexistente pasaría como "aislamiento".
        expect(
          registradas,
          `la ruta ${caso.ruta} no está registrada`,
        ).toContain(caso.ruta);

        const mio = combo.mio();
        const ajeno = combo.ajeno();
        const yo = mio[combo.rol];
        const sesion = caso.publica
          ? null
          : await abrirSesion(yo, mio.tenantId);
        const pedir: Contexto["pedir"] = (p, o = {}) => {
          const estudio = o.estudio === undefined ? mio.tenantId : o.estudio;
          return h.pedir({
            metodo: p.metodo,
            ruta: p.ruta,
            cuerpo: p.cuerpo,
            ...(p.binario ? { binario: p.binario } : {}),
            ...(sesion ? { cookie: sesion.cookie, csrf: sesion.csrf } : {}),
            ...(sesion && estudio ? { estudio } : {}),
          });
        };
        const c: Contexto = { yo, mio, ajeno, sesion, pedir };

        const ajenoAntes = await instantanea(ajeno, true);
        const propioAntes = await instantanea(mio, false);
        if (caso.antes) await caso.antes(c);
        expect(
          ajenoAntes.cliente,
          "instantánea vacía: la prueba sería vacía",
        ).toHaveLength(2);

        try {
          const esperados = caso.esperado[combo.rol];
          const peticiones = caso.construir(c);
          const respuestas: Resp[] = [];
          for (const p of peticiones) {
            const r = await pedir(p);
            respuestas.push(r);
            const id = `${p.metodo ?? "GET"} ${p.ruta}`;
            expect(
              esperados,
              `${id} respondió ${r.status} ${JSON.stringify(r.body)}`,
            ).toContain(r.status);
            expect(
              fugas(r, ajeno, caso),
              `${id}: datos del otro estudio en la respuesta`,
            ).toEqual([]);
          }

          // Una petición con `X-Estudio` del otro estudio nunca llega al negocio (rutas con estudio).
          // (El stream no tiene petición común: su caso abre el SSE en `extra`.)
          if (
            peticiones.length > 0 &&
            !caso.publica &&
            !caso.ruta.includes(" /auth/")
          ) {
            const r = await pedir(peticiones[0]!, { estudio: ajeno.tenantId });
            expect(
              ESTATUS_X_ESTUDIO_AJENO,
              `X-Estudio ajeno respondió ${r.status}`,
            ).toContain(r.status);
            expect(fugas(r, ajeno, caso)).toEqual([]);
          }

          if (caso.extra) await caso.extra(c, respuestas);

          // La BD del otro estudio queda intacta y el lote mezclado no aplicó nada en el propio.
          expect(await instantanea(ajeno, true)).toEqual(ajenoAntes);
          expect(await instantanea(mio, false)).toEqual(propioAntes);
        } finally {
          if (caso.despues) await caso.despues(c);
        }
      });
    }
  });
}
