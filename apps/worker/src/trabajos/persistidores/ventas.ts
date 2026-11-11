// Persistidor de ventas (spec 013, D2, D3, D16, D17). Valida con `validarFilaVenta` (dominio) y delega la normalización de
// lo recibido en `prepararFilaVenta` de `packages/db`, la misma que usa la importación del backend. Una venta descuadrada
// pero legible se guarda tal cual llegó (D3).
//
// Comparación (D16): fecha, moneda, tipo de cambio, tipo y número de documento y los 8 montos; nunca la razón social.
// Lo recibido se normaliza como `leerExistentes` devuelve lo guardado (ver `packages/db/src/ventas/preparacion.ts`).
// Spec 012b: con el periodo de ventas `generado`, la descarga termina en `ErrorDatos` sin crear nada.
import {
  existenteComplementable,
  insertarVentas,
  leerEstadoPeriodoVentas,
  leerExistentes,
  prepararFilaVenta,
  serieEnMayusculas,
  TIPO_DOC_AUSENTE,
  tipoCambioConEscala,
  type VentaNueva,
} from "@contapp/db";
import { claveNormalizada, validarFilaVenta } from "@contapp/domain";
import { ErrorDatos } from "@contapp/sunat";
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
      serie: serieEnMayusculas(f.serie),
      numero: f.numero,
    };
  });
}

export const persistidorVentas: PersistidorLibro<VentaNueva> = {
  preparar,
  async leerExistentes(tx: TxPersistidor, ctx: ContextoPersistidor) {
    // Spec 012b (D5, P-1): `FOR SHARE` sobre el estado del periodo de ventas (y lo crea `abierto` si falta), como compras en
    // 014: una marca de `generado` concurrente espera a esta transacción. `generado` rechaza la descarga antes de crear la
    // propuesta; `revisado` se acepta (P-9: el permiso se mira al encolar).
    const estado = await leerEstadoPeriodoVentas(tx, ctx.clienteId, ctx.periodo, {
      compartido: true,
    });
    if (estado.estado === "generado") throw new ErrorDatos();
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
