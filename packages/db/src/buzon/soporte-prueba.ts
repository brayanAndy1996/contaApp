// Soporte de las pruebas de BD de la spec 024 (T3, rojo): estudio sembrado con clientes, asignaciones y mensajes, oráculo en
// memoria de la bandeja y del indicador, y un contador de consultas. No es una prueba (sin sufijo .spec) ni código de producción
// (queda fuera de `tsconfig.build.json`). Necesita las variables DATABASE_URL (contapp_app, para `withTenant` como contapp_backend)
// y MIGRATIONS_DATABASE_URL (superusuario, para sembrar y limpiar); si faltan, la suite FALLA: no se salta.
//
// La siembra usa el superusuario y, para el estado de atención y la marca de histórico, `UPDATE` directo de las columnas
// `historico`, `atendido_en` y `atendido_por` de `buzon_mensaje` (0059): el superusuario puede, los roles de la app no. El
// historial (`buzon_atencion`) se siembra solo en las pruebas del detalle, con INSERT del superusuario.
//
// Fechas: viajan como texto UTC con microsegundos (`AAAA-MM-DDTHH:MI:SS.UUUUUUZ`), igual que `fechaTexto` de la fila de la
// bandeja, así el oráculo ordena por texto y las pruebas de cursor no pasan por `Date` (que pierde los microsegundos).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDb, type ContappDb, type Tx } from "../client";

export const CATEGORIAS = [
  "coactiva",
  "resolucion_determinacion",
  "resolucion_multa",
  "requerimiento_fiscalizacion",
  "otro",
] as const;

export type Alcance =
  { tipo: "global" } | { tipo: "asignado"; usuarioId: string };
export type FiltroAtencion =
  "pendientes" | "atendidos" | "historicos" | "todos";
export type EstadoAtencion = "pendiente" | "atendido" | "historico";

/** Filtros de `listarBandeja` (el contrato que fijan las pruebas; ver bandeja.spec.ts). */
export interface FiltrosBandeja {
  clienteId?: string;
  responsableId?: string;
  categoria?: string;
  leido?: boolean;
  atencion?: FiltroAtencion;
  desde?: string;
  hasta?: string;
  archivados?: boolean;
}

export interface UsuarioSembrado {
  id: string;
  nombre: string;
}

export interface ClienteSembrado {
  id: string;
  idx: number;
  razonSocial: string;
  archivado: boolean;
  responsableId: string | null;
  /** Usuarios con cualquier asignación (responsable o colaborador). */
  asignados: Set<string>;
}

export interface MensajeSembrado {
  id: string;
  clienteId: string;
  asunto: string;
  remitente: string;
  /** Texto UTC con microsegundos. */
  fecha: string;
  categoria: string;
  critico: boolean;
  motivo: string | null;
  leido: boolean;
  historico: boolean;
  atendidoPor: string | null;
  /** Texto UTC con milisegundos. */
  atendidoEn: string | null;
}

export interface Bordes {
  /** Lima 09 a las 23:59:59.999999 (04:59:59.999999Z del 10). */
  limaDia09Fin: string;
  /** Lima 10 a las 00:00:00 (05:00:00Z del 10). */
  limaDia10Inicio: string;
  /** Lima 10 a las 23:30 (04:30:00Z del 11). */
  limaDia10Noche: string;
  /** Lima 10 a las 23:59:59.999999 (04:59:59.999999Z del 11). */
  limaDia10Fin: string;
  /** Lima 11 a las 00:00:00 (05:00:00Z del 11). */
  limaDia11Inicio: string;
}

export interface Estudio {
  tenantId: string;
  dueno: UsuarioSembrado;
  contador: UsuarioSembrado;
  clientes: ClienteSembrado[];
  mensajes: MensajeSembrado[];
  /** Mensajes de borde de los días de Lima, todos del cliente `clientes[1]` (visible al contador, no archivado). */
  bordes: Bordes;
  limpiar(): Promise<void>;
}

