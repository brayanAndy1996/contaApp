/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de ventas (spec 013, T6). Encima de `soporte-credenciales.ts` (cola con Redis
// real): estudios rastreados, clientes con `sire_api` verificada, siembra de `propuesta`, `venta`, diferencias y saltos
// justificados por SQL (conexión de migraciones: no pasa por RLS ni grants, sí por los triggers y las FK) y archivos de
// importación `.csv`/`.xlsx` con el layout provisional. No es una prueba ni código de producción. Datos sintéticos.
//
// Las filas `sire` de `venta` son inmutables por trigger (013 D4) y las FK compuestas impiden borrar en cualquier orden:
// `cerrar()` borra las cuatro tablas con `session_replication_role = replica` ANTES de la limpieza de 005 a 007b (si no,
// `delete from cliente` falla y los estudios de prueba quedan huérfanos).
import { readFileSync } from "node:fs";
import { createDb } from "@contapp/db";
import {
  abrirBancoCola,
  pedirBin,
  type Actor,
  type BancoCola,
  type Estudio,
  type RespBin,
} from "./soporte-credenciales.js";
import { csv, xlsx } from "./soporte-importacion.js";
import type { Resp } from "./soporte.js";

export const PERIODO = "202610";
export type { Actor, BancoCola, Estudio, RespBin };

/** `FilaVentaSire` del plan (montos como cadenas). */
export interface FilaV {
  tipo: string;
  serie: string;
  numero: string;
  tipoDocContraparte?: string;
  docContraparte: string;
  fechaEmision: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

/** Boleta de S/ 118.00 (100 + 18) que cuadra; `extra` pisa cualquier campo. */
export function fila(
  serie: string,
  numero: string | number,
  extra: Partial<FilaV> = {},
): FilaV {
  return {
    tipo: "03",
    serie,
    numero: String(numero),
    docContraparte: "-",
    fechaEmision: "2026-10-05",
    moneda: "PEN",
    baseGravada: "100.00",
    igv: "18.00",
    exonerada: "0.00",
    inafecta: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otros: "0.00",
    total: "118.00",
    ...extra,
  };
}

/** Boletas B001-290 y B001-292: el caso real (falta la 291). */
export const boletas290y292 = (): FilaV[] => [
  fila("B001", 290),
  fila("B001", 292, {
    fechaEmision: "2026-10-06",
    baseGravada: "50.00",
    igv: "9.00",
    total: "59.00",
  }),
];

/** Las 11 filas del fixture del contribuyente de prueba (`fixtures/sire/20700000002-ventas-202610.json`). */
export function filasFixtureVentas(): FilaV[] {
  const ruta = new URL(
    "../../../fixtures/sire/20700000002-ventas-202610.json",
    import.meta.url,
  );
  return (JSON.parse(readFileSync(ruta, "utf8")) as { filas: FilaV[] }).filas;
}

/** Cuerpo de `POST …/ventas` (agregar): lo mismo que `ventaAgregarSchema` de `@contapp/shared`. */
export const cuerpoVenta = (
  serie: string,
  numero: string | number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ ...fila(serie, numero), ...extra });

export const claveDe = (tipo: string, serie: string, numero: string): string =>
  `${tipo}|${serie.toUpperCase()}|${numero.replace(/^0+(?=.)/, "")}`;

const numeroNDe = (numero: string): number | null =>
  /^[0-9]{1,8}$/.test(numero) ? Number(numero) : null;

/** Ruta base de ventas de un cliente y periodo. */
export const base = (clienteId: string, periodo = PERIODO): string =>
  `/clientes/${clienteId}/periodos/${periodo}/ventas`;

// --- Archivos de importación (layout provisional: los nombres de columna son los campos de `FilaVentaSire`) ---------

export const CABECERA_VENTAS = [
  "tipo",
  "serie",
  "numero",
  "tipoDocContraparte",
  "docContraparte",
  "fechaEmision",
  "moneda",
  "tipoCambio",
  "baseGravada",
  "igv",
  "exonerada",
  "inafecta",
  "isc",
  "icbper",
  "otros",
  "total",
] as const;

/** Una fila de datos en el orden de `CABECERA_VENTAS` (lo que falta va vacío). */
export function celdasDe(f: FilaV): string[] {
  const por = f as unknown as Record<string, string | undefined>;
  return CABECERA_VENTAS.map((c) => por[c] ?? "");
}

export const csvVentas = (
  filas: FilaV[],
  o: Parameters<typeof csv>[1] = {},
): Uint8Array => csv([[...CABECERA_VENTAS], ...filas.map(celdasDe)], o);

export const xlsxVentas = (
  filas: FilaV[],
  opc: Parameters<typeof xlsx>[1] = {},
): Uint8Array => xlsx([[...CABECERA_VENTAS], ...filas.map(celdasDe)], opc);

// --- Banco ----------------------------------------------------------------------------------------------------------

export interface FilaVentaBd {
  id: string;
  origen: string;
  propuesta_id: string | null;
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  numero_n: number | null;
  fecha: string;
  tipo_doc_contraparte: string | null;
  doc_contraparte: string;
  moneda: string;
  tipo_cambio: string | null;
  base_gravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
  creada_por: string | null;
}

export interface Conteo {
  propuestas: number;
  ventas: number;
  diferencias: number;
  saltos: number;
}

export interface OpcionesSembrarPropuesta {
  periodo?: string;
  libro?: "compras" | "ventas";
  fuente?: "api" | "importacion";
  nuevas?: number;
  iguales?: number;
  distintas?: number;
  usuarioId: string;
  /** ISO; por omisión `now()` (el orden de `creada_en` decide cuál es la más reciente). */
  creadaEn?: string;
}

export interface BancoVentas {
  b: BancoCola;
  /** Estudio rastreado (con su Dueño con sesión). */
  estudio(): Promise<Estudio>;
  /** Cliente con `sol` y `sire_api` verificadas; `o` pisa la semilla de 007a (`responsable`, `colaboradores`, `archivado`…). */
  cliente(
    t: Estudio,
    o?: Parameters<BancoCola["c"]["sembrar"]>[1],
  ): Promise<{ id: string; ruc: string }>;
  llamar(
    a: Actor,
    metodo: "GET" | "POST" | "DELETE",
    ruta: string,
    cuerpo?: unknown,
  ): Promise<Resp>;
  /** Petición con cuerpo binario crudo (`application/octet-stream`). */
  bin(
    a: Actor,
    metodo: "GET" | "POST",
    ruta: string,
    bytes?: Uint8Array,
  ): Promise<RespBin>;
  sembrarPropuesta(
    tenantId: string,
    clienteId: string,
    o: OpcionesSembrarPropuesta,
  ): Promise<string>;
  /**
   * Siembra ventas. `origen: "sire"` (por omisión) las cuelga de `propuestaId` o de una propuesta nueva; `"manual"` las
   * deja sin propuesta y con `creada_por`. Devuelve los ids en el orden de `filas`.
   */
  sembrarVentas(
    tenantId: string,
    clienteId: string,
    filas: FilaV[],
    o: {
      usuarioId: string;
      periodo?: string;
      origen?: "sire" | "manual";
      propuestaId?: string;
    },
  ): Promise<string[]>;
  /** `n` ventas `sire` (S001-1 a S001-n de S/ 118.00) en una sola sentencia; devuelve el id de su propuesta. */
  sembrarMuchas(
    tenantId: string,
    clienteId: string,
    n: number,
    o: { usuarioId: string; periodo?: string; serie?: string },
  ): Promise<string>;
  sembrarSalto(
    tenantId: string,
    clienteId: string,
    o: {
      usuarioId: string;
      periodo?: string;
      tipo?: string;
      serie?: string;
      desde: number;
      hasta: number;
      comentario?: string;
      revertido?: boolean;
    },
  ): Promise<string>;
  sembrarDiferencia(
    tenantId: string,
    propuestaId: string,
    o: {
      tipo?: string;
      serie: string;
      numero: string;
      origenExistente?: "sire" | "manual";
      campos: string[];
      valoresSire: Record<string, string>;
    },
  ): Promise<void>;
  ventas(clienteId: string, periodo?: string): Promise<FilaVentaBd[]>;
  propuestas(clienteId: string, periodo?: string): Promise<any[]>;
  diferencias(propuestaId: string): Promise<any[]>;
  saltos(clienteId: string, periodo?: string): Promise<any[]>;
  trabajos(clienteId: string): Promise<any[]>;
  /** Cuenta propuestas, ventas, diferencias y saltos del cliente (todos los periodos). */
  conteo(clienteId: string): Promise<Conteo>;
  cerrar(): Promise<void>;
}

export async function abrirBancoVentas(): Promise<BancoVentas> {
  const b = await abrirBancoCola();
  const sql = b.sql;
  const tenants: string[] = [];
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url)
    throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de ventas");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });

  const sembrarPropuesta: BancoVentas["sembrarPropuesta"] = async (
    tenantId,
    clienteId,
    o,
  ) => {
    const nuevas = o.nuevas ?? 0;
    const iguales = o.iguales ?? 0;
    const distintas = o.distintas ?? 0;
    const r = await sql(
      `insert into propuesta (tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
                              filas_iguales, filas_distintas, usuario_id, creada_en)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12::timestamptz, now())) returning id`,
      [
        tenantId,
        clienteId,
        o.periodo ?? PERIODO,
        o.libro ?? "ventas",
        o.fuente ?? "api",
        "a".repeat(64),
        nuevas + iguales + distintas,
        nuevas,
        iguales,
        distintas,
        o.usuarioId,
        o.creadaEn ?? null,
      ],
    );
    return r[0].id as string;
  };

  const sembrarVentas: BancoVentas["sembrarVentas"] = async (
    tenantId,
    clienteId,
    filas,
    o,
  ) => {
    const periodo = o.periodo ?? PERIODO;
    const origen = o.origen ?? "sire";
    const propuestaId =
      origen === "manual"
        ? null
        : (o.propuestaId ??
          (await sembrarPropuesta(tenantId, clienteId, {
            periodo,
            nuevas: filas.length,
            usuarioId: o.usuarioId,
          })));
    const ids: string[] = [];
    for (const f of filas) {
      const r = await sql(
        `insert into venta (
              tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
              tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper,
              otros, total, creada_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         returning id`,
        [
          tenantId,
          clienteId,
          periodo,
          propuestaId,
          origen,
          claveDe(f.tipo, f.serie, f.numero),
          f.tipo,
          f.serie,
          f.numero,
          numeroNDe(f.numero),
          f.fechaEmision,
          f.tipoDocContraparte ?? "0",
          f.docContraparte,
          f.moneda,
          f.tipoCambio ?? null,
          f.baseGravada,
          f.igv,
          f.exonerada,
          f.inafecta,
          f.isc,
          f.icbper,
          f.otros,
          f.total,
          origen === "manual" ? o.usuarioId : null,
        ],
      );
      ids.push(r[0].id as string);
    }
    return ids;
  };

  const sembrarMuchas: BancoVentas["sembrarMuchas"] = async (
    tenantId,
    clienteId,
    n,
    o,
  ) => {
    const periodo = o.periodo ?? PERIODO;
    const serie = o.serie ?? "S001";
    const propuestaId = await sembrarPropuesta(tenantId, clienteId, {
      periodo,
      nuevas: n,
      usuarioId: o.usuarioId,
    });
    await sql(
      `insert into venta (
              tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
              tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper,
              otros, total, creada_por)
       select $1, $2, $3, $4, 'sire', '03|' || $5::text || '|' || g, '03', $5::text, g::text, g, '2026-10-05', '0', '-',
              'PEN', null, 100, 18, 0, 0, 0, 0, 0, 118, null
         from generate_series(1, $6::int) g`,
      [tenantId, clienteId, periodo, propuestaId, serie, n],
    );
    return propuestaId;
  };

  return {
    b,
    estudio: async () => {
      const e = await b.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    cliente: (t, o = {}) =>
      b.c.sembrar(t.tenantId, {
        sol: "verificada",
        sireApi: "verificada",
        ...o,
      }),
    llamar: (a, metodo, ruta, cuerpo) =>
      b.c.p.b.llamar(a, metodo, ruta, cuerpo),
    bin: (a, metodo, ruta, bytes) =>
      pedirBin(b.c.p.b.h, a, metodo, ruta, bytes),
    sembrarPropuesta,
    sembrarVentas,
    sembrarMuchas,
    sembrarSalto: async (tenantId, clienteId, o) => {
      const r = await sql(
        `insert into venta_salto_justificado (tenant_id, cliente_id, periodo, tipo, serie, desde, hasta, comentario,
                                              usuario_id, revertido_por, revertido_en)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 case when $10::boolean then $9::uuid else null end,
                 case when $10::boolean then now() else null end)
         returning id`,
        [
          tenantId,
          clienteId,
          o.periodo ?? PERIODO,
          o.tipo ?? "03",
          o.serie ?? "B001",
          o.desde,
          o.hasta,
          o.comentario ?? "Boleta anulada en caja",
          o.usuarioId,
          o.revertido ?? false,
        ],
      );
      return r[0].id as string;
    },
    sembrarDiferencia: async (tenantId, propuestaId, o) => {
      const tipo = o.tipo ?? "03";
      await sql(
        `insert into propuesta_diferencia (tenant_id, propuesta_id, clave, tipo, serie, numero, origen_existente, campos,
                                           valores_sire)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb)`,
        [
          tenantId,
          propuestaId,
          claveDe(tipo, o.serie, o.numero),
          tipo,
          o.serie,
          o.numero,
          o.origenExistente ?? "sire",
          o.campos,
          JSON.stringify(o.valoresSire),
        ],
      );
    },
    ventas: (clienteId, periodo = PERIODO) =>
      sql(
        `select id, origen, propuesta_id, clave, tipo, serie, numero, numero_n, fecha::text as fecha, tipo_doc_contraparte,
                doc_contraparte, moneda, tipo_cambio::text as tipo_cambio, base_gravada::text as base_gravada, igv::text as igv,
                exonerada::text as exonerada, inafecta::text as inafecta, isc::text as isc, icbper::text as icbper,
                otros::text as otros, total::text as total, creada_por
           from venta where cliente_id = $1 and periodo = $2 order by tipo, serie, numero_n nulls last, numero`,
        [clienteId, periodo],
      ),
    propuestas: (clienteId, periodo = PERIODO) =>
      sql(
        `select id, cliente_id, periodo, libro, fuente, hash, filas_recibidas::int, filas_nuevas::int, filas_iguales::int,
                filas_distintas::int, usuario_id, trabajo_id
           from propuesta where cliente_id = $1 and periodo = $2 order by creada_en, id`,
        [clienteId, periodo],
      ),
    diferencias: (propuestaId) =>
      sql(
        `select clave, tipo, serie, numero, origen_existente, campos, valores_sire
           from propuesta_diferencia where propuesta_id = $1 order by clave`,
        [propuestaId],
      ),
    saltos: (clienteId, periodo = PERIODO) =>
      sql(
        `select id, tipo, serie, desde::int, hasta::int, comentario, usuario_id, revertido_por, revertido_en
           from venta_salto_justificado where cliente_id = $1 and periodo = $2 order by creada_en, id`,
        [clienteId, periodo],
      ),
    trabajos: (clienteId) =>
      sql(
        "select * from job_registro where cliente_id = $1 and tipo = 'sire.propuesta.descargar' order by creado_en, id",
        [clienteId],
      ),
    conteo: async (clienteId) => {
      const r = await sql(
        `select (select count(*)::int from propuesta where cliente_id = $1) as propuestas,
                (select count(*)::int from venta where cliente_id = $1) as ventas,
                (select count(*)::int from propuesta_diferencia d join propuesta p on p.id = d.propuesta_id
                  where p.cliente_id = $1) as diferencias,
                (select count(*)::int from venta_salto_justificado where cliente_id = $1) as saltos`,
        [clienteId],
      );
      return r[0] as Conteo;
    },
    cerrar: async () => {
      if (tenants.length > 0) {
        const c = await admin.pool.connect();
        try {
          await c.query("SET session_replication_role = replica");
          // Un DELETE estático por tabla, de la hija a la madre.
          const borrar = [
            "delete from venta_salto_justificado where tenant_id = any($1::uuid[])",
            "delete from venta where tenant_id = any($1::uuid[])",
            "delete from propuesta_diferencia where tenant_id = any($1::uuid[])",
            "delete from propuesta where tenant_id = any($1::uuid[])",
          ];
          for (const texto of borrar)
            await c.query(texto, [tenants]).catch(() => undefined);
        } finally {
          c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
        }
      }
      try {
        await b.cerrar();
      } finally {
        await admin.close();
      }
    },
  };
}

/** Parsea "123.45" a centavos (BigInt): sumar y comparar dinero sin `number`. */
export function centavos(monto: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(monto);
  if (m === null) throw new Error(`monto no canónico: ${monto}`);
  const v = BigInt(m[2]! + m[3]!);
  return m[1] === "-" ? -v : v;
}
