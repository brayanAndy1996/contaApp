// Soporte de las pruebas de BD de la spec 027 (T3, rojo). No es una prueba (no termina en .spec.ts).
// Siembra con el superusuario (MIGRATIONS_DATABASE_URL: pasa por los triggers y las FK, no por RLS ni grants) y llama a las funciones
// acotadas como backend o worker dentro de `withTenant`, o como `contapp_backend` con una sesion de plataforma (funciones `auth.*`).
// Al final borra todo con `session_replication_role = replica`. Datos sinteticos: sin RUC reales ni glosas reales.
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T3 (T10 lo implementa en las migraciones 0069-0070; plan 027, Contratos: BD). Donde el plan deja
// abierto un detalle, la decision de T3 esta marcada con [T3]:
//   Tablas de plataforma (0069; sin tenant_id ni RLS, dueño contapp_migrator, como `plan`):
//     gnd_palabra_global(id uuid v7, palabra text UNIQUE ^[a-z0-9]{3,40}$, categoria (6), excepciones text[] (<= 5 frases de 1 a 3
//       palabras ^[a-z0-9]+( [a-z0-9]+){0,2}$), activa boolean, version integer >= 1, actualizada_en)
//     gnd_global_historial(id, palabra_global_id -> gnd_palabra_global, accion agregada|editada, antes jsonb, despues jsonb,
//       usuario_id -> usuario, ocurrida_en); solo de insercion (trigger BEFORE UPDATE/DELETE -> 42501).
//     Grants: SELECT a contapp_backend y contapp_worker; contapp_auth (dueño de las funciones de plataforma): SELECT, INSERT, UPDATE
//     sobre gnd_palabra_global y SELECT, INSERT sobre gnd_global_historial; nadie mas, y nadie DELETE ni TRUNCATE.
//     Semilla (SEMILLA abajo): las 72 palabras del plan con sus excepciones, activas, version 1.
//   Tablas del estudio (0069; tenant_id uuid con app.tenant_id por defecto, RLS ENABLE + FORCE, politica tenant_isolation FOR ALL):
//     gnd_palabra_estudio(id, tenant_id, palabra, categoria, excepciones, origen manual|aprendida, activa, version >= 1, creado_por ->
//       usuario, compra_origen_id NULL (FK compuesta (tenant_id, compra_origen_id) -> compra; NOT NULL si origen = aprendida),
//       creada_en, actualizada_en); unica (tenant_id, palabra)
//     gnd_global_desactivada(tenant_id, palabra_global_id -> gnd_palabra_global, usuario_id -> usuario, desactivada_en); PK
//       (tenant_id, palabra_global_id)
//     gnd_config(tenant_id PK, umbral smallint 1..20, version integer)   (sin fila = umbral 3 y version 0)
//     gnd_cliente_categorias(tenant_id, cliente_id, permitidas text[], quitadas text[], version integer); PK (tenant_id, cliente_id), FK
//       (tenant_id, cliente_id) -> cliente; CHECK: ambas son subconjunto de las 6 categorias y disjuntas   (sin fila = version 0)
//     gnd_ciiu(tenant_id, ruc char(11) ^[0-9]{11}$, ciiu char(4) NULL ^[0-9]{4}$, consultado_en); PK (tenant_id, ruc)
//     Backend y worker: SELECT de las cinco; nadie INSERT, UPDATE, DELETE ni TRUNCATE directo (42501). Ningun otro rol tiene privilegio.
//     Las 6 categorias: calzado-ropa, juguetes, entretenimiento, alimentos-personales, cuidado-personal, utiles-escolares.
//     auditoria_accion_valida +8: ACCIONES_GND.
//   Funciones del estudio (0070), SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo al rol indicado; todas
//   `select ... from public.<f>(...)`. Las del backend exigen app.tenant_id y app.user_id con membresia activa (42501); la del worker solo
//   app.tenant_id. Un id (palabra, global, cliente, compra) de otro estudio o inexistente: P0002; cliente archivado: 55000; entradas
//   invalidas: 22023; version distinta: CA409; palabra propia repetida: CA420; mas de 2.000 propias activas: CA421; compra no
//   excluida: CA422; compra sin XML vigente: CA423. [T3] «sin cambios» (el estado, el umbral o las categorias pedidos ya son los
//   vigentes) es 22023, sin escribir ni auditar.
//     gnd_palabra_agregar(p_palabra text, p_categoria text, p_excepciones text[]) -> uuid                         (contapp_backend)
//       [T3] p_palabra ya normalizada (^[a-z0-9]{3,40}$), la categoria una de las 6 y p_excepciones <= 5 frases validas, si no 22023.
//       Inserta origen manual, activa, version 1. Una propia con la misma palabra que una global es valida (la reemplaza).
//     gnd_palabra_estado(p_id uuid, p_activa boolean, p_version integer) -> integer (version nueva = p_version + 1)  (contapp_backend)
//       Reactivar respeta CA421.
//     gnd_global_estado(p_palabra_global uuid, p_activa boolean) -> void                                            (contapp_backend)
//       p_activa = false desactiva la global para el estudio (inserta en gnd_global_desactivada); true la reactiva (borra la fila).
//       Global inexistente o inactiva: P0002.
//     gnd_umbral_fijar(p_umbral integer, p_version integer) -> integer (version nueva)                              (contapp_backend)
//       umbral 1..20, si no 22023; sin fila la version vigente es 0.
//     gnd_cliente_categorias_fijar(p_cliente uuid, p_permitidas text[], p_quitadas text[], p_version integer) -> integer
//       (contapp_backend) subconjuntos de las 6 y disjuntos, si no 22023; sin fila la version vigente es 0.
//     gnd_aprender(p_cliente uuid, p_compra uuid, p_terminos jsonb) -> jsonb                                        (contapp_backend)
//       p_terminos = arreglo de 1 a 10 objetos {termino, categoria}. Compra del cliente (si no P0002) con version vigente excluida
//       (si no CA422) y XML vigente (si no CA423). Un termino invalido o una categoria fuera de las 6, o 0 o mas de 10 terminos: 22023
//       a TODO. [T3] Devuelve {guardadas: [palabra, ...], omitidas: [palabra, ...]} en el orden de la entrada; omitida = ya existe como
//       propia (activa o no) o como global activa no desactivada por el estudio. Si lo nuevo pasa de 2.000 activas: CA421 a todo.
//     gnd_ciiu_guardar(p_entradas jsonb) -> integer (n de entradas procesadas)                                      (contapp_worker)
//       p_entradas = arreglo de 0 a 50 objetos {ruc, ciiu | null}; mas de 50, ruc o ciiu invalidos: 22023 a todo. Inserta o actualiza
//       (ciiu y consultado_en = clock_timestamp()); no lee ni escribe ninguna otra tabla (ni auditoria). [T3] Procesa las entradas en
//       orden de RUC (y una vez por RUC repetido): dos llamadas con los mismos RUC en orden contrario no se interbloquean (40P01).
//   Funciones de plataforma (0070; esquema `auth`, dueño contapp_auth, EXECUTE solo contapp_backend; primer argumento el token_hash de
//   la sesion viva; si no es de un admin_plataforma vivo: 42501; no necesitan app.tenant_id):
//     auth.gnd_global_listar(bytea) -> SETOF (id, palabra, categoria, excepciones, activa, version, actualizada_en) por categoria, palabra
//     auth.gnd_global_agregar(bytea, p_palabra text, p_categoria text, p_excepciones text[]) -> la fila nueva (mismas columnas); CA420 si
//       existe; 22023 si algo es invalido; inserta su fila `agregada` en gnd_global_historial con antes null y despues = la fila
//     auth.gnd_global_editar(bytea, p_id uuid, p_categoria text, p_excepciones text[], p_activa boolean, p_version integer) -> la fila
//       (version + 1); CA409 si la version no es la vigente; P0002 si no existe; inserta su fila `editada` con antes y despues
//     auth.gnd_global_historial(bytea, p_limite integer, p_antes timestamptz) -> SETOF (id, palabra_global_id, accion, antes, despues,
//       usuario_id, ocurrida_en) mas recientes primero; p_antes = null es la primera pagina; limite 1..200, si no 22023
//   Auditoria (D-4, 017) con actor usuario: [T3] datos EXACTOS (las listas se guardan tal cual las recibe la funcion):
//     gnd.palabra_agregada {palabra, categoria, origen: "manual"} · entidad gnd_palabra_estudio, entidad_id = id de la palabra
//     gnd.palabra_desactivada y gnd.palabra_reactivada {palabra, categoria, origen} · idem
//     gnd.palabra_aprendida {palabra, categoria, compraId} (una por guardada) · idem · cliente_id = el de la compra
//     gnd.global_desactivada y gnd.global_reactivada {palabra, categoria} · entidad gnd_palabra_global, entidad_id = id de la global
//     gnd.umbral_cambiado {antes, despues} (numeros; antes = 3 si no habia fila) · entidad gnd_config
//     gnd.categorias_cliente {clienteId, antes: {permitidas, quitadas}, despues: {permitidas, quitadas}} · entidad
//       gnd_cliente_categorias · cliente_id = el cliente
//     Nunca glosas, razon social, RUC ni montos.
import { randomUUID } from "node:crypto";
import type { ClientePrueba } from "./trabajos-soporte";
import { EscenarioAuditoria } from "./auditoria-soporte";
import { CANARIO_XML, identidadDe } from "./compras-xml-soporte";
import {
  barrera,
  codigoDe,
  comoRolSql,
  conExecute,
  conPlazo,
  infoFuncion,
  llamar,
  llamarOk,
  ROLES_APP,
  ROLES_FUNCION,
  type Llamada,
} from "./reglas-importacion-soporte";

