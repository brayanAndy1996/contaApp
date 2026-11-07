import { Inject, Injectable } from "@nestjs/common";
import {
  leerDetalleCompra,
  leerEstadoCredenciales,
  leerEstadoPeriodo,
  listarCompras,
  listarDiferencias,
  listarPropuestas,
  type Alcance,
  type ContappDb,
} from "@contapp/db";
import { puedeEscribir } from "@contapp/domain";
import {
  listarComprasSchema,
  type DetalleCompra,
  type DiferenciaComprasDto,
  type ListadoCompras,
  type PropuestaComprasDto,
  type TipoCredencial,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { aDiferenciaDto, aPropuestaDto, exigirCliente, idDe, periodoDe } from "./apoyo.js";
import { codificarCursor, decodificarCursor } from "./cursor.js";
import { ComprasError } from "./errores.js";
import { aDetalleVista, aFilaListada } from "./vistas.js";

const LIMITE_POR_OMISION = 200;
/** La descarga del SIRE usa las dos credenciales: la clave SOL y la del API (007b, D6). */
const CREDENCIALES_DESCARGA: readonly TipoCredencial[] = ["sol", "sire_api"];

/**
 * Compras del periodo: descarga, listado, detalle y propuestas (spec 014, D-3, D-11, D-13, DU-19). Toda consulta va dentro de
 * `withTenant`. El backend nunca llama a SUNAT: `descargar` solo encola. Los errores salen como códigos (`AccesoError`,
 * `ComprasError`) sin eco de filas, montos ni ids.
 */
@Injectable()
export class ComprasService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(Encolador) private readonly encolador: Encolador,
  ) {}

  /**
   * D-3, D-9: comprueba cliente, estado del periodo, permiso y credencial; encola `sire.propuesta.descargar` con
   * `{ periodo, libro: "compras" }` y responde sin esperar a nadie.
   */
  async descargar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<{ trabajoId: string }> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      const { estado } = await leerEstadoPeriodo(tx, clienteId, periodo);
      const escritura = puedeEscribir(estado, [...permisos]);
      if (!escritura.ok) throw new ComprasError(escritura.codigo);
      const configuradas = new Set((await leerEstadoCredenciales(tx, clienteId)).map((f) => f.tipo));
      if (!CREDENCIALES_DESCARGA.every((t) => configuradas.has(t))) throw new AccesoError("credencial_no_configurada");
    });
    // Un periodo posterior al mes en curso lo rechaza el catálogo (`ParametrosInvalidosError`: el filtro lo da como 400).
    const r = await this.encolador.encolar(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      {
        tipo: "sire.propuesta.descargar",
        clienteId,
        parametros: { periodo, libro: "compras" },
        prioridad: "interactivo",
        creadoPor: ctx.userId,
      },
    );
    return { trabajoId: r.trabajo.id };
  }

  /** D-13: página por cursor, filtrada y ordenada en el servidor. */
  async listar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    query: unknown,
  ): Promise<ListadoCompras> {
    const periodo = periodoDe(periodoCrudo);
    const filtros = listarComprasSchema.safeParse(query);
    if (!filtros.success) throw new AccesoError("solicitud_invalida");
    const { cursor, limite = LIMITE_POR_OMISION, vista, alertas, proveedorNuevo, q } = filtros.data;
    const posicion = cursor === undefined ? undefined : decodificarCursor(cursor);
    const pagina = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return listarCompras(tx, clienteId, periodo, {
        limite,
        ...(posicion === undefined ? {} : { cursor: posicion }),
        ...(vista === undefined ? {} : { vista }),
        ...(alertas === undefined ? {} : { alertas }),
        ...(proveedorNuevo === undefined ? {} : { proveedorNuevo }),
        ...(q === undefined ? {} : { q }),
      });
    });
    return { filas: pagina.filas.map(aFilaListada), siguiente: pagina.siguiente === null ? null : codificarCursor(pagina.siguiente) };
  }

  /** D-6: la versión 1, la vigente, todas las versiones y los hallazgos de la vigente. */
  async detalle(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
  ): Promise<DetalleCompra> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda);
    const leido = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return leerDetalleCompra(tx, clienteId, periodo, compraId);
    });
    if (leido === null) throw new AccesoError("no_encontrado");
    return aDetalleVista(leido);
  }

  /** DU-19: historial de descargas de compras del periodo, la más reciente primero. */
  async propuestas(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<PropuestaComprasDto[]> {
    const periodo = periodoDe(periodoCrudo);
    const filas = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return listarPropuestas(tx, clienteId, periodo, "compras");
    });
    return filas.map(aPropuestaDto);
  }

  /** DU-19: lo que el SIRE trajo distinto de lo guardado en una propuesta de ESTE cliente, periodo y libro compras. */
  async diferencias(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    propuestaCruda: string,
  ): Promise<DiferenciaComprasDto[]> {
    const periodo = periodoDe(periodoCrudo);
    const propuestaId = idDe(propuestaCruda);
    const filas = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const propuestas = await listarPropuestas(tx, clienteId, periodo, "compras");
      if (!propuestas.some((p) => p.id.toLowerCase() === propuestaId.toLowerCase())) throw new AccesoError("no_encontrado");
      return listarDiferencias(tx, propuestaId);
    });
    return filas.map(aDiferenciaDto);
  }
}
