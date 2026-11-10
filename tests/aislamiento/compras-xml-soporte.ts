// Soporte de las pruebas de BD de la spec 016 (T5, rojo). No es una prueba (no termina en .spec.ts).
// Siembra `documento_xml`, `documento_xml_obtencion`, `compra_evaluacion` y `compra_hallazgo` (con `evaluacion_n`) con la
// conexion administrativa (superusuario: no pasa por RLS ni por grants, pero SI por los triggers y las FK) y envuelve, por nombre,
// las funciones de `packages/db` que T11 implementa. Si falta una, la prueba dice cual (`exportado`).
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T5 (T11 lo implementa en las migraciones 0035 y 0036 y en `packages/db/src/xml/`):
//   Tablas (plan.md «Contratos: BD»; todas con tenant_id, RLS ENABLE + FORCE, columnas en snake_case, ninguna `*_at`):
//     documento_xml(id, tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen simulado|real|subido, ruta, sha256 bytea,
//       tamano int <= 1048576, detalle jsonb, subido_por null, creada_en); unica (tenant_id, cliente_id, ruc_emisor, tipo, serie,
//       numero, n); subido_por NOT NULL si y solo si origen = subido; SELECT/INSERT, sin UPDATE ni DELETE.
//     documento_xml_obtencion(tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, estado pendiente|no_encontrado|credencial|
//       transitorio, intentos, actualizado_en); PK (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero); UNICA tabla de 016 con
//       UPDATE (backend y worker); sin DELETE.
//     compra_evaluacion(id, tenant_id, compra_id, version_n, n, documento_xml_id null, creada_en); unica (tenant_id, compra_id,
//       version_n, n); FK compuestas a compra_version y a documento_xml; SELECT/INSERT. Backfill: n = 1 sin XML por cada version.
//     compra_hallazgo + evaluacion_n int NOT NULL (sin default tras 0036); unica (compra_id, version_n, evaluacion_n, regla);
//       FK compuesta a compra_evaluacion.
//   Funciones de `@contapp/db` (todas reciben la `tx` de `withTenant` como primer argumento; identidad normalizada como la `clave`
//   de 014: serie en mayusculas, numero sin ceros a la izquierda; montos y fechas como cadenas, nunca `number`):
//     guardarDocumentoXml(tx, EntradaXml): Promise<{ id: string; n: number } | "existente_no_simulado">
//         Toma el advisory del comprobante, decide P-6 (sin XML o con el vigente `simulado`: inserta n + 1; con uno `real` o
//         `subido`: devuelve "existente_no_simulado" y NO inserta) y conserva los anteriores.
//     leerXmlVigente(tx, clienteId, { rucEmisor, tipo, serie, numero }): Promise<XmlVigente | null>   (el de mayor n)
//     fijarObtencion(tx, clienteId, { rucEmisor, tipo, serie, numero }, estado): Promise<void>   (upsert de una fila por comprobante)
//     listarPorObtener(tx, clienteId, periodo): Promise<{ compraId; conHallazgos; tieneXml; obtencion }[]>
//     reevaluarCompra(tx, compraId, { evaluar }): Promise<unknown>
//         Bloquea en el orden de 016 (compra_periodo FOR SHARE -> compra_operacion -> compra), relee la version vigente ya
//         bloqueada, lee el XML vigente en la MISMA transaccion, inserta compra_evaluacion n + 1 de esa version (con el id del XML)
//         y los hallazgos que devuelve `evaluar`. NO crea version ni mueve el puntero. `no_encontrada` (ComprasReglaError) si la
//         compra no existe, es de otro estudio o esta descartada. Vale en cualquier estado del periodo (D-7).
//     `evaluar` recibe la fila de 014 MAS `xml`: `{ origen, detalle } | null` (el XML vigente leido dentro de la transaccion). Lo
//         reciben crearVersion, aplicarAccion, aplicarMasiva, deshacer/rehacer, insertarCompras y reevaluarCompra: cada version
//         nueva queda con su evaluacion n = 1 (con el id del XML vigente si lo hay).
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { exportado } from "./auth-soporte";
import {
  EscenarioCompras,
  type CompraLeida,
  type CompraSembrada,
  type DatosVersion,
  type HallazgoNuevo,
  type IdentidadCompra,
  type Montos,
  type OpcionesCompra,
  type ParametrosFalsos,
  type Transformar,
  type VersionFila,
} from "./compras-soporte";
import type { Tx } from "./soporte";
import type { ClientePrueba } from "./trabajos-soporte";

