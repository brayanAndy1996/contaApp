import { Inject, Injectable } from "@nestjs/common";
import {
  leerEstadoPeriodo,
  leerLoteParaResumen,
  type Alcance,
  type CompraParaResumen,
  type ContappDb,
} from "@contapp/db";
import {
  COLUMNAS_COMPRA,
  MontoFueraDeRangoError,
  MontosComprobante,
  Money,
  resumirCompras,
  type Casilleros,
  type ColumnaCompra,
  type CompraResumen,
} from "@contapp/domain";
import type { ResumenComprasVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { exigirCliente, periodoDe } from "./apoyo.js";
import { ComprasError } from "./errores.js";

/** Compras por lote al leer el periodo (DU-20): acota la memoria sin tope de filas. */
const TAMANO_LOTE = 2000;
const CASILLEROS: readonly (ColumnaCompra | "total")[] = [...COLUMNAS_COMPRA, "total"];

type Acumulado = Record<ColumnaCompra | "total", Money>;
const cero = (): Acumulado => Object.fromEntries(CASILLEROS.map((c) => [c, Money.cero("PEN")])) as Acumulado;
const sumar = (a: Acumulado, b: Casilleros): Acumulado =>
  Object.fromEntries(CASILLEROS.map((c) => [c, a[c].sumar(b[c])])) as Acumulado;
const restar = (a: Acumulado, b: Acumulado): Acumulado =>
  Object.fromEntries(CASILLEROS.map((c) => [c, a[c].restar(b[c])])) as Acumulado;
const cadenas = (a: Acumulado): ResumenComprasVista["casilleros"]["original"] =>
  Object.fromEntries(CASILLEROS.map((c) => [c, a[c].toString()])) as ResumenComprasVista["casilleros"]["original"];

function aCompraResumen(c: CompraParaResumen): CompraResumen {
  return {
    id: c.id,
    origen: c.origen,
    excluida: c.excluida,
    descartada: false,
    original: MontosComprobante.desde(c.moneda, c.original),
    vigente: MontosComprobante.desde(c.moneda, c.vigente),
  };
}

/**
 * Resumen por casillero del periodo (spec 014, D-8, RF-068, RF-069, DU-20). Lee todas las compras vivas por lotes con cursor por
 * id y acumula con `Money` lote a lote (sin `SUM` de SQL: la conversión USD y el redondeo son los de 010 y los montos nunca
 * pasan por `number`), sin tope de filas. Una suma fuera de NUMERIC(14,2) es un 422 controlado, no un 500.
 */
@Injectable()
export class ResumenComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async resumen(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<ResumenComprasVista> {
    const periodo = periodoDe(periodoCrudo);
    // Una foto: todas las lecturas del periodo ven el mismo instante (H-014-2).
    return this.db.withTenant({ ...contextoDe(sesion), foto: true }, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const { estado } = await leerEstadoPeriodo(tx, clienteId, periodo);
      let original = cero();
      let vigente = cero();
      let conIgv = cero();
      let sinIgv = cero();
      let nConIgv = 0;
      let nSinIgv = 0;
      const sinConvertir = new Set<string>();
      try {
        let despuesDe: string | null = null;
        for (;;) {
          const lote = await leerLoteParaResumen(tx, clienteId, periodo, despuesDe, TAMANO_LOTE);
          if (lote.length === 0) break;
          const tiposCambio = new Map<string, string>();
          for (const c of lote) if (c.tipoCambio !== null) tiposCambio.set(c.id, c.tipoCambio);
          const r = resumirCompras(lote.map(aCompraResumen), tiposCambio);
          original = sumar(original, r.casilleros.original);
          vigente = sumar(vigente, r.casilleros.vigente);
          conIgv = sumar(conIgv, r.conIgv.casilleros);
          sinIgv = sumar(sinIgv, r.sinIgv.casilleros);
          nConIgv += r.conIgv.n;
          nSinIgv += r.sinIgv.n;
          for (const id of r.filasSinConvertir) sinConvertir.add(id);
          despuesDe = lote[lote.length - 1]!.id;
          if (lote.length < TAMANO_LOTE) break;
        }
        return {
          estado,
          casilleros: { original: cadenas(original), vigente: cadenas(vigente), diferencia: cadenas(restar(vigente, original)) },
          conIgv: { n: nConIgv, casilleros: cadenas(conIgv) },
          sinIgv: { n: nSinIgv, casilleros: cadenas(sinIgv) },
          filasSinConvertir: [...sinConvertir].sort(),
        };
      } catch (e) {
        if (e instanceof MontoFueraDeRangoError) throw new ComprasError("resumen_fuera_de_rango");
        throw e;
      }
    });
  }
}