export {
  barrera,
  codigoDe,
  comoRolSql,
  conExecute,
  conPlazo,
  infoFuncion,
  llamar,
  llamarOk,
  ROLES_APP,
  ROLES_FUNCION,
};
export type { ClientePrueba, Llamada };

export const CATEGORIAS = [
  "calzado-ropa",
  "juguetes",
  "entretenimiento",
  "alimentos-personales",
  "cuidado-personal",
  "utiles-escolares",
] as const;

export const TABLAS_GND_ESTUDIO = [
  "gnd_palabra_estudio",
  "gnd_global_desactivada",
  "gnd_config",
  "gnd_cliente_categorias",
  "gnd_ciiu",
] as const;
export const TABLAS_GND_PLATAFORMA = [
  "gnd_palabra_global",
  "gnd_global_historial",
] as const;
export const TABLAS_GND = [
  ...TABLAS_GND_PLATAFORMA,
  ...TABLAS_GND_ESTUDIO,
] as const;

export const ACCIONES_GND = [
  "gnd.palabra_agregada",
  "gnd.palabra_desactivada",
  "gnd.palabra_reactivada",
  "gnd.palabra_aprendida",
  "gnd.global_desactivada",
  "gnd.global_reactivada",
  "gnd.umbral_cambiado",
  "gnd.categorias_cliente",
] as const;

