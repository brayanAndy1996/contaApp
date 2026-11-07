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
import type { Procesador } from "../ejecutor.js";
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
}

export interface ResultadoDescarga {
  propuestaId: string;
  recibidas: number;
  nuevas: number;
  iguales: number;
  distintas: number;
  claves: string[];
  truncado: boolean;
}

function leerParametros(p: unknown) {
  const r = SIRE_PROPUESTA_DESCARGAR.parametros.safeParse(p);
  if (!r.success) throw new ErrorPropuesta("parametros_invalidos");
  return r.data;
}

export function descargarPropuesta(d: DepsDescargarPropuesta): Procesador {
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

    return d.db.withTenant({ tenantId: t.tenantId }, async (tx) => {
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
        insertar: (x, propuestaId, nuevas) =>
          persistidor.insertar(x, ctx, propuestaId, nuevas),
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
      };
      return resultado;
    });
  };
}
