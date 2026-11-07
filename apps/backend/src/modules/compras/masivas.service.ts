import { Inject, Injectable } from "@nestjs/common";
import {
  aplicarMasiva,
  descartar,
  leerHallazgosVigentes,
  leerOrigenesCompras,
  ComprasReglaError,
  type Alcance,
  type ContappDb,
  type ResultadoMasivaCompra,
  type TransformarCompra,
  type Tx,
} from "@contapp/db";
import {
  masivaAceptarSchema,
  masivaClasificarSchema,
  masivaExcluirSchema,
  masivaRestaurarSchema,
  type CodigoRechazoMasiva,
  type InformeMasiva,
  type ItemMasiva,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { periodoDe } from "./apoyo.js";
import { entornoDeReglas, exigirEscritura, type EntornoReglas } from "./escritura.js";
import {
  transformarClasificar,
  transformarExcluir,
  transformarRestaurar,
  transformarSugerencia,
} from "./transformar.js";

type AccionMasiva = "clasificar" | "sugerencia" | "excluir" | "restaurar";

function informe(r: ResultadoMasivaCompra): InformeMasiva {
  return {
    operacionId: r.operacionId,
    aplicadas: r.aplicadas,
    // Los códigos son los de la lista cerrada del contrato (`CODIGOS_RECHAZO_MASIVA`): los pone `packages/db` y `transformar*`.
    rechazadas: r.rechazadas.map((x) => ({ compraId: x.compraId, codigo: x.codigo as CodigoRechazoMasiva })),
  };
}

/**
 * Una masiva sin ninguna fila aplicada no escribe nada, ni siquiera la fila de `compra_periodo` que crea el bloqueo del estado:
 * se sale de la transacción con esta marca (que la revierte) y se responde el informe.
 */
class SinCambios extends Error {
  constructor(readonly informe: InformeMasiva) {
    super("masiva sin filas aplicadas");
  }
}

interface OpcionesMasiva {
  accion: AccionMasiva;
  items: ItemMasiva[];
  parametros: unknown;
  armar: (entorno: EntornoReglas, tx: Tx) => TransformarCompra;
  /** DU-16: en excluir, una agregada se descarta (no entra en la operación ni en deshacer). */
  descartaAgregadas?: boolean;
}

/**
 * Acciones masivas (spec 014, D-2, D-15, DU-5, DU-6, DU-14 a DU-16, DU-22): hasta 5.000 `{ compraId, versionBase }`. Son
 * parciales: las filas válidas se aplican en UNA operación y las demás vuelven en `rechazadas` con su código; sin ninguna
 * aplicada no se crea operación. Un id de otro cliente, periodo o estudio es `no_encontrada`, igual que uno inexistente. Las
 * filas se bloquean en orden de id (lo hace `packages/db`), así que dos masivas cruzadas no se interbloquean.
 */
@Injectable()
export class MasivasComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  clasificar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    cuerpo: unknown,
  ): Promise<InformeMasiva> {
    const v = masivaClasificarSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.ejecutar(sesion, alcance, permisos, clienteId, periodo, {
      accion: "clasificar",
      items: v.data.items,
      parametros: { destino: v.data.destino },
      armar: () => transformarClasificar,
    });
  }

  /** DU-6, DU-22: solo entran los hallazgos guardados sin confirmación ni dato, contrastados con la fila actual. */
  aceptar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    cuerpo: unknown,
  ): Promise<InformeMasiva> {
    const v = masivaAceptarSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const { items, regla } = v.data;
    return this.ejecutar(sesion, alcance, permisos, clienteId, periodo, {
      accion: "sugerencia",
      items,
      parametros: { regla },
      armar: (entorno, tx) =>
        transformarSugerencia({
          cargarHallazgos: () => leerHallazgosVigentes(tx, items.map((i) => i.compraId.toLowerCase())),
          conocidos: entorno.conocidos,
          enMasa: true,
          regla,
          confirmar: false,
          dato: undefined,
        }),
    });
  }

  excluir(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    cuerpo: unknown,
  ): Promise<InformeMasiva> {
    const v = masivaExcluirSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.ejecutar(sesion, alcance, permisos, clienteId, periodo, {
      accion: "excluir",
      items: v.data.items,
      parametros: v.data.motivo === undefined ? {} : { motivo: v.data.motivo },
      armar: () => transformarExcluir,
      descartaAgregadas: true,
    });
  }

  restaurar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    cuerpo: unknown,
  ): Promise<InformeMasiva> {
    const v = masivaRestaurarSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.ejecutar(sesion, alcance, permisos, clienteId, periodo, {
      accion: "restaurar",
      items: v.data.items,
      parametros: {},
      armar: () => transformarRestaurar,
    });
  }

  private async ejecutar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    o: OpcionesMasiva,
  ): Promise<InformeMasiva> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    try {
      return await this.aplicar(ctx, alcance, permisos, clienteId, periodo, o);
    } catch (e) {
      if (e instanceof SinCambios) return e.informe;
      throw e;
    }
  }

  private aplicar(
    ctx: { tenantId: string; userId: string },
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    o: OpcionesMasiva,
  ): Promise<InformeMasiva> {
    return this.db.withTenant(ctx, async (tx) => {
      await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: true, archivado: true });
      const entorno = await entornoDeReglas(tx, clienteId, periodo);
      let items = o.items;
      let agregadas: ItemMasiva[] = [];
      if (o.descartaAgregadas === true) {
        const origenes = await leerOrigenesCompras(tx, clienteId, periodo, items.map((i) => i.compraId));
        const esAgregada = (i: ItemMasiva): boolean => origenes.get(i.compraId.toLowerCase()) === "agregada";
        agregadas = items.filter(esAgregada).sort((a, b) => a.compraId.toLowerCase().localeCompare(b.compraId.toLowerCase()));
        items = items.filter((i) => !esAgregada(i));
      }
      const r =
        items.length === 0 && agregadas.length > 0
          ? { operacionId: null, aplicadas: 0, rechazadas: [] }
          : await aplicarMasiva(
              tx,
              { clienteId, periodo, usuarioId: ctx.userId, accion: o.accion, parametros: o.parametros, items },
              { transformar: o.armar(entorno, tx), evaluar: entorno.evaluar },
            );
      const final = informe(await descartarAgregadas(tx, ctx.userId, agregadas, r));
      if (final.aplicadas === 0) throw new SinCambios(final);
      return final;
    });
  }
}

/** Se descartan después de la operación, para no tomar bloqueos de `compra` antes de `compra_operacion` (orden del plan). */
async function descartarAgregadas(
  tx: Tx,
  usuarioId: string,
  agregadas: ItemMasiva[],
  r: ResultadoMasivaCompra,
): Promise<ResultadoMasivaCompra> {
  let aplicadas = r.aplicadas;
  const rechazadas = [...r.rechazadas];
  for (const a of agregadas) {
    try {
      await descartar(tx, { compraId: a.compraId, versionBase: a.versionBase, usuarioId });
      aplicadas += 1;
    } catch (e) {
      if (!(e instanceof ComprasReglaError)) throw e;
      rechazadas.push({ compraId: a.compraId, codigo: e.codigo === "version_obsoleta" ? "version_obsoleta" : "no_encontrada" });
    }
  }
  return { operacionId: r.operacionId, aplicadas, rechazadas };
}