export const LIMITE_PROPIAS = 2000;

/** Firmas (regprocedure) de las siete funciones de `public` de 0070. */
export const FIRMAS = {
  agregar: "gnd_palabra_agregar(text,text,text[])",
  estado: "gnd_palabra_estado(uuid,boolean,integer)",
  globalEstado: "gnd_global_estado(uuid,boolean)",
  umbral: "gnd_umbral_fijar(integer,integer)",
  categorias: "gnd_cliente_categorias_fijar(uuid,text[],text[],integer)",
  aprender: "gnd_aprender(uuid,uuid,jsonb)",
  ciiu: "gnd_ciiu_guardar(jsonb)",
} as const;

/** Rol de la app que ejecuta cada funcion de `public`. */
export const EJECUTA: Record<
  keyof typeof FIRMAS,
  "contapp_backend" | "contapp_worker"
> = {
  agregar: "contapp_backend",
  estado: "contapp_backend",
  globalEstado: "contapp_backend",
  umbral: "contapp_backend",
  categorias: "contapp_backend",
  aprender: "contapp_backend",
  ciiu: "contapp_worker",
};

/** Las cuatro funciones de plataforma (esquema `auth`, dueño contapp_auth, EXECUTE solo contapp_backend). */
export const FIRMAS_PLATAFORMA = {
  listar: "auth.gnd_global_listar(bytea)",
  agregar: "auth.gnd_global_agregar(bytea,text,text,text[])",
  editar: "auth.gnd_global_editar(bytea,uuid,text,text[],boolean,integer)",
  historial:
    "auth.gnd_global_historial(bytea,integer,timestamp with time zone)",
} as const;

