import { Inject, Injectable } from "@nestjs/common";
import { listarCompras, type Alcance, type ContappDb, type CursorListadoCompras } from "@contapp/db";
import { Money } from "@contapp/domain";
import type { FilaCompraVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { exigirCliente, periodoDe } from "./apoyo.js";
import { aFilaVista } from "./vistas.js";
import { generarLibro, type CeldaXlsx, type ColumnaXlsx, type HojaXlsx } from "./escritor-xlsx.js";

/** Compras por lote al leer el periodo (DU-20): acota la memoria de la lectura sin tope de filas. */
const TAMANO_LOTE = 2000;

/** Casilleros de montos, en el orden de las columnas de 010 y el total. */
const MONTOS = [
  ["biDg", "BI gravada (DG)"],
  ["igvDg", "IGV (DG)"],
  ["biDgng", "BI gravada (DGNG)"],
  ["igvDgng", "IGV (DGNG)"],
  ["biDng", "BI gravada (DNG)"],
  ["igvDng", "IGV (DNG)"],
  ["noGravado", "No gravado"],
  ["isc", "ISC"],
  ["icbper", "ICBPER"],
  ["otrosTributos", "Otros tributos"],
  ["total", "Total"],
] as const;

const COLUMNAS: readonly ColumnaXlsx[] = [
  { titulo: "Fecha", ancho: 12 },
  { titulo: "Tipo", ancho: 8 },
  { titulo: "Serie", ancho: 8 },
  { titulo: "Número", ancho: 14 },
  { titulo: "Tipo doc. proveedor", ancho: 12 },
  { titulo: "N.º doc. proveedor", ancho: 16 },
  { titulo: "Razón social", ancho: 44 },
  { titulo: "Moneda", ancho: 9 },
  { titulo: "Tipo de cambio", ancho: 14 },
  ...MONTOS.map(([, titulo]) => ({ titulo, ancho: 16 })),
  { titulo: "Origen", ancho: 10 },
  { titulo: "Versión", ancho: 9 },
  { titulo: "Motivo de exclusión", ancho: 32 },
];

const texto = (valor: string | null): CeldaXlsx => (valor === null ? null : { tipo: "texto", valor });

/**
 * Una compra vigente como fila del Excel. Cada monto pasa por `Money` (valida rango y escala de NUMERIC(14,2)) y se escribe como
 * número desde su cadena exacta; la razón social y el motivo, que vienen del SIRE o del usuario, se neutralizan al escribirlos.
 */
function filaExcel(f: FilaCompraVista): CeldaXlsx[] {
  return [
    texto(f.fecha),
    texto(f.tipo),
    texto(f.serie),
    texto(f.numero),
    texto(f.proveedor.tipo),
    texto(f.proveedor.numero),
    texto(f.proveedor.razonSocial),
    texto(f.moneda),
    texto(f.tipoCambio),
    ...MONTOS.map(([k]): CeldaXlsx => ({ tipo: "monto", valor: Money.desde(f.montos[k], f.moneda).toString() })),
    texto(f.origen === "agregada" ? "Agregada" : "SIRE"),
    { tipo: "entero", valor: f.version },
    texto(f.motivo),
  ];
}

/**
 * Excel de las compras del periodo (spec 014, D-17, RF-105, DU-11, DU-20). Se genera en memoria en el servidor: una hoja con las
 * vigentes (sin descartadas) y otra con las excluidas. Lee todo el periodo por lotes con cursor, sin tope de 5.000. No consulta
 * SUNAT ni toca credenciales; el nombre del archivo solo lleva el periodo.
 */
@Injectable()
export class ExportarComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async exportar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<{ nombre: string; datos: Uint8Array }> {
    const periodo = periodoDe(periodoCrudo);
    // Una foto: todas las lecturas del periodo ven el mismo instante (H-014-2).
    const hojas = await this.db.withTenant({ ...contextoDe(sesion), foto: true }, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const leer = async (vista: "excluidas" | undefined): Promise<CeldaXlsx[][]> => {
        const filas: CeldaXlsx[][] = [];
        let cursor: CursorListadoCompras | undefined;
        for (;;) {
          const pagina = await listarCompras(tx, clienteId, periodo, {
            limite: TAMANO_LOTE,
            ...(vista === undefined ? {} : { vista }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const l of pagina.filas) filas.push(filaExcel(aFilaVista(l.compra, l.proveedorNuevo, [])));
          if (pagina.siguiente === null) return filas;
          cursor = pagina.siguiente;
        }
      };
      const vigentes = await leer(undefined);
      const excluidas = await leer("excluidas");
      return [
        { nombre: "Compras", columnas: COLUMNAS, filas: vigentes },
        { nombre: "Excluidas", columnas: COLUMNAS, filas: excluidas },
      ] satisfies HojaXlsx[];
    });
    return { nombre: `compras-${periodo}.xlsx`, datos: generarLibro(hojas) };
  }
}
