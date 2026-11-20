// Soporte de las pruebas del worker de la spec 023 (T5): captura (`sol.buzon.revisar`), apertura (`sol.buzon.abrir`) y programador
// (`buzon.programar`). No es código de producción ni una prueba. Usa la BD y Redis reales de las demás pruebas de integración.
//
// CONTRATO DEL WORKER QUE FIJAN ESTAS PRUEBAS (lo implementa T12; plan 023, Contratos: Programador y Worker):
// - `DepsTrabajos` gana `solPortal?: SolPortal` (por defecto `MockSolPortal`). `iniciarTrabajos` registra `sol.buzon.revisar` y
//   `sol.buzon.abrir` junto a los demás procesadores que descifran (solo si hay KEK), con `storage`, `logger` y `notificador` de
//   las deps. Cada procesador descifra UNA vez por trabajo (servicio auditado de 003) y NO tiene transacción abierta mientras
//   corre el puerto (008 D6).
// - `apps/worker/src/trabajos/procesadores/programar-buzon.ts` exporta `programarBuzon(deps): () => Promise<ResultadoCicloBuzon>`:
//     deps = { db: Pick<ContappDb, "withSistema" | "withTenant">, redis, prefijo?, logger?, dueno?: string }
//     `dueno` por omisión = uuid aleatorio de ESA instancia. Cada llamada del resultado es un tick: intenta tomar el ciclo
//     (`sistema.buzon_ciclo_tomar`) y, si lo toma, recorre los estudios (`sistema.estudios_buzon`, `buzon_candidatos`,
//     `seleccionarVencidos`, `encolar_buzon_programados`), publica lo encolado (pista y evento), renueva el candado tras cada estudio
//     y lo suelta en `finally`. Nunca lanza por un fallo de un estudio. Resultado:
//     ResultadoCicloBuzon = { tomado: boolean; estudios: number; encolados: number; perdioCandado: boolean }
//     (`tomado: false` = otro tiene el ciclo o aún no toca el intervalo: sin efectos). El log solo lleva tenant_id, conteos y códigos.
// - `iniciarTrabajos`: el caso `buzon.programar` de `procesarSistema` ejecuta un tick de ese programador; y llama a
//   `programarBuzon()` de la cola de sistema salvo que `process.env.BUZON_PROGRAMADOR === "off"` (se lee al arrancar).
// - Resultados (solo conteos, D-10): revisar = { nuevos, criticos, avisados, actualizados, pendientes: boolean };
//   abrir = { adjuntos, omitidos, marcoLeido: boolean }.
// - Descifrado auditado: UNA fila de `auditoria_descifrado` (resultado `ok`) por trabajo.
// - Un `ErrorCredencial` a mitad de la captura deja guardado lo ya confirmado y el `cursor_pendiente` de la página que falló,
//   para que la captura siguiente continúe sin huecos (P-4, CA-7); la invalidación y el aviso son los del ejecutor de 008.
//
// El portal de estas pruebas es un doble en memoria (`PortalControlado`), no `MockSolPortal`: así el rojo es del worker y no del mock.
/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas en pruebas */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import {
  ErrorCredencial,
  ErrorTransitorio,
  type AdjuntoSol,
  type CredencialSol,
  type MensajeSol,
  type PaginaMensajesSol,
  type SolPortal,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import { AlmacenEspia } from "./xml.js";
import {
  compuerta,
  encolarYPublicar,
  Escenario,
  type ClientePrueba,
} from "./trabajos.js";

export type { ClientePrueba };
export const MiB = 1024 * 1024;
export const TOPE_ADJUNTO = 20 * MiB;
export const TOPE_MENSAJE = 50 * MiB;
export const DIA_MS = 86_400_000;

export const sha256 = (b: Uint8Array | string): Buffer =>
  createHash("sha256").update(b).digest();

// ---------------------------------------------------------------------------------------------------------------
// Buzón de prueba
// ---------------------------------------------------------------------------------------------------------------

export interface MsgPrueba {
  idSunat: string;
  asunto: string;
  /** ISO con zona. */
  fecha: string;
  remitente?: string;
  codigoTipo?: string | null;
  leido?: boolean;
  /** Adjuntos declarados en el listado. */
  adjuntos?: { idSunat: string; nombre: string }[];
  /** Lo que devuelve `obtenerMensaje` (por omisión, texto vacío y sin adjuntos). */
  contenido?: { formato: "texto" | "html"; cuerpo: string };
  adjuntosBytes?: AdjuntoSol[];
}

/** ISO de hace `dias` días (con decimales). */
export const hace = (dias: number): string =>
  new Date(Date.now() - dias * DIA_MS).toISOString();

export const idMsg = (i: number): string => `M-${String(i).padStart(6, "0")}`;

/** Asuntos críticos de las cuatro categorías (código de categoría de `shared` -> asunto). */
export const ASUNTO_CRITICO = {
  coactiva: "Notificación de Resolución Coactiva - inicio de ejecución",
  resolucion_determinacion: "Resolución de Determinación N° 012-003-0001234",
  resolucion_multa: "Resolución de Multa N° 012-002-0000456",
  requerimiento_fiscalizacion: "Requerimiento de Fiscalización - Carta 26",
} as const;
export type CategoriaCriticaPrueba = keyof typeof ASUNTO_CRITICO;

export function critico(
  id: string,
  categoria: CategoriaCriticaPrueba,
  haceDias: number,
  extra: Partial<MsgPrueba> = {},
): MsgPrueba {
  return {
    idSunat: id,
    asunto: ASUNTO_CRITICO[categoria],
    fecha: hace(haceDias),
    ...extra,
  };
}

export function comun(
  id: string,
  haceDias: number,
  extra: Partial<MsgPrueba> = {},
): MsgPrueba {
  return {
    idSunat: id,
    asunto: `Boletín informativo ${id}`,
    fecha: hace(haceDias),
    ...extra,
  };
}

/** `n` comunes con ids `M-000001..M-n` (el id mayor es el más reciente, un minuto de diferencia). */
export function comunes(n: number, desde = 1): MsgPrueba[] {
  const ahora = Date.now();
  return Array.from({ length: n }, (_, k) => {
    const i = desde + k;
    return {
      idSunat: idMsg(i),
      asunto: `Boletín informativo ${i}`,
      fecha: new Date(
        ahora - (n - k + 1) * 60_000 - desde * 1000,
      ).toISOString(),
    };
  });
}

/** Buzón de 12 mensajes: coactiva (3 días), RD (10), RM (45), requerimiento (5) y ocho comunes. */
export function buzonBase(): MsgPrueba[] {
  return [
    critico("C-COAC", "coactiva", 3),
    critico("C-RD", "resolucion_determinacion", 10),
    critico("C-RM", "resolucion_multa", 45),
    critico("C-REQ", "requerimiento_fiscalizacion", 5),
    ...Array.from({ length: 8 }, (_, k) => comun(`C-OTRO-${k + 1}`, 1 + k * 2)),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Portal controlado (doble de `SolPortal`)
// ---------------------------------------------------------------------------------------------------------------

type ModoFalla = "credencial" | "transitorio" | "error";

export interface OpcionesPortal {
  /** Tope de mensajes por página, sea cual sea el `limite` pedido (por omisión 100). */
  pagina?: number;
}

/**
 * Doble de `SolPortal` con las mismas observables que `MockSolPortal` (`llamadasListar`, `llamadasObtener`, `leidosMarcados`),
 * paginación por desplazamiento, fallos programables (`fallar`), pausa dentro de la llamada y lo que recibió (credenciales,
 * topes, transacciones abiertas del worker en cada llamada). `obtenerMensaje` marca leído (`marcaLeido: true`) por omisión.
 */
export class PortalControlado implements SolPortal {
  private readonly buzones = new Map<string, MsgPrueba[]>();
  private readonly cuentas = { listar: 0, obtener: 0, desdeArmado: 0 };
  private readonly porId = new Map<string, number>();
  private falla: {
    modo: ModoFalla;
    despuesDe: number;
    veces: number;
    error?: Error;
  } | null = null;
  private puerta: ReturnType<typeof compuerta> | null = null;
  private enPausa = 0;
  readonly credenciales: CredencialSol[] = [];
  readonly topes: { maxBytesAdjunto: number; maxBytesMensaje: number }[] = [];
  readonly marcados: { ruc: string; idSunat: string }[] = [];
  /** Transacciones del worker abiertas en el instante de cada llamada (se conecta con `ProcesoWorker.dbEstado`). */
  readonly txEnLlamada: number[] = [];
  contarTx: () => number = () => 0;
  /** Mensajes entregados en llamadas a `listarMensajes` que NO fallaron. */
  entregados = 0;
  /** Si abrir un mensaje lo marca leído en SUNAT (RF-126). */
  marcaLeidoAlAbrir = true;
  private readonly tamanoPagina: number;

  constructor(o: OpcionesPortal = {}) {
    this.tamanoPagina = o.pagina ?? 100;
  }

  /** Fija el buzón de un RUC (se sirve de lo reciente a lo antiguo: fecha desc, id desc). */
  buzon(ruc: string, mensajes: MsgPrueba[]): this {
    this.buzones.set(
      ruc,
      [...mensajes].sort(
        (a, b) =>
          Date.parse(b.fecha) - Date.parse(a.fecha) ||
          (a.idSunat < b.idSunat ? 1 : -1),
      ),
    );
    return this;
  }

  /** Agrega mensajes a un buzón ya fijado. */
  agregar(ruc: string, mensajes: MsgPrueba[]): this {
    return this.buzon(ruc, [...(this.buzones.get(ruc) ?? []), ...mensajes]);
  }

  /** Alguien (SUNAT, otro usuario) lee el mensaje fuera del sistema. */
  marcarLeidoExterno(ruc: string, idSunat: string): void {
    const m = this.buzones.get(ruc)?.find((x) => x.idSunat === idSunat);
    if (m) m.leido = true;
  }

  /** Las llamadas siguientes (listar y obtener) fallan: pasan `despuesDe`, fallan `veces` y luego se recupera. */
  fallar(
    modo: ModoFalla | null,
    o: { despuesDe?: number; veces?: number; error?: Error } = {},
  ): void {
    this.cuentas.desdeArmado = 0;
    this.falla =
      modo === null
        ? null
        : {
            modo,
            despuesDe: o.despuesDe ?? 0,
            veces: o.veces ?? Number.POSITIVE_INFINITY,
            ...(o.error ? { error: o.error } : {}),
          };
  }

  pausar(): void {
    this.puerta = compuerta();
  }
  abrir(): void {
    this.puerta?.abrir();
    this.puerta = null;
  }
  /** Llamadas que están esperando dentro de la pausa. */
  enEspera(): number {
    return this.enPausa;
  }

  leidosMarcados(): readonly { ruc: string; idSunat: string }[] {
    return this.marcados;
  }
  llamadasListar(): number {
    return this.cuentas.listar;
  }
  llamadasObtener(): number {
    return this.cuentas.obtener;
  }
  llamadasObtenerDe(idSunat: string): number {
    return this.porId.get(idSunat) ?? 0;
  }

  private async entrar(): Promise<void> {
    this.txEnLlamada.push(this.contarTx());
    if (this.puerta) {
      this.enPausa += 1;
      try {
        await this.puerta.esperar();
      } finally {
        this.enPausa -= 1;
      }
    }
    const n = this.cuentas.desdeArmado++;
    const f = this.falla;
    if (f && n >= f.despuesDe && n < f.despuesDe + f.veces) {
      if (f.modo === "credencial") throw new ErrorCredencial();
      if (f.modo === "transitorio") throw new ErrorTransitorio();
      throw f.error ?? new Error("falla del portal de la prueba");
    }
  }

  async listarMensajes(
    c: CredencialSol,
    o: { cursor: string | null; limite: number },
  ): Promise<PaginaMensajesSol> {
    this.cuentas.listar += 1;
    this.credenciales.push({ ...c });
    await this.entrar();
    const todos = this.buzones.get(c.ruc) ?? [];
    const desde = o.cursor === null ? 0 : Number(o.cursor.replace(/^c/, ""));
    const n = Math.min(o.limite, this.tamanoPagina);
    const pagina = todos.slice(desde, desde + n);
    this.entregados += pagina.length;
    return {
      mensajes: pagina.map((m) => ({
        idSunat: m.idSunat,
        asunto: m.asunto,
        remitente: m.remitente ?? "SUNAT",
        fecha: m.fecha,
        codigoTipo: m.codigoTipo ?? null,
        leidoEnSunat: m.leido ?? false,
        adjuntos: [...(m.adjuntos ?? [])],
      })),
      siguiente: desde + n < todos.length ? `c${desde + n}` : null,
    };
  }

  async obtenerMensaje(
    c: CredencialSol,
    idSunat: string,
    o: { maxBytesAdjunto: number; maxBytesMensaje: number },
  ): Promise<MensajeSol> {
    this.cuentas.obtener += 1;
    this.porId.set(idSunat, (this.porId.get(idSunat) ?? 0) + 1);
    this.credenciales.push({ ...c });
    this.topes.push({ ...o });
    await this.entrar();
    const m = (this.buzones.get(c.ruc) ?? []).find(
      (x) => x.idSunat === idSunat,
    );
    if (!m) throw new Error("mensaje inexistente en la prueba");
    if (this.marcaLeidoAlAbrir) {
      m.leido = true;
      this.marcados.push({ ruc: c.ruc, idSunat });
    }
    return {
      idSunat,
      contenido: m.contenido ?? { formato: "texto", cuerpo: "" },
      adjuntos: [...(m.adjuntosBytes ?? [])],
      marcaLeido: this.marcaLeidoAlAbrir,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Storage con fallos programables
// ---------------------------------------------------------------------------------------------------------------

/** `AlmacenEspia` que falla en el n-ésimo `guardar` (1 = el primero) si se le pide. */
export class AlmacenControlado extends AlmacenEspia {
  private contador = 0;
  private fallaEn: number | null = null;
  fallarEnGuardado(n: number | null): void {
    this.contador = 0;
    this.fallaEn = n;
  }
  override async guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    this.contador += 1;
    if (this.fallaEn !== null && this.contador === this.fallaEn) {
      this.intentosGuardar.push(ruta);
      throw new Error("el almacenamiento falló en la prueba");
    }
    return super.guardar(ruta, bytes);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Escenario: estudios con plan, clientes con credencial SOL, ciclos
// ---------------------------------------------------------------------------------------------------------------

export type EstadoCred =
  "configurada" | "verificada" | "invalida" | "solo_sire" | null;

export class EscenarioBuzon extends Escenario {
  private readonly planes: string[] = [];

  async plan(frecuenciaMin = 1440): Promise<string> {
    const codigo = `w023_${randomBytes(5).toString("hex")}`;
    const r = await this.admin.pool.query(
      `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra,
                         max_rucs_extra, frecuencia_buzon_min, features, activo)
       values ($1, $2, '10.00', null, 100000, 1000, '1.00', 0, $3, '{}'::jsonb, true) returning id`,
      [codigo, `Plan ${codigo}`, frecuenciaMin],
    );
    this.planes.push(codigo);
    return r.rows[0].id as string;
  }

  /** Estudio con suscripción (por omisión `activa`, plan de 1440 min); `estado: null` = sin suscripción. */
  async estudioConSub(
    o: {
      estado?: "activa" | "prueba" | null;
      /** Intervalo SQL desde ahora (`'-1 day'` = prueba vencida). */
      venceEn?: string | null;
      frecuenciaMin?: number;
    } = {},
  ): Promise<string> {
    const T = await this.estudio();
    if (o.estado !== null) {
      const estado = o.estado ?? "activa";
      const vence =
        o.venceEn === undefined
          ? estado === "prueba"
            ? "14 days"
            : null
          : o.venceEn;
      await this.admin.pool.query(
        `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
         values ($1, $2, $3, case when $4::interval is null then null else now() + $4::interval end, 0)`,
        [T, await this.plan(o.frecuenciaMin ?? 1440), estado, vence],
      );
    }
    return T;
  }

  /** Cliente con credencial SOL sintética en el estado dado (por omisión `configurada`), archivado o no. */
  async clienteBuzon(
    T: string,
    o: { cred?: EstadoCred; archivado?: boolean } = {},
  ): Promise<ClientePrueba> {
    const c = await this.cliente(T);
    const cred = o.cred === undefined ? "configurada" : o.cred;
    if (cred !== null) {
      await this.credencial(T, c.id, cred === "solo_sire" ? "sire_api" : "sol");
      if (cred === "verificada" || cred === "invalida") {
        await this.admin.pool.query(
          "update credencial set estado = $3 where tenant_id = $1 and cliente_id = $2 and tipo = 'sol'",
          [T, c.id, cred],
        );
      }
    }
    if (o.archivado)
      await this.admin.pool.query(
        "update cliente set archivado_at = now() where id = $1",
        [c.id],
      );
    return c;
  }

  /** `n` clientes con credencial SOL `configurada` en una sola sentencia (estudios grandes). Devuelve sus ids. */
  async clientesMasivos(T: string, n: number): Promise<string[]> {
    const r = await this.admin.pool.query(
      `insert into cliente (tenant_id, ruc, razon_social)
       select $1, '2' || lpad(g::text, 9, '0') || '0', 'Cliente masivo ' || g from generate_series(1, $2::int) g
       returning id`,
      [T, n],
    );
    const ids = (r.rows as { id: string }[]).map((f) => f.id);
    await this.admin.pool.query(
      `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
       select $1, c.id, 'sol', decode(repeat('ab', 64), 'hex'), decode(repeat('cd', 12), 'hex'),
              decode(repeat('ef', 16), 'hex'), decode(repeat('01', 512), 'hex'), 'k1', 1
         from cliente c where c.tenant_id = $1`,
      [T],
    );
    return ids;
  }

  override async limpiar(): Promise<void> {
    await limpiarBuzon(this.admin, this.estudios, this.planes);
    await super.limpiar();
  }
}

/** Borra las filas de buzón, suscripciones y planes propios de los estudios (modo replica, conexión descartable). */
export async function limpiarBuzon(
  admin: ContappDb,
  estudios: string[],
  planes: string[] = [],
): Promise<void> {
  if (estudios.length === 0) return;
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const sql of [
      "delete from buzon_adjunto where tenant_id = any($1::uuid[])",
      "delete from buzon_mensaje where tenant_id = any($1::uuid[])",
      "delete from buzon_estado_cliente where tenant_id = any($1::uuid[])",
      "delete from suscripcion where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
    if (planes.length > 0)
      await c
        .query("delete from plan where codigo = any($1::text[])", [planes])
        .catch(() => undefined);
  } catch {
    // limpieza de mejor esfuerzo
  } finally {
    c.release(true);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Encolado como lo hace el backend
// ---------------------------------------------------------------------------------------------------------------

export interface Mundo {
  T: string;
  /** Responsable del cliente (contador). */
  u: string;
  c: ClientePrueba;
}

export async function encolarRevisar(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: Pick<Mundo, "T" | "u" | "c">,
  prioridad: "interactivo" | "programado" = "interactivo",
): Promise<string> {
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: "sol.buzon.revisar",
    clienteId: m.c.id,
    parametros: {},
    prioridad,
    creadoPor: m.u,
  });
  return r.trabajo.id;
}

export async function encolarAbrir(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: Pick<Mundo, "T" | "u" | "c">,
  mensajeId: string,
): Promise<{ id: string; nuevo: boolean }> {
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: "sol.buzon.abrir",
    clienteId: m.c.id,
    parametros: { mensajeId },
    prioridad: "interactivo",
    creadoPor: m.u,
  });
  return { id: r.trabajo.id, nuevo: r.nuevo };
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas con el rol administrativo
// ---------------------------------------------------------------------------------------------------------------

export interface FilaMensaje {
  id: string;
  id_sunat: string;
  asunto: string;
  categoria: string;
  critico: boolean;
  motivo_critico: string | null;
  version_catalogo: number;
  avisado: boolean;
  leido_sunat: boolean;
  primera_captura_en: Date;
  ultima_captura_en: Date;
  adjuntos_declarados: number;
  contenido_ruta: string | null;
  contenido_bytes: number | null;
  contenido_obtenido_en: Date | null;
}

export async function mensajesDe(
  admin: ContappDb,
  clienteId: string,
): Promise<FilaMensaje[]> {
  const r = await admin.pool.query(
    "select * from buzon_mensaje where cliente_id = $1 order by id_sunat",
    [clienteId],
  );
  return r.rows as FilaMensaje[];
}

export async function mensajeDe(
  admin: ContappDb,
  clienteId: string,
  idSunat: string,
): Promise<FilaMensaje> {
  const r = await admin.pool.query(
    "select * from buzon_mensaje where cliente_id = $1 and id_sunat = $2",
    [clienteId, idSunat],
  );
  return r.rows[0] as FilaMensaje;
}

export interface FilaAdjunto {
  id: string;
  id_sunat: string;
  nombre: string;
  mime: string | null;
  tamano: number | null;
  sha256: Buffer | null;
  ruta: string | null;
  omitido: string | null;
}

export async function adjuntosDe(
  admin: ContappDb,
  mensajeId: string,
): Promise<FilaAdjunto[]> {
  const r = await admin.pool.query(
    `select id, id_sunat, nombre, mime, tamano::int as tamano, sha256, ruta, omitido
       from buzon_adjunto where mensaje_id = $1 order by id_sunat`,
    [mensajeId],
  );
  return r.rows as FilaAdjunto[];
}

export async function estadoDeCaptura(
  admin: ContappDb,
  clienteId: string,
): Promise<
  | {
      ultima_captura_en: Date | null;
      sincronizado_en: Date | null;
      cursor_pendiente: string | null;
      ultima_programada_en: Date | null;
    }
  | undefined
> {
  const r = await admin.pool.query(
    "select * from buzon_estado_cliente where cliente_id = $1",
    [clienteId],
  );
  return r.rows[0];
}

/** Notificaciones `buzon_critico` de un cliente, con el usuario y los `params`. */
export async function avisosBuzon(
  admin: ContappDb,
  tenantId: string,
  clienteId: string,
): Promise<{ usuario_id: string; params: any; clave_dedupe: string }[]> {
  const r = await admin.pool.query(
    `select usuario_id, params, clave_dedupe from notificacion
      where tenant_id = $1 and cliente_id = $2 and tipo = 'buzon_critico' order by creada_en, id`,
    [tenantId, clienteId],
  );
  return r.rows as any[];
}

export async function notificacionesTipo(
  admin: ContappDb,
  tenantId: string,
  clienteId: string,
  tipo: string,
): Promise<{ usuario_id: string }[]> {
  const r = await admin.pool.query(
    "select usuario_id from notificacion where tenant_id = $1 and cliente_id = $2 and tipo = $3",
    [tenantId, clienteId, tipo],
  );
  return r.rows as any[];
}

/** Inserta un mensaje como lo dejaría una captura anterior (superusuario; el trigger de aviso exige `avisado` en críticos recientes). */
export async function insertarMensajeAdmin(
  admin: ContappDb,
  tenantId: string,
  clienteId: string,
  o: {
    idSunat: string;
    asunto?: string;
    categoria?: string;
    critico?: boolean;
    avisado?: boolean;
    fechaHaceDias?: number;
    adjuntosDeclarados?: number;
    leido?: boolean;
  },
): Promise<string> {
  const crit = o.critico ?? false;
  const r = await admin.pool.query(
    `insert into buzon_mensaje
        (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico, version_catalogo,
         avisado, leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados)
     values ($1, $2, $3, $4, 'SUNAT', now() - make_interval(secs => $5::float8 * 86400), $6, $7,
             case when $7 then 'asunto' else null end, 1, $8, $9, now(), now(), $10)
     returning id`,
    [
      tenantId,
      clienteId,
      o.idSunat,
      o.asunto ?? "Mensaje sembrado",
      o.fechaHaceDias ?? 1,
      o.categoria ?? (crit ? "coactiva" : "otro"),
      crit,
      o.avisado ?? false,
      o.leido ?? false,
      o.adjuntosDeclarados ?? 0,
    ],
  );
  return r.rows[0].id as string;
}

/** Texto de job_registro, notificación, auditoría y auditoría de descifrado del estudio (todo MENOS las tablas de buzón). */
export async function volcarTrazas(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const r = await admin.pool.query(
    `select t from (
       select to_jsonb(j)::text as t from job_registro j where tenant_id = any($1::uuid[])
       union all select to_jsonb(n)::text from notificacion n where tenant_id = any($1::uuid[])
       union all select to_jsonb(a)::text from auditoria a where tenant_id = any($1::uuid[])
       union all select to_jsonb(d)::text from auditoria_descifrado d where tenant_id = any($1::uuid[])
     ) x`,
    [estudios],
  );
  return (r.rows as { t: string }[]).map((f) => f.t).join("\n");
}

export async function descifradosDe(
  admin: ContappDb,
  clienteId: string,
): Promise<{ resultado: string; motivo: string }[]> {
  const r = await admin.pool.query(
    "select resultado, motivo from auditoria_descifrado where cliente_id = $1 order by created_at, id",
    [clienteId],
  );
  return r.rows as any[];
}

// ---------------------------------------------------------------------------------------------------------------
// Trabajos de buzón y fila de programación
// ---------------------------------------------------------------------------------------------------------------

export interface TrabajoBuzon {
  id: string;
  tenant_id: string;
  cliente_id: string;
  estado: string;
  prioridad: string;
  creado_por: string | null;
}

export async function trabajosRevisar(
  admin: ContappDb,
  filtro: { tenantId?: string; clienteId?: string } = {},
): Promise<TrabajoBuzon[]> {
  const r = await admin.pool.query(
    `select id, tenant_id, cliente_id, estado, prioridad, creado_por from job_registro
      where tipo = 'sol.buzon.revisar' and ($1::uuid is null or tenant_id = $1) and ($2::uuid is null or cliente_id = $2)
      order by creado_en, id`,
    [filtro.tenantId ?? null, filtro.clienteId ?? null],
  );
  return r.rows as TrabajoBuzon[];
}

/** Marca como terminados los trabajos vivos de buzón de los estudios (así la clave de dedupe vuelve a estar libre). */
export async function terminarTrabajosBuzon(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  await admin.pool.query(
    `update job_registro set estado = 'completado', terminado_en = now(), actualizado_en = now()
      where tenant_id = any($1::uuid[]) and tipo = 'sol.buzon.revisar' and estado in ('en_cola', 'ejecutando')`,
    [estudios],
  );
}

export interface FilaProgramacion {
  intervalo_min: number;
  reserva_interactiva: number;
  lote_estudio: number;
  ciclo_dueno: string | null;
  ciclo_hasta: Date | null;
  ultimo_ciclo_inicio: Date | null;
  ultimo_ciclo_fin: Date | null;
}

/** Guarda y restaura la fila única de `buzon_programacion` (las pruebas la cambian sin transacción). */
export class ProgramacionGuardada {
  private original: FilaProgramacion | undefined;
  constructor(private readonly admin: ContappDb) {}

  async guardar(): Promise<void> {
    try {
      this.original = (
        await this.admin.pool.query("select * from buzon_programacion")
      ).rows[0];
    } catch {
      /* rojo: la tabla aún no existe */
    }
  }

  async restaurar(): Promise<void> {
    const p = this.original;
    if (!p) return;
    await this.admin.pool
      .query(
        `update buzon_programacion set intervalo_min = $1, reserva_interactiva = $2, lote_estudio = $3, ciclo_dueno = $4,
                ciclo_hasta = $5, ultimo_ciclo_inicio = $6, ultimo_ciclo_fin = $7`,
        [
          p.intervalo_min,
          p.reserva_interactiva,
          p.lote_estudio,
          p.ciclo_dueno,
          p.ciclo_hasta,
          p.ultimo_ciclo_inicio,
          p.ultimo_ciclo_fin,
        ],
      )
      .catch(() => undefined);
  }

  /** Cambia las columnas dadas de la fila única (sin carrera: el programador de la prueba no corre mientras tanto). */
  async fijar(cambios: {
    intervalo_min?: number;
    reserva_interactiva?: number;
    lote_estudio?: number;
    ultimo_ciclo_inicio?: Date;
  }): Promise<void> {
    await this.admin.pool.query(
      `update buzon_programacion set intervalo_min = coalesce($1, intervalo_min),
              reserva_interactiva = coalesce($2, reserva_interactiva), lote_estudio = coalesce($3, lote_estudio),
              ultimo_ciclo_inicio = coalesce($4, ultimo_ciclo_inicio)`,
      [
        cambios.intervalo_min ?? null,
        cambios.reserva_interactiva ?? null,
        cambios.lote_estudio ?? null,
        cambios.ultimo_ciclo_inicio ?? null,
      ],
    );
  }

  /** Deja el ciclo libre y con el intervalo ya cumplido: el siguiente tick puede tomarlo. */
  async listoParaTomar(intervaloMin = 15): Promise<void> {
    await this.admin.pool.query(
      `update buzon_programacion set intervalo_min = $1, ciclo_dueno = null, ciclo_hasta = null,
              ultimo_ciclo_inicio = clock_timestamp() - make_interval(mins => $1 + 1)`,
      [intervaloMin],
    );
  }

  async leer(): Promise<FilaProgramacion> {
    return (await this.admin.pool.query("select * from buzon_programacion"))
      .rows[0] as FilaProgramacion;
  }
}

export const uuidAleatorio = (): string => randomUUID();