export const SQL = {
  agregar:
    "select public.gnd_palabra_agregar($1::text, $2::text, $3::text[]) as id",
  estado:
    "select public.gnd_palabra_estado($1::uuid, $2::boolean, $3::integer) as version",
  globalEstado: "select public.gnd_global_estado($1::uuid, $2::boolean)",
  umbral: "select public.gnd_umbral_fijar($1::integer, $2::integer) as version",
  categorias:
    "select public.gnd_cliente_categorias_fijar($1::uuid, $2::text[], $3::text[], $4::integer) as version",
  aprender: "select public.gnd_aprender($1::uuid, $2::uuid, $3::jsonb) as r",
  ciiu: "select public.gnd_ciiu_guardar($1::jsonb) as n",
} as const;

export const SQL_PLATAFORMA = {
  listar: "select * from auth.gnd_global_listar($1::bytea)",
  agregar:
    "select * from auth.gnd_global_agregar($1::bytea, $2::text, $3::text, $4::text[])",
  editar:
    "select * from auth.gnd_global_editar($1::bytea, $2::uuid, $3::text, $4::text[], $5::boolean, $6::integer)",
  historial:
    "select * from auth.gnd_global_historial($1::bytea, $2::integer, $3::timestamptz)",
} as const;

/** Canarios: aparecen en glosas (XML), razon social y motivos para buscarlos en la auditoria y en los mensajes de error. */
export const CANARIO = {
  razonSocial: "RAZON-CANARIO-027-ZZ",
  glosa: CANARIO_XML,
  motivo: "MOTIVO-CANARIO-027-ZZ",
  ruc: "20999999991",
} as const;

/** Semilla del diccionario global (plan 027, «Semilla»): categoria -> palabra -> frases de excepcion. */
export const SEMILLA: Record<string, Record<string, string[]>> = {
  "calzado-ropa": {
    zapatilla: ["seguridad", "punta de acero"],
    zapato: ["seguridad", "punta de acero"],
    sandalia: [],
    bota: ["seguridad", "jebe", "punta de acero"],
    polo: ["a tierra"],
    polera: [],
    casaca: ["seguridad", "reflectiva"],
    blusa: [],
    vestido: [],
    falda: [],
    pantalon: [],
    jean: [],
    camisa: [],
    chompa: [],
    pijama: [],
  },
  juguetes: Object.fromEntries(
    [
      "juguete",
      "peluche",
      "muneca",
      "lego",
      "rompecabeza",
      "pelota",
      "triciclo",
      "patineta",
      "trompo",
      "sonajero",
    ].map((p) => [p, [] as string[]]),
  ),
  entretenimiento: Object.fromEntries(
    [
      "videojuego",
      "cine",
      "concierto",
      "playstation",
      "nintendo",
      "xbox",
      "netflix",
      "spotify",
      "karaoke",
      "teatro",
      "boliche",
    ].map((p) => [p, [] as string[]]),
  ),
  "alimentos-personales": Object.fromEntries(
    [
      "golosina",
      "chocolate",
      "helado",
      "cerveza",
      "vino",
      "whisky",
      "pisco",
      "ron",
      "vodka",
      "licor",
      "cigarro",
      "cigarrillo",
      "snack",
      "caramelo",
    ].map((p) => [p, [] as string[]]),
  ),
  "cuidado-personal": Object.fromEntries(
    [
      "perfume",
      "colonia",
      "maquillaje",
      "labial",
      "shampoo",
      "champu",
      "acondicionador",
      "desodorante",
      "rimel",
      "afeitadora",
      "depiladora",
      "cosmetico",
    ].map((p) => [p, [] as string[]]),
  ),
  "utiles-escolares": {
    lonchera: [],
    mochila: ["fumigadora"],
    plastilina: [],
    crayola: [],
    crayon: [],
    tempera: [],
    acuarela: [],
    escolar: [],
    cartuchera: [],
    papelote: [],
  },
};

