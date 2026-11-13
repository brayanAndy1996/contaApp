// R-HIS en la descarga de compras (spec 021, D-6, D-7, D-8, D-10). Decide en el dominio (`planificarHistorial`, puro) qué compras
// NUEVAS de la descarga se mueven al destino de la regla aprendida de su proveedor y lo entrega a `insertarCompras` como la
// función `historial` que espera; la BD recalcula la misma consolidación y falla cerrado (42501) si no coincide. Aquí no hay IO.
// Solo se cuentan las compras que `insertarCompras` pide mover: el conteo es lo único que sale al `resultado` (D-10).
import type {
  CompraNueva,
  HistorialDescarga,
  LecturaReglasMotor,
  MontosCompra,
  ReglaVigente,
} from "@contapp/db";
import {
  MontosComprobante,
  planificarHistorial,
  type CodigoReglaMotor,
} from "@contapp/domain";

/** Las 10 columnas de monto, como en `MontosCompra`. */
const COLUMNAS = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
] as const;

/** Códigos del motor apagados por el estudio (sin fila = encendido). */
export function codigosApagados(motor: LecturaReglasMotor): CodigoReglaMotor[] {
  return motor.filas
    .filter((f) => !f.activa)
    .map((f) => f.codigo as CodigoReglaMotor);
}

export interface HistorialPlanificado {
  /** Para `insertarCompras`: `null` si la compra se queda en su versión 1. */
  historial: HistorialDescarga;
  /** Cuántas compras pidió mover `insertarCompras` (válido después de insertar). */
  contar(): number;
}

/**
 * Planifica una vez, con todas las filas nuevas, y deja que `insertarCompras` consulte por la clave de cada compra. `reglas`
 * son las vigentes y activas del cliente (vacías si R-HIS está apagado en el estudio); `rHisActiva` es el mismo interruptor.
 */
export function planificarHistorialDescarga(
  nuevas: readonly CompraNueva[],
  reglas: readonly ReglaVigente[],
  rHisActiva: boolean,
): HistorialPlanificado {
  const plan = planificarHistorial(
    nuevas.map((n, i) => ({
      id: String(i),
      proveedor: { tipo: n.docTipo, numero: n.docNumero },
      comprobante: { tipo: n.tipoDoc, serie: n.serie, numero: n.numero },
      montos: MontosComprobante.desde(n.moneda, n.montos),
    })),
    reglas.map((r) => ({
      id: r.reglaId,
      proveedor: { tipo: r.docTipo, numero: r.docNumero },
      destino: r.destino,
    })),
    { rHisActiva },
  );
  const porClave = new Map<string, { reglaId: string; datos: MontosCompra }>();
  for (const p of plan) {
    const datos = { total: p.montos.total.toString() } as MontosCompra;
    for (const c of COLUMNAS) datos[c] = p.montos.obtener(c).toString();
    porClave.set(nuevas[Number(p.filaId)]!.clave, { reglaId: p.reglaId, datos });
  }
  let movidas = 0;
  return {
    historial: (fila) => {
      const h = porClave.get(fila.clave) ?? null;
      if (h !== null) movidas += 1;
      return h;
    },
    contar: () => movidas,
  };
}
