import { Inject, Injectable } from "@nestjs/common";
import {
  aplicarComplemento,
  existenteComplementable,
  hashContenido,
  insertarVentas,
  leerExistentes,
  prepararFilaVenta,
  type Alcance,
  type ContappDb,
  type FilaComplementable,
  type VentaNueva,
} from "@contapp/db";
import {
  claveNormalizada,
  LAYOUT_VENTAS_PROVISIONAL,
  planificarComplemento,
  validarFilaVenta,
  type ErrorFilaVenta,
  type FilaVentaValida,
} from "@contapp/domain";
import type { MotivoFilaVenta, PropuestaVentasDto, VistaPreviaVentas } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { leerCsvTabla } from "../importacion/lector-csv.js";
import { leerXlsxTabla } from "../importacion/lector-xlsx.js";
import { columnasDePerfil, type FilaTabla, type PerfilTabla } from "../importacion/tabla.js";
import { ErrorArchivo, LIMITES_VENTAS } from "../importacion/tipos.js";
import { aPropuestaDto, exigirCliente, periodoDe } from "./apoyo.js";
import { VentasError } from "./errores.js";

/** Tope de filas de un archivo y de filas vivas de un periodo (P-9, D10): el mismo de la descarga del worker. */
const TOPE_FILAS = LIMITES_VENTAS.maxFilas;

/** Columnas del layout provisional de 009/013 (D6, D14b): sus nombres son los campos de `FilaVentaSire`. */
const PERFIL_VENTAS: PerfilTabla<string> = {
  limites: LIMITES_VENTAS,
  columnas: columnasDePerfil(LAYOUT_VENTAS_PROVISIONAL.columnas.map((c) => c.nombre)),
  obligatorias: LAYOUT_VENTAS_PROVISIONAL.columnas.filter((c) => c.obligatoria).map((c) => c.nombre),
};

/** Códigos de `validarFilaVenta` (MAYÚSCULAS) → lista cerrada de motivos de `shared`. */
const MOTIVO: Readonly<Record<string, MotivoFilaVenta>> = {
  CAMPO_OBLIGATORIO: "campo_obligatorio",
  FILA_INVALIDA: "campo_obligatorio",
  TIPO_INVALIDO: "tipo_invalido",
  SERIE_INVALIDA: "serie_invalida",
  NUMERO_INVALIDO: "numero_invalido",
  FECHA_INVALIDA: "fecha_invalida",
  MONEDA_INVALIDA: "moneda_invalida",
  TIPO_CAMBIO_INVALIDO: "tipo_cambio_invalido",
  TIPO_CAMBIO_SOLO_EN_USD: "tipo_cambio_invalido",
  DOCUMENTO_INVALIDO: "documento_invalido",
  TIPO_DOCUMENTO_INVALIDO: "documento_invalido",
  MONTO_INVALIDO: "monto_invalido",
};

/**
 * Una celda que una hoja de cálculo evaluaría: empieza (tras espacios) por `=` o `@`, por `+` o `-` sin ser un número
 * (o el «-» solo del consumidor final), o trae un carácter de control. Las notas de crédito en negativo no lo son.
 */
function esPeligrosa(celda: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(celda)) return true;
  const t = celda.replace(/^[\s﻿]+/u, "");
  if (t === "") return false;
  if (t.startsWith("=") || t.startsWith("@")) return true;
  if (t.startsWith("+") || t.startsWith("-")) return !/^(?:-|[+-]\d+(?:\.\d+)?)$/.test(t.trimEnd());
  return false;
}

/** Motivos de una fila inválida, sin repetir y en el orden en que se encontraron. */
function motivosDe(errores: readonly ErrorFilaVenta[]): MotivoFilaVenta[] {
  return [...new Set(errores.map((e) => MOTIVO[e.codigo] ?? "campo_obligatorio"))];
}

interface FilaEvaluada {
  n: number;
  motivos: MotivoFilaVenta[];
  /** Presente solo si la fila es válida. */
  fila?: FilaVentaValida;
}

/** Evalúa una fila del archivo: una celda peligrosa la descarta sin más; si no, la juzga `validarFilaVenta` (dominio). */
function evaluar(f: FilaTabla<string>): FilaEvaluada {
  if (f.formulas.length > 0 || Object.values(f.valores).some(esPeligrosa)) {
    return { n: f.n, motivos: ["celda_peligrosa"] };
  }
  const cruda: Record<string, string> = {};
  for (const [campo, valor] of Object.entries(f.valores)) {
    const v = valor.trim();
    if (v !== "") cruda[campo] = v;
  }
  // La serie se guarda en mayúsculas, como la de una venta agregada a mano, para no crear una serie aparte (D7).
  if (cruda["serie"] !== undefined) cruda["serie"] = cruda["serie"].toUpperCase();
  const r = validarFilaVenta(cruda);
  return r.ok ? { n: f.n, motivos: [], fila: r.fila } : { n: f.n, motivos: motivosDe(r.errores) };
}