// ---- Filas ---------------------------------------------------------------------------------------------------------------------
export interface FilaPalabraEstudio {
  id: string;
  tenant_id: string;
  palabra: string;
  categoria: string;
  excepciones: string[];
  origen: string;
  activa: boolean;
  version: number;
  creado_por: string;
  compra_origen_id: string | null;
  creada_en: Date;
  actualizada_en: Date;
}
export interface FilaGlobal {
  id: string;
  palabra: string;
  categoria: string;
  excepciones: string[];
  activa: boolean;
  version: number;
  actualizada_en: Date;
}
export interface FilaHistorial {
  id: string;
  palabra_global_id: string;
  accion: string;
  antes: unknown;
  despues: unknown;
  usuario_id: string;
  ocurrida_en: Date;
}
export interface FilaCategorias {
  tenant_id: string;
  cliente_id: string;
  permitidas: string[];
  quitadas: string[];
  version: number;
}
export interface FilaCiiu {
  tenant_id: string;
  ruc: string;
  ciiu: string | null;
  consultado_en: Date;
}

export interface OpcionesPalabraEstudio {
  palabra?: string;
  categoria?: string;
  excepciones?: string[];
  origen?: "manual" | "aprendida";
  activa?: boolean;
  version?: number;
  creadoPor?: string;
  compraOrigenId?: string | null;
}

export interface OpcionesCompraExcluida {
  /** Version vigente excluida (por omision si). */
  excluida?: boolean;
  /** XML vigente sembrado (por omision si). */
  conXml?: boolean;
  periodo?: string;
}
export interface CompraConXml {
  id: string;
  clienteId: string;
}

/** Tablas que las funciones de gnd NO deben tocar fuera de lo que declaran. */
const TABLAS_AJENAS = [
  "compra",
  "compra_version",
  "documento_xml",
  "cliente",
  "membresia",
] as const;

export class EscenarioGnd extends EscenarioAuditoria {
  private nGnd = 0;

  /** Palabra normalizada unica de la prueba (para las globales: la unica es mundial). */
  palabraNueva(): string {
    return `t3${this.ea.esc.marca}p${++this.nGnd}`;
  }

  /** Global sembrada con el superusuario (version 1, activa). */
  async palabraGlobal(
    o: {
      palabra?: string;
      categoria?: string;
      excepciones?: string[];
      activa?: boolean;
      version?: number;
    } = {},
  ): Promise<FilaGlobal> {
    const r = await this.admin.query(
      `insert into gnd_palabra_global (palabra, categoria, excepciones, activa, version)
       values ($1, $2, $3::text[], $4, $5) returning *`,
      [
        o.palabra ?? this.palabraNueva(),
        o.categoria ?? "juguetes",
        o.excepciones ?? [],
        o.activa ?? true,
        o.version ?? 1,
      ],
    );
    return r.rows[0] as FilaGlobal;
  }

  async global(id: string): Promise<FilaGlobal | undefined> {
    return (
      await this.admin.query("select * from gnd_palabra_global where id = $1", [
        id,
      ])
    ).rows[0] as FilaGlobal | undefined;
  }

  async globalPorPalabra(palabra: string): Promise<FilaGlobal | undefined> {
    return (
      await this.admin.query(
        "select * from gnd_palabra_global where palabra = $1",
        [palabra],
      )
    ).rows[0] as FilaGlobal | undefined;
  }

  async historial(globalId: string): Promise<FilaHistorial[]> {
    return (
      await this.admin.query(
        "select * from gnd_global_historial where palabra_global_id = $1 order by ocurrida_en, id",
        [globalId],
      )
    ).rows as FilaHistorial[];
  }