export type OrigenXml = "simulado" | "real" | "subido";
export type EstadoObtencion =
  "pendiente" | "no_encontrado" | "credencial" | "transitorio";

export interface IdentidadXml {
  rucEmisor: string;
  tipo: string;
  serie: string;
  numero: string;
}

export interface EntradaXml extends IdentidadXml {
  clienteId: string;
  origen: OrigenXml;
  ruta: string;
  sha256: Uint8Array;
  tamano: number;
  detalle: unknown;
  subidoPor?: string | null;
}

export type ResultadoGuardar =
  { id: string; n: number } | "existente_no_simulado";

export interface XmlVigente {
  id: string;
  n: number;
  origen: OrigenXml;
  detalle: unknown;
  ruta: string;
  tamano: number;
  subidoPor: string | null;
  creadaEn: Date;
}

/** La fila de 014 mas el XML vigente que `packages/db` le pasa a `evaluar`. */
export type FilaConXml = CompraLeida & {
  xml?: { origen: OrigenXml; detalle: unknown } | null;
};
export type EvaluarConXml = (
  fila: FilaConXml,
) => Promise<HallazgoNuevo[]> | HallazgoNuevo[];

/** Canario: aparece en el `detalle` sembrado para reconocer que `evaluar` recibio ESE XML. */
export const CANARIO_XML = "CANARIO-XML-016-7f3a";
export const detalleXml = (marca = CANARIO_XML) => ({
  identidad: { tipo: "01", serie: "F001", numero: "2056" },
  totales: { pagar: "0.00" },
  marca,
});

/** Serie en mayusculas y numero sin ceros a la izquierda (la `clave` de 014). */
export const normalizarIdentidad = (i: IdentidadXml): IdentidadXml => ({
  ...i,
  serie: i.serie.toUpperCase(),
  numero: i.numero.replace(/^0+(?=.)/, ""),
});

/** Identidad de XML de una compra sembrada con `OpcionesCompra` (ruc del emisor = doc_numero). */
export const identidadDe = (o: {
  tipoDoc?: string;
  serie: string;
  numero: string;
  docNumero?: string;
}): IdentidadXml => ({
  rucEmisor: o.docNumero ?? "20100070970",
  tipo: o.tipoDoc ?? "01",
  serie: o.serie,
  numero: o.numero,
});

export const rutaDe = (tenantId: string, clienteId: string): string =>
  `xml/${tenantId}/${clienteId}/${randomUUID()}.xml`;

/** Entrada completa para `guardarDocumentoXml`. */
export function entradaXml(
  tenantId: string,
  clienteId: string,
  id: IdentidadXml,
  o: {
    origen?: OrigenXml;
    subidoPor?: string | null;
    detalle?: unknown;
    tamano?: number;
  } = {},
): EntradaXml {
  const ruta = rutaDe(tenantId, clienteId);
  const origen = o.origen ?? "real";
  return {
    clienteId,
    ...id,
    origen,
    ruta,
    sha256: createHash("sha256").update(ruta).digest(),
    tamano: o.tamano ?? 1234,
    detalle: o.detalle ?? detalleXml(),
    subidoPor: origen === "subido" ? (o.subidoPor ?? null) : null,
  };
}

// --- funciones de packages/db, por nombre ----------------------------------------------------------------------------------
export const guardarDocumentoXml = (tx: Tx, e: EntradaXml) =>
  exportado<(tx: Tx, e: EntradaXml) => Promise<ResultadoGuardar>>(
    "guardarDocumentoXml",
  )(tx, e);
