// Procesador de `reglas.historial.importar` (spec 025, D-1, D-2, D-11; CA-1, CA-6, CA-12; plan Contratos: Worker).
//  (1) Lee la importación y el RUC del cliente en una `withTenant` corta y la cierra. Los periodos salen de la fila, no del payload.
//  (2) Por periodo, del más reciente al más antiguo, llama al puerto SIN transacción abierta (008 D6). `ErrorDatos` del puerto =
//      «sin datos» y sigue. Cada respuesta se reduce de inmediato a `FilaHistorial` (el registro crudo no se conserva).
//  (3) `aprenderDeHistorial` (dominio) deduce las candidatas; las que la BD rechazaría por la gramática del documento (p. ej.
//      un RUC que no tiene 11 dígitos) no son candidatas: una sola fila rara no puede tumbar toda la importación.
//  (4) UNA transacción con `reglas_importacion_completar`, sin SAVEPOINT. Nunca toca compras, versiones ni reglas (D-2, D-4).
// Fallos: credencial o datos terminan la importación como `fallida` con el motivo del trabajo; un fallo transitorio la cierra solo
// en el último intento (los reintentos los decide 008). Si no se pudo cerrar, la siguiente importación del cliente la da por
// interrumpida (`reglas_importacion_iniciar`). Importación ya cerrada (55000) = el trabajo termina bien sin escribir.
// El `resultado` lleva solo conteos; nada de lo recibido llega a logs ni a errores: los errores son códigos (D-11).
import {
  completarImportacion,
  fallarImportacion,
  leerImportacion,
  AprendizajeRepoError,
  type CandidataNueva,
  type ContappDb,
} from "@contapp/db";
import {
  aprenderDeHistorial,
  type CandidataDeducida,
  type FilaHistorial,
} from "@contapp/domain";
import {
  REGLAS_HISTORIAL_IMPORTAR,
  type CacheConfig,
  type NombreCola,
} from "@contapp/queue";
import {
  ErrorDatos,
  clasificarError,
  type FilaPropuestaSire,
  type SireApiClient,
} from "@contapp/sunat";
import type { ContextoProcesador } from "../ejecutor.js";
import { ErrorPropuesta } from "../persistidores/errores.js";
import { TOPE_FILAS } from "./descargar-propuesta.js";

export interface DepsImportarHistorial {
  db: Pick<ContappDb, "withTenant">;
  sireApi: SireApiClient;
  /** Configuración vigente de las colas: de ahí sale el último intento (`reintentos` de la cola `sire`). */
  config: Pick<CacheConfig, "obtener">;
}

/** Solo conteos (D-11). */
export interface ResultadoImportarHistorial {
  periodosLeidos: number;
  periodosSinDatos: number;
  candidatas: number;
  sinCriterio: number;
}

/** La importación ya estaba cerrada (o se cerró mientras se leía): no se escribió nada. */
export interface ImportacionOmitida {
  omitida: true;
}

const COLA: NombreCola = "sire";

/** `completar` rechaza todo si una candidata no cumple su gramática; aquí se descartan las que no la cumplen (no son candidatas). */
const TIPO_DOC = /^[0-9A-Z]{1,2}$/;
const NUMERO_DOC = /^[0-9A-Z-]{1,20}$/;
const ALFANUMERICO = /[0-9A-Z]/;
const RUC = /^[0-9]{11}$/;

export function esCandidataGuardable(c: CandidataDeducida): boolean {
  const { tipo, numero } = c.proveedor;
  return (
    TIPO_DOC.test(tipo) &&
    NUMERO_DOC.test(numero) &&
    ALFANUMERICO.test(numero) &&
    (tipo !== "6" || RUC.test(numero))
  );
}

const MONTO = ["biDg", "biDgng", "biDng"] as const;

/** Reduce una fila del registro a lo que el dominio necesita; una fila con montos que no son texto es ilegible (sin contenido). */
function aFilaHistorial(f: FilaPropuestaSire, periodo: string): FilaHistorial {
  if (typeof f !== "object" || f === null)
    throw new ErrorPropuesta("fila_invalida");
  for (const m of MONTO)
    if (typeof f[m] !== "string") throw new ErrorPropuesta("fila_invalida");
  const tipoDoc: unknown = f.tipoDocContraparte;
  const razon: unknown = f.razonSocialContraparte;
  return {
    periodo,
    tipoDocProveedor: typeof tipoDoc === "string" ? tipoDoc : null,
    numeroDocProveedor:
      typeof f.rucContraparte === "string" ? f.rucContraparte : "",
    razonSocial: typeof razon === "string" ? razon : null,
    tipoComprobante: typeof f.tipo === "string" ? f.tipo : "",
    biDg: f.biDg,
    biDgng: f.biDgng,
    biDng: f.biDng,
  };
}