  /** Palabra propia sembrada (superusuario). Devuelve la fila. */
  async palabraEstudio(
    tenantId: string,
    o: OpcionesPalabraEstudio = {},
  ): Promise<FilaPalabraEstudio> {
    const origen = o.origen ?? "manual";
    const r = await this.admin.query(
      `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por, compra_origen_id)
       values ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9) returning *`,
      [
        tenantId,
        o.palabra ?? this.palabraNueva(),
        o.categoria ?? "entretenimiento",
        o.excepciones ?? [],
        origen,
        o.activa ?? true,
        o.version ?? 1,
        o.creadoPor ?? (await this.usuarioDe(tenantId)),
        o.compraOrigenId ?? null,
      ],
    );
    return r.rows[0] as FilaPalabraEstudio;
  }

  /** `n` propias activas de golpe (generate_series), para llegar al limite de 2.000 sin 2.000 viajes. */
  async llenarPalabras(
    tenantId: string,
    n: number,
    o: { activa?: boolean; prefijo?: string } = {},
  ): Promise<void> {
    const usuario = await this.usuarioDe(tenantId);
    await this.admin.query(
      `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por)
       select $1, $2 || lpad(i::text, 5, '0'), 'juguetes', '{}'::text[], 'manual', $3, 1, $4
         from generate_series(1, $5::int) as i`,
      [tenantId, o.prefijo ?? "llena", o.activa ?? true, usuario, n],
    );
  }

  async propias(tenantId: string): Promise<FilaPalabraEstudio[]> {
    return (
      await this.admin.query(
        "select * from gnd_palabra_estudio where tenant_id = $1 order by palabra",
        [tenantId],
      )
    ).rows as FilaPalabraEstudio[];
  }

  async propia(
    tenantId: string,
    palabra: string,
  ): Promise<FilaPalabraEstudio | undefined> {
    return (
      await this.admin.query(
        "select * from gnd_palabra_estudio where tenant_id = $1 and palabra = $2",
        [tenantId, palabra],
      )
    ).rows[0] as FilaPalabraEstudio | undefined;
  }

  async activas(tenantId: string): Promise<number> {
    return Number(
      (
        await this.admin.query(
          "select count(*)::int as n from gnd_palabra_estudio where tenant_id = $1 and activa",
          [tenantId],
        )
      ).rows[0].n,
    );
  }

  async desactivadaGlobal(
    tenantId: string,
    globalId: string,
    usuarioId?: string,
  ): Promise<void> {
    await this.admin.query(
      `insert into gnd_global_desactivada (tenant_id, palabra_global_id, usuario_id) values ($1, $2, $3)`,
      [tenantId, globalId, usuarioId ?? (await this.usuarioDe(tenantId))],
    );
  }

  async desactivadas(tenantId: string): Promise<string[]> {
    return (
      await this.admin.query(
        "select palabra_global_id from gnd_global_desactivada where tenant_id = $1 order by 1",
        [tenantId],
      )
    ).rows.map((x) => x.palabra_global_id as string);
  }

  async config(tenantId: string, umbral: number, version = 1): Promise<void> {
    await this.admin.query(
      "insert into gnd_config (tenant_id, umbral, version) values ($1, $2, $3)",
      [tenantId, umbral, version],
    );
  }

  async configDe(
    tenantId: string,
  ): Promise<{ umbral: number; version: number } | undefined> {
    return (
      await this.admin.query(
        "select umbral::int as umbral, version from gnd_config where tenant_id = $1",
        [tenantId],
      )
    ).rows[0];
  }

