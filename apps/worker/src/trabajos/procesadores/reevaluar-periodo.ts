// Procesador de `compras.reevaluar` (spec 027, R-12; CA-12, CA-15): «Volver a evaluar» las compras vivas de un cliente y periodo
// con el diccionario, el umbral, las categorías y la caché de CIIU de AHORA. Solo en un periodo `abierto`.
//  (1) Parámetros revalidados con el catálogo ANTES de abrir ninguna transacción: `ErrorDatos` fijo que no repite lo recibido.
//  (2) Por lotes de 200 compras (por id), UNA transacción por lote: `compra_periodo` `FOR SHARE` (primer bloqueo, 014); si el periodo
//      ya no está `abierto` (al empezar o a mitad del trabajo) termina con lo hecho: `detenido`. Después arma el contexto de R-GP
//      (`contextoGastos`: solo LEE la caché de CIIU, no consulta a nadie) y agrega la evaluación `n + 1` solo a las compras cuyos
//      hallazgos cambian (`reevaluarLoteSiCambia`): no crea versiones ni mueve el puntero. Sin UPDATE sobre `compra` (0038), bloquea
//      con la función acotada.
// `resultado` = solo conteos `{ revisadas, cambiadas, detenido }`. Un fallo de BD sube tal cual para que el ejecutor decida (lo ya
// confirmado de lotes anteriores se conserva y la repetición solo agrega lo que aún cambie). Nada de glosas, XML ni montos llega a
// logs, errores ni al `resultado`.
import {
  leerEstadoPeriodo,
  leerProveedoresConocidos,
  leerReglasMotor,
  reevaluarLoteSiCambia,
  type ContappDb,
} from "@contapp/db";
import { COMPRAS_REEVALUAR } from "@contapp/queue";
import { ErrorDatos } from "@contapp/sunat";
import type { Procesador } from "../ejecutor.js";
import { crearEvaluarCompras } from "../persistidores/compras-evaluar.js";
import { codigosApagados } from "../persistidores/compras-historial.js";
import { leerPerfilCliente, leerProveedoresConRegla } from "../persistidores/compras-std.js";
import { contextoGastos } from "../persistidores/contexto-gastos.js";
import type { LoggerTrabajos } from "../registro.js";

export interface DepsReevaluarPeriodo {
  db: Pick<ContappDb, "withTenant">;
  logger?: LoggerTrabajos;
}

/** Compras por transacción (plan 027, Worker). */
const LOTE = 200;

/** Devuelve `{ revisadas, cambiadas, detenido }` (solo conteos). */
export function reevaluarPeriodo(d: DepsReevaluarPeriodo): Procesador {
  return async ({ trabajo: t }) => {
    const p = COMPRAS_REEVALUAR.parametros.safeParse(t.parametros);
    if (!p.success) throw new ErrorDatos(); // sin repetir lo recibido
    const { periodo } = p.data;
    const estudio = { tenantId: t.tenantId };
    const enReglas = process.env.XML_SIMULADO_EN_REGLAS === "1";

    let revisadas = 0;
    let cambiadas = 0;
    let detenido = false;
    let despuesDe: string | null = null;
    for (;;) {
      const lote = await d.db.withTenant(estudio, async (tx) => {
        const estado = await leerEstadoPeriodo(tx, t.clienteId, periodo, { compartido: true });
        if (estado.estado !== "abierto") return null;
        // Mismo orden de lectura que la descarga y el XML: reglas, perfil y proveedores con regla; después las compras.
        const reglasApagadas = codigosApagados(await leerReglasMotor(tx));
        const perfil = await leerPerfilCliente(tx, t.clienteId);
        const proveedoresConRegla = await leerProveedoresConRegla(tx, t.clienteId);
        const conocidos = await leerProveedoresConocidos(tx, t.clienteId, periodo);
        return reevaluarLoteSiCambia(tx, t.clienteId, periodo, despuesDe, LOTE, {
          // El contexto de gastos (CIIU e historial) es el de los proveedores del lote.
          evaluarDe: async (compras) =>
            crearEvaluarCompras(conocidos, {
              xmlSimuladoEnReglas: enReglas,
              reglasApagadas,
              proveedoresConRegla,
              perfil,
              gastos: await contextoGastos(
                tx,
                t.clienteId,
                periodo,
                compras.map((c) => ({ tipo: c.docTipo, numero: c.docNumero })),
              ),
            }),
          bloqueo: "funcion",
        });
      });
      if (lote === null) {
        detenido = true;
        break;
      }
      if (lote.ultimoId === null) break;
      revisadas += lote.revisadas;
      cambiadas += lote.cambiadas;
      despuesDe = lote.ultimoId;
    }
    return { revisadas, cambiadas, detenido };
  };
}
