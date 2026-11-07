// Persistidor de ventas (spec 013, D2, D3, D16, D17). Valida con `validarFilaVenta` (dominio), arma los `campos` que se
// comparan y delega la lectura y la inserción en los repositorios de `packages/db`. Una venta descuadrada pero legible
// se guarda tal cual llegó (D3).
//
// Comparación (D16): fecha, moneda, tipo de cambio, tipo y número de documento y los 8 montos; nunca la razón social.
// Los campos se llaman como los de `FilaVentaSire`. Lo recibido se normaliza como `leerExistentes` devuelve lo guardado:
// montos con 2 decimales (ya lo deja `validarFilaVenta`), tipo de cambio con los 3 de NUMERIC(7,3) y cadena vacía si
// falta, y tipo de documento «0» si falta (es lo que se guarda).
import {
  insertarVentas,
  leerExistentes,
  type ExistenteVenta,
  type VentaNueva,
} from "@contapp/db";
import {
  claveNormalizada,
  validarFilaVenta,
  type ExistenteComplemento,
} from "@contapp/domain";
import { ErrorPropuesta } from "./errores.js";
import type {
  ContextoPersistidor,
  FilaPreparada,
  PersistidorLibro,
  TxPersistidor,
} from "./tipos.js";

/** Tipo de documento de la contraparte cuando el SIRE no lo trae. */
export const TIPO_DOC_AUSENTE = "0";
const DECIMALES_TIPO_CAMBIO = 3;

/** «3.3» → «3.300». La gramática de dominio ya limita a 3 decimales, así que solo se completan ceros. */
export function tipoCambioConEscala(tc: string): string {
  const [entera = "", fraccion = ""] = tc.split(".");
  return `${entera}.${fraccion.padEnd(DECIMALES_TIPO_CAMBIO, "0")}`;
}

function preparar(filas: readonly unknown[]): FilaPreparada<VentaNueva>[] {
  return filas.map((cruda) => {
    const r = validarFilaVenta(cruda);
    // Ni el campo ni el valor: solo que una fila no se pudo leer.
    if (!r.ok) throw new ErrorPropuesta("fila_invalida");
    const f = r.fila;
    const clave = claveNormalizada(f.tipo, f.serie, f.numero);
    const tipoCambio =
      f.tipoCambio === undefined ? null : tipoCambioConEscala(f.tipoCambio);
    const tipoDocContraparte = f.tipoDocContraparte ?? TIPO_DOC_AUSENTE;
    return {
      clave,
      tipo: f.tipo,
      serie: f.serie,
      numero: f.numero,
      campos: {
        fechaEmision: f.fechaEmision,
        moneda: f.moneda,
        tipoCambio: tipoCambio ?? "",
        tipoDocContraparte,
        docContraparte: f.docContraparte,
        baseGravada: f.baseGravada,
        igv: f.igv,
        exonerada: f.exonerada,
        inafecta: f.inafecta,
        isc: f.isc,
        icbper: f.icbper,
        otros: f.otros,
        total: f.total,
      },
      datos: {
        clave,
        tipo: f.tipo,
        serie: f.serie,
        numero: f.numero,
        fecha: f.fechaEmision,
        tipoDocContraparte,
        docContraparte: f.docContraparte,
        moneda: f.moneda,
        tipoCambio,
        baseGravada: f.baseGravada,
        igv: f.igv,
        exonerada: f.exonerada,
        inafecta: f.inafecta,
        isc: f.isc,
        icbper: f.icbper,
        otros: f.otros,
        total: f.total,
      },
    };
  });
}

/** `leerExistentes` nombra la fecha `fecha` (columna); la comparación usa el nombre de `FilaVentaSire`. */
function aComplemento(e: ExistenteVenta): ExistenteComplemento {
  const { fecha, ...resto } = e.campos;
  return {
    clave: e.clave,
    origen: e.origen,
    campos: { fechaEmision: fecha as string, ...resto },
  };
}

export const persistidorVentas: PersistidorLibro<VentaNueva> = {
  preparar,
  async leerExistentes(tx: TxPersistidor, ctx: ContextoPersistidor) {
    const existentes = await leerExistentes(tx, ctx.clienteId, ctx.periodo);
    return existentes.map(aComplemento);
  },
  async insertar(tx, ctx, propuestaId, nuevas) {
    await insertarVentas(
      tx,
      { clienteId: ctx.clienteId, periodo: ctx.periodo, propuestaId },
      nuevas.map((n) => n.datos),
    );
  },
};