export const leerXmlVigente = (tx: Tx, clienteId: string, i: IdentidadXml) =>
  exportado<
    (tx: Tx, clienteId: string, i: IdentidadXml) => Promise<XmlVigente | null>
  >("leerXmlVigente")(tx, clienteId, i);
export const fijarObtencion = (
  tx: Tx,
  clienteId: string,
  i: IdentidadXml,
  estado: EstadoObtencion,
) =>
  exportado<
    (
      tx: Tx,
      clienteId: string,
      i: IdentidadXml,
      estado: EstadoObtencion,
    ) => Promise<void>
  >("fijarObtencion")(tx, clienteId, i, estado);
export const listarPorObtener = (tx: Tx, clienteId: string, periodo: string) =>
  exportado<
    (
      tx: Tx,
      clienteId: string,
      periodo: string,
    ) => Promise<
      {
        compraId: string;
        conHallazgos: boolean;
        tieneXml: boolean;
        obtencion: unknown;
      }[]
    >
  >("listarPorObtener")(tx, clienteId, periodo);
export const reevaluarCompra = (
  tx: Tx,
  compraId: string,
  f: { evaluar: EvaluarConXml },
) =>
  exportado<
    (
      tx: Tx,
      compraId: string,
      f: { evaluar: EvaluarConXml },
    ) => Promise<unknown>
  >("reevaluarCompra")(tx, compraId, f);

// Funciones de 014 que 016 modifica (la evaluacion numerada); las firmas son las de 014.
export const crearVersion = (
  tx: Tx,
  e: {
    compraId: string;
    versionBase: number;
    datos: DatosVersion;
    accion: string;
    usuarioId: string;
    operacionId?: string | null;
  },
  f: { evaluar: EvaluarConXml },
) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<VersionFila>>(
    "crearVersion",
  )(tx, e, f);
export const aplicarAccion = (
  tx: Tx,
  e: {
    compraId: string;
    versionBase: number;
    accion: string;
    parametros: ParametrosFalsos;
    usuarioId: string;
  },
  f: { transformar: Transformar; evaluar: EvaluarConXml },
) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<unknown>>(
    "aplicarAccion",
  )(tx, e, f);
export const aplicarMasiva = (
  tx: Tx,
  e: {
    clienteId: string;
    periodo: string;
    usuarioId: string;
    accion: string;
    parametros: ParametrosFalsos;
    items: { compraId: string; versionBase: number }[];
  },
  f: { transformar: Transformar; evaluar: EvaluarConXml },
) =>
  exportado<
    (
      tx: Tx,
      e: unknown,
      f: unknown,
    ) => Promise<{
      operacionId: string | null;
      aplicadas: number;
      rechazadas: { compraId: string; codigo: string }[];
    }>
  >("aplicarMasiva")(tx, e, f);
export const deshacer = (
  tx: Tx,
  e: { clienteId: string; periodo: string; usuarioId: string },
  f: { evaluar: EvaluarConXml },
) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<unknown>>("deshacer")(
    tx,
    e,
    f,
  );
export const insertarCompras = (
  tx: Tx,
  c: { clienteId: string; periodo: string; propuestaId: string },
  nuevas: (IdentidadCompra & { montos: Montos })[],
  f: { evaluar: EvaluarConXml },
) =>
  exportado<(tx: Tx, c: unknown, n: unknown, f: unknown) => Promise<string[]>>(
    "insertarCompras",
  )(tx, c, nuevas, f);
export const listarCompras = (
  tx: Tx,
  clienteId: string,
  periodo: string,
  filtros: { limite: number; alertas?: boolean; vista?: string },
) =>
  exportado<
    (
      tx: Tx,
      clienteId: string,
      periodo: string,
      filtros: unknown,
    ) => Promise<{
      filas: {
        compra: { id: string };
        hallazgos: { regla: string; lecturas: Record<string, string> }[];
      }[];
    }>
  >("listarCompras")(tx, clienteId, periodo, filtros);
export const leerHallazgosVigentes = (tx: Tx, ids: string[]) =>
  exportado<
    (
      tx: Tx,
      ids: string[],
    ) => Promise<
      Map<
        string,
        {
          regla: string;
          lecturas: Record<string, string>;
          requiereConfirmacion: boolean;
        }[]
      >
    >
  >("leerHallazgosVigentes")(tx, ids);
