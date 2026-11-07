// Persistidor de ventas (spec 013, D2, D3, D16, D17). Valida con `validarFilaVenta` (dominio) y delega la normalización de
// lo recibido en `prepararFilaVenta` de `packages/db`, la misma que usa la importación del backend. Una venta descuadrada
// pero legible se guarda tal cual llegó (D3).
//
// Comparación (D16): fecha, moneda, tipo de cambio, tipo y número de documento y los 8 montos; nunca la razón social.
// Lo recibido se normaliza como `leerExistentes` devuelve lo guardado (ver `packages/db/src/ventas/preparacion.ts`).
import {
  existenteComplementable,
  insertarVentas,
  leerExistentes,
  prepararFilaVenta,
  TIPO_DOC_AUSENTE,
  tipoCambioConEscala,
  type VentaNueva,
} from "@contapp/db";
import { claveNormalizada, validarFilaVenta } from "@contapp/domain";
import { ErrorPropuesta } from "./errores.js";
import type {
  ContextoPersistidor,
  FilaPreparada,
  PersistidorLibro,
  TxPersistidor,
} from "./tipos.js";

export { TIPO_DOC_AUSENTE, tipoCambioConEscala };

function preparar(filas: readonly unknown[]): FilaPreparada<VentaNueva>[] {
  return filas.map((cruda) => {
    const r = validarFilaVenta(cruda);
    // Ni el campo ni el valor: solo que una fila no se pudo leer.
    if (!r.ok) throw new ErrorPropuesta("fila_invalida");
    const f = r.fila;
    return {
      ...prepararFilaVenta(f, claveNormalizada(f.tipo, f.serie, f.numero)),
      tipo: f.tipo,
      serie: f.serie,
      numero: f.numero,
    };
  });
}

export const persistidorVentas: PersistidorLibro<VentaNueva> = {
  preparar,
  async leerExistentes(tx: TxPersistidor, ctx: ContextoPersistidor) {
    const existentes = await leerExistentes(tx, ctx.clienteId, ctx.periodo);
    return existentes.map(existenteComplementable);
  },
  async insertar(tx, ctx, propuestaId, nuevas) {
    await insertarVentas(
      tx,
      { clienteId: ctx.clienteId, periodo: ctx.periodo, propuestaId },
      nuevas.map((n) => n.datos),
    );
  },
};
