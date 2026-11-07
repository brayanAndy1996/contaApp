// Persistidor de compras (spec 014, T13; D-1, D-3, D-4, D-18, DU-17, DU-20, DU-21). Valida con `Money`/`TipoCambio` del dominio y
// delega en `packages/db` (`leerExistentesCompras`, `insertarCompras`). Una compra descuadrada pero legible se guarda tal cual
// llegó (D-3); una ilegible lanza `fila_invalida` sin contenido y no se guarda nada de la descarga.
//
// Clave (`claveComprobante`): `tipo|SERIE|numero|tipoDoc|DOC`. Comparación (D-18): fecha, moneda, tipo de cambio, documento del
// proveedor, las 10 columnas de monto y el total, con los mismos nombres y escala que devuelve `leerExistentesCompras`; nunca
// la razón social. Lo guardado se compara con su versión 1 (el original del SIRE), no con lo que el usuario corrigió después.
import {
  insertarCompras,
  leerEstadoPeriodo,
  leerExistentesCompras,
  leerProveedoresConocidos,
  tipoCambioConEscala,
  type CompraNueva,
  type MontosCompra,
} from "@contapp/db";
import { Money, TipoCambio, claveComprobante } from "@contapp/domain";
import { ErrorDatos, type FilaPropuestaSire } from "@contapp/sunat";
import { crearEvaluarCompras } from "./compras-evaluar.js";
import { ErrorPropuesta } from "./errores.js";
import type {
  ContextoPersistidor,
  FilaPreparada,
  PersistidorLibro,
  TxPersistidor,
} from "./tipos.js";

/** Tipo de documento del proveedor cuando no se informa: RUC. */
const TIPO_DOC_PROVEEDOR_AUSENTE = "6";
const MAX_RAZON_SOCIAL = 200;

const TIPO = /^[0-9]{2}$/;
const SERIE = /^[0-9A-Za-z]{1,4}$/;
const NUMERO = /^[0-9A-Za-z]{1,20}$/;
const TIPO_DOC = /^[0-9A-Za-z]$/;
const DOCUMENTO = /^[0-9A-Za-z][0-9A-Za-z-]{0,19}$/;
const FECHA = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MINUSCULA_ASCII = /[a-z]/g;

/** Las 10 columnas de monto (la décima se llama `otros` en la propuesta y `otrosTributos` en la tabla) y el total. */
const COLUMNAS: ReadonlyArray<
  readonly [keyof FilaPropuestaSire, keyof MontosCompra]
> = [
  ["biDg", "biDg"],
  ["igvDg", "igvDg"],
  ["biDgng", "biDgng"],
  ["igvDgng", "igvDgng"],
  ["biDng", "biDng"],
  ["igvDng", "igvDng"],
  ["noGravado", "noGravado"],
  ["isc", "isc"],
  ["icbper", "icbper"],
  ["otros", "otrosTributos"],
  ["total", "total"],
];

const enMayusculas = (s: string): string =>
  s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());

/** Ni el campo ni el valor: solo que una fila no se pudo leer. */
const ilegible = (): never => {
  throw new ErrorPropuesta("fila_invalida");
};

/** Solo propiedades propias: un valor heredado de Object.prototype no cuenta. */
function leer(o: object, nombre: string): unknown {
  return Object.hasOwn(o, nombre)
    ? (o as Record<string, unknown>)[nombre]
    : undefined;
}

function texto(o: object, nombre: string, patron: RegExp): string {
  const v = leer(o, nombre);
  return typeof v === "string" && patron.test(v) ? v : ilegible();
}

/** AAAA-MM-DD existente en el calendario (sin depender de la zona horaria). */
function fechaReal(o: object): string {
  const v = leer(o, "fechaEmision");
  const m = typeof v === "string" ? FECHA.exec(v) : null;
  if (m === null) return ilegible();
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (
    anio < 1 ||
    d.getUTCFullYear() !== anio ||
    d.getUTCMonth() !== mes - 1 ||
    d.getUTCDate() !== dia
  )
    return ilegible();
  return v as string;
}

function monto(v: unknown, moneda: "PEN" | "USD"): string {
  if (typeof v !== "string") return ilegible();
  try {
    return Money.desde(v, moneda).toString();
  } catch {
    // Solo errores de dinero (cadena mal formada o fuera de NUMERIC(14,2)); no se repite el valor.
    return ilegible();
  }
}