  async categorias(
    tenantId: string,
    c: ClientePrueba | string,
    o: { permitidas?: string[]; quitadas?: string[]; version?: number } = {},
  ): Promise<void> {
    await this.admin.query(
      `insert into gnd_cliente_categorias (tenant_id, cliente_id, permitidas, quitadas, version)
       values ($1, $2, $3::text[], $4::text[], $5)`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        o.permitidas ?? [],
        o.quitadas ?? [],
        o.version ?? 1,
      ],
    );
  }

  async categoriasDe(clienteId: string): Promise<FilaCategorias | undefined> {
    return (
      await this.admin.query(
        "select * from gnd_cliente_categorias where cliente_id = $1",
        [clienteId],
      )
    ).rows[0] as FilaCategorias | undefined;
  }

  async ciiu(
    tenantId: string,
    ruc: string,
    ciiu: string | null,
    o: { haceDias?: number } = {},
  ): Promise<void> {
    await this.admin.query(
      `insert into gnd_ciiu (tenant_id, ruc, ciiu, consultado_en)
       values ($1, $2, $3, now() - make_interval(days => $4::int))`,
      [tenantId, ruc, ciiu, o.haceDias ?? 0],
    );
  }

  async ciiuDe(tenantId: string): Promise<FilaCiiu[]> {
    return (
      await this.admin.query(
        "select * from gnd_ciiu where tenant_id = $1 order by ruc",
        [tenantId],
      )
    ).rows as FilaCiiu[];
  }

  /**
   * Compra del cliente con su XML vigente y, por omision, la version vigente excluida (accion `excluir`). El XML lleva el canario en
   * su detalle y la compra una razon social canario: ninguno debe aparecer en la auditoria.
   */
  async compraExcluida(
    tenantId: string,
    c: ClientePrueba,
    o: OpcionesCompraExcluida = {},
  ): Promise<CompraConXml> {
    const usuario = await this.usuarioDe(tenantId);
    const serie = "F001";
    const numero = String(7000 + ++this.nGnd);
    const s = await this.compra(tenantId, c, {
      serie,
      numero,
      docNumero: CANARIO.ruc,
      razonSocial: CANARIO.razonSocial,
      periodo: o.periodo,
    });
    if (o.excluida ?? true) {
      await this.version(tenantId, s.id, 2, {
        excluida: true,
        motivo: CANARIO.motivo,
        accion: "excluir",
        usuarioId: usuario,
      });
    }
    if (o.conXml ?? true) {
      // `xml()` siembra el detalle con el canario CANARIO_XML (la «glosa»).
      await this.xml(
        tenantId,
        c,
        identidadDe({ serie, numero, docNumero: CANARIO.ruc }),
        { origen: "real" },
      );
    }
    return { id: s.id, clienteId: c.id };
  }

  async archivar(clienteId: string): Promise<void> {
    await this.admin.query(
      "update cliente set archivado_at = now() where id = $1",
      [clienteId],
    );
  }

  /** Filas del estudio en las cinco tablas del estudio de gnd y en las que las funciones no deben tocar. */
  async totales(tenantId: string): Promise<Record<string, number>> {
    const salida: Record<string, number> = {};
    for (const t of [...TABLAS_GND_ESTUDIO, ...TABLAS_AJENAS]) {
      salida[t] = Number(
        (
          await this.admin.query(
            `select count(*)::int as n from ${t} where tenant_id = $1`,
            [tenantId],
          )
        ).rows[0].n,
      );
    }
    return salida;
  }

  /** Solo las cinco tablas del estudio (para comprobar «no escribio nada»). */
  async totalesGnd(tenantId: string): Promise<Record<string, number>> {
    const t = await this.totales(tenantId);
    return Object.fromEntries(TABLAS_GND_ESTUDIO.map((k) => [k, t[k]!]));
  }

  override async limpiar(): Promise<void> {
    const t = [...this.ea.estudios];
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of TABLAS_GND_ESTUDIO) {
        await c
          .query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [t])
          .catch(() => undefined);
      }
      const patron = `t3${this.ea.esc.marca}%`;
      await c
        .query(
          `delete from gnd_global_historial where palabra_global_id in (select id from gnd_palabra_global where palabra like $1)`,
          [patron],
        )
        .catch(() => undefined);
      await c
        .query(`delete from gnd_palabra_global where palabra like $1`, [patron])
        .catch(() => undefined);
    } finally {
      c.release(true);
    }
    await super.limpiar();
  }
}

export const idNuevo = (): string => randomUUID();
