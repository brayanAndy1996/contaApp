// Soporte de las pruebas de BD de la spec 025 (T4, rojo): estudio, clientes, trabajos, reglas, importaciones y candidatas sembrados
// con el superusuario (MIGRATIONS_DATABASE_URL: pasa por FK y CHECK, no por RLS ni grants) y un oráculo en memoria del listado.
// No es una prueba (sin sufijo .spec) ni código de producción (queda fuera de `tsconfig.build.json`). Necesita DATABASE_URL (rol
// de la app, para `withTenant` como contapp_backend o contapp_worker) y MIGRATIONS_DATABASE_URL; si faltan, la suite FALLA.
//
// Las tablas `regla_importacion` y `regla_candidata` son las de plan.md (Contratos: BD, 0061); esta siembra usa sus columnas. Datos
// sintéticos: ningún RUC ni razón social reales.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDb, type ContappDb, type RolApp } from "../client";

export const DESTINOS = ["DG", "DGNG", "DNG"] as const;
export type Destino = (typeof DESTINOS)[number];

const VARIABLES = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const;

/** Falla (no salta) si faltan las URLs de la BD. */
export function exigirEntorno(): void {
  const faltan = VARIABLES.filter((v) => !process.env[v]);
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno para las pruebas de BD del aprendizaje: ${faltan.join(", ")}`,
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

export const abrirDb = (rolApp: RolApp): ContappDb =>
  createDb({ rolApp, poolMax: 4 });

// ---- Estudio y clientes ----------------------------------------------------------------------------------------------------
export interface ClienteSembrado {
  id: string;
  ruc: string;
}

export interface Estudio {
  tenantId: string;
  dueno: { id: string; nombre: string };
  /** Cliente archivado (nunca cambia). */
  archivado: ClienteSembrado;
  /** Crea un cliente nuevo del estudio (cada prueba usa el suyo: una importación en curso por cliente). */
  nuevoCliente(): Promise<ClienteSembrado>;
  limpiar(): Promise<void>;
}

export async function sembrarEstudio(admin: Pool): Promise<Estudio> {
  const marca = randomBytes(3).toString("hex");
  const tenantId = randomUUID();
  const dueno = { id: randomUUID(), nombre: `Dueno T4 ${marca}` };
  let secuencia = 0;
  const prefijo = String(parseInt(marca, 16) % 100_000).padStart(5, "0");

  const crearCliente = async (archivado: boolean): Promise<ClienteSembrado> => {
    const cliente = {
      id: randomUUID(),
      ruc: `3${prefijo}${String(++secuencia).padStart(5, "0")}`,
    };
    await admin.query(
      `insert into cliente (id, tenant_id, ruc, razon_social, archivado_at)
       values ($1, $2, $3, $4, case when $5::boolean then now() else null end)`,
      [
        cliente.id,
        tenantId,
        cliente.ruc,
        `Cliente T4 ${marca}-${secuencia}`,
        archivado,
      ],
    );
    return cliente;
  };

  const limpiar = async (): Promise<void> => {
    const c = await admin.connect();
    try {
      // Sin disparadores (inmutabilidad, último dueño) y cada paso tolera que falte una tabla.
      await c.query("SET session_replication_role = replica");
      const pasos = [
        "delete from regla_candidata where tenant_id = $1",
        "delete from regla_importacion where tenant_id = $1",
        "delete from regla_confirmacion where tenant_id = $1",
        "delete from regla_aceptacion where tenant_id = $1",
        "delete from regla_aplicacion where tenant_id = $1",
        "delete from regla_aprendida where tenant_id = $1",
        "delete from auditoria where tenant_id = $1",
        "delete from job_registro where tenant_id = $1",
        "delete from asignacion where tenant_id = $1",
        "delete from membresia where tenant_id = $1",
        "delete from cliente where tenant_id = $1",
        "delete from suscripcion where tenant_id = $1",
      ];
      for (const sql of pasos)
        await c.query(sql, [tenantId]).catch(() => undefined);
      await c
        .query("delete from usuario where id = $1", [dueno.id])
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
      `Estudio T4 ${marca}`,
    ]);
    await admin.query(
      "insert into usuario (id, email, nombre) values ($1, $2, $3)",
      [dueno.id, `t4-${marca}-dueno@ejemplo.test`, dueno.nombre],
    );
    await admin.query(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'dueno')",
      [tenantId, dueno.id],
    );
    const archivado = await crearCliente(true);
    return {
      tenantId,
      dueno,
      archivado,
      nuevoCliente: () => crearCliente(false),
      limpiar,
    };
  } catch (e) {
    await limpiar();
    throw e;
  }
}

/** Fila de `job_registro` del cliente (el trabajo de la importación), sembrada con el superusuario. */
export async function sembrarTrabajo(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  estado: "en_cola" | "error" = "en_cola",
): Promise<string> {
  const r = await admin.query(
    `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
     values ($1, $2, $3, 'reglas.historial.importar', 'sire', 'sire', 'interactivo', $4, '{}'::jsonb, $5, $6, 3) returning id`,
    [e.tenantId, c.id, c.ruc, estado, randomBytes(32), e.dueno.id],
  );
  return r.rows[0].id as string;
}

// ---- Escenario de candidatas -----------------------------------------------------------------------------------------------
export type Tipo =
  | "propuesta"
  | "ya_aprendida"
  | "distinta"
  | "sin_criterio"
  | "activada"
  | "descartada";

export interface PlanEscenario {
  propuestas: number;
  yaAprendidas: number;
  distintas: number;
  sinCriterio: number;
  activadas: number;
  descartadas: number;
}

/** 1.000 candidatas: 400 propuestas, 300 en conflicto (la mitad `ya_aprendida`), 150 sin criterio y 150 resueltas. */
export const ESCENARIO_1000: PlanEscenario = {
  propuestas: 400,
  yaAprendidas: 150,
  distintas: 150,
  sinCriterio: 150,
  activadas: 60,
  descartadas: 90,
};
/** Un escenario pequeño para las pruebas que escriben. */
export const ESCENARIO_CHICO: PlanEscenario = {
  propuestas: 30,
  yaAprendidas: 6,
  distintas: 6,
  sinCriterio: 8,
  activadas: 4,
  descartadas: 4,
};

export interface Conteos {
  DG: number;
  DGNG: number;
  DNG: number;
  mixto: number;
  total: number;
}

export interface ReglaSembrada {
  id: string;
  destino: Destino;
  version: number;
}

export interface CandidataSembrada {
  id: string;
  tipo: Tipo;
  docTipo: string;
  docNumero: string;
  razonSocial: string | null;
  destinoPropuesto: Destino | null;
  conteos: Conteos;
  periodosConProveedor: number;
  /** La regla viva del proveedor (conflicto) o la creada al activar (`activada`); `null` si no hay. */
  regla: ReglaSembrada | null;
}

export type Grupo = "propuestas" | "sin_criterio" | "conflicto" | "resueltas";

export interface Escenario {
  importacionId: string;
  /** Importación completada anterior, con candidatas `reemplazada`: nunca se listan. */
  anteriorId: string;
  /** Importación `fallida` posterior a la completada: tampoco cambia el listado. */
  fallidaId: string;
  periodos: string[];
  periodoHasta: string;
  periodosLeidos: number;
  periodosSinDatos: string[];
  candidatas: CandidataSembrada[];
}

export const PERIODOS = [
  "202610",
  "202609",
  "202608",
  "202607",
  "202606",
  "202605",
] as const;

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

const total = (c: Omit<Conteos, "total">): number =>
  c.DG + c.DGNG + c.DNG + c.mixto;

/** Conteos que cumplen el umbral de U-2 (`n >= 2` y `5n >= 4t`) para el destino `d`, según la variante `v`. */
function conteosDe(d: Destino, v: number): Conteos {
  const otro = DESTINOS[(DESTINOS.indexOf(d) + 1) % 3]!;
  const base = { DG: 0, DGNG: 0, DNG: 0, mixto: 0 };
  if (v % 3 === 0)
    Object.assign(base, { [d]: 4, mixto: 1 }); // 4 de 5 = 80 % justo
  else if (v % 3 === 1)
    Object.assign(base, { [d]: 8, [otro]: 1, mixto: 1 }); // 8 de 10
  else Object.assign(base, { [d]: 2 }); // 2 de 2: el mínimo
  return { ...base, total: total(base) };
}

/** Conteos sin criterio claro: empate, 1 de 1, 60 %, muchos mixtos. */
function conteosSinCriterio(v: number): Conteos {
  const base = { DG: 0, DGNG: 0, DNG: 0, mixto: 0 };
  if (v % 4 === 0) Object.assign(base, { DG: 2, DNG: 2 });
  else if (v % 4 === 1) Object.assign(base, { DNG: 1 });
  else if (v % 4 === 2) Object.assign(base, { DG: 3, DNG: 2 });
  else Object.assign(base, { DGNG: 1, mixto: 4 });
  return { ...base, total: total(base) };
}

const RAZONES = [
  "COMERCIAL ANDINA SAC",
  "Ferretería Ñandú EIRL",
  "DISTRIBUIDORA SOL & LUNA SRL",
  null,
  "Transportes Pérez e Hijos SA",
];

function documento(i: number): { docTipo: string; docNumero: string } {
  if (i % 5 === 0)
    return { docTipo: "1", docNumero: String(10_000_000 + i * 37) };
  return { docTipo: "6", docNumero: `20${String(100_000_000 + i * 7919)}` };
}

/**
 * Importación `completada` (6 periodos, uno sin datos) con las candidatas del plan, más una completada anterior (con candidatas
 * `reemplazada`) y una `fallida` posterior. Las reglas vivas de los conflictos y de las `activada` se siembran en `regla_aprendida`
 * (versión 3 en las `distinta`, para probar la versión vieja). Los tipos se reparten con un orden fijo pseudoaleatorio.
 */
export async function sembrarEscenario(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  plan: PlanEscenario,
): Promise<Escenario> {
  const r = mulberry32(7);
  const tipos: Tipo[] = [
    ...Array<Tipo>(plan.propuestas).fill("propuesta"),
    ...Array<Tipo>(plan.yaAprendidas).fill("ya_aprendida"),
    ...Array<Tipo>(plan.distintas).fill("distinta"),
    ...Array<Tipo>(plan.sinCriterio).fill("sin_criterio"),
    ...Array<Tipo>(plan.activadas).fill("activada"),
    ...Array<Tipo>(plan.descartadas).fill("descartada"),
  ];
  for (let i = tipos.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [tipos[i], tipos[j]] = [tipos[j]!, tipos[i]!];
  }

  const periodos = [...PERIODOS];
  const periodosSinDatos = ["202605"];
  const periodosLeidos = 5;
  const periodoHasta = "202610";
  const candidatas: CandidataSembrada[] = tipos.map((tipo, i) => {
    const sinDestino =
      tipo === "sin_criterio" || (tipo === "descartada" && i % 2 === 0);
    const destino = DESTINOS[i % 3]!;
    const conteos = sinDestino ? conteosSinCriterio(i) : conteosDe(destino, i);
    let regla: ReglaSembrada | null = null;
    if (tipo === "ya_aprendida")
      regla = { id: randomUUID(), destino, version: 1 };
    if (tipo === "distinta")
      regla = { id: randomUUID(), destino: DESTINOS[(i + 1) % 3]!, version: 3 };
    if (tipo === "activada") regla = { id: randomUUID(), destino, version: 1 };
    return {
      id: randomUUID(),
      tipo,
      ...documento(i),
      razonSocial: RAZONES[i % RAZONES.length] ?? null,
      destinoPropuesto: sinDestino ? null : destino,
      conteos,
      periodosConProveedor: Math.min(conteos.total, 1 + (i % periodosLeidos)),
      regla,
    };
  });

  const importacionId = randomUUID();
  const anteriorId = randomUUID();
  const fallidaId = randomUUID();
  const importacion = (
    id: string,
    estado: string,
    hace: string,
    leidos: number,
    nCandidatas: number,
    sinCriterio: number,
  ) =>
    admin.query(
      `insert into regla_importacion (id, tenant_id, cliente_id, estado, periodos, periodo_hasta, solicitada_por, solicitada_en,
         terminada_en, periodos_leidos, periodos_sin_datos, candidatas, sin_criterio, motivo)
       values ($1, $2, $3, $4, $5::char(6)[], $6, $7, now() - $8::interval, now() - $8::interval + interval '1 minute', $9,
         $10::char(6)[], $11, $12, case when $4 = 'fallida' then 'credencial_invalida' else null end)`,
      [
        id,
        e.tenantId,
        c.id,
        estado,
        periodos,
        periodoHasta,
        e.dueno.id,
        hace,
        leidos,
        estado === "fallida" ? [] : periodosSinDatos,
        nCandidatas,
        sinCriterio,
      ],
    );
  await importacion(anteriorId, "completada", "3 days", periodosLeidos, 30, 0);
  await importacion(
    importacionId,
    "completada",
    "2 days",
    periodosLeidos,
    candidatas.length,
    candidatas.filter((x) => x.destinoPropuesto === null).length,
  );
  await importacion(fallidaId, "fallida", "1 day", 0, 0, 0);

  // Reglas vivas (conflictos y activadas).
  const reglas = candidatas.filter((x) => x.regla !== null);
  if (reglas.length > 0) {
    await admin.query(
      `insert into regla_aprendida (id, tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
         creada_por, actualizada_por)
       select x.id, $1, $2, x.dt, x.dn, x.d, true, x.v, '202609', $3, $3
         from jsonb_to_recordset($4::jsonb) as x(id uuid, dt text, dn text, d text, v int)`,
      [
        e.tenantId,
        c.id,
        e.dueno.id,
        JSON.stringify(
          reglas.map((x) => ({
            id: x.regla!.id,
            dt: x.docTipo,
            dn: x.docNumero,
            d: x.regla!.destino,
            v: x.regla!.version,
          })),
        ),
      ],
    );
  }

  // Candidatas de la importación vigente.
  await admin.query(
    `insert into regla_candidata (id, tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
       n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado, destino_elegido, regla_id, resuelta_por, resuelta_en)
     select x.id, $1, $2, $3, x.dt, x.dn, x.rs, x.dp, x.dg, x.dgng, x.dng, x.mx, x.tt, x.pc, x.st,
            case when x.st = 'activada' then x.dp else null end,
            case when x.st = 'activada' then x.rid else null end,
            case when x.st <> 'pendiente' then $4::uuid else null end,
            case when x.st <> 'pendiente' then now() else null end
       from jsonb_to_recordset($5::jsonb)
         as x(id uuid, dt text, dn text, rs text, dp text, dg int, dgng int, dng int, mx int, tt int, pc int, st text, rid uuid)`,
    [
      e.tenantId,
      c.id,
      importacionId,
      e.dueno.id,
      JSON.stringify(
        candidatas.map((x) => ({
          id: x.id,
          dt: x.docTipo,
          dn: x.docNumero,
          rs: x.razonSocial,
          dp: x.destinoPropuesto,
          dg: x.conteos.DG,
          dgng: x.conteos.DGNG,
          dng: x.conteos.DNG,
          mx: x.conteos.mixto,
          tt: x.conteos.total,
          pc: x.periodosConProveedor,
          st:
            x.tipo === "activada"
              ? "activada"
              : x.tipo === "descartada"
                ? "descartada"
                : "pendiente",
          rid: x.regla?.id ?? null,
        })),
      ),
    ],
  );
  // Las `activada` tomaron el destino propuesto como elegido; las candidatas de la importación anterior quedaron `reemplazada`.
  await admin.query(
    `insert into regla_candidata (tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
       n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado, resuelta_por, resuelta_en)
     select $1, $2, $3, x.doc_tipo, x.doc_numero, 'PROVEEDOR ANTERIOR SAC', 'DNG', 0, 0, 3, 0, 3, 2, 'reemplazada', $4, now()
       from jsonb_to_recordset($5::jsonb) as x(doc_tipo text, doc_numero text)`,
    [
      e.tenantId,
      c.id,
      anteriorId,
      e.dueno.id,
      JSON.stringify(
        Array.from({ length: 30 }, (_, i) => {
          const d = documento(i + 2000);
          return { doc_tipo: d.docTipo, doc_numero: d.docNumero };
        }),
      ),
    ],
  );

  return {
    importacionId,
    anteriorId,
    fallidaId,
    periodos,
    periodoHasta,
    periodosLeidos,
    periodosSinDatos,
    candidatas,
  };
}

// ---- Oráculo del listado ---------------------------------------------------------------------------------------------------
export const grupoDe = (c: CandidataSembrada): Grupo => {
  if (c.tipo === "activada" || c.tipo === "descartada") return "resueltas";
  if (c.tipo === "ya_aprendida" || c.tipo === "distinta") return "conflicto";
  return c.destinoPropuesto === null ? "sin_criterio" : "propuestas";
};

export interface CandidataEsperada {
  id: string;
  proveedor: { tipo: string; numero: string; razonSocial: string | null };
  destinoPropuesto: Destino | null;
  conteos: Conteos;
  periodosConProveedor: number;
  periodosLeidos: number;
  estado: "pendiente" | "activada" | "descartada";
  destinoElegido: Destino | null;
  regla: ReglaSembrada | null;
  conflicto: "ninguno" | "ya_aprendida" | "distinto";
}

export function esperada(
  c: CandidataSembrada,
  esc: Escenario,
): CandidataEsperada {
  return {
    id: c.id,
    proveedor: {
      tipo: c.docTipo,
      numero: c.docNumero,
      razonSocial: c.razonSocial,
    },
    destinoPropuesto: c.destinoPropuesto,
    conteos: c.conteos,
    periodosConProveedor: c.periodosConProveedor,
    periodosLeidos: esc.periodosLeidos,
    estado:
      c.tipo === "activada"
        ? "activada"
        : c.tipo === "descartada"
          ? "descartada"
          : "pendiente",
    destinoElegido: c.tipo === "activada" ? c.destinoPropuesto : null,
    regla: c.regla,
    conflicto:
      c.tipo === "ya_aprendida"
        ? "ya_aprendida"
        : c.tipo === "distinta"
          ? "distinto"
          : "ninguno",
  };
}

/** Orden del listado: tipo y número del documento (los números son solo dígitos: el mismo orden en cualquier colación). */
export const porDocumento = (
  a: CandidataSembrada,
  b: CandidataSembrada,
): number =>
  a.docTipo === b.docTipo
    ? a.docNumero < b.docNumero
      ? -1
      : a.docNumero > b.docNumero
        ? 1
        : 0
    : a.docTipo < b.docTipo
      ? -1
      : 1;

/** Lo que debe devolver el listado de un grupo, completo y en orden. */
export function oraculo(
  esc: Escenario,
  grupo: Grupo,
  excluir: ReadonlySet<string> = new Set(),
): CandidataEsperada[] {
  return esc.candidatas
    .filter((c) => grupoDe(c) === grupo && !excluir.has(c.id))
    .sort(porDocumento)
    .map((c) => esperada(c, esc));
}