const VARIABLES = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const;

/** Falla (no salta) si faltan las URLs de la BD. */
export function exigirEntorno(): void {
  const faltan = VARIABLES.filter((v) => !process.env[v]);
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno para las pruebas de BD de la bandeja: ${faltan.join(", ")}`,
    );
  }
}

export function abrirAdmin(): Pool {
  const p = new Pool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL,
    max: 4,
  });
  p.on("error", () => undefined);
  return p;
}

/** Pool de la app como contapp_backend (el rol que usa el backend). */
export function abrirBackend(): ContappDb {
  return createDb({ rolApp: "contapp_backend", poolMax: 4 });
}

// ---- Generador determinista --------------------------------------------------------------------------------------------
function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Instantes de la rejilla: muchas filas comparten fecha al microsegundo, y hay pares que difieren solo en el microsegundo. */
export const TIEMPOS = [
  "2026-10-28T13:00:00.000000Z",
  "2026-11-02T09:15:30.500000Z",
  "2026-11-05T22:00:00.000001Z",
  "2026-11-05T22:00:00.000002Z",
  "2026-11-09T16:45:10.250000Z",
  "2026-11-10T15:30:00.123456Z",
  "2026-11-10T15:30:00.123457Z",
  "2026-11-12T15:30:00.123456Z",
  "2026-11-13T12:00:00.000000Z",
  "2026-11-15T07:20:00.000000Z",
  "2026-11-16T21:10:05.000000Z",
  "2026-11-17T03:00:00.000000Z",
  "2026-11-18T10:00:00.000000Z",
  "2026-11-19T18:30:00.999999Z",
] as const;

const BORDES: Bordes = {
  limaDia09Fin: "2026-11-10T04:59:59.999999Z",
  limaDia10Inicio: "2026-11-10T05:00:00.000000Z",
  limaDia10Noche: "2026-11-11T04:30:00.000000Z",
  limaDia10Fin: "2026-11-11T04:59:59.999999Z",
  limaDia11Inicio: "2026-11-11T05:00:00.000000Z",
};

/** Fecha aleatoria con microsegundos entre el 20-oct y el 19-nov de 2026. */
function fechaAleatoria(r: () => number): string {
  const base = Date.UTC(2026, 9, 20) + Math.floor(r() * 30 * 86_400_000);
  const micro = String(Math.floor(r() * 1_000_000)).padStart(6, "0");
  return `${new Date(base).toISOString().slice(0, 19)}.${micro}Z`;
}

/** Día de Lima (UTC-5, sin horario de verano) de un texto UTC. */
export function diaLima(fechaUtc: string): string {
  return new Date(new Date(fechaUtc).getTime() - 5 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

export const estadoDe = (m: MensajeSembrado): EstadoAtencion =>
  m.atendidoEn !== null ? "atendido" : m.historico ? "historico" : "pendiente";

export const esNuevo = (m: MensajeSembrado): boolean =>
  m.atendidoEn === null && !m.historico;

export interface OpcionesEstudio {
  clientes?: number;
  semilla?: number;
}

/**
 * Estudio nuevo con usuarios Dueño y Contador, `clientes` clientes y sus mensajes:
 *  - archivados los de índice múltiplo de 9; el Contador está asignado a los 15 primeros (responsable los pares, colaborador los
 *    impares; incluye dos archivados); el Dueño es responsable de los de índice ≥ 15 con idx % 4 = 3 y de los idx 3 y 9;
 *  - 0 a 10 mensajes por cliente, con las cinco categorías, leídos o no, y los estados pendiente, atendido, histórico y atendido
 *    + histórico; los clientes idx % 13 = 5 no tienen pendientes y los idx % 11 = 4 solo críticos pendientes;
 *  - mensajes de borde de los días de Lima en `clientes[1]` y un grupo con la misma fecha al microsegundo.
 */
export async function sembrarEstudio(
  admin: Pool,
  o: OpcionesEstudio = {},
): Promise<Estudio> {
  const total = o.clientes ?? 120;
  const r = mulberry32(o.semilla ?? 1);
  const marca = randomBytes(3).toString("hex");
  const prefijo = String(parseInt(marca, 16) % 100000).padStart(5, "0");
  const tenantId = randomUUID();
  const dueno: UsuarioSembrado = {
    id: randomUUID(),
    nombre: `Dueno T3 ${marca}`,
  };
  const contador: UsuarioSembrado = {
    id: randomUUID(),
    nombre: `Contador T3 ${marca}`,
  };
  const usuarios = [dueno.id, contador.id];

  const limpiar = async (): Promise<void> => {
    const c = await admin.connect();
    try {
      // Sin disparadores (triggers de inmutabilidad y del último dueño); cada paso tolera que falte una tabla.
      await c.query("SET session_replication_role = replica");
      const pasos = [
        "delete from notificacion where tenant_id = $1",
        "delete from plan_aviso where tenant_id = $1",
        "delete from auditoria where tenant_id = $1",
        "delete from buzon_atencion where tenant_id = $1",
        "delete from buzon_adjunto where tenant_id = $1",
        "delete from buzon_mensaje where tenant_id = $1",
        "delete from buzon_estado_cliente where tenant_id = $1",
        "delete from asignacion where tenant_id = $1",
        "delete from membresia where tenant_id = $1",
        "delete from cliente where tenant_id = $1",
        "delete from suscripcion where tenant_id = $1",
      ];
      for (const sql of pasos)
        await c.query(sql, [tenantId]).catch(() => undefined);
      await c
        .query("delete from usuario where id = any($1::uuid[])", [usuarios])
        .catch(() => undefined);
      await c
        .query("delete from tenant where id = $1", [tenantId])
        .catch(() => undefined);
    } finally {
      c.release(true); // la conexión con session_replication_role = replica no vuelve al pool
    }
  };

  try {
    await admin.query("insert into tenant (id, nombre) values ($1, $2)", [
      tenantId,
      `Estudio T3 ${marca}`,
    ]);
    for (const [u, rol] of [
      [dueno, "dueno"],
      [contador, "contador"],
    ] as const) {
      await admin.query(
        "insert into usuario (id, email, nombre) values ($1, $2, $3)",
        [u.id, `t3-${marca}-${rol}@ejemplo.test`, u.nombre],
      );
      await admin.query(
        "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)",
        [tenantId, u.id, rol],
      );
    }

    // Clientes y asignaciones.
    const clientes: ClienteSembrado[] = [];
    for (let idx = 0; idx < total; idx++) {
      const enContador = idx < 15;
      let responsableId: string | null = null;
      if (enContador && idx % 2 === 0) responsableId = contador.id;
      else if ((idx >= 15 && idx % 4 === 3) || idx === 3 || idx === 9)
        responsableId = dueno.id;
      const asignados = new Set<string>();
      if (enContador) asignados.add(contador.id);
      if (responsableId !== null) asignados.add(responsableId);
      clientes.push({
        id: randomUUID(),
        idx,
        razonSocial: `Cliente T3 ${marca}-${String(idx).padStart(3, "0")}`,
        archivado: idx % 9 === 0,
        responsableId,
        asignados,
      });
    }
    await admin.query(
      `insert into cliente (id, tenant_id, ruc, razon_social, archivado_at)
       select x.id, $1, '3' || $2 || lpad(x.idx::text, 5, '0'), x.razon, case when x.arch then now() else null end
         from jsonb_to_recordset($3::jsonb) as x(id uuid, idx int, razon text, arch boolean)`,
      [
        tenantId,
        prefijo,
        JSON.stringify(
          clientes.map((c) => ({
            id: c.id,
            idx: c.idx,
            razon: c.razonSocial,
            arch: c.archivado,
          })),
        ),
      ],
    );
    const asignaciones: Array<{ c: string; u: string; t: string }> = [];
    for (const c of clientes) {
      if (c.responsableId !== null)
        asignaciones.push({ c: c.id, u: c.responsableId, t: "responsable" });
      if (c.idx < 15 && c.responsableId !== contador.id)
        asignaciones.push({ c: c.id, u: contador.id, t: "colaborador" });
    }
    await admin.query(
      `insert into asignacion (tenant_id, cliente_id, usuario_id, tipo)
       select $1, x.c, x.u, x.t from jsonb_to_recordset($2::jsonb) as x(c uuid, u uuid, t text)`,
      [tenantId, JSON.stringify(asignaciones)],
    );

    // Mensajes.
    const mensajes: MensajeSembrado[] = [];
    const nuevo = (
      c: ClienteSembrado,
      p: Partial<MensajeSembrado> = {},
    ): MensajeSembrado => {
      const categoria = p.categoria ?? CATEGORIAS[Math.floor(r() * 5)]!;
      const critico = p.critico ?? (categoria !== "otro" || r() < 0.12);
      const m: MensajeSembrado = {
        id: randomUUID(),
        clienteId: c.id,
        asunto: `Asunto ${mensajes.length}`,
        remitente: "SUNAT",
        fecha:
          r() < 0.5
            ? TIEMPOS[Math.floor(r() * TIEMPOS.length)]!
            : fechaAleatoria(r),
        categoria,
        critico,
        motivo: critico ? (categoria === "otro" ? "duda" : "codigo") : null,
        leido: r() < 0.4,
        historico: false,
        atendidoPor: null,
        atendidoEn: null,
        ...p,
      };
      mensajes.push(m);
      return m;
    };
    const estado = (m: MensajeSembrado, e: number): void => {
      // e en [0,1): 45 % pendiente, 25 % atendido, 18 % histórico, 12 % atendido + histórico.
      if (e >= 0.45) {
        if (e < 0.7 || e >= 0.88) {
          m.atendidoPor = r() < 0.5 ? dueno.id : contador.id;
          m.atendidoEn = new Date(
            Date.UTC(2026, 10, 18, 12, 0, 0) + mensajes.length * 60_000,
          ).toISOString();
        }
        if (e >= 0.7) m.historico = true;
      }
    };
    for (const c of clientes) {
      let cuantos = (c.idx * 7) % 11;
      if (c.idx % 10 === 7) cuantos = 0;
      const sinPendientes = c.idx % 13 === 5;
      const soloCriticos = c.idx % 11 === 4;
      if ((sinPendientes || soloCriticos) && cuantos < 2) cuantos = 2;
      for (let k = 0; k < cuantos; k++) {
        if (soloCriticos) {
          nuevo(c, { categoria: "coactiva", critico: true, motivo: "codigo" });
          continue;
        }
        const m = nuevo(c);
        estado(m, sinPendientes ? 0.45 + r() * 0.55 : r());
      }
    }
    // Bordes de los días de Lima: pendientes, no críticos, no leídos, en `clientes[1]`.
    const cb = clientes[1]!;
    const borde = (fecha: string): string =>
      nuevo(cb, {
        fecha,
        categoria: "otro",
        critico: false,
        motivo: null,
        leido: false,
      }).id;
    const bordes: Bordes = {
      limaDia09Fin: borde(BORDES.limaDia09Fin),
      limaDia10Inicio: borde(BORDES.limaDia10Inicio),
      limaDia10Noche: borde(BORDES.limaDia10Noche),
      limaDia10Fin: borde(BORDES.limaDia10Fin),
      limaDia11Inicio: borde(BORDES.limaDia11Inicio),
    };
    // Doce mensajes con exactamente la misma fecha al microsegundo en clientes distintos (más tres del Contador).
    const empate = "2026-11-12T15:30:00.123456Z";
    for (const idx of [2, 4, 6, 20, 21, 22, 23, 24, 25, 26, 27, 28]) {
      const c = clientes[idx];
      if (c !== undefined)
        nuevo(c, {
          fecha: empate,
          categoria: "otro",
          critico: false,
          motivo: null,
        });
    }

    const filas = mensajes.map((m) => ({
      id: m.id,
      c: m.clienteId,
      s: `T3-${m.id}`,
      a: m.asunto,
      rm: m.remitente,
      f: m.fecha,
      cat: m.categoria,
      cr: m.critico,
      mo: m.motivo,
      av: m.critico,
      le: m.leido,
    }));
    await admin.query(
      `insert into buzon_mensaje
          (id, tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico, version_catalogo,
           avisado, leido_sunat)
       select x.id, $1, x.c, x.s, x.a, x.rm, x.f::timestamptz, x.cat, x.cr, x.mo, 1, x.av, x.le
         from jsonb_to_recordset($2::jsonb)
           as x(id uuid, c uuid, s text, a text, rm text, f text, cat text, cr boolean, mo text, av boolean, le boolean)`,
      [tenantId, JSON.stringify(filas)],
    );
    // Todas las filas (no solo las marcadas): el trigger de 0059 fija `historico` al insertar según el reloj (D-12, también para el
    // superusuario), así que la siembra impone el estado del modelo en cada mensaje.
    const estados = mensajes
      .map((m) => ({
        id: m.id,
        h: m.historico,
        ae: m.atendidoEn,
        ap: m.atendidoPor,
      }));
    if (estados.length > 0) {
      await admin.query(
        `update buzon_mensaje m
            set historico = x.h, atendido_en = x.ae::timestamptz, atendido_por = x.ap
           from jsonb_to_recordset($1::jsonb) as x(id uuid, h boolean, ae text, ap uuid)
          where m.id = x.id and m.tenant_id = $2`,
        [JSON.stringify(estados), tenantId],
      );
    }

    return { tenantId, dueno, contador, clientes, mensajes, bordes, limpiar };
  } catch (e) {
    // Una siembra a medias (p. ej. falta la migración 0059) no deja filas huérfanas.
    await limpiar();
    throw e;
  }
}

// ---- Oráculo -----------------------------------------------------------------------------------------------------------
/** Orden de la bandeja: fecha descendente e id descendente (la fecha es texto de ancho fijo; el uuid se ordena como texto). */
export const porBandeja = (a: MensajeSembrado, b: MensajeSembrado): number =>
  a.fecha !== b.fecha
    ? a.fecha < b.fecha
      ? 1
      : -1
    : a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0;

function clienteVisible(c: ClienteSembrado, a: Alcance): boolean {
  return a.tipo === "global" || c.asignados.has(a.usuarioId);
}

/**
 * Lo que debe devolver la bandeja completa (todas las páginas) para el alcance y los filtros, en su orden. Reglas (spec 024):
 *  - D-2: solo clientes visibles; sin `archivados` salen los archivados, salvo con `clienteId` (bandeja fijada);
 *    `responsableId` deja los clientes de los que esa persona es responsable;
 *  - D-3/D-12: `pendientes` = sin atender y no histórico; `atendidos` = atendidos; `historicos` = histórico sin atender;
 *    `todos` = todos; `categoria: "criticos"` = `critico`; `desde`/`hasta` son días de Lima, inclusive.
 */
export function oraculoBandeja(
  e: Estudio,
  a: Alcance,
  f: FiltrosBandeja = {},
): MensajeSembrado[] {
  const clientes = new Map(
    e.clientes
      .filter((c) => {
        if (!clienteVisible(c, a)) return false;
        if (f.clienteId !== undefined) return c.id === f.clienteId;
        if (c.archivado && f.archivados !== true) return false;
        if (
          f.responsableId !== undefined &&
          c.responsableId !== f.responsableId
        )
          return false;
        return true;
      })
      .map((c) => [c.id, c] as const),
  );
  return e.mensajes
    .filter((m) => {
      if (!clientes.has(m.clienteId)) return false;
      if (
        f.categoria === "criticos"
          ? !m.critico
          : f.categoria !== undefined && m.categoria !== f.categoria
      )
        return false;
      if (f.leido !== undefined && m.leido !== f.leido) return false;
      const est = estadoDe(m);
      switch (f.atencion ?? "todos") {
        case "pendientes":
          if (est !== "pendiente") return false;
          break;
        case "atendidos":
          if (est !== "atendido") return false;
          break;
        case "historicos":
          if (est !== "historico") return false;
          break;
        default:
      }
      const dia = diaLima(m.fecha);
      if (f.desde !== undefined && dia < f.desde) return false;
      if (f.hasta !== undefined && dia > f.hasta) return false;
      return true;
    })
    .sort(porBandeja);
}

/** Pendientes y críticos pendientes por cliente, de todos los clientes del estudio (con 0 si no tiene). */
export function oraculoIndicador(
  e: Estudio,
): Map<string, { nuevos: number; criticosNuevos: number }> {
  const r = new Map<string, { nuevos: number; criticosNuevos: number }>(
    e.clientes.map((c) => [c.id, { nuevos: 0, criticosNuevos: 0 }]),
  );
  for (const m of e.mensajes) {
    if (!esNuevo(m)) continue;
    const x = r.get(m.clienteId)!;
    x.nuevos++;
    if (m.critico) x.criticosNuevos++;
  }
  return r;
}

// ---- Mutaciones del estudio (BD y modelo a la vez) --------------------------------------------------------------------------
/** Marca como atendidos (UPDATE directo del superusuario; no pasa por la función acotada) y actualiza el modelo. */
export async function atenderDirecto(
  admin: Pool,
  e: Estudio,
  ids: string[],
  por: string,
  en = "2026-11-19T20:00:00.000Z",
): Promise<void> {
  if (ids.length === 0) return;
  await admin.query(
    "update buzon_mensaje set atendido_en = $3::timestamptz, atendido_por = $4 where tenant_id = $1 and id = any($2::uuid[])",
    [e.tenantId, ids, en, por],
  );
  const set = new Set(ids);
  for (const m of e.mensajes)
    if (set.has(m.id)) {
      m.atendidoEn = en;
      m.atendidoPor = por;
    }
}

/** Devuelve a pendiente (sin atender; la marca de histórico no cambia) y actualiza el modelo. */
export async function desatenderDirecto(
  admin: Pool,
  e: Estudio,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await admin.query(
    "update buzon_mensaje set atendido_en = null, atendido_por = null where tenant_id = $1 and id = any($2::uuid[])",
    [e.tenantId, ids],
  );
  const set = new Set(ids);
  for (const m of e.mensajes)
    if (set.has(m.id)) {
      m.atendidoEn = null;
      m.atendidoPor = null;
    }
}

/** Quita la asignación de `usuarioId` al cliente (superusuario) y actualiza el modelo. */
export async function desasignarDirecto(
  admin: Pool,
  e: Estudio,
  clienteId: string,
  usuarioId: string,
): Promise<void> {
  await admin.query(
    "delete from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3",
    [e.tenantId, clienteId, usuarioId],
  );
  const c = e.clientes.find((x) => x.id === clienteId)!;
  c.asignados.delete(usuarioId);
  if (c.responsableId === usuarioId) c.responsableId = null;
}

// ---- Contador de consultas ---------------------------------------------------------------------------------------------------
/** Envuelve la `tx` de withTenant y cuenta cuántas sentencias se envían (para «una sola consulta para N clientes»). */
export function contarConsultas(tx: Tx): { tx: Tx; consultas: () => number } {
  let n = 0;
  const envuelta = {
    query: (texto: string, valores?: unknown[]) => {
      n++;
      return tx.query(texto, valores);
    },
    get orm() {
      return tx.orm;
    },
  } as Tx;
  return { tx: envuelta, consultas: () => n };
}