export const leerDetalleCompra = (
  tx: Tx,
  clienteId: string,
  periodo: string,
  compraId: string,
) =>
  exportado<
    (
      tx: Tx,
      clienteId: string,
      periodo: string,
      compraId: string,
    ) => Promise<{
      versiones: { n: number }[];
      hallazgos: { regla: string; lecturas: Record<string, string> }[];
    } | null>
  >("leerDetalleCompra")(tx, clienteId, periodo, compraId);

// --- evaluadores de prueba -------------------------------------------------------------------------------------------------
export interface LlamadaEvaluar {
  version: number;
  xml: { origen: OrigenXml; detalle: unknown } | null;
}

/**
 * `evaluar` falso que deja ver con que XML evaluo: un hallazgo `R-XML` cuyas lecturas dicen el origen del XML recibido (o «sin»)
 * y la version evaluada. `llamadas` guarda lo que recibio cada vez.
 */
export function evaluadorXml(
  hacer: (f: FilaConXml) => HallazgoNuevo[] = (f) => [
    {
      regla: "R-XML",
      sugerencia: { destino: "DNG" },
      lecturas: { xml: f.xml?.origen ?? "sin", version: String(f.version) },
      requiereConfirmacion: false,
    },
  ],
) {
  const llamadas: LlamadaEvaluar[] = [];
  const evaluar: EvaluarConXml = async (f) => {
    llamadas.push({ version: f.version, xml: f.xml ?? null });
    return hacer(f);
  };
  return { evaluar, llamadas };
}

// --- escenario -------------------------------------------------------------------------------------------------------------
export class EscenarioXml extends EscenarioCompras {
  /** `documento_xml` sembrado con el superusuario (identidad normalizada). `n` por omision: el siguiente. Devuelve su id. */
  async xml(
    tenantId: string,
    c: ClientePrueba | string,
    id: IdentidadXml,
    o: {
      origen?: OrigenXml;
      subidoPor?: string | null;
      n?: number;
      detalle?: unknown;
      tamano?: number;
    } = {},
  ): Promise<string> {
    const clienteId = typeof c === "string" ? c : c.id;
    const i = normalizarIdentidad(id);
    const origen = o.origen ?? "real";
    const ruta = rutaDe(tenantId, clienteId);
    const r = await this.admin.query(
      `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle,
                                  subido_por)
       values ($1, $2, $3, $4, $5, $6,
               coalesce($7::int, (select coalesce(max(n), 0) + 1 from documento_xml
                                   where tenant_id = $1 and cliente_id = $2 and ruc_emisor = $3 and tipo = $4 and serie = $5
                                     and numero = $6)),
               $8, $9, $10, $11, $12::jsonb, $13)
       returning id`,
      [
        tenantId,
        clienteId,
        i.rucEmisor,
        i.tipo,
        i.serie,
        i.numero,
        o.n ?? null,
        origen,
        ruta,
        createHash("sha256").update(ruta).digest(),
        o.tamano ?? 1234,
        JSON.stringify(o.detalle ?? detalleXml()),
        origen === "subido" ? (o.subidoPor ?? null) : null,
      ],
    );
    return r.rows[0].id as string;
  }

