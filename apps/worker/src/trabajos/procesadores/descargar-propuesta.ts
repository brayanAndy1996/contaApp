// Procesador de `sire.propuesta.descargar` (spec 013, D2, D3, D16, D18; CA-1 a CA-3, CA-11). Común a los libros del SIRE;
// lo propio de cada libro vive en su persistidor (`../persistidores`).
//  (1) Parámetros y persistidor del libro, antes de gastar una llamada: sin persistidor, `libro_no_soportado`.
//  (2) Token y descarga SIN transacción abierta (008 D6): `conToken` y el puerto `SireApiClient`.
//  (3) Tope de 20.000 filas recibidas y validación de TODAS las filas: una ilegible da `ErrorDatos` y no se guarda nada.
//  (4) Una sola `withTenant`: bloqueo advisory (cliente, periodo, libro) -> existentes -> `planificarComplemento` ->
//      `propuesta` -> `propuesta_diferencia` -> filas nuevas. Todo o nada. Sin tope de filas vivas (D19).
// El `resultado` del trabajo lleva solo contadores y hasta 40 claves (≤ 4 KB, sin montos). Nada de lo recibido llega a
// logs ni a mensajes de error: los errores son códigos.
import { aplicarComplemento, hashContenido, type ContappDb } from "@contapp/db";
import { planificarComplemento } from "@contapp/domain";
import { SIRE_PROPUESTA_DESCARGAR } from "@contapp/queue";
import type { SireApiClient } from "@contapp/sunat";
import type { ContextoProcesador } from "../ejecutor.js";
import type { RedisEncolado } from "../encolar-xml.js";
import { registrar, type LoggerTrabajos } from "../registro.js";
import { ErrorPropuesta } from "../persistidores/errores.js";
import { PERSISTIDORES } from "../persistidores/index.js";
import type { PersistidoresLibro } from "../persistidores/tipos.js";

// El hash vive en `packages/db`: la importación del backend lo calcula igual.
export { hashContenido };

/** Tope de filas RECIBIDAS en una descarga (P-9, D10, D19); no limita las filas vivas del periodo. */
export const TOPE_FILAS = 20_000;
/** Claves que lista el `resultado` (la lista completa queda en `propuesta_diferencia`). */
export const TOPE_CLAVES_RESULTADO = 40;

export interface DepsDescargarPropuesta {
  db: Pick<ContappDb, "withTenant">;
  sireApi: SireApiClient;
  /** Por defecto, el registro de `../persistidores`. */
  persistidores?: PersistidoresLibro;
  /** Redis y prefijo con que `trasConfirmar` publica los trabajos que encola (016); sin Redis solo quedan en BD. */
  redis?: RedisEncolado;
  prefijo?: string;
  /** Donde se registra (solo un código) el fallo de `trasConfirmar`; sin logger no se registra. */
  logger?: LoggerTrabajos;
}

export interface ResultadoDescarga {
  propuestaId: string;
  recibidas: number;
  nuevas: number;
  iguales: number;
  distintas: number;
  claves: string[];
  truncado: boolean;
  /** Spec 021 (D-10): compras nuevas movidas por R-HIS; solo si hay alguna, y solo en compras. */
  segunHistorial?: number;
}

function leerParametros(p: unknown) {
  const r = SIRE_PROPUESTA_DESCARGAR.parametros.safeParse(p);
  if (!r.success) throw new ErrorPropuesta("parametros_invalidos");
  return r.data;
}

/** Es un `Procesador` que, además, tipa su resultado (la descarga de 013). */
export function descargarPropuesta(
  d: DepsDescargarPropuesta,
): (ctx: ContextoProcesador) => Promise<ResultadoDescarga> {
  const persistidores = d.persistidores ?? PERSISTIDORES;
  return async ({ trabajo: t, conToken }) => {
    const { periodo, libro } = leerParametros(t.parametros);
    const persistidor = persistidores[libro];
    if (persistidor === undefined) throw new ErrorPropuesta("libro_no_soportado");
    if (t.creadoPor === null) throw new ErrorPropuesta("usuario_requerido");
    const usuarioId = t.creadoPor;

    // El vencimiento del token lo gestiona la caché de 008: el cliente del SIRE solo usa el valor.
    const propuesta = await conToken((token) =>
      d.sireApi.descargarPropuesta(
        { token, expiraEn: new Date(0) },
        { ruc: t.ruc, periodo, libro },
      ),
    );
    if (propuesta.libro !== libro || !Array.isArray(propuesta.filas))
      throw new ErrorPropuesta("respuesta_inconsistente");
    if (propuesta.filas.length > TOPE_FILAS)
      throw new ErrorPropuesta("propuesta_demasiado_grande");

    const preparadas = persistidor.preparar(propuesta.filas);
    const hash = hashContenido(libro, periodo, preparadas);
    const ctx = { clienteId: t.clienteId, periodo };

    const resultado = await d.db.withTenant({ tenantId: t.tenantId, trabajoId: t.id }, async (tx) => {
      let segunHistorial = 0;
      const aplicado = await aplicarComplemento(tx, {
        clienteId: t.clienteId,
        periodo,
        libro,
        fuente: "api",
        hash,
        usuarioId,
        trabajoId: t.id,
        filas: preparadas,
        leerExistentes: (x) => persistidor.leerExistentes(x, ctx),
        planificar: planificarComplemento,
        insertar: async (x, propuestaId, nuevas) => {
          const r = await persistidor.insertar(x, ctx, propuestaId, nuevas);
          if (r !== undefined) segunHistorial = r.segunHistorial;
        },
      });
      const { propuesta: creada, plan } = aplicado;
      const claves = [...new Set(plan.distintas.map((x) => x.clave))];
      const resultado: ResultadoDescarga = {
        propuestaId: creada.id,
        recibidas: preparadas.length,
        nuevas: plan.nuevas.length,
        iguales: plan.iguales,
        distintas: plan.distintas.length,
        claves: claves.slice(0, TOPE_CLAVES_RESULTADO),
        truncado: claves.length > TOPE_CLAVES_RESULTADO,
        ...(segunHistorial > 0 ? { segunHistorial } : {}),
      };
      return resultado;
    });

    // Después del commit (016): el gancho del libro. Su fallo no cambia la descarga ni su resultado; solo se registra un código.
    if (persistidor.trasConfirmar !== undefined) {
      try {
        await persistidor.trasConfirmar(
          {
            ...ctx,
            tenantId: t.tenantId,
            trabajoId: t.id,
            usuarioId,
            db: d.db,
            ...(d.redis === undefined ? {} : { redis: d.redis }),
            ...(d.prefijo === undefined ? {} : { prefijo: d.prefijo }),
          },
          resultado.propuestaId,
        );
      } catch (e) {
        if (d.logger !== undefined) {
          const codigo = (e as { codigo?: unknown } | null)?.codigo;
          registrar(d.logger, "warn", {
            evento: "tras_confirmar_fallo",
            tenant_id: t.tenantId,
            job_id: t.id,
            tipo: t.tipo,
            codigo: typeof codigo === "string" ? codigo : "desconocido",
          });
        }
      }
    }
    return resultado;
  };
}