/** Un `.xlsx` es un zip (`PK`); lo demás se lee como texto (`.csv`/`.txt` con `,` o `;`). */
const esZip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b;

/** Error del lector → código de ventas; el mensaje nunca lleva el contenido de una celda. */
function errorDeArchivo(e: ErrorArchivo): VentasError {
  return new VentasError(e.codigo === "demasiadas_filas" ? "propuesta_demasiado_grande" : e.codigo);
}

/** El archivo llega crudo (`Buffer`, analizado en `crearApp`); cualquier otro cuerpo no es un archivo. */
function leerArchivo(cuerpo: unknown): FilaEvaluada[] {
  if (!(cuerpo instanceof Uint8Array)) throw new VentasError("archivo_invalido");
  try {
    const filas = esZip(cuerpo) ? leerXlsxTabla(cuerpo, PERFIL_VENTAS) : leerCsvTabla(cuerpo, PERFIL_VENTAS);
    return filas.map(evaluar);
  } catch (e) {
    if (e instanceof ErrorArchivo) throw errorDeArchivo(e);
    throw e;
  }
}

/**
 * Con `NODE_ENV=production` el layout provisional no importa (D6). Se lee en cada petición y jamás de la petición; va
 * después de la autorización (guards) y antes de leer el archivo.
 */
function exigirLayoutOficial(): void {
  if (process.env["NODE_ENV"] === "production" && !LAYOUT_VENTAS_PROVISIONAL.oficial) {
    throw new VentasError("layout_no_oficial");
  }
}

/**
 * Importación de la propuesta de ventas desde `.xlsx`/`.csv`/`.txt` con el layout provisional (RF-051; spec 013, D3, D6, D10,
 * D16, D18). El archivo vive solo en memoria: ni a disco ni a logs ni en la respuesta. No pasa por la cola ni toca SUNAT.
 * `vistaPrevia` no escribe nada; `confirmar` revalida todo y aplica el mismo complemento que la descarga
 * (`aplicarComplemento` de `packages/db`), todo o nada.
 */
@Injectable()
export class ImportarPropuestaService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async vistaPrevia(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<VistaPreviaVentas> {
    periodoDe(periodoCrudo);
    exigirLayoutOficial();
    await this.db.withTenant(contextoDe(sesion), (tx) => exigirCliente(tx, clienteId, alcance, false));
    const filas = leerArchivo(cuerpo);
    const validas = filas.filter((f) => f.fila !== undefined).length;
    return {
      filas: filas.map((f) => ({ n: f.n, estado: f.fila === undefined ? "error" : "valida", motivos: f.motivos })),
      validas,
      conError: filas.length - validas,
    };
  }

  async confirmar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<{ propuesta: PropuestaVentasDto }> {
    const periodo = periodoDe(periodoCrudo);
    exigirLayoutOficial();
    const ctx = contextoDe(sesion);
    // Un cliente archivado se rechaza antes de leer el archivo; la transacción de abajo lo repite al escribir.
    await this.db.withTenant(ctx, (tx) => exigirCliente(tx, clienteId, alcance, true));
    const evaluadas = leerArchivo(cuerpo);
    // Todo o nada (D3): una fila con error, o con una fórmula, y no se guarda nada ni el encabezado.
    if (evaluadas.some((f) => f.fila === undefined)) throw new VentasError("filas_con_errores");

    const filas = evaluadas.map((e) => {
      const f = e.fila as FilaVentaValida;
      return {
        ...prepararFilaVenta(f, claveNormalizada(f.tipo, f.serie, f.numero)),
        tipo: f.tipo,
        serie: f.serie,
        numero: f.numero,
      };
    });
    const hash = hashContenido("ventas", periodo, filas);

    const propuesta = await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      const aplicado = await aplicarComplemento<FilaComplementable<VentaNueva>, typeof tx>(tx, {
        clienteId,
        periodo,
        libro: "ventas",
        fuente: "importacion",
        hash,
        usuarioId: ctx.userId,
        trabajoId: null,
        filas,
        topeVivas: TOPE_FILAS,
        leerExistentes: async (x) => (await leerExistentes(x, clienteId, periodo)).map(existenteComplementable),
        planificar: planificarComplemento,
        insertar: (x, propuestaId, nuevas) =>
          insertarVentas(
            x,
            { clienteId, periodo, propuestaId },
            nuevas.map((n) => n.datos),
          ),
      });
      if (aplicado.excedeTope) throw new VentasError("propuesta_demasiado_grande");
      return aplicado.propuesta;
    });
    return { propuesta: aPropuestaDto(propuesta) };
  }
}
