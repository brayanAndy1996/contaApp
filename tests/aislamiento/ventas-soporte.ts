// Soporte de las pruebas de BD de la spec 013 (T2). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus estudios, clientes y usuarios (EscenarioTrabajos) y siembra `propuesta`, `venta` y saltos con la
// conexion administrativa (superusuario: no pasa por RLS ni por grants, pero SI por los triggers y las FK de la tabla). Al
// final los borra con `session_replication_role = replica` porque las filas `sire` de `venta` son inmutables por trigger
// (013 D4) y las FK compuestas impedirian borrar en cualquier orden. Datos sinteticos: sin RUC reales.
import type { Pool } from "pg";
import { EscenarioTrabajos, type ClientePrueba } from "./trabajos-soporte";

export const HASH = "a".repeat(64);
export const PERIODO = "202610";

/** Montos de una venta, como las cadenas que devuelve `pg` para NUMERIC(14,2). */
export const MONTOS_CERO = {
  baseGravada: "0.00",
  igv: "0.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "0.00",
} as const;

export interface OpcionesPropuesta {
  periodo?: string;
  libro?: "compras" | "ventas";
  fuente?: "api" | "importacion";
  recibidas?: number;
  nuevas?: number;
  iguales?: number;
  distintas?: number;
  trabajoId?: string | null;
}

export interface OpcionesVenta {
  periodo?: string;
  origen?: "sire" | "manual";
  /** Obligatorio si origen = sire (se ignora en manual). */
  propuestaId?: string | null;
  tipo?: string;
  serie?: string;
  numero?: string;
  /** `null` = numero no evaluable; por omision se deriva de `numero` (1 a 8 digitos). */
  numeroN?: number | null;
  fecha?: string;
  moneda?: "PEN" | "USD";
  tipoCambio?: string | null;
  tipoDocContraparte?: string;
  docContraparte?: string;
  clave?: string;
  montos?: Partial<Record<keyof typeof MONTOS_CERO, string>>;
}

export const claveDe = (tipo: string, serie: string, numero: string): string =>
  `${tipo}|${serie.toUpperCase()}|${numero.replace(/^0+(?=.)/, "")}`;

const numeroNDe = (numero: string): number | null =>
  /^[0-9]{1,8}$/.test(numero) ? Number(numero) : null;

export class EscenarioVentas extends EscenarioTrabajos {
  private readonly usuarios = new Map<string, string>();
  private readonly tenants = new Set<string>();

  /** Un usuario miembro del estudio (se reutiliza) para `propuesta.usuario_id` y similares. */
  async usuarioDe(tenantId: string): Promise<string> {
    let u = this.usuarios.get(tenantId);
    if (!u) {
      u = (await this.miembro(tenantId, "contador")).id;
      this.usuarios.set(tenantId, u);
    }
    return u;
  }

  /** Encabezado de propuesta sembrado con el superusuario. Devuelve su id. */
  async propuesta(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesPropuesta = {},
  ): Promise<string> {
    this.tenants.add(tenantId);
    const clienteId = typeof c === "string" ? c : c.id;
    const nuevas = o.nuevas ?? 0;
    const iguales = o.iguales ?? 0;
    const distintas = o.distintas ?? 0;
    const recibidas = o.recibidas ?? nuevas + iguales + distintas;
    const r = await this.admin.query(
      `insert into propuesta (tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
                              filas_iguales, filas_distintas, usuario_id, trabajo_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [
        tenantId,
        clienteId,
        o.periodo ?? PERIODO,
        o.libro ?? "ventas",
        o.fuente ?? "api",
        HASH,
        recibidas,
        nuevas,
        iguales,
        distintas,
        await this.usuarioDe(tenantId),
        o.trabajoId ?? null,
      ],
    );
    return r.rows[0].id as string;
  }

  /** Venta sembrada con el superusuario. Una `sire` sin `propuestaId` crea antes su propuesta. */
  async venta(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesVenta = {},
  ): Promise<string> {
    this.tenants.add(tenantId);
    const clienteId = typeof c === "string" ? c : c.id;
    const periodo = o.periodo ?? PERIODO;
    const origen = o.origen ?? "sire";
    const tipo = o.tipo ?? "03";
    const serie = o.serie ?? "B001";
    const numero = o.numero ?? "290";
    const propuestaId =
      origen === "manual"
        ? null
        : (o.propuestaId ??
          (await this.propuesta(tenantId, clienteId, {
            periodo,
            nuevas: 1,
          })));
    const m = { ...MONTOS_CERO, ...(o.montos ?? {}) };
    const r = await this.admin.query(
      `insert into venta (tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n,
                          fecha, tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv,
                          exonerada, inafecta, isc, icbper, otros, total, creada_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
               $23, $24) returning id`,
      [
        tenantId,
        clienteId,
        periodo,
        propuestaId,
        origen,
        o.clave ?? claveDe(tipo, serie, numero),
        tipo,
        serie,
        numero,
        o.numeroN === undefined ? numeroNDe(numero) : o.numeroN,
        o.fecha ?? "2026-10-05",
        o.tipoDocContraparte ?? "0",
        o.docContraparte ?? "-",
        o.moneda ?? "PEN",
        o.tipoCambio ?? null,
        m.baseGravada,
        m.igv,
        m.exonerada,
        m.inafecta,
        m.isc,
        m.icbper,
        m.otros,
        m.total,
        origen === "manual" ? await this.usuarioDe(tenantId) : null,
      ],
    );
    return r.rows[0].id as string;
  }

  /** Salto justificado sembrado con el superusuario. */
  async salto(
    tenantId: string,
    clienteId: string,
    o: {
      periodo?: string;
      tipo?: string;
      serie?: string;
      desde?: number;
      hasta?: number;
      comentario?: string;
      revertido?: boolean;
    } = {},
  ): Promise<string> {
    this.tenants.add(tenantId);
    const u = await this.usuarioDe(tenantId);
    const r = await this.admin.query(
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
        o.desde ?? 291,
        o.hasta ?? 291,
        o.comentario ?? "Boleta anulada en caja",
        u,
        o.revertido ?? false,
      ],
    );
    return r.rows[0].id as string;
  }

  override async limpiar(): Promise<void> {
    const t = this.ea.estudios;
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of [
        // Spec 012b (T4): versiones de archivo (inmutables por trigger), exclusiones y estado del periodo de ventas.
        "archivo_generado",
        "venta_exclusion",
        "venta_periodo",
        "venta_salto_justificado",
        "venta",
        "propuesta_diferencia",
        "propuesta",
      ]) {
        await c
          .query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [t])
          .catch(() => undefined);
      }
    } finally {
      c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
    }
    await super.limpiar();
  }
}

/** Lee una tabla con el superusuario, ordenada, para comprobar que un intento fallido no cambio nada. */
export async function contar(
  admin: Pool,
  tabla: string,
  donde = "true",
  valores: unknown[] = [],
): Promise<number> {
  const r = await admin.query(
    `select count(*)::int as n from ${tabla} where ${donde}`,
    valores,
  );
  return r.rows[0].n as number;
}