  /** `documento_xml_obtencion` sembrado. */
  async obtencion(
    tenantId: string,
    c: ClientePrueba | string,
    id: IdentidadXml,
    estado: EstadoObtencion = "pendiente",
  ): Promise<void> {
    const i = normalizarIdentidad(id);
    await this.admin.query(
      `insert into documento_xml_obtencion (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, estado)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        i.rucEmisor,
        i.tipo,
        i.serie,
        i.numero,
        estado,
      ],
    );
  }

  /** `compra_evaluacion` sembrada. Devuelve su id. */
  async evaluacion(
    tenantId: string,
    compraId: string,
    versionN: number,
    n: number,
    documentoXmlId: string | null = null,
  ): Promise<string> {
    const r = await this.admin.query(
      `insert into compra_evaluacion (tenant_id, compra_id, version_n, n, documento_xml_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [tenantId, compraId, versionN, n, documentoXmlId],
    );
    return r.rows[0].id as string;
  }

  /** Hallazgo sembrado en la evaluacion `evaluacionN` de la version (crea la evaluacion si falta). */
  async hallazgo(
    tenantId: string,
    compraId: string,
    versionN: number,
    regla: string,
    evaluacionN = 1,
    lecturas: Record<string, string> = {},
  ): Promise<void> {
    await this.admin.query(
      `insert into compra_evaluacion (tenant_id, compra_id, version_n, n)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [tenantId, compraId, versionN, evaluacionN],
    );
    await this.admin.query(
      `insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas,
                                    requiere_confirmacion)
       values ($1, $2, $3, $4, $5, '{}', $6::jsonb, false)`,
      [
        tenantId,
        compraId,
        versionN,
        evaluacionN,
        regla,
        JSON.stringify(lecturas),
      ],
    );
  }

  /**
   * Compra sembrada con serie y numero fijos y su evaluacion n = 1 de la version 1 (lo que deja `insertarCompras`); devuelve
   * ademas la identidad de su XML. `ec.compra` a secas no siembra la evaluacion (el backfill de 0036 solo cubre lo anterior).
   */
  async compraXml(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesCompra & { serie: string; numero: string },
  ): Promise<CompraSembrada & { identidad: IdentidadXml }> {
    const s = await this.compra(tenantId, c, o);
    await this.evaluacion(tenantId, s.id, 1, 1);
    return {
      ...s,
      identidad: normalizarIdentidad(
        identidadDe({
          tipoDoc: o.tipoDoc,
          serie: o.serie,
          numero: o.numero,
          docNumero: o.docNumero,
        }),
      ),
    };
  }
}

// --- consultas de verificacion (superusuario) ------------------------------------------------------------------------------
export interface FilaEvaluacion {
  version_n: number;
  n: number;
  documento_xml_id: string | null;
}
export const evaluacionesDe = async (
  admin: Pool,
  compraId: string,
): Promise<FilaEvaluacion[]> =>
  (
    await admin.query(
      "select version_n, n, documento_xml_id from compra_evaluacion where compra_id = $1 order by version_n, n",
      [compraId],
    )
  ).rows;

export interface FilaHallazgoEval {
  version_n: number;
  evaluacion_n: number;
  regla: string;
  lecturas: Record<string, string>;
}
export const hallazgosPorEvaluacion = async (
  admin: Pool,
  compraId: string,
): Promise<FilaHallazgoEval[]> =>
  (
    await admin.query(
      `select version_n, evaluacion_n, regla, lecturas from compra_hallazgo where compra_id = $1
        order by version_n, evaluacion_n, regla`,
      [compraId],
    )
  ).rows;

export const versionesN = async (
  admin: Pool,
  compraId: string,
): Promise<number[]> =>
  (
    await admin.query(
      "select n from compra_version where compra_id = $1 order by n",
      [compraId],
    )
  ).rows.map((r) => r.n as number);

export const punteroDe = async (
  admin: Pool,
  compraId: string,
): Promise<number> =>
  (
    await admin.query("select version_vigente from compra where id = $1", [
      compraId,
    ])
  ).rows[0]?.version_vigente as number;

export const xmlsDe = async (
  admin: Pool,
  clienteId: string,
  i: IdentidadXml,
): Promise<{ id: string; n: number; origen: OrigenXml }[]> => {
  const x = normalizarIdentidad(i);
  return (
    await admin.query(
      `select id, n, origen from documento_xml
        where cliente_id = $1 and ruc_emisor = $2 and tipo = $3 and serie = $4 and numero = $5 order by n`,
      [clienteId, x.rucEmisor, x.tipo, x.serie, x.numero],
    )
  ).rows;
};

/** Codigo (`codigo` de las clases de 014 o `code` de pg) de lo que lanza una promesa, o 'ok'. */
export async function codigoError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    const x = e as { codigo?: string; code?: string };
    return String(x.codigo ?? x.code ?? "sin_codigo");
  }
}
