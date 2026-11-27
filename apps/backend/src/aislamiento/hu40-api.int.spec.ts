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
// 024 (T4) agrega las 3 rutas de la bandeja (`GET /buzon/mensajes`, `POST /buzon/atencion` y `POST /clientes/:clienteId/buzon/mensajes/
// :mensajeId/atencion`) y amplía `GET /clientes` con el indicador `buzon` y el filtro `conMensajesNuevos`: ids de B, solos o mezclados
// con los propios, dan 404 (400 si el parámetro o el cursor no es del contrato) y nada de B en la respuesta; `buzon_mensaje`,
// `buzon_atencion` y la auditoría de ambos estudios quedan intactos. Rojo hasta T7 (tablas y columnas) y T8 (rutas).
// 025 (T6) agrega las 6 rutas del aprendizaje del historial (`POST …/reglas/importaciones`, `GET …/importaciones/ultima`, `GET …/candidatas`,
// `POST …/candidatas/activar`, `…/candidatas/:candidataId/reemplazar` y `…/candidatas/descartar`): cada estudio tiene una importación
// completada y una candidata pendiente en su primer cliente (sembradas por SQL); sus ids, el RUC y la razón social del proveedor son marcas
// de fuga. Un usuario de A con ids de B (cliente, importación, candidata), solos o mezclados con los propios, recibe 404 (o 403 sin
// `reglas.gestionar`) igual que ante un id inexistente, y `regla_importacion`, `regla_candidata`, las reglas y los trabajos de ambos
// estudios quedan intactos. Rojo hasta T10 (tablas) y T12 (rutas): sin tablas la siembra falla y solo fallan los casos nuevos.
// 026 (T6) agrega las 6 rutas de la prorrata (`GET …/prorrata`, `GET …/prorrata/meses/:periodo/historial`, `POST …/prorrata/declaraciones`,
// `PUT …/prorrata/meses/:periodo`, `POST …/prorrata/meses/:periodo/eliminar` y `PUT …/prorrata/usada/:periodo`): cada estudio tiene una obtención,
// un PDT (declaración), un mes manual y una prorrata ingresada en su primer cliente (sembrados por SQL); sus ids y el motivo del manual son marcas
// de fuga. Un usuario de A con el cliente (o un id cualquiera) de B recibe 404 (o 403 sin `prorrata.gestionar`) igual que ante un id inexistente,
// y las cuatro tablas, los trabajos y las reglas de ambos estudios quedan intactos. Rojo hasta T10 (tablas) y T12 (rutas).
// 027 (T6) agrega las 14 rutas de gastos no deducibles (`GET|PUT …/estudio/reglas-motor/gastos/{umbral,palabras,palabras/:id,globales/:id}`, `GET|PUT
// …/clientes/:clienteId/gastos/categorias`, `GET|POST …/clientes/:clienteId/periodos/:periodo/gastos/aprender/:compraId`, `POST …/gastos/reevaluar`
// y las cuatro de `/plataforma/diccionario*`): cada estudio tiene una palabra propia, una global desactivada, un umbral, un ajuste de categorías y una
// entrada de CIIU en su primer cliente (sembrados por SQL); sus ids, su palabra y el RUC de la caché son marcas de fuga. Un usuario de A con ids de B
// recibe 404 (o 403 sin `reglas.gestionar`) igual que ante un id inexistente, el estudio sale de la sesión (un `tenantId` en el cuerpo es 400), las rutas
// de plataforma dan 403 a quien no es super-admin, y las cinco tablas, los trabajos y la auditoría de ambos estudios quedan intactos. Rojo hasta T10
// (tablas) y T12 (rutas).
// 028 (T6) agrega las 4 rutas de correo (`GET|PUT /cuenta/correo`, `POST|GET /correo/baja`): cada estudio tiene, sembradas por SQL, las cuatro
// preferencias del Dueño y de la asistente (con valores distintos entre A y B), un envío `fallido` del Dueño y su token de baja de resumen; el id
// del envío y el token (en claro, en base64url y en hex del hash) son marcas de fuga. Un usuario de A con el `usuarioId` o `tenantId` de B en el
// cuerpo o la consulta recibe 400 o su propia vista, el hash almacenado de B usado como token y los cuerpos mal formados no aplican nada (200 `{}`
// o 400), y `GET /correo/baja?t=<token real de B>` es 405 sin efectos; las cuatro tablas de correo y la auditoría `correo.preferencia_cambiada`
// de ambos estudios quedan intactas. Los `PUT` válidos y la baja con el token propio se prueban en «las pruebas no son vacías» (restauran lo que
// cambian). Rojo hasta T10 (tablas) y T12 (rutas): hasta entonces solo fallan los casos nuevos.
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
import { borrarCorreoDeEstudios, sembrarEnvio, sembrarToken } from "../../test/soporte-correo.js";
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
  /** 021: una regla aprendida del primer cliente (sembrada por SQL), con la que se prueban las rutas de reglas. */
  reglaId: string;
  /** 023: un mensaje del buzón del primer cliente, con un adjunto omitido (sembrados por SQL), para las rutas del buzón. */
  mensajeId: string;
  adjuntoId: string;
  /** Asunto y nombre del adjunto: textos únicos que tampoco deben verse desde el otro estudio. */
  asuntoBuzon: string;
  nombreAdjunto: string;
  /** 025: importación completada y candidata pendiente del primer cliente (sembradas por SQL; ausentes si faltan las tablas). */
  importacionId?: string;
  candidataId?: string;
  /** 025: RUC y razón social del proveedor de la candidata (marcas de fuga). */
  proveedorCandidata?: { numero: string; razonSocial: string };
  /** 026: obtención, PDT, mes manual y prorrata ingresada del primer cliente (sembrados por SQL; ausentes si faltan las tablas). */
  prorrata?: { obtencionId: string; declaracionId: string; manualId: string; usadaId: string; motivo: string };
  /** 027: palabra propia, global desactivada, umbral, ajuste de categorías del primer cliente y CIIU en la caché (ausentes si faltan las tablas). */
  gastos?: { propiaId: string; palabra: string; categoriasClienteId: string; ruc: string };
  /** 028: envío `fallido` del Dueño y su token de baja de resumen (token en claro; hash en base64url y en hex). Ausente si faltan las tablas. */
  correo?: { envioId: string; token: string; hashB64: string; hashHex: string };
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
/** 021: reglas aprendidas sembradas por la prueba (se quitan antes que los clientes que referencian). */
const reglasSembradas: string[] = [];
/** 023: mensajes del buzón sembrados (sus adjuntos se quitan antes que ellos y ambos antes que los clientes). */
const mensajesBuzonSembrados: string[] = [];
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
/** 025: si la siembra de importaciones y candidatas falló (¿tablas de T10?), el motivo; los casos nuevos lo muestran. */
let falloSiembra025: string | null = null;
/** 025: candidatas sembradas (se quitan antes que las reglas y los clientes). */
const candidatasSembradas: string[] = [];
const importacionesSembradas: string[] = [];
/** 026: si la siembra de la prorrata falló (¿tablas de T10?), el motivo; los casos nuevos lo muestran. */
let falloSiembra026: string | null = null;
/** 027: si la siembra de gastos no deducibles falló (¿tablas de T10?), el motivo; los casos nuevos lo muestran. */
let falloSiembra027: string | null = null;
/** 028: si la siembra de correo (preferencias, envío fallido y token de baja) falló (¿tablas de T10?), el motivo; los casos nuevos lo muestran. */
let falloSiembra028: string | null = null;

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
  // 021: una regla aprendida viva en el primer cliente (el id y el destino de B no deben verse ni cambiar desde A).
  const regla = await h.sql(
    `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, periodo_aprendido, creada_por, actualizada_por)
     values ($1, $2, '6', $3, 'DNG', '202609', $4, $4) returning id`,
    [tenantId, clientes[0], `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, dueno.id],
  );
  reglasSembradas.push(regla[0].id);
  // 023: un mensaje del buzón en el primer cliente y un adjunto omitido (sin archivo: nada que leer del storage).
  const asuntoBuzon = `HU40 ${etiqueta} buzon asunto ${sufijo}`;
  const nombreAdjunto = `HU40-${etiqueta}-adjunto-${sufijo}.pdf`;
  const mensaje = await h.sql(
    `insert into buzon_mensaje (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, version_catalogo, adjuntos_declarados)
     values ($1, $2, $3, $4, 'SUNAT', now() - interval '1 day', 'otro', false, 1, 1) returning id`,
    [tenantId, clientes[0], `HU40-${hex()}`, asuntoBuzon],
  );
  mensajesBuzonSembrados.push(mensaje[0].id);
  const adjunto = await h.sql(
    `insert into buzon_adjunto (tenant_id, cliente_id, mensaje_id, id_sunat, nombre, omitido)
     values ($1, $2, $3, $4, $5, 'mime') returning id`,
    [tenantId, clientes[0], mensaje[0].id, `HU40-${hex()}`, nombreAdjunto],
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
    reglaId: regla[0].id,
    mensajeId: mensaje[0].id,
    adjuntoId: adjunto[0].id,
    asuntoBuzon,
    nombreAdjunto,
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

/**
 * 025: una importación completada y una candidata pendiente (DNG, sin regla viva) en el primer cliente del estudio, por SQL. El RUC del
 * proveedor y su razón social son únicos de la prueba: marcas de fuga. Sin las tablas de T10 falla (42P01) y lo captura el arranque.
 */
async function sembrarAprendizaje(r: Recursos, etiqueta: "A" | "B"): Promise<void> {
  const numero = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const razonSocial = `HU40 ${etiqueta} proveedor importado ${sufijo}`;
  const imp = await h.sql(
    `insert into regla_importacion (tenant_id, cliente_id, estado, periodos, periodo_hasta, solicitada_por, solicitada_en, terminada_en,
       periodos_leidos, periodos_sin_datos, candidatas, sin_criterio)
     values ($1, $2, 'completada', '{202610,202609,202608}'::char(6)[], '202610', $3, now() - interval '1 day',
       now() - interval '1 day' + interval '1 minute', 3, '{}'::char(6)[], 1, 0) returning id`,
    [r.tenantId, r.clientes[0], r.dueno.id],
  );
  importacionesSembradas.push(imp[0].id);
  const cand = await h.sql(
    `insert into regla_candidata (tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
       n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado)
     values ($1, $2, $3, '6', $4, $5, 'DNG', 0, 0, 4, 1, 5, 3, 'pendiente') returning id`,
    [r.tenantId, r.clientes[0], imp[0].id, numero, razonSocial],
  );
  candidatasSembradas.push(cand[0].id);
  r.importacionId = imp[0].id;
  r.candidataId = cand[0].id;
  r.proveedorCandidata = { numero, razonSocial };
}

/**
 * 026: una obtención, un PDT (periodo 202610, sin prorrata usada), un mes manual (202601) y una prorrata ingresada (202610) en el primer cliente
 * del estudio, por SQL. El motivo del manual es único de la prueba: marca de fuga. Sin las tablas de T10 falla (42P01) y lo captura el arranque.
 */
async function sembrarProrrata(r: Recursos, etiqueta: "A" | "B"): Promise<void> {
  const motivo = `HU40 ${etiqueta} motivo prorrata ${sufijo}`;
  const ob = await h.sql(
    `insert into prorrata_obtencion (tenant_id, cliente_id, periodo_hasta, trabajo_id, periodos_leidos, periodos_sin_declaracion, nuevas)
     values ($1, $2, '202610', null, '{202511,202512,202601,202602,202603,202604,202605,202606,202607,202608,202609,202610}'::char(6)[],
       '{202511}'::char(6)[], 1) returning id`,
    [r.tenantId, r.clientes[0]],
  );
  const de = await h.sql(
    `insert into declaracion_mensual (tenant_id, cliente_id, periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
       ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada, obtencion_id)
     values ($1, $2, '202610', 9001, '2026-11-10', 'original', 100000.00, 18000.00, 0.00, 20000.00, 9000.00, 1800.00, null, $3) returning id`,
    [r.tenantId, r.clientes[0], ob[0].id],
  );
  const ma = await h.sql(
    `insert into prorrata_mes_manual (tenant_id, cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo, autor)
     values ($1, $2, '202601', 1, 'guardado', 100000.00, 0.00, 20000.00, $3, $4) returning id`,
    [r.tenantId, r.clientes[0], motivo, r.dueno.id],
  );
  const us = await h.sql(
    `insert into prorrata_usada_manual (tenant_id, cliente_id, periodo, version, porcentaje, autor)
     values ($1, $2, '202610', 1, 50.00, $3) returning id`,
    [r.tenantId, r.clientes[0], r.dueno.id],
  );
  r.prorrata = { obtencionId: ob[0].id, declaracionId: de[0].id, manualId: ma[0].id, usadaId: us[0].id, motivo };
}

/**
 * 027: una palabra propia, la global «polo» desactivada, el umbral 7, el ajuste de categorías del primer cliente y una entrada de CIIU en la caché
 * del estudio, por SQL. La palabra y el RUC son únicos de la prueba: marcas de fuga. Sin las tablas de T10 falla (42P01) y lo captura el arranque.
 */
async function sembrarGastos(r: Recursos, etiqueta: "A" | "B"): Promise<void> {
  const palabra = `hu40${etiqueta.toLowerCase()}${sufijo}`;
  const ruc = etiqueta === "A" ? "20700027001" : "20700027002";
  const pa = await h.sql(
    `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por)
     values ($1, $2, 'entretenimiento', '{}', 'manual', true, 1, $3) returning id`,
    [r.tenantId, palabra, r.dueno.id],
  );
  await h.sql(
    `insert into gnd_global_desactivada (tenant_id, palabra_global_id, usuario_id)
     select $1, id, $2 from gnd_palabra_global where palabra = 'polo'`,
    [r.tenantId, r.dueno.id],
  );
  await h.sql("insert into gnd_config (tenant_id, umbral, version) values ($1, 7, 1)", [r.tenantId]);
  const ca = await h.sql(
    `insert into gnd_cliente_categorias (tenant_id, cliente_id, permitidas, quitadas, version) values ($1, $2, '{juguetes}', '{}', 1) returning cliente_id`,
    [r.tenantId, r.clientes[0]],
  );
  await h.sql("insert into gnd_ciiu (tenant_id, ruc, ciiu) values ($1, $2, '4752')", [r.tenantId, ruc]);
  r.gastos = { propiaId: pa[0].id, palabra, categoriasClienteId: ca[0].cliente_id, ruc };
}

/**
 * 028: las cuatro preferencias del Dueño y de la asistente (valores distintos entre A y B para que una vista cruzada se note), un envío `fallido`
 * del Dueño y su token de baja de resumen, por SQL. El id del envío y el token son marcas de fuga. Sin las tablas de T10 falla (42P01) y lo
 * captura el arranque.
 */
type PrefsSembradas = { buzon: boolean; cred: boolean; plan: boolean; resumen: boolean };
const PREFS_028: Record<"A" | "B", Record<"dueno" | "asistente", PrefsSembradas>> = {
  A: { dueno: { buzon: false, cred: true, plan: true, resumen: true }, asistente: { buzon: true, cred: true, plan: true, resumen: true } },
  B: { dueno: { buzon: true, cred: false, plan: true, resumen: true }, asistente: { buzon: true, cred: true, plan: false, resumen: true } },
};
async function sembrarCorreo(r: Recursos, etiqueta: "A" | "B"): Promise<void> {
  for (const rol of ["dueno", "asistente"] as const) {
    const v = PREFS_028[etiqueta][rol];
    for (const [tipo, activo] of [
      ["buzon_critico", v.buzon],
      ["credencial_invalida", v.cred],
      ["plan_limite", v.plan],
      ["resumen", v.resumen],
    ] as const)
      await h.sql("insert into correo_preferencia (tenant_id, usuario_id, tipo, activo, todos_clientes) values ($1, $2, $3, $4, false)", [
        r.tenantId,
        r[rol].id,
        tipo,
        activo,
      ]);
  }
  const envioId = await sembrarEnvio(h.sql, { tenantId: r.tenantId, usuarioId: r.dueno.id, tipo: "resumen", estado: "fallido", hace: "5 minutes" });
  const t = await sembrarToken(h.sql, { tenantId: r.tenantId, usuarioId: r.dueno.id, tipo: "resumen", envioId });
  r.correo = { envioId, token: t.token, hashB64: t.hash.toString("base64url"), hashHex: t.hash.toString("hex") };
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
    de.reglaId,
    de.mensajeId,
    de.adjuntoId,
    ...(de.importacionId ? [de.importacionId] : []),
    ...(de.candidataId ? [de.candidataId] : []),
    ...(de.prorrata ? [de.prorrata.obtencionId, de.prorrata.declaracionId, de.prorrata.manualId, de.prorrata.usadaId] : []),
  ]);
  const correos = new Set<string>([de.invitacionCorreo]);
  const otros = new Set<string>([de.nombre, de.asuntoBuzon, de.nombreAdjunto]);
  if (de.proveedorCandidata) {
    otros.add(de.proveedorCandidata.numero);
    otros.add(de.proveedorCandidata.razonSocial);
  }
  if (de.prorrata) otros.add(de.prorrata.motivo);
  if (de.gastos) {
    ids.add(de.gastos.propiaId);
    otros.add(de.gastos.palabra);
    otros.add(de.gastos.ruc);
  }
  if (de.correo) {
    ids.add(de.correo.envioId);
    for (const m of [de.correo.token, de.correo.hashB64, de.correo.hashHex]) otros.add(m);
  }
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
/** 026: las cuatro tablas de la prorrata de los clientes de `r` (vacías, sin romper, mientras no existan: rojo hasta T10). */
async function instantaneaProrrata(
  r: Recursos,
  q: (texto: string, valores: unknown[]) => Promise<unknown[]>,
): Promise<Record<string, unknown>> {
  const salida: Record<string, unknown> = {};
  for (const tabla of ["prorrata_obtencion", "declaracion_mensual", "prorrata_mes_manual", "prorrata_usada_manual"]) {
    salida[tabla] = await q(`select to_jsonb(g) j from ${tabla} g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id`, [
      r.tenantId,
      r.clientes,
    ]).catch((e: { code?: string }) => {
      if (e.code === "42P01") return [];
      throw e;
    });
  }
  return salida;
}

/** 027: las cinco tablas del estudio de gastos no deducibles de `r` (vacías, sin romper, mientras no existan: rojo hasta T10). */
async function instantaneaGastos(
  r: Recursos,
  q: (texto: string, valores: unknown[]) => Promise<unknown[]>,
): Promise<Record<string, unknown>> {
  const salida: Record<string, unknown> = {};
  for (const tabla of ["gnd_palabra_estudio", "gnd_global_desactivada", "gnd_config", "gnd_cliente_categorias", "gnd_ciiu"]) {
    salida[tabla] = await q(`select to_jsonb(g) j from ${tabla} g where tenant_id = $1 order by 1`, [r.tenantId]).catch((e: { code?: string }) => {
      if (e.code === "42P01") return [];
      throw e;
    });
  }
  return salida;
}

/** 028: las cuatro tablas de correo del estudio y las filas de auditoría `correo.preferencia_cambiada` (vacías, sin romper, mientras no existan: rojo hasta T10). */
async function instantaneaCorreo(
  r: Recursos,
  q: (texto: string, valores: unknown[]) => Promise<unknown[]>,
): Promise<Record<string, unknown>> {
  const salida: Record<string, unknown> = {};
  for (const tabla of ["correo_preferencia", "correo_envio", "correo_envio_aviso", "correo_baja_token"]) {
    salida[tabla] = await q(`select to_jsonb(g) j from ${tabla} g where tenant_id = $1 order by 1`, [r.tenantId]).catch((e: { code?: string }) => {
      if (e.code === "42P01") return [];
      throw e;
    });
  }
  salida.auditoria_correo = await q("select to_jsonb(g) j from auditoria g where tenant_id = $1 and accion = 'correo.preferencia_cambiada' order by 1", [r.tenantId]);
  return salida;
}

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
    regla_aprendida: await q(
      "select to_jsonb(g) j from regla_aprendida g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ),
    buzon_mensaje: await q(
      "select to_jsonb(g) j from buzon_mensaje g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ),
    buzon_adjunto: await q(
      "select to_jsonb(g) j from buzon_adjunto g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ),
    buzon_estado_cliente: await q(
      "select to_jsonb(g) j from buzon_estado_cliente g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by cliente_id",
      [r.tenantId, r.clientes],
    ),
    // 025: importaciones y candidatas (0061). Mientras las tablas no existan (rojo) la instantánea no las incluye y no rompe los casos de 004 a 024.
    regla_importacion: await q(
      "select to_jsonb(g) j from regla_importacion g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ).catch((e: { code?: string }) => {
      if (e.code === "42P01") return [];
      throw e;
    }),
    regla_candidata: await q(
      "select to_jsonb(g) j from regla_candidata g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ).catch((e: { code?: string }) => {
      if (e.code === "42P01") return [];
      throw e;
    }),
    // 026: obtenciones, PDT, manuales y prorratas ingresadas (0065). Mientras las tablas no existan (rojo) la instantánea no las incluye.
    ...(await instantaneaProrrata(r, q)),
    // 027: las cinco tablas de gastos no deducibles (0069). Mientras no existan (rojo) la instantánea no las incluye.
    ...(await instantaneaGastos(r, q)),
    // 028: las cuatro tablas de correo y su auditoría (0073). Mientras no existan (rojo) la instantánea no las incluye.
    ...(await instantaneaCorreo(r, q)),
    // 024: historial de atención (0059). Mientras la tabla no exista (rojo) la instantánea no la incluye y no rompe los casos de 004 a 023.
    buzon_atencion: await q(
      "select to_jsonb(g) j from buzon_atencion g where tenant_id = $1 and cliente_id = any($2::uuid[]) order by id",
      [r.tenantId, r.clientes],
    ).catch((e: { code?: string }) => {
      if (e.code === "42P01") return [];
      throw e;
    }),
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


/* ---------------------------- 021 · reglas aprendidas ----------------------------
 * `/clientes/:clienteId/reglas*` (reglas.ver para leer, reglas.gestionar para escribir) y `/estudio/reglas-motor*` (el estudio sale de
 * la sesión; escribir exige reglas.gestionar y alcance global). Un cliente o una regla de B desde A: el mismo 404 `no_encontrado`,
 * nunca un dato ni un cambio en B; la asistente (sin reglas.gestionar) recibe 403 en toda escritura, antes de mirar el recurso. */
const NO_ENCONTRADO = { codigo: "no_encontrado" };
const PERMISO_DENEGADO = { codigo: "permiso_denegado" };
const CODIGOS_MOTOR = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-STD", "R-HIS"]; // 025: R-STD antes de R-HIS

/** Pares (cliente, regla) con ids del otro estudio solos y mezclados con los propios; ninguno existe para quien llama. */
const paresDeRegla = (c: Contexto): [string, string][] => [
  [c.ajeno.clientes[0], c.ajeno.reglaId], // todo ajeno y real
  [c.mio.clientes[0], c.ajeno.reglaId], // cliente propio (visible para la asistente), regla de B
  [c.mio.clientes[1], c.ajeno.reglaId], // cliente propio, regla de B
  [c.ajeno.clientes[1], c.ajeno.reglaId], // otro cliente de B con la regla de B
  [c.ajeno.clientes[0], randomUUID()], // cliente de B, regla inexistente
  [c.ajeno.asignacionId, c.ajeno.reglaId], // id de otra cosa de B como cliente
  [c.mio.clientes[0], c.ajeno.asignacionId], // id de otra cosa de B como regla
];

/** `estudio_regla_motor` y `estudio_reglas_config` de un estudio (el rol del arnés las lee sin RLS). */
async function filasMotor(tenantId: string): Promise<unknown[]> {
  const a = await h.sql("select to_jsonb(m) j from estudio_regla_motor m where tenant_id = $1 order by codigo", [tenantId]);
  const b = await h.sql("select to_jsonb(g) j from estudio_reglas_config g where tenant_id = $1", [tenantId]);
  return [...a, ...b].map((f) => f.j);
}
let motorAntes: { mio: unknown[]; ajeno: unknown[] } | null = null;
const registrarMotorAntes = async (c: Contexto): Promise<void> => {
  motorAntes = { mio: await filasMotor(c.mio.tenantId), ajeno: await filasMotor(c.ajeno.tenantId) };
};

/** La regla sembrada de `r` sigue como se sembró (viva, activa, versión 1, destino DNG). */
async function reglaIntacta(r: Recursos): Promise<void> {
  const f = await h.sql(
    "select destino, activa, version, eliminada_en, eliminada_por from regla_aprendida where id = $1",
    [r.reglaId],
  );
  expect(f).toEqual([{ destino: "DNG", activa: true, version: 1, eliminada_en: null, eliminada_por: null }]);
}

/** Todas las respuestas son el mismo 404 sin revelar cuál de los ids no existe. */
function mismoNoEncontrado(respuestas: Resp[], referencia: Resp): void {
  for (const r of respuestas) {
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
    expect(r.text).toBe(referencia.text);
  }
}

function casosReglas(): Caso[] {
  const cuerpoEditar = (c: Contexto) => ({ versionBase: 1, destino: "DG", activa: false, tenantId: c.ajeno.tenantId, clienteId: c.ajeno.clientes[0] });
  /** Escrituras de reglas con ids de B: la asistente (sin reglas.gestionar) recibe 403; el Dueño, el 404 de siempre. */
  const verificarEscritura = async (c: Contexto, respuestas: Resp[]): Promise<void> => {
    const referencia = await c.pedir({ ruta: `/clientes/${randomUUID()}/reglas` });
    expect(referencia.status).toBe(404);
    if (c.yo.rol === "asistente") {
      for (const r of respuestas) {
        expect(r.status, r.text).toBe(403);
        expect(r.body).toEqual(PERMISO_DENEGADO);
      }
    } else {
      mismoNoEncontrado(respuestas, respuestas[0]!);
      expect(respuestas[0]!.body).toEqual(referencia.body);
    }
    await reglaIntacta(c.ajeno);
    await reglaIntacta(c.mio);
  };

  return [
    {
      ruta: "GET /clientes/:clienteId/reglas",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/reglas` })),
      extra: async (c, respuestas) => {
        // Cliente de otro estudio, no visible o inexistente: el mismo 404, sin revelar cuál es.
        const noExiste = await c.pedir({ ruta: `/clientes/${randomUUID()}/reglas` });
        expect(noExiste.status).toBe(404);
        expect(noExiste.body).toEqual(NO_ENCONTRADO);
        mismoNoEncontrado(respuestas, noExiste);
        // Propio y visible: la regla sembrada, con su id; propio y no visible (la asistente solo ve su cliente asignado).
        const propio = await c.pedir({ ruta: `/clientes/${c.mio.clientes[0]}/reglas` });
        expect(propio.status, propio.text).toBe(200);
        expect((propio.body as any[]).map((x) => x.id)).toEqual([c.mio.reglaId]);
        expect(JSON.stringify(propio.body)).not.toContain(c.ajeno.reglaId);
        const noVisible = await c.pedir({ ruta: `/clientes/${c.mio.clientes[1]}/reglas` });
        if (c.yo.rol === "asistente") {
          expect(noVisible.status, noVisible.text).toBe(404);
          expect(noVisible.text).toBe(noExiste.text);
        } else {
          expect(noVisible.status, noVisible.text).toBe(200);
          expect(noVisible.body).toEqual([]);
        }
        await reglaIntacta(c.ajeno);
      },
    },
    {
      ruta: "POST /clientes/:clienteId/reglas/recordar",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${id}/reglas/recordar`,
          cuerpo: { compraIds: [randomUUID()], destino: "DG", versionBase: null, tenantId: c.ajeno.tenantId },
        })),
      extra: async (c, respuestas) => {
        await verificarEscritura(c, respuestas);
        // Con el cliente visible pero una compra de otro estudio (id inexistente aquí): la asistente sigue sin permiso, el Dueño 404.
        const propio = await c.pedir({
          metodo: "POST",
          ruta: `/clientes/${c.mio.clientes[0]}/reglas/recordar`,
          cuerpo: { compraIds: [randomUUID()], destino: "DG", versionBase: null },
        });
        expect(propio.status, propio.text).toBe(c.yo.rol === "asistente" ? 403 : 404);
        expect(propio.body).toEqual(c.yo.rol === "asistente" ? PERMISO_DENEGADO : NO_ENCONTRADO);
        const n = await h.sql("select count(*)::int n from regla_aprendida where cliente_id = any($1::uuid[])", [
          [...c.mio.clientes, ...c.ajeno.clientes],
        ]);
        expect(n[0].n).toBe(2); // solo las dos sembradas (una por estudio): no se creó ninguna
      },
    },
    {
      ruta: "PATCH /clientes/:clienteId/reglas/:reglaId",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        paresDeRegla(c).map(([cl, rg]) => ({
          metodo: "PATCH" as const,
          ruta: `/clientes/${cl}/reglas/${rg}`,
          cuerpo: cuerpoEditar(c),
        })),
      extra: verificarEscritura,
    },
    {
      ruta: "DELETE /clientes/:clienteId/reglas/:reglaId",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        paresDeRegla(c).map(([cl, rg]) => ({
          metodo: "DELETE" as const,
          ruta: `/clientes/${cl}/reglas/${rg}?versionBase=1&tenantId=${c.ajeno.tenantId}`,
        })),
      extra: verificarEscritura,
    },
    {
      // El estudio sale de la sesión: `tenantId` en la consulta no cambia de estudio y la respuesta es solo la configuración propia.
      ruta: "GET /estudio/reglas-motor",
      esperado: todos(200),
      construir: (c) => [{ ruta: "/estudio/reglas-motor" }, { ruta: `/estudio/reglas-motor?tenantId=${c.ajeno.tenantId}&estudioId=${c.ajeno.tenantId}` }],
      extra: async (c, respuestas) => {
        for (const r of respuestas) {
          expect((r.body.reglas as any[]).map((x) => x.codigo)).toEqual(CODIGOS_MOTOR);
          expect(typeof r.body.aportarCatalogo).toBe("boolean");
        }
      },
    },
    {
      // Escribir exige reglas.gestionar Y alcance global: el Dueño pasa (200, o 404 si el código no es del catálogo) y la asistente
      // recibe 403 antes de mirar el código. Los valores escritos son los de por defecto (sin fila = encendida): el efecto es neutro.
      ruta: "PUT /estudio/reglas-motor/:codigo",
      esperado: { dueno: [200, 404], asistente: [403] },
      construir: (c) => [
        { metodo: "PUT", ruta: "/estudio/reglas-motor/R-ISC", cuerpo: { activa: true, tenantId: c.ajeno.tenantId, estudioId: c.ajeno.tenantId } },
        { metodo: "PUT", ruta: `/estudio/reglas-motor/R-HIS?tenantId=${c.ajeno.tenantId}`, cuerpo: { activa: true } },
        { metodo: "PUT", ruta: "/estudio/reglas-motor/prevalidacion", cuerpo: { activa: true } },
        { metodo: "PUT", ruta: `/estudio/reglas-motor/${c.ajeno.tenantId}`, cuerpo: { activa: true, tenantId: c.ajeno.tenantId } },
      ],
      antes: registrarMotorAntes,
      extra: async (c, respuestas) => {
        if (c.yo.rol === "asistente") {
          for (const r of respuestas) expect(r.body).toEqual(PERMISO_DENEGADO);
          expect(await filasMotor(c.mio.tenantId)).toEqual(motorAntes!.mio); // sin permiso: nada se guarda
        } else {
          expect(respuestas.map((r) => r.status)).toEqual([200, 200, 404, 404]);
          expect((respuestas[0]!.body.reglas as any[]).find((x) => x.codigo === "R-ISC").activa).toBe(true);
          const propias = (await h.sql("select codigo, activa from estudio_regla_motor where tenant_id = $1 order by codigo", [c.mio.tenantId])).map(
            (f) => `${f.codigo}:${f.activa}`,
          );
          expect(propias).toEqual(expect.arrayContaining(["R-HIS:true", "R-ISC:true"])); // en el estudio de la sesión
        }
        expect(await filasMotor(c.ajeno.tenantId)).toEqual(motorAntes!.ajeno); // el estudio de B no se toca
      },
    },
    {
      ruta: "PUT /estudio/reglas-motor/aporte",
      esperado: { dueno: [200], asistente: [403] },
      construir: (c) => [
        { metodo: "PUT", ruta: "/estudio/reglas-motor/aporte", cuerpo: { aportar: true, tenantId: c.ajeno.tenantId, estudioId: c.ajeno.tenantId } },
        { metodo: "PUT", ruta: `/estudio/reglas-motor/aporte?tenantId=${c.ajeno.tenantId}`, cuerpo: { aportar: true } },
      ],
      antes: registrarMotorAntes,
      extra: async (c, respuestas) => {
        if (c.yo.rol === "asistente") {
          for (const r of respuestas) expect(r.body).toEqual(PERMISO_DENEGADO);
          expect(await filasMotor(c.mio.tenantId)).toEqual(motorAntes!.mio);
        } else {
          for (const r of respuestas) expect(r.body.aportarCatalogo).toBe(true);
          const f = await h.sql("select aportar_catalogo from estudio_reglas_config where tenant_id = $1", [c.mio.tenantId]);
          expect(f).toEqual([{ aportar_catalogo: true }]); // el valor por defecto, en el estudio de la sesión
        }
        expect(await filasMotor(c.ajeno.tenantId)).toEqual(motorAntes!.ajeno);
      },
    },
  ];
}

/* ---------------------------- 023 · buzón SOL del cliente ----------------------------
 * `/clientes/:clienteId/buzon/*` (buzon.ver para leer y revisar, buzon.marcar_leido para abrir; el Dueño y la asistente tienen ambos).
 * Un cliente, mensaje o adjunto de B desde A (solo, cruzado con ids propios, de otra cosa de B o inexistente): el mismo 404
 * `no_encontrado`, nunca un dato ni un efecto en B: ni trabajo, ni estado, ni mensaje, ni auditoría del buzón. La asistente solo ve el
 * cliente que tiene asignado: el otro cliente propio le da el mismo 404 que uno inexistente. */
let auditoriaBuzonAntes: { mio: number; ajeno: number } | null = null;
const auditoriaBuzon = async (tenantId: string): Promise<number> =>
  (await h.sql("select count(*)::int n from auditoria where tenant_id = $1 and accion like 'buzon.%'", [tenantId]))[0].n;
const registrarAuditoriaBuzonAntes = async (c: Contexto): Promise<void> => {
  auditoriaBuzonAntes = { mio: await auditoriaBuzon(c.mio.tenantId), ajeno: await auditoriaBuzon(c.ajeno.tenantId) };
};

/** El mensaje y el adjunto sembrados de `r` siguen en su sitio, sin contenido ni marca de lectura. */
async function buzonIntacto(r: Recursos): Promise<void> {
  const m = await h.sql(
    "select asunto, leido_sunat, contenido_ruta, contenido_obtenido_en from buzon_mensaje where id = $1",
    [r.mensajeId],
  );
  expect(m).toEqual([{ asunto: r.asuntoBuzon, leido_sunat: false, contenido_ruta: null, contenido_obtenido_en: null }]);
  const a = await h.sql("select nombre, omitido from buzon_adjunto where id = $1", [r.adjuntoId]);
  expect(a).toEqual([{ nombre: r.nombreAdjunto, omitido: "mime" }]);
}

/** 024: el mensaje sembrado de `r` sigue pendiente (sin atención ni marca de histórico) y sus clientes no tienen eventos de atención. */
async function atencionIntacta(r: Recursos): Promise<void> {
  const m = await h.sql("select atendido_en, atendido_por, historico from buzon_mensaje where id = $1", [r.mensajeId]);
  expect(m).toEqual([{ atendido_en: null, atendido_por: null, historico: false }]);
  const e = await h.sql("select count(*)::int n from buzon_atencion where tenant_id = $1 and cliente_id = any($2::uuid[])", [r.tenantId, r.clientes]);
  expect(e[0].n).toBe(0);
}
const CANARIO_ATENCION = "CANARIO-hu40-atencion-comentario";
/** Ningún estudio guardó el texto del comentario (ni en la auditoría ni en el historial). */
async function sinCanarioDeAtencion(): Promise<void> {
  const aud = await h.sql("select count(*)::int n from auditoria where datos::text like $1", [`%${CANARIO_ATENCION}%`]);
  expect(aud[0].n).toBe(0);
  const ev = await h.sql("select count(*)::int n from buzon_atencion where comentario like $1", [`%${CANARIO_ATENCION}%`]);
  expect(ev[0].n).toBe(0);
}
/** Cursor armado a mano con el formato del plan 024 (`{v, f, i, h}`) y el id de un mensaje de B como posición. */
const cursorConId = (id: string): string =>
  Buffer.from(JSON.stringify({ v: 1, f: "2026-11-19T12:00:00.000000Z", i: id, h: "0000000000000000" }), "utf8").toString("base64url");

/** Pares (cliente, mensaje) con ids del otro estudio solos y mezclados con los propios; ninguno existe para quien llama. */
const paresDeMensaje = (c: Contexto): [string, string][] => [
  [c.ajeno.clientes[0], c.ajeno.mensajeId], // todo ajeno y real
  [c.mio.clientes[0], c.ajeno.mensajeId], // cliente propio (visible para la asistente), mensaje de B
  [c.mio.clientes[1], c.ajeno.mensajeId], // cliente propio, mensaje de B
  [c.ajeno.clientes[1], c.ajeno.mensajeId], // otro cliente de B con el mensaje de B
  [c.ajeno.clientes[0], randomUUID()], // cliente de B, mensaje inexistente
  [c.ajeno.asignacionId, c.ajeno.mensajeId], // id de otra cosa de B como cliente
  [c.mio.clientes[0], c.ajeno.asignacionId], // id de otra cosa de B como mensaje
];

/** Ternas (cliente, mensaje, adjunto): lo de B solo y mezclado con lo propio, incluido el adjunto de B bajo el mensaje propio. */
const ternasDeAdjunto = (c: Contexto): [string, string, string][] => [
  [c.ajeno.clientes[0], c.ajeno.mensajeId, c.ajeno.adjuntoId], // todo ajeno y real
  [c.mio.clientes[0], c.ajeno.mensajeId, c.ajeno.adjuntoId], // cliente propio, mensaje y adjunto de B
  [c.mio.clientes[0], c.mio.mensajeId, c.ajeno.adjuntoId], // cliente y mensaje propios, adjunto de B
  [c.mio.clientes[1], c.mio.mensajeId, c.ajeno.adjuntoId], // cliente propio sin el mensaje, adjunto de B
  [c.ajeno.clientes[1], c.ajeno.mensajeId, c.ajeno.adjuntoId], // otro cliente de B
  [c.ajeno.clientes[0], c.ajeno.mensajeId, randomUUID()], // mensaje de B, adjunto inexistente
  [c.ajeno.asignacionId, c.ajeno.mensajeId, c.ajeno.adjuntoId], // id de otra cosa de B como cliente
  [c.mio.clientes[0], c.ajeno.asignacionId, c.ajeno.invitacionId], // ids de otras cosas de B como mensaje y adjunto
];

function casosBuzon(): Caso[] {
  /** Todas las respuestas son el 404 de un cliente inexistente (mismo texto) y el buzón de B y el propio quedan como estaban. */
  const verificar404 = async (c: Contexto, respuestas: Resp[], escribe: boolean): Promise<void> => {
    const noExiste = await c.pedir({ ruta: `/clientes/${randomUUID()}/buzon/mensajes` });
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    mismoNoEncontrado(respuestas, noExiste);
    await buzonIntacto(c.ajeno);
    await buzonIntacto(c.mio);
    if (escribe) {
      const despues = { mio: await auditoriaBuzon(c.mio.tenantId), ajeno: await auditoriaBuzon(c.ajeno.tenantId) };
      expect(despues).toEqual(auditoriaBuzonAntes); // ni auditoría de solicitud en B ni en el propio estudio
    }
  };

  return [
    {
      ruta: "GET /clientes/:clienteId/buzon/mensajes",
      esperado: todos(404),
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/buzon/mensajes` })),
      extra: async (c, respuestas) => {
        await verificar404(c, respuestas, false);
        // Propio y visible: solo su mensaje, nunca el de B; propio y no visible (la asistente solo ve su cliente asignado).
        const propio = await c.pedir({ ruta: `/clientes/${c.mio.clientes[0]}/buzon/mensajes` });
        expect(propio.status, propio.text).toBe(200);
        expect((propio.body.mensajes as any[]).map((x) => x.id)).toEqual([c.mio.mensajeId]);
        expect(JSON.stringify(propio.body)).not.toContain(c.ajeno.mensajeId);
        // Las claves que no son del contrato (clienteId, tenantId) no cambian el alcance.
        const intruso = await c.pedir({
          ruta: `/clientes/${c.mio.clientes[0]}/buzon/mensajes?clienteId=${c.ajeno.clientes[0]}&tenantId=${c.ajeno.tenantId}`,
        });
        if (intruso.status === 200) expect((intruso.body.mensajes as any[]).map((x) => x.id)).toEqual([c.mio.mensajeId]);
        else expect(intruso.status, intruso.text).toBe(400);
        const noVisible = await c.pedir({ ruta: `/clientes/${c.mio.clientes[1]}/buzon/mensajes` });
        if (c.yo.rol === "asistente") {
          expect(noVisible.status, noVisible.text).toBe(404);
          expect(noVisible.body).toEqual(NO_ENCONTRADO);
        } else {
          expect(noVisible.status, noVisible.text).toBe(200);
          expect(noVisible.body.mensajes).toEqual([]);
        }
      },
    },
    {
      ruta: "GET /clientes/:clienteId/buzon/mensajes/:mensajeId",
      esperado: todos(404),
      construir: (c) =>
        paresDeMensaje(c).map(([cl, m]) => ({ ruta: `/clientes/${cl}/buzon/mensajes/${m}` })),
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        await verificar404(c, respuestas, false);
        // Propio y visible: el detalle de su mensaje (sin contenido: no se audita), con su adjunto omitido.
        const propio = await c.pedir({ ruta: `/clientes/${c.mio.clientes[0]}/buzon/mensajes/${c.mio.mensajeId}` });
        expect(propio.status, propio.text).toBe(200);
        expect(propio.body.mensaje.id).toBe(c.mio.mensajeId);
        expect(propio.body.contenido).toBeNull();
        expect((propio.body.adjuntos as any[]).map((x) => x.id)).toEqual([c.mio.adjuntoId]);
        // El mensaje propio bajo el otro cliente propio (o bajo uno de B) no se cruza.
        const cruzado = await c.pedir({ ruta: `/clientes/${c.mio.clientes[1]}/buzon/mensajes/${c.mio.mensajeId}` });
        expect(cruzado.status, cruzado.text).toBe(404);
        expect(cruzado.body).toEqual(NO_ENCONTRADO);
        expect(await auditoriaBuzon(c.ajeno.tenantId)).toBe(auditoriaBuzonAntes!.ajeno);
      },
    },
    {
      ruta: "GET /clientes/:clienteId/buzon/mensajes/:mensajeId/adjuntos/:adjuntoId",
      esperado: todos(404),
      construir: (c) =>
        ternasDeAdjunto(c).map(([cl, m, a]) => ({ ruta: `/clientes/${cl}/buzon/mensajes/${m}/adjuntos/${a}` })),
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        await verificar404(c, respuestas, false);
        // Un adjunto omitido propio tampoco se descarga (no tiene archivo): el mismo 404, nunca los bytes ni un error distinto.
        const omitido = await c.pedir({
          ruta: `/clientes/${c.mio.clientes[0]}/buzon/mensajes/${c.mio.mensajeId}/adjuntos/${c.mio.adjuntoId}`,
        });
        expect(omitido.status, omitido.text).toBe(404);
        expect(omitido.body).toEqual(NO_ENCONTRADO);
        expect(await auditoriaBuzon(c.ajeno.tenantId)).toBe(auditoriaBuzonAntes!.ajeno);
        expect(await auditoriaBuzon(c.mio.tenantId)).toBe(auditoriaBuzonAntes!.mio); // no se descargó nada: nada que auditar
      },
    },
    {
      // Abrir exige buzon.marcar_leido (el Dueño y la asistente lo tienen; Lectura recibiría 403, ver abrir.int.spec). Con ids de B:
      // el mismo 404, sin trabajo ni auditoría de solicitud en ningún estudio.
      ruta: "POST /clientes/:clienteId/buzon/mensajes/:mensajeId/abrir",
      esperado: todos(404),
      construir: (c) =>
        paresDeMensaje(c).map(([cl, m]) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${cl}/buzon/mensajes/${m}/abrir`,
          cuerpo: { mensajeId: c.ajeno.mensajeId, clienteId: c.ajeno.clientes[0], tenantId: c.ajeno.tenantId },
        })),
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        await verificar404(c, respuestas, true);
        const n = await h.sql(
          "select count(*)::int n from job_registro where cliente_id = any($1::uuid[]) and tipo = 'sol.buzon.abrir'",
          [[...c.mio.clientes, ...c.ajeno.clientes]],
        );
        expect(n[0].n).toBe(0); // ningún «abrir» encolado
      },
    },
    {
      ruta: "POST /clientes/:clienteId/buzon/revisar",
      esperado: todos(404),
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${id}/buzon/revisar`,
          cuerpo: { tenantId: c.ajeno.tenantId, clienteId: c.ajeno.clientes[0] },
        })),
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        await verificar404(c, respuestas, true);
        const n = await h.sql(
          "select count(*)::int n from job_registro where cliente_id = any($1::uuid[]) and tipo = 'sol.buzon.revisar'",
          [[...c.mio.clientes, ...c.ajeno.clientes]],
        );
        expect(n[0].n).toBe(0); // ningún «revisar» encolado
      },
    },
    /* ---------- 024: bandeja unificada y atención ---------- */
    {
      // La ruta no lleva ids en la URL: el alcance lo aplica la consulta. Con la query de B (clienteId, tenantId, un cursor con un
      // mensaje de B) es 400; sin ella, solo las filas propias: nunca el mensaje, el cliente ni el asunto de B.
      ruta: "GET /buzon/mensajes",
      esperado: todos(200, 400),
      construir: (c) => [
        { ruta: "/buzon/mensajes" },
        { ruta: "/buzon/mensajes?atencion=todos&archivados=1&limite=100" },
        { ruta: `/buzon/mensajes?clienteId=${c.ajeno.clientes[0]}` },
        { ruta: `/buzon/mensajes?tenantId=${c.ajeno.tenantId}&clienteId=${c.ajeno.clientes[1]}&atencion=todos` },
        { ruta: `/buzon/mensajes?cursor=${cursorConId(c.ajeno.mensajeId)}` },
        { ruta: "/buzon/mensajes?responsable=yo&atencion=pendientes" },
      ],
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        const [base, todos, conCliente, conTenant, conCursor, responsable] = respuestas as [Resp, Resp, Resp, Resp, Resp, Resp];
        for (const r of [conCliente, conTenant]) {
          expect(r.status, r.text).toBe(400);
          expect(r.body).toEqual({ codigo: "solicitud_invalida" });
        }
        expect(conCursor.status, conCursor.text).toBe(400);
        expect(conCursor.body).toEqual({ codigo: "cursor_invalido" });
        const deB = new Set<string>(c.ajeno.clientes);
        for (const r of [base, todos, responsable]) {
          expect(r.status, r.text).toBe(200);
          expect(Array.isArray(r.body.mensajes), r.text).toBe(true);
          for (const f of r.body.mensajes as any[]) expect(deB.has(f.cliente.id), `cliente ${f.cliente.id} es del otro estudio`).toBe(false);
          expect(JSON.stringify(r.body)).not.toContain(c.ajeno.mensajeId);
        }
        // Control no vacío: el mensaje propio sí está, con la forma de la bandeja (la asistente solo ve su cliente asignado).
        const fila = (base.body.mensajes as any[]).find((f) => f.id === c.mio.mensajeId);
        expect(fila, "falta el mensaje propio en la bandeja").toBeDefined();
        expect(fila.cliente).toMatchObject({ id: c.mio.clientes[0], archivado: false });
        expect(fila.atencion).toEqual({ estado: "pendiente", por: null, en: null });
        if (c.yo.rol === "asistente") for (const f of base.body.mensajes as any[]) expect(f.cliente.id).toBe(c.mio.clientes[0]);
        await buzonIntacto(c.ajeno);
        await buzonIntacto(c.mio);
        expect(await auditoriaBuzon(c.ajeno.tenantId)).toBe(auditoriaBuzonAntes!.ajeno);
      },
    },
    {
      // Lote: un id de B (o inexistente), solo o junto a uno propio, da el mismo 404 a todo el lote sin cambiar nada; la query de B
      // en el cuerpo y `accion` (no se deshace en lote) son 400. El comentario no se guarda en ninguna parte.
      ruta: "POST /buzon/atencion",
      esperado: todos(400, 404),
      construir: (c) => [
        { metodo: "POST" as const, ruta: "/buzon/atencion", cuerpo: { mensajes: [c.ajeno.mensajeId], comentario: CANARIO_ATENCION } },
        { metodo: "POST" as const, ruta: "/buzon/atencion", cuerpo: { mensajes: [c.mio.mensajeId, c.ajeno.mensajeId], comentario: CANARIO_ATENCION } },
        { metodo: "POST" as const, ruta: "/buzon/atencion", cuerpo: { mensajes: [c.ajeno.mensajeId, randomUUID()], comentario: CANARIO_ATENCION } },
        { metodo: "POST" as const, ruta: "/buzon/atencion", cuerpo: { mensajes: [c.ajeno.asignacionId, c.ajeno.mensajeId] } },
        { metodo: "POST" as const, ruta: "/buzon/atencion", cuerpo: { mensajes: [randomUUID()] } },
        {
          metodo: "POST" as const,
          ruta: "/buzon/atencion",
          cuerpo: { mensajes: [c.ajeno.mensajeId], tenantId: c.ajeno.tenantId, clienteId: c.ajeno.clientes[0] },
        },
        { metodo: "POST" as const, ruta: "/buzon/atencion", cuerpo: { mensajes: [c.mio.mensajeId], accion: "deshacer" } },
      ],
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        const inexistente = respuestas[4]!;
        expect(inexistente.status, inexistente.text).toBe(404);
        expect(inexistente.body).toEqual(NO_ENCONTRADO);
        for (const r of respuestas.slice(0, 4)) {
          expect(r.status, r.text).toBe(404);
          expect(r.body).toEqual(NO_ENCONTRADO);
          expect(r.text).toBe(inexistente.text);
        }
        for (const r of respuestas.slice(5)) {
          expect(r.status, r.text).toBe(400);
          expect(r.body).toEqual({ codigo: "solicitud_invalida" });
        }
        await atencionIntacta(c.ajeno);
        await atencionIntacta(c.mio);
        await buzonIntacto(c.ajeno);
        await buzonIntacto(c.mio);
        expect({ mio: await auditoriaBuzon(c.mio.tenantId), ajeno: await auditoriaBuzon(c.ajeno.tenantId) }).toEqual(auditoriaBuzonAntes);
        await sinCanarioDeAtencion();
      },
    },
    {
      // Individual: los pares de ids de B (solos, cruzados con los propios, de otra cosa de B o inexistentes) dan el 404 de un cliente
      // inexistente, tanto al marcar como al deshacer, sin evento ni auditoría en ningún estudio.
      ruta: "POST /clientes/:clienteId/buzon/mensajes/:mensajeId/atencion",
      esperado: todos(404),
      construir: (c) =>
        paresDeMensaje(c).flatMap(([cl, m]) =>
          (["marcar", "deshacer"] as const).map((accion) => ({
            metodo: "POST" as const,
            ruta: `/clientes/${cl}/buzon/mensajes/${m}/atencion`,
            cuerpo: { accion, comentario: CANARIO_ATENCION },
          })),
        ),
      antes: registrarAuditoriaBuzonAntes,
      extra: async (c, respuestas) => {
        await verificar404(c, respuestas, true);
        await atencionIntacta(c.ajeno);
        await atencionIntacta(c.mio);
        await sinCanarioDeAtencion();
        // Control no vacío: el detalle del mensaje propio trae la atención pendiente y un historial vacío.
        const propio = await c.pedir({ ruta: `/clientes/${c.mio.clientes[0]}/buzon/mensajes/${c.mio.mensajeId}` });
        expect(propio.status, propio.text).toBe(200);
        expect(propio.body.atencion).toEqual({ estado: "pendiente", por: null, en: null, comentario: null });
        expect(propio.body.historial).toEqual([]);
        // Y el detalle de un mensaje de B bajo un cliente propio sigue siendo el mismo 404 (sin historial de B).
        const cruzado = await c.pedir({ ruta: `/clientes/${c.mio.clientes[0]}/buzon/mensajes/${c.ajeno.mensajeId}` });
        expect(cruzado.status, cruzado.text).toBe(404);
        expect(cruzado.body).toEqual(NO_ENCONTRADO);
      },
    },
  ];
}

/* ---------------------------- 025 · aprendizaje del historial ----------------------------
 * `/clientes/:clienteId/reglas/importaciones*` y `/clientes/:clienteId/reglas/candidatas*`: leer exige `reglas.ver` y escribir
 * `reglas.gestionar`. Un cliente, una importación o una candidata de B desde A: el mismo 404 `no_encontrado` que ante un id inexistente,
 * nunca un dato ni un cambio en B ni en A (un lote que mezcla ids propios y ajenos no aplica nada: P0002 a todo); la asistente (sin
 * `reglas.gestionar`) recibe 403 en toda escritura, antes de mirar el recurso. `activar` con `todas` y una importación ajena da 400 o 404. */
/** Pares (cliente, candidata) con ids del otro estudio solos y mezclados con los propios; ninguno existe para quien llama. */
const paresDeCandidata = (c: Contexto): [string, string][] => [
  [c.ajeno.clientes[0], c.ajeno.candidataId!], // todo ajeno y real
  [c.mio.clientes[0], c.ajeno.candidataId!], // cliente propio (visible para la asistente), candidata de B
  [c.mio.clientes[1], c.ajeno.candidataId!], // cliente propio, candidata de B
  [c.ajeno.clientes[1], c.ajeno.candidataId!], // otro cliente de B con la candidata de B
  [c.ajeno.clientes[0], randomUUID()], // cliente de B, candidata inexistente
  [c.ajeno.asignacionId, c.ajeno.candidataId!], // id de otra cosa de B como cliente
  [c.mio.clientes[0], c.ajeno.asignacionId], // id de otra cosa de B como candidata
];

/** Las candidatas sembradas de ambos estudios siguen pendientes y sin regla ni quien las resolviera. */
async function candidatasIntactas(c: Contexto): Promise<void> {
  const ids = [c.mio.candidataId, c.ajeno.candidataId].filter((x): x is string => x !== undefined);
  expect(ids, "la siembra de 025 falló (¿tablas de T10?)").toHaveLength(2);
  const f = await h.sql("select id, estado, regla_id, destino_elegido, resuelta_por from regla_candidata where id = any($1::uuid[]) order by id", [ids]);
  expect(f).toHaveLength(2);
  for (const x of f) expect(x).toMatchObject({ estado: "pendiente", regla_id: null, destino_elegido: null, resuelta_por: null });
}

function casosAprendizaje(): Caso[] {
  const exigirSiembra = (): void => expect(falloSiembra025, "la siembra de 025 falló (¿tablas de T10?)").toBeNull();
  /** Escrituras con ids de B: la asistente (sin reglas.gestionar) recibe 403; el Dueño, el 404 de siempre y lo mismo que ante un id inexistente. */
  const verificarEscritura = async (c: Contexto, respuestas: Resp[], referencia: Pet, exactas = respuestas.length): Promise<void> => {
    exigirSiembra();
    const ref = await c.pedir(referencia);
    expect(ref.status, ref.text).toBe(c.yo.rol === "asistente" ? 403 : 404);
    if (c.yo.rol === "asistente") {
      for (const r of respuestas) {
        expect(r.status, r.text).toBe(403);
        expect(r.body).toEqual(PERMISO_DENEGADO);
      }
    } else {
      respuestas.forEach((r, i) => {
        if (i < exactas) {
          expect(r.status, r.text).toBe(404);
          expect(r.body).toEqual(NO_ENCONTRADO);
          expect(r.text).toBe(ref.text);
        } else expect([400, 404], r.text).toContain(r.status); // `todas` con la importación de B
      });
    }
    await candidatasIntactas(c);
    await reglaIntacta(c.ajeno);
    await reglaIntacta(c.mio);
  };
  const lectura = async (c: Contexto, respuestas: Resp[], ruta: (cl: string) => string, propio: (r: Resp) => void): Promise<void> => {
    exigirSiembra();
    // Cliente de otro estudio, no visible o inexistente: el mismo 404, sin revelar cuál es.
    const noExiste = await c.pedir({ ruta: ruta(randomUUID()) });
    expect(noExiste.status).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    mismoNoEncontrado(respuestas, noExiste);
    // Propio y visible: lo suyo y nada de B.
    const mio = await c.pedir({ ruta: ruta(c.mio.clientes[0]) });
    expect(mio.status, mio.text).toBe(200);
    propio(mio);
    for (const marca of [c.ajeno.importacionId!, c.ajeno.candidataId!, c.ajeno.proveedorCandidata!.numero, c.ajeno.proveedorCandidata!.razonSocial])
      expect(mio.text).not.toContain(marca);
    // Propio y no visible (la asistente solo ve su cliente asignado).
    const noVisible = await c.pedir({ ruta: ruta(c.mio.clientes[1]) });
    if (c.yo.rol === "asistente") {
      expect(noVisible.status, noVisible.text).toBe(404);
      expect(noVisible.text).toBe(noExiste.text);
    } else {
      expect(noVisible.status, noVisible.text).toBe(200);
    }
  };

  return [
    {
      ruta: "POST /clientes/:clienteId/reglas/importaciones",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${id}/reglas/importaciones`,
          cuerpo: { periodos: 6, tenantId: c.ajeno.tenantId },
        })),
      extra: async (c, respuestas) => {
        await verificarEscritura(c, respuestas, { metodo: "POST", ruta: `/clientes/${randomUUID()}/reglas/importaciones`, cuerpo: { periodos: 6 } });
        // Ningún trabajo de importación en ninguno de los dos estudios (la instantánea de `job_registro` lo confirma por cliente).
        const n = await h.sql("select count(*)::int n from job_registro where tipo = 'reglas.historial.importar' and cliente_id = any($1::uuid[])", [
          [...c.mio.clientes, ...c.ajeno.clientes],
        ]);
        expect(n[0].n).toBe(0);
      },
    },
    {
      ruta: "GET /clientes/:clienteId/reglas/importaciones/ultima",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/reglas/importaciones/ultima` })),
      extra: async (c, respuestas) =>
        lectura(
          c,
          respuestas,
          (cl) => `/clientes/${cl}/reglas/importaciones/ultima`,
          (r) => {
            // Con cliente propio: la importación sembrada, con su id y sin la de B.
            expect(r.body.importacion?.id).toBe(c.mio.importacionId);
          },
        ),
    },
    {
      ruta: "GET /clientes/:clienteId/reglas/candidatas",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/reglas/candidatas?grupo=propuestas` })),
      extra: async (c, respuestas) =>
        lectura(
          c,
          respuestas,
          (cl) => `/clientes/${cl}/reglas/candidatas?grupo=propuestas`,
          (r) => {
            expect((r.body.candidatas as any[]).map((x) => x.id)).toEqual([c.mio.candidataId]);
          },
        ),
    },
    {
      ruta: "POST /clientes/:clienteId/reglas/candidatas/activar",
      esperado: { dueno: [400, 404], asistente: [403] },
      construir: (c) => [
        ...idsDeCliente(c.ajeno).map((id) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${id}/reglas/candidatas/activar`,
          cuerpo: { items: [{ id: c.ajeno.candidataId }] },
        })),
        // Cliente propio: candidata ajena sola, mezclada con la propia (P0002 a todo: ni la propia se activa) e inexistente.
        { metodo: "POST" as const, ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/activar`, cuerpo: { items: [{ id: c.ajeno.candidataId }] } },
        {
          metodo: "POST" as const,
          ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/activar`,
          cuerpo: { items: [{ id: c.mio.candidataId }, { id: c.ajeno.candidataId }] },
        },
        { metodo: "POST" as const, ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/activar`, cuerpo: { items: [{ id: randomUUID() }] } },
        // `todas` con la importación de B: nunca activa nada (400 o 404; no revela si existe).
        { metodo: "POST" as const, ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/activar`, cuerpo: { todas: true, importacionId: c.ajeno.importacionId } },
        { metodo: "POST" as const, ruta: `/clientes/${c.ajeno.clientes[0]}/reglas/candidatas/activar`, cuerpo: { todas: true, importacionId: c.ajeno.importacionId } },
      ],
      extra: async (c, respuestas) => {
        exigirSiembra();
        // Las de `items` son 404 exactos; solo las dos últimas, de `todas`, admiten 400.
        await verificarEscritura(
          c,
          respuestas,
          { metodo: "POST", ruta: `/clientes/${randomUUID()}/reglas/candidatas/activar`, cuerpo: { items: [{ id: randomUUID() }] } },
          respuestas.length - 2,
        );
        // Con el cliente de B (no existe para quien llama) la importación ajena tampoco se distingue: 404.
        if (c.yo.rol !== "asistente") expect(respuestas[respuestas.length - 1]!.status).toBe(404);
      },
    },
    {
      ruta: "POST /clientes/:clienteId/reglas/candidatas/:candidataId/reemplazar",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        paresDeCandidata(c).map(([cl, cand]) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${cl}/reglas/candidatas/${cand}/reemplazar`,
          cuerpo: { versionRegla: 1, destino: "DG", tenantId: c.ajeno.tenantId },
        })),
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "POST", ruta: `/clientes/${randomUUID()}/reglas/candidatas/${randomUUID()}/reemplazar`, cuerpo: { versionRegla: 1 } }),
    },
    {
      ruta: "POST /clientes/:clienteId/reglas/candidatas/descartar",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) => [
        ...idsDeCliente(c.ajeno).map((id) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${id}/reglas/candidatas/descartar`,
          cuerpo: { ids: [c.ajeno.candidataId], tenantId: c.ajeno.tenantId },
        })),
        { metodo: "POST" as const, ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/descartar`, cuerpo: { ids: [c.ajeno.candidataId] } },
        { metodo: "POST" as const, ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/descartar`, cuerpo: { ids: [c.mio.candidataId, c.ajeno.candidataId] } },
        { metodo: "POST" as const, ruta: `/clientes/${c.mio.clientes[0]}/reglas/candidatas/descartar`, cuerpo: { ids: [randomUUID()] } },
      ],
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "POST", ruta: `/clientes/${randomUUID()}/reglas/candidatas/descartar`, cuerpo: { ids: [randomUUID()] } }),
    },
  ];
}

/* ---------------------------- 026 · prorrata e IGV estimado ----------------------------
 * `/clientes/:clienteId/prorrata*`: leer exige `prorrata.ver` y escribir `prorrata.gestionar` (la asistente solo tiene la primera). Un cliente de B
 * (o cualquier id que no sea un cliente propio visible) desde A: el mismo 404 `no_encontrado` que ante un id inexistente, nunca un dato ni un
 * cambio en B ni en A; la asistente (sin `prorrata.gestionar`) recibe 403 en toda escritura, antes de mirar el cliente. Las cuatro tablas, los
 * trabajos `sol.declaraciones.descargar` y la auditoría de ambos estudios quedan como estaban. */
const TABLAS_PRORRATA = ["prorrata_obtencion", "declaracion_mensual", "prorrata_mes_manual", "prorrata_usada_manual"] as const;
const MES_PRORRATA = "202601";
const cuerpoManualPropio = { gravadas: "10.00", exportaciones: "0.00", noGravadas: "5.00", motivo: "Libro físico", version: 0 };
const PERIODO_PRORRATA = "202610";

/** Cada estudio conserva SU fila sembrada en cada tabla (y ninguna otra) y ninguno tiene trabajos de descarga de declaraciones. */
async function prorrataIntacta(c: Contexto): Promise<void> {
  for (const r of [c.mio, c.ajeno]) {
    for (const t of TABLAS_PRORRATA) {
      const f = await h.sql(`select count(*)::int n from ${t} where cliente_id = any($1::uuid[])`, [r.clientes]);
      expect(f[0].n, `${t} de ${r.nombre}: la siembra de 026 falló o se escribió algo`).toBe(1);
    }
    const j = await h.sql("select count(*)::int n from job_registro where tipo = 'sol.declaraciones.descargar' and cliente_id = any($1::uuid[])", [r.clientes]);
    expect(j[0].n, `trabajos de descarga de ${r.nombre}`).toBe(0);
  }
}

function casosProrrata(): Caso[] {
  const exigirSiembra = (): void => expect(falloSiembra026, "la siembra de 026 falló (¿tablas de T10?)").toBeNull();
  /** Escrituras con el cliente de B: la asistente (sin prorrata.gestionar) recibe 403; el Dueño, el 404 de siempre y lo mismo que ante un id inexistente. */
  const verificarEscritura = async (c: Contexto, respuestas: Resp[], referencia: Pet): Promise<void> => {
    exigirSiembra();
    const ref = await c.pedir(referencia);
    expect(ref.status, ref.text).toBe(c.yo.rol === "asistente" ? 403 : 404);
    for (const r of respuestas) {
      if (c.yo.rol === "asistente") {
        expect(r.status, r.text).toBe(403);
        expect(r.body).toEqual(PERMISO_DENEGADO);
      } else {
        expect(r.status, r.text).toBe(404);
        expect(r.body).toEqual(NO_ENCONTRADO);
        expect(r.text).toBe(ref.text);
      }
    }
    await prorrataIntacta(c);
    await reglaIntacta(c.ajeno);
    await reglaIntacta(c.mio);
  };
  const lecturaProrrata = async (c: Contexto, respuestas: Resp[], ruta: (cl: string) => string, propio: (r: Resp) => void): Promise<void> => {
    exigirSiembra();
    const noExiste = await c.pedir({ ruta: ruta(randomUUID()) });
    expect(noExiste.status).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    mismoNoEncontrado(respuestas, noExiste);
    const mio = await c.pedir({ ruta: ruta(c.mio.clientes[0]) });
    expect(mio.status, mio.text).toBe(200);
    propio(mio);
    const p = c.ajeno.prorrata!;
    for (const marca of [p.obtencionId, p.declaracionId, p.manualId, p.usadaId, p.motivo]) expect(mio.text).not.toContain(marca);
    const noVisible = await c.pedir({ ruta: ruta(c.mio.clientes[1]) });
    if (c.yo.rol === "asistente") {
      expect(noVisible.status, noVisible.text).toBe(404);
      expect(noVisible.text).toBe(noExiste.text);
    } else {
      expect(noVisible.status, noVisible.text).toBe(200);
    }
    await prorrataIntacta(c);
  };
  const cuerpoManual = { gravadas: "10.00", exportaciones: "0.00", noGravadas: "5.00", motivo: "Libro físico", version: 0 };

  return [
    {
      ruta: "GET /clientes/:clienteId/prorrata",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/prorrata?periodo=${PERIODO_PRORRATA}` })),
      extra: (c, respuestas) =>
        lecturaProrrata(
          c,
          respuestas,
          (cl) => `/clientes/${cl}/prorrata?periodo=${PERIODO_PRORRATA}`,
          (r) => {
            // Con cliente propio: su PDT de 202610, su manual de 202601 y su prorrata ingresada; nada de B.
            const mes = (p: string) => (r.body.ventana as any[]).find((m) => m.periodo === p);
            expect(mes(PERIODO_PRORRATA)).toMatchObject({ origen: "declarado", gravadas: "100000.00" });
            expect(mes(MES_PRORRATA)).toMatchObject({ origen: "manual", manual: { motivo: c.mio.prorrata!.motivo } });
            expect(r.body.prorrataUsada).toEqual({ valor: "50.00", origen: "ingresada" });
            expect(r.body.ultimaObtencion?.periodosSinDeclaracion).toEqual(["202511"]);
          },
        ),
    },
    {
      ruta: "GET /clientes/:clienteId/prorrata/meses/:periodo/historial",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/prorrata/meses/${MES_PRORRATA}/historial` })),
      extra: (c, respuestas) =>
        lecturaProrrata(
          c,
          respuestas,
          (cl) => `/clientes/${cl}/prorrata/meses/${MES_PRORRATA}/historial`,
          (r) => {
            expect(r.body.declaraciones).toEqual([]);
            expect((r.body.manual as any[]).map((x) => [x.version, x.motivo])).toEqual([[1, c.mio.prorrata!.motivo]]);
          },
        ),
    },
    {
      ruta: "POST /clientes/:clienteId/prorrata/declaraciones",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ metodo: "POST" as const, ruta: `/clientes/${id}/prorrata/declaraciones`, cuerpo: { periodo: PERIODO_PRORRATA } })),
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "POST", ruta: `/clientes/${randomUUID()}/prorrata/declaraciones`, cuerpo: { periodo: PERIODO_PRORRATA } }),
    },
    {
      ruta: "PUT /clientes/:clienteId/prorrata/meses/:periodo",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ metodo: "PUT" as const, ruta: `/clientes/${id}/prorrata/meses/202602`, cuerpo: cuerpoManual })),
      extra: async (c, respuestas) => {
        await verificarEscritura(c, respuestas, { metodo: "PUT", ruta: `/clientes/${randomUUID()}/prorrata/meses/202602`, cuerpo: cuerpoManual });
        // Con un cliente PROPIO, un cuerpo con ids de B no se acepta: el cliente sale de la ruta, nunca del cuerpo (esquema estricto).
        const r = await c.pedir({
          metodo: "PUT",
          ruta: `/clientes/${c.mio.clientes[0]}/prorrata/meses/202602`,
          cuerpo: { ...cuerpoManual, clienteId: c.ajeno.clientes[0], tenantId: c.ajeno.tenantId },
        });
        expect(r.status, r.text).toBe(c.yo.rol === "asistente" ? 403 : 400);
        await prorrataIntacta(c);
      },
    },
    {
      ruta: "POST /clientes/:clienteId/prorrata/meses/:periodo/eliminar",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({ metodo: "POST" as const, ruta: `/clientes/${id}/prorrata/meses/${MES_PRORRATA}/eliminar`, cuerpo: { motivo: "Quitar", version: 1 } })),
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "POST", ruta: `/clientes/${randomUUID()}/prorrata/meses/${MES_PRORRATA}/eliminar`, cuerpo: { motivo: "Quitar", version: 1 } }),
    },
    {
      ruta: "PUT /clientes/:clienteId/prorrata/usada/:periodo",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({ metodo: "PUT" as const, ruta: `/clientes/${id}/prorrata/usada/${PERIODO_PRORRATA}`, cuerpo: { porcentaje: "50.00", version: 1 } })),
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "PUT", ruta: `/clientes/${randomUUID()}/prorrata/usada/${PERIODO_PRORRATA}`, cuerpo: { porcentaje: "50.00", version: 1 } }),
    },
  ];
}

/* ---------------------------- 027 · gastos no deducibles ----------------------------
 * Diccionario, umbral y globales del estudio (`/estudio/reglas-motor/gastos*`: escribir exige `reglas.gestionar` y alcance global), categorías del cliente
 * y aprender (`/clientes/:clienteId/…/gastos/*`: `reglas.gestionar` y cliente visible), «Volver a evaluar» (`sire.clasificar`) y el diccionario de
 * plataforma (solo super-admin: 403 para todos aquí). Un id de B (palabra, cliente, compra) desde A: el mismo 404 `no_encontrado` que ante un id
 * inexistente; la asistente (sin `reglas.gestionar`) recibe 403 antes de mirar el recurso. Un `tenantId` o `clienteId` en el cuerpo es 400 (esquemas
 * estrictos): el estudio sale de la sesión. Las cinco tablas, los trabajos `compras.reevaluar` y la auditoría de ambos estudios quedan como estaban. */
const PERIODO_GASTOS = "202610";
const RUTA_GASTOS = "/estudio/reglas-motor/gastos";

/** Ni una fila nueva ni una cambiada: cada estudio conserva SU palabra, su umbral, su ajuste, su CIIU y su global desactivada, y no hay trabajos de reevaluar. */
async function gastosIntacto(c: Contexto): Promise<void> {
  for (const r of [c.mio, c.ajeno]) {
    const p = await h.sql("select id, palabra, activa, version::int as version from gnd_palabra_estudio where tenant_id = $1", [r.tenantId]);
    expect(p, `palabras de ${r.nombre}: la siembra de 027 falló o se escribió algo`).toEqual([{ id: r.gastos!.propiaId, palabra: r.gastos!.palabra, activa: true, version: 1 }]);
    const g = await h.sql("select count(*)::int n from gnd_global_desactivada where tenant_id = $1", [r.tenantId]);
    expect(g[0].n, `globales desactivadas de ${r.nombre}`).toBe(1);
    const u = await h.sql("select umbral::int as umbral, version::int as version from gnd_config where tenant_id = $1", [r.tenantId]);
    expect(u, `umbral de ${r.nombre}`).toEqual([{ umbral: 7, version: 1 }]);
    const k = await h.sql("select permitidas, quitadas, version::int as version from gnd_cliente_categorias where tenant_id = $1", [r.tenantId]);
    expect(k, `categorías de ${r.nombre}`).toEqual([{ permitidas: ["juguetes"], quitadas: [], version: 1 }]);
    const j = await h.sql("select count(*)::int n from job_registro where tipo = 'compras.reevaluar' and cliente_id = any($1::uuid[])", [r.clientes]);
    expect(j[0].n, `trabajos de reevaluar de ${r.nombre}`).toBe(0);
    const a = await h.sql("select count(*)::int n from auditoria where tenant_id = $1 and accion like 'gnd.%'", [r.tenantId]);
    expect(a[0].n, `auditoría de 027 de ${r.nombre}`).toBe(0);
  }
}

function casosGastos(): Caso[] {
  const exigirSiembra = (): void => expect(falloSiembra027, "la siembra de 027 falló (¿tablas de T10?)").toBeNull();
  /** Ids de B (y de otras cosas de B) como ids de palabra, de global o de compra: ninguno existe para quien llama. */
  const idsAjenos = (c: Contexto): string[] => [c.ajeno.gastos?.propiaId ?? randomUUID(), c.ajeno.asignacionId, c.ajeno.tenantId, c.ajeno.reglaId, randomUUID()];
  /** Escrituras con ids de B: la asistente (sin reglas.gestionar) recibe 403; el Dueño, el 404 de siempre y lo mismo que ante un id inexistente. */
  const verificarEscritura = async (c: Contexto, respuestas: Resp[], referencia: Pet): Promise<void> => {
    exigirSiembra();
    const ref = await c.pedir(referencia);
    expect(ref.status, ref.text).toBe(c.yo.rol === "asistente" ? 403 : 404);
    for (const r of respuestas) {
      if (c.yo.rol === "asistente") {
        expect(r.status, r.text).toBe(403);
        expect(r.body).toEqual(PERMISO_DENEGADO);
      } else {
        expect(r.status, r.text).toBe(404);
        expect(r.body).toEqual(NO_ENCONTRADO);
        expect(r.text).toBe(ref.text);
      }
    }
    await gastosIntacto(c);
  };
  /** Escrituras con cuerpo ajeno: `tenantId`, `clienteId` o `usuarioId` en el cuerpo (el estudio sale de la sesión): 400 para el Dueño, 403 para la asistente. */
  const verificarCuerpoAjeno = async (c: Contexto, respuestas: Resp[]): Promise<void> => {
    exigirSiembra();
    for (const r of respuestas) {
      if (c.yo.rol === "asistente") {
        expect(r.status, r.text).toBe(403);
        expect(r.body).toEqual(PERMISO_DENEGADO);
      } else {
        expect(r.status, r.text).toBe(400);
        expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      }
    }
    await gastosIntacto(c);
  };
  const lecturaCliente = async (c: Contexto, respuestas: Resp[], ruta: (cl: string) => string, propio: (r: Resp) => void): Promise<void> => {
    exigirSiembra();
    const noExiste = await c.pedir({ ruta: ruta(randomUUID()) });
    expect(noExiste.status).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    mismoNoEncontrado(respuestas, noExiste);
    const mio = await c.pedir({ ruta: ruta(c.mio.clientes[0]) });
    expect(mio.status, mio.text).toBe(200);
    propio(mio);
    const g = c.ajeno.gastos!;
    for (const marca of [g.propiaId, g.palabra, g.ruc]) expect(mio.text).not.toContain(marca);
    const noVisible = await c.pedir({ ruta: ruta(c.mio.clientes[1]) });
    if (c.yo.rol === "asistente") {
      expect(noVisible.status, noVisible.text).toBe(404);
      expect(noVisible.text).toBe(noExiste.text);
    } else {
      expect(noVisible.status, noVisible.text).toBe(200);
    }
    await gastosIntacto(c);
  };
  const PLAT_PALABRA = { categoria: "juguetes", excepciones: [], activa: true, version: 1 };

  return [
    {
      ruta: "GET /estudio/reglas-motor/gastos",
      esperado: todos(200),
      construir: (c) => [{ ruta: RUTA_GASTOS }, { ruta: `${RUTA_GASTOS}?tenantId=${c.ajeno.tenantId}&estudioId=${c.ajeno.tenantId}` }],
      extra: async (c, respuestas) => {
        exigirSiembra();
        for (const r of respuestas) {
          // Solo lo propio: su palabra, su umbral y su global desactivada; nada de B (las marcas de fuga se buscan además en cada respuesta).
          expect(r.body.umbral).toBe(7);
          expect((r.body.propias as any[]).map((p) => p.id)).toEqual([c.mio.gastos!.propiaId]);
          expect((r.body.globales as any[]).find((g) => g.palabra === "polo").desactivadaPorEstudio).toBe(true);
        }
        await gastosIntacto(c);
      },
    },
    {
      ruta: "PUT /estudio/reglas-motor/gastos/umbral",
      esperado: { dueno: [400], asistente: [403] },
      construir: (c) => [
        { metodo: "PUT", ruta: `${RUTA_GASTOS}/umbral`, cuerpo: { umbral: 5, version: 1, tenantId: c.ajeno.tenantId } },
        { metodo: "PUT", ruta: `${RUTA_GASTOS}/umbral?tenantId=${c.ajeno.tenantId}`, cuerpo: { umbral: 5, version: 1, estudioId: c.ajeno.tenantId } },
      ],
      extra: verificarCuerpoAjeno,
    },
    {
      ruta: "POST /estudio/reglas-motor/gastos/palabras",
      esperado: { dueno: [400], asistente: [403] },
      construir: (c) => [
        { metodo: "POST", ruta: `${RUTA_GASTOS}/palabras`, cuerpo: { palabra: `hu40intruso${sufijo}`, categoria: "juguetes", tenantId: c.ajeno.tenantId } },
        { metodo: "POST", ruta: `${RUTA_GASTOS}/palabras?tenantId=${c.ajeno.tenantId}`, cuerpo: { palabra: `hu40intruso${sufijo}`, categoria: "juguetes", usuarioId: c.ajeno.dueno.id } },
      ],
      extra: async (c, respuestas) => {
        await verificarCuerpoAjeno(c, respuestas);
        const f = await h.sql("select count(*)::int n from gnd_palabra_estudio where palabra like $1", [`hu40intruso${sufijo}%`]);
        expect(f[0].n).toBe(0);
      },
    },
    {
      ruta: "PUT /estudio/reglas-motor/gastos/palabras/:id",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) => idsAjenos(c).map((id) => ({ metodo: "PUT" as const, ruta: `${RUTA_GASTOS}/palabras/${id}`, cuerpo: { activa: false, version: 1 } })),
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "PUT", ruta: `${RUTA_GASTOS}/palabras/${randomUUID()}`, cuerpo: { activa: false, version: 1 } }),
    },
    {
      ruta: "PUT /estudio/reglas-motor/gastos/globales/:id",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) => idsAjenos(c).map((id) => ({ metodo: "PUT" as const, ruta: `${RUTA_GASTOS}/globales/${id}`, cuerpo: { activa: false } })),
      extra: (c, respuestas) =>
        verificarEscritura(c, respuestas, { metodo: "PUT", ruta: `${RUTA_GASTOS}/globales/${randomUUID()}`, cuerpo: { activa: false } }),
    },
    {
      ruta: "GET /clientes/:clienteId/gastos/categorias",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/gastos/categorias` })),
      extra: (c, respuestas) =>
        lecturaCliente(c, respuestas, (cl) => `/clientes/${cl}/gastos/categorias`, (r) => expect(r.body).toMatchObject({ permitidas: ["juguetes"], quitadas: [], version: 1 })),
    },
    {
      ruta: "PUT /clientes/:clienteId/gastos/categorias",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({ metodo: "PUT" as const, ruta: `/clientes/${id}/gastos/categorias`, cuerpo: { permitidas: ["calzado-ropa"], quitadas: [], version: 1 } })),
      extra: async (c, respuestas) => {
        await verificarEscritura(c, respuestas, { metodo: "PUT", ruta: `/clientes/${randomUUID()}/gastos/categorias`, cuerpo: { permitidas: ["calzado-ropa"], quitadas: [], version: 1 } });
        // Con un cliente PROPIO, un cuerpo con ids de B no se acepta: el cliente sale de la ruta, nunca del cuerpo (esquema estricto).
        const r = await c.pedir({
          metodo: "PUT",
          ruta: `/clientes/${c.mio.clientes[0]}/gastos/categorias`,
          cuerpo: { permitidas: ["calzado-ropa"], quitadas: [], version: 1, clienteId: c.ajeno.clientes[0], tenantId: c.ajeno.tenantId },
        });
        expect(r.status, r.text).toBe(c.yo.rol === "asistente" ? 403 : 400);
        await gastosIntacto(c);
      },
    },
    {
      ruta: "GET /clientes/:clienteId/periodos/:periodo/gastos/aprender/:compraId",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ ruta: `/clientes/${id}/periodos/${PERIODO_GASTOS}/gastos/aprender/${randomUUID()}` })),
      extra: async (c, respuestas) => {
        exigirSiembra();
        const base = `periodos/${PERIODO_GASTOS}/gastos/aprender`;
        const noExiste = await c.pedir({ ruta: `/clientes/${randomUUID()}/${base}/${randomUUID()}` });
        if (c.yo.rol === "asistente") {
          // Sin `reglas.gestionar`: 403 antes de mirar el cliente o la compra.
          expect(noExiste.status, noExiste.text).toBe(403);
          for (const r of respuestas) expect(r.body).toEqual(PERMISO_DENEGADO);
        } else {
          expect(noExiste.status, noExiste.text).toBe(404);
          expect(noExiste.body).toEqual(NO_ENCONTRADO);
          mismoNoEncontrado(respuestas, noExiste);
          // Un cliente propio con una compra inexistente o de B: el mismo 404.
          for (const compraId of [randomUUID(), c.ajeno.asignacionId, c.ajeno.tenantId]) {
            const r = await c.pedir({ ruta: `/clientes/${c.mio.clientes[0]}/${base}/${compraId}` });
            expect(r.status, r.text).toBe(404);
            expect(r.text).toBe(noExiste.text);
          }
        }
        await gastosIntacto(c);
      },
    },
    {
      ruta: "POST /clientes/:clienteId/periodos/:periodo/gastos/aprender/:compraId",
      esperado: { dueno: [404], asistente: [403] },
      construir: (c) =>
        idsDeCliente(c.ajeno).map((id) => ({
          metodo: "POST" as const,
          ruta: `/clientes/${id}/periodos/${PERIODO_GASTOS}/gastos/aprender/${randomUUID()}`,
          cuerpo: { terminos: [{ termino: "intruso", categoria: "juguetes" }] },
        })),
      extra: async (c, respuestas) => {
        await verificarEscritura(c, respuestas, {
          metodo: "POST",
          ruta: `/clientes/${randomUUID()}/periodos/${PERIODO_GASTOS}/gastos/aprender/${randomUUID()}`,
          cuerpo: { terminos: [{ termino: "intruso", categoria: "juguetes" }] },
        });
        // Un cliente propio con una compra de B y `tenantId` en el cuerpo (esquema estricto): 400 para el Dueño, 403 para la asistente.
        const r = await c.pedir({
          metodo: "POST",
          ruta: `/clientes/${c.mio.clientes[0]}/periodos/${PERIODO_GASTOS}/gastos/aprender/${c.ajeno.asignacionId}`,
          cuerpo: { terminos: [{ termino: "intruso", categoria: "juguetes" }], tenantId: c.ajeno.tenantId },
        });
        expect(r.status, r.text).toBe(c.yo.rol === "asistente" ? 403 : 400);
        await gastosIntacto(c);
      },
    },
    {
      ruta: "POST /clientes/:clienteId/periodos/:periodo/gastos/reevaluar",
      esperado: { dueno: [404], asistente: [404] },
      construir: (c) => idsDeCliente(c.ajeno).map((id) => ({ metodo: "POST" as const, ruta: `/clientes/${id}/periodos/${PERIODO_GASTOS}/gastos/reevaluar`, cuerpo: {} })),
      extra: async (c, respuestas) => {
        exigirSiembra();
        const noExiste = await c.pedir({ metodo: "POST", ruta: `/clientes/${randomUUID()}/periodos/${PERIODO_GASTOS}/gastos/reevaluar`, cuerpo: {} });
        expect(noExiste.status, noExiste.text).toBe(404);
        expect(noExiste.body).toEqual(NO_ENCONTRADO);
        mismoNoEncontrado(respuestas, noExiste);
        // El cliente no visible de la asistente (el segundo) también es el mismo 404; el propio sí se encola (y se quita para no dejar trabajos).
        if (c.yo.rol === "asistente") {
          const noVisible = await c.pedir({ metodo: "POST", ruta: `/clientes/${c.mio.clientes[1]}/periodos/${PERIODO_GASTOS}/gastos/reevaluar`, cuerpo: {} });
          expect(noVisible.status, noVisible.text).toBe(404);
          expect(noVisible.text).toBe(noExiste.text);
        }
        // Un cuerpo con ids de B no se acepta ni encola nada.
        const conCuerpo = await c.pedir({
          metodo: "POST",
          ruta: `/clientes/${c.mio.clientes[0]}/periodos/${PERIODO_GASTOS}/gastos/reevaluar`,
          cuerpo: { clienteId: c.ajeno.clientes[0], tenantId: c.ajeno.tenantId },
        });
        expect(conCuerpo.status, conCuerpo.text).toBe(400);
        await gastosIntacto(c);
      },
    },
    // Diccionario de plataforma: solo el super-admin; ningún usuario de estudio (ni con ids de B) llega a las funciones.
    { ruta: "GET /plataforma/diccionario", esperado: todos(403), construir: () => [{ ruta: "/plataforma/diccionario" }] },
    {
      ruta: "POST /plataforma/diccionario",
      esperado: todos(403),
      construir: (c) => [{ metodo: "POST", ruta: "/plataforma/diccionario", cuerpo: { palabra: `hu40plat${sufijo}`, categoria: "juguetes", tenantId: c.ajeno.tenantId } }],
      extra: async () => {
        expect(await h.sql("select 1 from gnd_palabra_global where palabra like $1", [`hu40plat${sufijo}%`])).toHaveLength(0);
      },
    },
    {
      ruta: "PUT /plataforma/diccionario/:id",
      esperado: todos(403),
      construir: (c) =>
        [c.ajeno.gastos?.propiaId ?? randomUUID(), c.ajeno.tenantId, ...c.ajeno.clientes].map((id) => ({
          metodo: "PUT" as const,
          ruta: `/plataforma/diccionario/${id}`,
          cuerpo: PLAT_PALABRA,
        })),
      extra: async () => {
        const f = await h.sql("select categoria, activa, version::int as version from gnd_palabra_global where palabra = 'zapatilla'");
        expect(f).toEqual([{ categoria: "calzado-ropa", activa: true, version: 1 }]); // la semilla sin tocar
      },
    },
    { ruta: "GET /plataforma/diccionario/historial", esperado: todos(403), construir: () => [{ ruta: "/plataforma/diccionario/historial?limite=10" }] },
  ];
}

/* ---------------------------- 028 · correo: preferencias y baja ----------------------------
 * `GET|PUT /cuenta/correo` (solo estudio: el usuario y el estudio salen de la sesión; un `usuarioId`/`tenantId` en el cuerpo es 400, en la consulta se
 * ignora) y `POST|GET /correo/baja` (públicas: el token es la credencial; el hash almacenado de B no sirve de token, un cuerpo mal formado es 400 y un
 * GET es 405 aun con un token real). Las cuatro tablas de correo y la auditoría de ambos estudios quedan como estaban. */
const BODY_028 = { buzonCritico: false, credencialInvalida: true, planLimite: true, resumen: true, todosClientes: false };
/** Lo que ve cada usuario sembrado en `etiqueta` (la asistente es responsable de un cliente: sin «todos»; solo el Dueño tiene un envío fallido). */
const vistaSembrada = (etiqueta: "A" | "B", rol: "dueno" | "asistente") => {
  const v = PREFS_028[etiqueta][rol];
  return {
    buzonCritico: v.buzon,
    credencialInvalida: v.cred,
    planLimite: v.plan,
    resumen: v.resumen,
    todosClientes: false,
    todosDisponible: rol === "dueno",
    todosIgnorado: false,
    invitacionResumen: false,
    ultimoEnvioFallido: rol === "dueno" ? expect.any(String) : null,
  };
};
const etiquetaDe = (r: Recursos): "A" | "B" => (r.tenantId === A.tenantId ? "A" : "B");

function casosCorreo(): Caso[] {
  const exigirSiembra = (): void => expect(falloSiembra028, "la siembra de 028 falló (¿tablas de T10?)").toBeNull();
  const tokenInventado = (): string => randomBytes(32).toString("base64url");
  return [
    {
      ruta: "GET /cuenta/correo",
      esperado: { dueno: [200, 400], asistente: [200, 400] },
      construir: (c) => {
        exigirSiembra();
        return [{ ruta: "/cuenta/correo" }, { ruta: `/cuenta/correo?usuarioId=${c.ajeno.dueno.id}&tenantId=${c.ajeno.tenantId}` }];
      },
      extra: async (c, respuestas) => {
        // La vista es la del usuario de la sesión en su estudio (su valor sembrado, distinto del de B), con o sin ids ajenos en la consulta.
        const esperada = vistaSembrada(etiquetaDe(c.mio), c.yo.rol);
        expect(respuestas[0]!.status, respuestas[0]!.text).toBe(200);
        expect(respuestas[0]!.body).toEqual(esperada);
        if (respuestas[1]!.status === 200) expect(respuestas[1]!.body).toEqual(esperada);
        expect(esperada).not.toEqual(vistaSembrada(etiquetaDe(c.ajeno), c.yo.rol)); // la prueba no es vacía: lo de B se distingue
      },
    },
    {
      ruta: "PUT /cuenta/correo",
      esperado: todos(400),
      construir: (c) => {
        exigirSiembra();
        return [
          { metodo: "PUT", ruta: "/cuenta/correo", cuerpo: { ...BODY_028, tenantId: c.ajeno.tenantId } },
          { metodo: "PUT", ruta: "/cuenta/correo", cuerpo: { ...BODY_028, usuarioId: c.ajeno.dueno.id } },
          { metodo: "PUT", ruta: "/cuenta/correo", cuerpo: { ...BODY_028, usuarioId: c.ajeno.asistente.id, tenantId: c.ajeno.tenantId } },
        ];
      },
      extra: async (c, respuestas) => {
        for (const r of respuestas) expect(r.body).toEqual({ codigo: "solicitud_invalida" });
        // Lo propio tampoco cambió (la instantánea del final lo exige también): sigue lo sembrado.
        const v = await c.pedir({ ruta: "/cuenta/correo" });
        expect(v.body).toEqual(vistaSembrada(etiquetaDe(c.mio), c.yo.rol));
      },
    },
    {
      ruta: "POST /correo/baja",
      publica: true,
      esperado: todos(200, 400),
      construir: (c) => {
        exigirSiembra();
        const k = c.ajeno.correo!;
        return [
          { metodo: "POST", ruta: "/correo/baja", cuerpo: { token: k.hashB64 } }, // el hash almacenado no es el token
          { metodo: "POST", ruta: "/correo/baja", cuerpo: { token: tokenInventado() } },
          { metodo: "POST", ruta: "/correo/baja", cuerpo: { token: k.hashHex } }, // 64 caracteres: no cumple el esquema
          { metodo: "POST", ruta: "/correo/baja", cuerpo: { token: k.token, usuarioId: c.mio.dueno.id, tenantId: c.mio.tenantId } }, // clave extra: 400
        ];
      },
      extra: async (c, respuestas) => {
        expect(respuestas.map((r) => r.status)).toEqual([200, 200, 400, 400]);
        expect(respuestas[0]!.text).toBe("{}");
        expect(respuestas[0]!.text).toBe(respuestas[1]!.text);
        // Control: B conserva su token y su preferencia de resumen activa (la instantánea del final lo exige además).
        const filas = await h.sql("select count(*)::int n from correo_baja_token where tenant_id = $1", [c.ajeno.tenantId]);
        expect(filas[0].n).toBe(1);
      },
    },
    {
      ruta: "GET /correo/baja",
      publica: true,
      esperado: todos(405),
      construir: (c) => {
        exigirSiembra();
        const t = c.ajeno.correo!.token;
        return [{ ruta: "/correo/baja" }, { ruta: `/correo/baja?t=${t}` }, { ruta: `/correo/baja?t=${t}&List-Unsubscribe=One-Click` }];
      },
    },
  ];
}

/** 029 (T7): sesión del otro estudio con la que se intenta `POST /auth/sesiones/:id/revocar` (se fija en `antes`). */
let sesionAjena029: { id: string; revocadaEn: Date | null } = { id: "", revocadaEn: null };

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
  /* ---------- 029 (T7): cuenta segura. Todo es de la cuenta propia; nada alcanza al otro estudio ni a sus sesiones. ---------- */
  {
    ruta: "GET /auth/sesiones",
    esperado: todos(200),
    construir: () => [{ ruta: "/auth/sesiones" }],
    extra: async (c, [r]) => {
      const ajenas = await h.sql("select id from auth.sesion where usuario_id = any($1::uuid[])", [[c.ajeno.dueno.id, c.ajeno.asistente.id]]);
      const ids = new Set(lista(r!).map((x) => x.id));
      expect(ajenas.filter((f) => ids.has(f.id))).toEqual([]);
    },
  },
  {
    ruta: "POST /auth/sesiones/:id/revocar",
    esperado: todos(204),
    antes: async (c) => {
      const [f] = await h.sql(
        "select id, revocada_en from auth.sesion where usuario_id = $1 order by creada_en desc limit 1",
        [c.ajeno.dueno.id],
      );
      sesionAjena029 = f === undefined ? { id: randomUUID(), revocadaEn: null } : { id: f.id, revocadaEn: f.revocada_en };
    },
    construir: () => [{ metodo: "POST", ruta: `/auth/sesiones/${sesionAjena029.id}/revocar` }],
    extra: async () => {
      const [f] = await h.sql("select revocada_en from auth.sesion where id = $1", [sesionAjena029.id]);
      expect(f?.revocada_en ?? null).toEqual(sesionAjena029.revocadaEn);
    },
  },
  {
    ruta: "POST /auth/sesiones/revocar-otras",
    esperado: todos(204),
    construir: () => [{ metodo: "POST", ruta: "/auth/sesiones/revocar-otras" }],
  },
  {
    ruta: "POST /auth/2fa/verificar",
    // La sesión del atacante no es `pendiente`: no hay segundo paso que hacer (ni ajeno).
    esperado: todos(401),
    construir: () => [
      { ruta: "/auth/2fa/verificar", cuerpo: { codigo: "123456" } },
      { ruta: "/auth/2fa/verificar", cuerpo: { codigoRecuperacion: "AAAA-AAAA-AAAA" } },
    ],
  },
  {
    ruta: "POST /auth/totp/enrolar",
    esperado: todos(401),
    construir: (c) => [{ ruta: "/auth/totp/enrolar", cuerpo: { contrasena: c.ajeno.dueno.contrasena + "-mala", usuarioId: c.ajeno.dueno.id } }],
    despues: async (c) => h.reiniciarIntentos(c.yo.correo),
  },
  {
    ruta: "POST /auth/totp/confirmar",
    esperado: todos(401),
    construir: () => [{ ruta: "/auth/totp/confirmar", cuerpo: { codigo: "123456" } }],
    despues: async (c) => h.reiniciarIntentos(c.yo.correo),
  },
  {
    ruta: "POST /auth/totp/desactivar",
    esperado: todos(401),
    construir: () => [{ ruta: "/auth/totp/desactivar", cuerpo: { contrasena: contrasenaMala, codigo: "123456" } }],
    despues: async (c) => h.reiniciarIntentos(c.yo.correo),
  },
  {
    ruta: "POST /auth/totp/recuperacion",
    esperado: todos(401),
    construir: () => [{ ruta: "/auth/totp/recuperacion", cuerpo: { contrasena: contrasenaMala, codigo: "123456" } }],
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
      // 024 (D-9): indicador `buzon` y filtro «con mensajes nuevos»; la query de B no cambia el alcance ni los conteos.
      { ruta: "/clientes?conMensajesNuevos=1" },
      { ruta: `/clientes?conMensajesNuevos=1&tenantId=${c.ajeno.tenantId}&q=${encodeURIComponent("HU40")}` },
      { ruta: "/clientes?conMensajesNuevos=1&archivados=1" },
    ],
    extra: async (c, respuestas) => {
      const [todos, conTenant, conFiltro, conFiltroYTenant, conArchivados] = respuestas as [Resp, Resp, Resp, Resp, Resp];
      const deB = new Set<string>(c.ajeno.clientes);
      for (const r of [todos, conTenant]) {
        for (const f of lista(r)) {
          expect(deB.has(f.id), `cliente ${f.id} es del otro estudio`).toBe(false);
          expect(f.buzon, `${f.razonSocial} sin indicador`).toEqual({ nuevos: expect.any(Number), criticosNuevos: expect.any(Number) });
        }
      }
      // El cliente con el mensaje sembrado (pendiente, no crítico, de hace un día) cuenta uno; nada de B suma.
      const conMensaje = lista(todos).find((f) => f.id === c.mio.clientes[0]);
      expect(conMensaje, "falta el cliente propio con mensaje").toBeDefined();
      expect(conMensaje.buzon).toEqual({ nuevos: 1, criticosNuevos: 0 });
      for (const r of [conFiltro, conFiltroYTenant, conArchivados]) {
        expect(r.status, r.text).toBe(200);
        expect(lista(r).map((f) => f.id)).toEqual([c.mio.clientes[0]]);
        expect(lista(r)[0].buzon).toEqual({ nuevos: 1, criticosNuevos: 0 });
      }
    },
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

  /* ---------- 021: reglas aprendidas y reglas del motor ---------- */
  ...casosReglas(),

  /* ---------- 023: buzón SOL del cliente ---------- */
  ...casosBuzon(),

  /* ---------- 025: aprendizaje del historial ---------- */
  ...casosAprendizaje(),

  /* ---------- 026: prorrata e IGV estimado ---------- */
  ...casosProrrata(),

  /* ---------- 027: gastos no deducibles ---------- */
  ...casosGastos(),

  /* ---------- 028: correo (preferencias y baja) ---------- */
  ...casosCorreo(),
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
  // 025: si las tablas de T10 aún no existen la siembra falla y solo fallan los casos nuevos (los demás no la necesitan).
  try {
    await sembrarAprendizaje(A, "A");
    await sembrarAprendizaje(B, "B");
  } catch (e) {
    falloSiembra025 = e instanceof Error ? e.message : String(e);
  }
  // 026: igual, con las tablas de la prorrata (T10); antes de los marcadores: sus ids y el motivo del manual son marcas de fuga.
  try {
    await sembrarProrrata(A, "A");
    await sembrarProrrata(B, "B");
  } catch (e) {
    falloSiembra026 = e instanceof Error ? e.message : String(e);
  }
  // 027: igual, con las cinco tablas de gastos no deducibles (T10); antes de los marcadores: sus ids, la palabra y el RUC son marcas de fuga.
  try {
    await sembrarGastos(A, "A");
    await sembrarGastos(B, "B");
  } catch (e) {
    falloSiembra027 = e instanceof Error ? e.message : String(e);
  }
  // 028: igual, con las preferencias, el envío fallido y el token de baja (T10); antes de los marcadores: el id del envío y el token son marcas de fuga.
  try {
    await sembrarCorreo(A, "A");
    await sembrarCorreo(B, "B");
  } catch (e) {
    falloSiembra028 = e instanceof Error ? e.message : String(e);
  }
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
  // 028: las cuatro tablas de correo de los dos estudios del seed y su auditoría (solo cede en modo `replica`), antes que las membresías y los clientes.
  await borrarCorreoDeEstudios(h.sql, [A.tenantId, B.tenantId]);
  const auditoriaCorreo = await h
    .sql("select id from auditoria where tenant_id = any($1::uuid[]) and accion = 'correo.preferencia_cambiada'", [[A.tenantId, B.tenantId]])
    .catch(() => [] as { id: string }[]);
  await borrarPorId("auditoria", auditoriaCorreo.map((f) => f.id));
  // 027: las cinco tablas del estudio (escritas solo por funciones; el superusuario de la conexión de migraciones puede borrar), antes que los clientes.
  for (const t of ["gnd_palabra_estudio", "gnd_global_desactivada", "gnd_config", "gnd_cliente_categorias", "gnd_ciiu"])
    await h.sql(`delete from ${t} where tenant_id = any($1::uuid[])`, [[A.tenantId, B.tenantId]]).catch(() => undefined);
  await h.sql("delete from job_registro where tipo = 'compras.reevaluar' and cliente_id = any($1::uuid[])", [clientesCreados]).catch(() => undefined);
  // 026: tablas de solo inserción (el superusuario de la conexión de migraciones puede borrar); de la hija a la madre, antes que los clientes.
  for (const t of ["declaracion_mensual", "prorrata_mes_manual", "prorrata_usada_manual", "prorrata_obtencion"])
    await h.sql(`delete from ${t} where cliente_id = any($1::uuid[])`, [clientesCreados]).catch(() => undefined);
  // 025: las candidatas apuntan a importaciones y a reglas; todas van antes que las reglas y los clientes.
  await h.sql("delete from regla_candidata where cliente_id = any($1::uuid[])", [clientesCreados]).catch(() => undefined);
  await h.sql("delete from regla_importacion where cliente_id = any($1::uuid[])", [clientesCreados]).catch(() => undefined);
  await h.sql("delete from regla_aprendida where id = any($1::uuid[])", [reglasSembradas]).catch(() => undefined);
  // 023: el adjunto referencia al mensaje y este al cliente: van antes que los clientes.
  await h.sql("delete from buzon_adjunto where mensaje_id = any($1::uuid[])", [mensajesBuzonSembrados]).catch(() => undefined);
  await h.sql("delete from buzon_mensaje where id = any($1::uuid[])", [mensajesBuzonSembrados]).catch(() => undefined);
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

describe("HU-40 por API · 025 · las pruebas no son vacías (importación y candidata propias)", () => {
  it("cada estudio ve su importación y su candidata en su primer cliente y nunca las del otro; la asistente las lee y no las escribe", async () => {
    expect(falloSiembra025, "la siembra de 025 falló (¿tablas de T10?)").toBeNull();
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const pedir = (s: Sesion, ruta: string, o: { metodo?: Peticion["metodo"]; cuerpo?: unknown } = {}) =>
        h.pedir({ ruta, cookie: s.cookie, csrf: s.csrf, estudio: mio.tenantId, ...o });
      const ultima = await pedir(d, `/clientes/${mio.clientes[0]}/reglas/importaciones/ultima`);
      expect(ultima.status, ultima.text).toBe(200);
      expect(ultima.body.importacion).toMatchObject({ id: mio.importacionId, estado: "completada" });
      expect(ultima.text).not.toContain(ajeno.importacionId!);
      const cands = await pedir(d, `/clientes/${mio.clientes[0]}/reglas/candidatas?grupo=propuestas`);
      expect(cands.status, cands.text).toBe(200);
      expect((cands.body.candidatas as any[]).map((x) => x.id)).toEqual([mio.candidataId]);
      expect(cands.body.candidatas[0].proveedor).toEqual({ tipo: "6", numero: mio.proveedorCandidata!.numero, razonSocial: mio.proveedorCandidata!.razonSocial });
      expect(cands.text).not.toContain(ajeno.candidataId!);
      expect(cands.text).not.toContain(ajeno.proveedorCandidata!.numero);

      const a = await abrirSesion(mio.asistente, mio.tenantId);
      expect((await pedir(a, `/clientes/${mio.clientes[0]}/reglas/candidatas?grupo=propuestas`)).status).toBe(200);
      const escribe = await pedir(a, `/clientes/${mio.clientes[0]}/reglas/candidatas/activar`, { metodo: "POST", cuerpo: { items: [{ id: mio.candidataId }] } });
      expect(escribe.status, escribe.text).toBe(403);
    }
  });
});

describe("HU-40 por API · 026 · las pruebas no son vacías (prorrata propia)", () => {
  it("cada estudio ve el PDT, el manual y la prorrata de su primer cliente y nunca los del otro; la asistente los lee y no escribe", async () => {
    expect(falloSiembra026, "la siembra de 026 falló (¿tablas de T10?)").toBeNull();
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const pedir = (s: Sesion, ruta: string, o: { metodo?: Peticion["metodo"]; cuerpo?: unknown } = {}) =>
        h.pedir({ ruta, cookie: s.cookie, csrf: s.csrf, estudio: mio.tenantId, ...o });
      const vista = await pedir(d, `/clientes/${mio.clientes[0]}/prorrata?periodo=${PERIODO_PRORRATA}`);
      expect(vista.status, vista.text).toBe(200);
      expect((vista.body.ventana as any[]).find((m) => m.periodo === MES_PRORRATA)).toMatchObject({ origen: "manual", manual: { motivo: mio.prorrata!.motivo } });
      expect(vista.body.prorrataUsada).toEqual({ valor: "50.00", origen: "ingresada" });
      expect(vista.text).not.toContain(ajeno.prorrata!.motivo);
      expect(vista.text).not.toContain(ajeno.prorrata!.manualId);
      const historial = await pedir(d, `/clientes/${mio.clientes[0]}/prorrata/meses/${MES_PRORRATA}/historial`);
      expect(historial.status, historial.text).toBe(200);
      expect(historial.text).not.toContain(ajeno.prorrata!.motivo);

      const a = await abrirSesion(mio.asistente, mio.tenantId);
      expect((await pedir(a, `/clientes/${mio.clientes[0]}/prorrata?periodo=${PERIODO_PRORRATA}`)).status).toBe(200);
      const escribe = await pedir(a, `/clientes/${mio.clientes[0]}/prorrata/meses/202602`, { metodo: "PUT", cuerpo: cuerpoManualPropio });
      expect(escribe.status, escribe.text).toBe(403);
    }
  });
});

describe("HU-40 por API · 027 · las pruebas no son vacías (gastos no deducibles propios)", () => {
  it("cada estudio ve su palabra, su umbral, su ajuste de categorías y su global desactivada y nunca los del otro; la asistente los lee y no escribe", async () => {
    expect(falloSiembra027, "la siembra de 027 falló (¿tablas de T10?)").toBeNull();
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const pedir = (s: Sesion, ruta: string, o: { metodo?: Peticion["metodo"]; cuerpo?: unknown } = {}) =>
        h.pedir({ ruta, cookie: s.cookie, csrf: s.csrf, estudio: mio.tenantId, ...o });
      const vista = await pedir(d, RUTA_GASTOS);
      expect(vista.status, vista.text).toBe(200);
      expect(vista.body.umbral).toBe(7);
      expect((vista.body.propias as any[]).map((p) => [p.id, p.palabra])).toEqual([[mio.gastos!.propiaId, mio.gastos!.palabra]]);
      expect((vista.body.globales as any[]).find((g) => g.palabra === "polo").desactivadaPorEstudio).toBe(true);
      for (const marca of [ajeno.gastos!.propiaId, ajeno.gastos!.palabra]) expect(vista.text).not.toContain(marca);
      const cat = await pedir(d, `/clientes/${mio.clientes[0]}/gastos/categorias`);
      expect(cat.status, cat.text).toBe(200);
      expect(cat.body).toMatchObject({ permitidas: ["juguetes"], quitadas: [], version: 1 });

      const a = await abrirSesion(mio.asistente, mio.tenantId);
      expect((await pedir(a, RUTA_GASTOS)).status).toBe(200);
      const escribe = await pedir(a, `${RUTA_GASTOS}/umbral`, { metodo: "PUT", cuerpo: { umbral: 5, version: 1 } });
      expect(escribe.status, escribe.text).toBe(403);
    }
  });
});

describe("HU-40 por API · 028 · las pruebas no son vacías (preferencias y baja propias)", () => {
  it("cada estudio ve SUS preferencias y su fallo y nunca las del otro; el PUT propio responde 200; GET /correo/baja no apaga y el POST con el token propio sí", async () => {
    expect(falloSiembra028, "la siembra de 028 falló (¿tablas de T10?)").toBeNull();
    for (const [mio, ajeno] of [
      [A, B],
      [B, A],
    ] as const) {
      const e = etiquetaDe(mio);
      const pedir = (s: Sesion, ruta: string, o: { metodo?: Peticion["metodo"]; cuerpo?: unknown } = {}) =>
        h.pedir({ ruta, cookie: s.cookie, csrf: s.csrf, estudio: mio.tenantId, ...o });
      const d = await abrirSesion(mio.dueno, mio.tenantId);
      const a = await abrirSesion(mio.asistente, mio.tenantId);
      for (const [rol, s] of [
        ["dueno", d],
        ["asistente", a],
      ] as const) {
        const v = await pedir(s, "/cuenta/correo");
        expect(v.status, v.text).toBe(200);
        expect(v.body, `${mio.nombre} ${rol}`).toEqual(vistaSembrada(e, rol));
        expect(v.body).not.toEqual(vistaSembrada(etiquetaDe(ajeno), rol));
        expect(v.text).not.toContain(ajeno.correo!.envioId);
      }
      // PUT propio con los mismos valores: 200 y la misma vista (nada cambia, nada se audita).
      const mismos = { buzonCritico: PREFS_028[e].dueno.buzon, credencialInvalida: PREFS_028[e].dueno.cred, planLimite: PREFS_028[e].dueno.plan, resumen: true, todosClientes: false };
      const put = await pedir(d, "/cuenta/correo", { metodo: "PUT", cuerpo: mismos });
      expect(put.status, put.text).toBe(200);
      expect(put.body).toEqual(vistaSembrada(e, "dueno"));
      // GET con el token propio: 405 y el resumen sigue activo; el POST con ese token lo apaga SOLO al Dueño de este estudio.
      const get = await h.pedir({ ruta: `/correo/baja?t=${mio.correo!.token}` });
      expect(get.status, get.text).toBe(405);
      expect((await pedir(d, "/cuenta/correo")).body.resumen).toBe(true);
      try {
        const baja = await h.pedir({ metodo: "POST", ruta: "/correo/baja", cuerpo: { token: mio.correo!.token } });
        expect(baja.status, baja.text).toBe(200);
        expect((await pedir(d, "/cuenta/correo")).body).toEqual({ ...vistaSembrada(e, "dueno"), resumen: false });
        expect((await pedir(a, "/cuenta/correo")).body).toEqual(vistaSembrada(e, "asistente")); // la asistente no
        const ajenoDueno = await abrirSesion(ajeno.dueno, ajeno.tenantId);
        expect((await h.pedir({ ruta: "/cuenta/correo", cookie: ajenoDueno.cookie, csrf: ajenoDueno.csrf, estudio: ajeno.tenantId })).body.resumen).toBe(true);
        const auditoria = await h.sql("select datos from auditoria where tenant_id = $1 and accion = 'correo.preferencia_cambiada'", [mio.tenantId]);
        expect(auditoria.map((f) => f.datos)).toEqual([{ tipo: "resumen", de: true, a: false, origen: "enlace" }]);
      } finally {
        // Restaura lo sembrado para los casos que siguen (la auditoría solo cede en modo `replica`).
        await h.sql("update correo_preferencia set activo = true where tenant_id = $1 and usuario_id = $2 and tipo = 'resumen'", [mio.tenantId, mio.dueno.id]);
        const filas = await h.sql("select id from auditoria where tenant_id = $1 and accion = 'correo.preferencia_cambiada'", [mio.tenantId]);
        await borrarPorId("auditoria", filas.map((f) => f.id));
      }
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