const aCandidataNueva = (c: CandidataDeducida): CandidataNueva => ({
  proveedor: { tipo: c.proveedor.tipo, numero: c.proveedor.numero },
  razonSocial: c.razonSocial,
  destino: c.destino,
  conteos: { ...c.conteos },
  periodosConProveedor: c.periodosConProveedor,
});

const codigoDe = (e: unknown): string | undefined =>
  e instanceof AprendizajeRepoError ? e.codigo : undefined;

/** Es un `Procesador` que, además, tipa su resultado. */
export function importarHistorial(
  d: DepsImportarHistorial,
): (
  ctx: ContextoProcesador,
) => Promise<ResultadoImportarHistorial | ImportacionOmitida> {
  return async ({ trabajo: t, conToken }) => {
    const p = REGLAS_HISTORIAL_IMPORTAR.parametros.safeParse(t.parametros);
    if (!p.success) throw new ErrorPropuesta("parametros_invalidos");
    const { importacionId } = p.data;
    const estudio = { tenantId: t.tenantId, trabajoId: t.id };

    // (1) La importación y el RUC, en una transacción corta que se cierra antes de llamar al puerto.
    const imp = await d.db.withTenant(estudio, (tx) =>
      leerImportacion(tx, importacionId),
    );
    // Inexistente en el estudio o de otro cliente que el del trabajo: payload forjado o repetido, sin efectos.
    if (imp === null || imp.clienteId !== t.clienteId)
      throw new ErrorPropuesta("parametros_invalidos");
    if (imp.estado !== "en_curso") return { omitida: true };

    /** Cierra la importación como fallida; si no se puede (ya cerrada, BD caída), la siguiente iniciar la da por interrumpida. */
    const cerrar = async (motivo: string): Promise<void> => {
      try {
        await d.db.withTenant(estudio, (tx) =>
          fallarImportacion(tx, { importacionId, motivo }),
        );
      } catch {
        // sin efecto: solo se pierde el cierre anticipado
      }
    };

    try {
      // (2) Del más reciente al más antiguo, fuera de toda transacción.
      const periodos = [...imp.periodos].sort().reverse();
      const filas: FilaHistorial[] = [];
      const sinDatos: string[] = [];
      let leidos = 0;
      for (const periodo of periodos) {
        let registro;
        try {
          registro = await conToken((token) =>
            d.sireApi.descargarRegistroPresentado(
              { token, expiraEn: new Date(0) },
              { ruc: imp.ruc, periodo },
            ),
          );
        } catch (e) {
          // Periodo sin registro: se anota y sigue. Los demás errores (credencial, red) salen.
          if (e instanceof ErrorDatos) {
            sinDatos.push(periodo);
            continue;
          }
          throw e;
        }
        if (registro.libro !== "compras" || !Array.isArray(registro.filas))
          throw new ErrorPropuesta("respuesta_inconsistente");
        if (registro.filas.length > TOPE_FILAS)
          throw new ErrorPropuesta("propuesta_demasiado_grande");
        for (const f of registro.filas) filas.push(aFilaHistorial(f, periodo));
        leidos += 1;
      }

      // (3) Deducción (dominio, sin IO). Un monto que no es decimal es una fila ilegible.
      let candidatas: CandidataDeducida[];
      try {
        candidatas =
          aprenderDeHistorial(filas).candidatas.filter(esCandidataGuardable);
      } catch {
        throw new ErrorPropuesta("fila_invalida");
      }
      const sinCriterio = candidatas.filter((c) => c.destino === null).length;

      // (4) Una sola escritura, en una transacción sin SAVEPOINT.
      await d.db.withTenant(estudio, (tx) =>
        completarImportacion(tx, {
          importacionId,
          resumen: {
            periodosLeidos: leidos,
            periodosSinDatos: sinDatos,
            candidatas: candidatas.length,
            sinCriterio,
          },
          candidatas: candidatas.map(aCandidataNueva),
        }),
      );
      return {
        periodosLeidos: leidos,
        periodosSinDatos: sinDatos.length,
        candidatas: candidatas.length,
        sinCriterio,
      };
    } catch (e) {
      const codigo = codigoDe(e);
      // Cerrada por otro proceso (o ya completada) mientras se leía: no hay nada que escribir.
      if (codigo === "55000") return { omitida: true };
      // La BD rechazó lo que se le envió: no se arregla reintentando; es un fallo de datos, no de red.
      if (codigo === "22023") {
        await cerrar("datos_invalidos");
        throw new ErrorDatos();
      }
      const { clase } = clasificarError(e);
      if (clase === "credencial") await cerrar("credencial_invalida");
      else if (clase === "datos") await cerrar("datos_invalidos");
      else if (clase === "portal") await cerrar("portal_cambio");
      else {
        // Transitorio: 008 reintenta; solo en el último intento queda cerrada (`decidirTrasError`: intentos >= reintentos).
        const reintentos =
          (await d.config.obtener()).get(COLA)?.reintentos ?? 0;
        if (t.intentos >= reintentos) await cerrar("sunat_no_responde");
      }
      throw e;
    }
  };
}