/** Tipo de cambio con la escala de NUMERIC(7,3), o `null` si no hay. En PEN no se guarda (la compra no se convierte). */
function tipoCambio(o: object, moneda: "PEN" | "USD"): string | null {
  const v = leer(o, "tipoCambio");
  if (moneda === "PEN" || v === undefined || v === null || v === "")
    return null;
  try {
    TipoCambio.desde(v as string);
  } catch {
    return ilegible();
  }
  return tipoCambioConEscala(v as string);
}

function razonSocial(o: object): string | null {
  const v = leer(o, "razonSocialContraparte");
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return ilegible();
  // La tabla limita a 200 caracteres; una razón social más larga se recorta y no tumba la descarga.
  const puntos = Array.from(v);
  return puntos.length > MAX_RAZON_SOCIAL
    ? puntos.slice(0, MAX_RAZON_SOCIAL).join("")
    : v;
}

function prepararFila(cruda: unknown): FilaPreparada<CompraNueva> {
  if (typeof cruda !== "object" || cruda === null || Array.isArray(cruda))
    return ilegible();
  const tipo = texto(cruda, "tipo", TIPO);
  const serie = enMayusculas(texto(cruda, "serie", SERIE));
  const numero = texto(cruda, "numero", NUMERO);
  const docNumero = enMayusculas(
    texto(cruda, "rucContraparte", DOCUMENTO),
  );
  const tipoDocCruda = leer(cruda, "tipoDocContraparte");
  const docTipo =
    tipoDocCruda === undefined || tipoDocCruda === null || tipoDocCruda === ""
      ? TIPO_DOC_PROVEEDOR_AUSENTE
      : texto(cruda, "tipoDocContraparte", TIPO_DOC);
  const fecha = fechaReal(cruda);
  const monedaCruda = leer(cruda, "moneda");
  if (monedaCruda !== "PEN" && monedaCruda !== "USD") return ilegible();
  const moneda = monedaCruda;
  const tc = tipoCambio(cruda, moneda);

  const montos = {} as Record<keyof MontosCompra, string>;
  for (const [propuesta, columna] of COLUMNAS)
    montos[columna] = monto(leer(cruda, propuesta), moneda);

  const clave = claveComprobante(
    { tipo, serie, numero },
    { tipo: docTipo, numero: docNumero },
  );
  // Las tres primeras partes las lee `partesDeClave` (013): una `|` dentro de alguna rompería la clave. Los patrones ya
  // las excluyen; esta comprobación deja la garantía junto a la clave.
  if (clave.split("|").length !== 5) return ilegible();

  return {
    clave,
    tipo,
    serie,
    numero,
    campos: {
      fecha,
      moneda,
      tipoCambio: tc ?? "",
      docTipo,
      docNumero,
      ...montos,
    },
    datos: {
      clave,
      tipoDoc: tipo,
      serie,
      numero,
      docTipo,
      docNumero,
      razonSocial: razonSocial(cruda),
      fecha,
      moneda,
      tipoCambio: tc,
      montos,
    },
  };
}

export const persistidorCompras: PersistidorLibro<CompraNueva> = {
  preparar(filas: readonly unknown[]) {
    return filas.map(prepararFila);
  },

  async leerExistentes(tx: TxPersistidor, ctx: ContextoPersistidor) {
    // `FOR SHARE` sobre el estado del periodo (y lo crea `abierto` si falta): una marca de `generado` concurrente espera a esta
    // transacción. `generado` rechaza la descarga antes de crear la propuesta; `revisado` se acepta (DU-21).
    const estado = await leerEstadoPeriodo(tx, ctx.clienteId, ctx.periodo, {
      compartido: true,
    });
    if (estado.estado === "generado") throw new ErrorDatos();
    return leerExistentesCompras(tx, ctx.clienteId, ctx.periodo);
  },

  async insertar(tx, ctx, propuestaId, nuevas) {
    if (nuevas.length === 0) return;
    const conocidos = await leerProveedoresConocidos(
      tx,
      ctx.clienteId,
      ctx.periodo,
    );
    await insertarCompras(
      tx,
      { clienteId: ctx.clienteId, periodo: ctx.periodo, propuestaId },
      nuevas.map((n) => n.datos),
      { evaluar: crearEvaluarCompras(conocidos) },
    );
  },
};
