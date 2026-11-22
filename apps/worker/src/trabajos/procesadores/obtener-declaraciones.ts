// Procesador `sol.declaraciones.descargar` (spec 026, plan «Worker»; D-1 a D-3, D-7; CA-1, CA-7, CA-10, CA-11). Obtiene del portal
// SOL las presentaciones del PDT 621 de los 12 periodos de la ventana (M−11..M) y las guarda con la función acotada
// `prorrata_declaraciones_registrar` (0066); nunca toca ventas, compras ni meses manuales.
//  (0) R-1: un periodo posterior al mes en curso en hora de Lima es `ErrorDatos` sin tocar la credencial ni SOL (H-026-1-3).
//  (1) `withTenant` corto: ubica la credencial SOL del cliente (sin transacción abierta al salir).
//  (2) Descifrado auditado, UNA vez por trabajo (003).
//  (3) Una llamada al puerto por periodo, del más reciente al más antiguo, SIN transacción abierta (008 D6). `ErrorDatos` o lista
//      vacía = periodo «sin declaración» y sigue. Cualquier otro error del puerto sale tal cual y sin escribir: el ejecutor
//      (008) lo clasifica como en 023 (credencial -> `credencial_invalida` sin reintento; transitorio reintenta; portal cambió).
//      Una presentación de otro periodo que el pedido es un portal que cambió de contrato: `ErrorPortal`, sin escribir.
//  (4) UNA transacción con una sola llamada a `registrarDeclaraciones`, sin SAVEPOINT. `55000` (cliente archivado entre medio):
//      el trabajo termina `completado` sin escribir; el resto de los SQLSTATE sale para que 008 lo clasifique.
// `resultado` = {periodosLeidos, sinDeclaracion, nuevas}: solo conteos enteros (D-7).
import {
  ProrrataRepoError,
  registrarDeclaraciones,
  type ContappDb,
  type DeclaracionNueva,
} from "@contapp/db";
import { ventanaProrrata } from "@contapp/domain";
import { SOL_DECLARACIONES_DESCARGAR } from "@contapp/queue";
import { ErrorDatos, ErrorPortal, type SolPortal } from "@contapp/sunat";
import type { ServicioCredenciales } from "../../credenciales/descifrar-credencial.js";
import type { Procesador } from "../ejecutor.js";
import {
  descifrarCredencialSol,
  ubicarCredencialSol,
} from "./credencial-sol.js";

export interface DepsObtenerDeclaraciones {
  db: Pick<ContappDb, "withTenant">;
  servicio: ServicioCredenciales;
  solPortal: SolPortal;
}

export interface ResultadoObtenerDeclaraciones {
  periodosLeidos: number;
  sinDeclaracion: number;
  nuevas: number;
}

/** SQLSTATE de «objeto no está en el estado requerido»: el cliente se archivó entre la lectura y la escritura. */
const CLIENTE_ARCHIVADO = "55000";

/** Lima no tiene horario de verano: UTC-5 todo el año (mismo criterio que el backend y el catálogo de la cola). */
const HUSO_LIMA_MS = 5 * 60 * 60 * 1000;

/** Mes en curso en hora de Lima (AAAAMM), con el reloj de `Date` (las pruebas lo fijan con fake timers). */
function periodoEnCursoLima(ahoraMs: number): string {
  const lima = new Date(ahoraMs - HUSO_LIMA_MS);
  return `${lima.getUTCFullYear()}${String(lima.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function obtenerDeclaraciones(d: DepsObtenerDeclaraciones): Procesador {
  return async ({ trabajo: t }) => {
    const params = SOL_DECLARACIONES_DESCARGAR.parametros.safeParse(
      t.parametros,
    );
    if (!params.success) throw new ErrorDatos(); // sin repetir lo recibido
    const periodoHasta = params.data.periodo;
    // R-1 (H-026-1-3): M posterior al mes en curso en Lima no se consulta: antes de ubicar o descifrar la credencial.
    if (periodoHasta > periodoEnCursoLima(Date.now()))
      throw new ErrorDatos();
    const ctx = { tenantId: t.tenantId, trabajoId: t.id };

    // (1) Credencial del cliente; (2) descifrado una sola vez.
    const credencialId = await d.db.withTenant(ctx, (tx) =>
      ubicarCredencialSol(tx, t.clienteId),
    );
    const cred = await descifrarCredencialSol(d, t, credencialId);

    // (3) Del más reciente al más antiguo, sin transacción abierta.
    const leidos = ventanaProrrata(periodoHasta).reverse();
    const sinDeclaracion: string[] = [];
    const declaraciones: DeclaracionNueva[] = [];
    for (const periodo of leidos) {
      let presentaciones: DeclaracionNueva[];
      try {
        presentaciones = await d.solPortal.obtenerDeclaraciones621(cred, {
          periodo,
        });
      } catch (e) {
        if (e instanceof ErrorDatos) {
          sinDeclaracion.push(periodo);
          continue;
        }
        throw e;
      }
      if (presentaciones.length === 0) {
        sinDeclaracion.push(periodo);
        continue;
      }
      if (presentaciones.some((p) => p.periodo !== periodo))
        throw new ErrorPortal();
      declaraciones.push(...presentaciones);
    }

    // (4) Una transacción, una escritura.
    let nuevas = 0;
    try {
      nuevas = await d.db.withTenant(ctx, (tx) =>
        registrarDeclaraciones(tx, {
          clienteId: t.clienteId,
          trabajoId: t.id,
          periodoHasta,
          leidos,
          sinDeclaracion,
          declaraciones,
        }),
      );
    } catch (e) {
      if (!(e instanceof ProrrataRepoError && e.codigo === CLIENTE_ARCHIVADO))
        throw e;
    }
    const r: ResultadoObtenerDeclaraciones = {
      periodosLeidos: leidos.length,
      sinDeclaracion: sinDeclaracion.length,
      nuevas,
    };
    return r;
  };
}
