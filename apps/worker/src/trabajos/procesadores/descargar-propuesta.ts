// Procesador de `sire.propuesta.descargar` (spec 013, D2, D3, D16, D18; CA-1 a CA-3, CA-11). Común a los libros del SIRE;
// lo propio de cada libro vive en su persistidor (`../persistidores`).
//  (1) Parámetros y persistidor del libro, antes de gastar una llamada: sin persistidor, `libro_no_soportado`.
//  (2) Token y descarga SIN transacción abierta (008 D6): `conToken` y el puerto `SireApiClient`.
//  (3) Tope de 20.000 filas recibidas y validación de TODAS las filas: una ilegible da `ErrorDatos` y no se guarda nada.
//  (4) Una sola `withTenant`: bloqueo advisory (cliente, periodo, libro) -> existentes -> `planificarComplemento` ->
//      tope de 20.000 vivas -> `propuesta` -> `propuesta_diferencia` -> filas nuevas. Todo o nada.
// El `resultado` del trabajo lleva solo contadores y hasta 40 claves (≤ 4 KB, sin montos). Nada de lo recibido llega a
// logs ni a mensajes de error: los errores son códigos.
import { createHash } from "node:crypto";
import {
  bloquearPeriodoLibro,
  crearPropuesta,
  insertarDiferencias,
  type ContappDb,
  type NuevaDiferencia,
} from "@contapp/db";
import { planificarComplemento } from "@contapp/domain";
import { SIRE_PROPUESTA_DESCARGAR } from "@contapp/queue";
import type { SireApiClient } from "@contapp/sunat";
import type { Procesador } from "../ejecutor.js";
import { ErrorPropuesta } from "../persistidores/errores.js";
import { PERSISTIDORES } from "../persistidores/index.js";
import type {
  FilaPreparada,
  PersistidoresLibro,
} from "../persistidores/tipos.js";

/** Tope de filas de una propuesta y de filas vivas de un periodo (P-9, D10). */
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

/**
 * Hash del contenido recibido: no depende del orden de las filas ni de nada ajeno a ellas. Cada fila entra con sus
 * valores tal como llegaron; las filas se ordenan para que el mismo conjunto dé siempre el mismo SHA-256.
 */
export function hashContenido(
  libro: string,
  periodo: string,
  filas: readonly FilaPreparada[],
): string {
  const lineas = filas
    .map((f) =>
      JSON.stringify([
        f.tipo,
        f.serie,
        f.numero,
        ...Object.keys(f.campos)
          .sort()
          .map((k) => f.campos[k]),
      ]),
    )
    .sort();
  const h = createHash("sha256");
  h.update(JSON.stringify([libro, periodo, lineas]));
  return h.digest("hex");
}

function leerParametros(p: unknown) {
  const r = SIRE_PROPUESTA_DESCARGAR.parametros.safeParse(p);
  if (!r.success) throw new ErrorPropuesta("parametros_invalidos");
  return r.data;
}

/** Tipo, serie y número normalizados salen de la clave `tipo|SERIE|numero` (ninguno contiene `|`). */
function partesDeClave(clave: string): [string, string, string] {
  const [tipo = "", serie = "", numero = ""] = clave.split("|");
  return [tipo, serie, numero];
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
      await bloquearPeriodoLibro(tx, t.clienteId, periodo, libro);
      const existentes = await persistidor.leerExistentes(tx, ctx);
      const plan = planificarComplemento(
        existentes,
        preparadas.map((p) => ({ clave: p.clave, campos: p.campos })),
      );
      if (existentes.length + plan.nuevas.length > TOPE_FILAS)
        throw new ErrorPropuesta("propuesta_demasiado_grande");

      const nuevas = new Set(plan.nuevas);
      const aInsertar: FilaPreparada[] = [];
      for (const p of preparadas)
        if (nuevas.delete(p.clave)) aInsertar.push(p); // la primera aparición (D18)

      const creada = await crearPropuesta(tx, {
        clienteId: t.clienteId,
        periodo,
        libro,
        fuente: "api",
        hash,
        filasRecibidas: preparadas.length,
        filasNuevas: plan.nuevas.length,
        filasIguales: plan.iguales,
        filasDistintas: plan.distintas.length,
        usuarioId,
        trabajoId: t.id,
      });
      const diferencias: NuevaDiferencia[] = plan.distintas.map((x) => {
        const [tipo, serie, numero] = partesDeClave(x.clave);
        return {
          clave: x.clave,
          tipo,
          serie,
          numero,
          origenExistente: x.origenExistente,
          campos: [...x.campos],
          valoresSire: { ...x.valoresSire },
        };
      });
      await insertarDiferencias(tx, creada.id, diferencias);
      await persistidor.insertar(tx, ctx, creada.id, aInsertar);

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
