import { Inject, Injectable } from "@nestjs/common";
import {
  bloquearPeriodoLibro,
  clienteVisible,
  crearVentaManual,
  justificar,
  leerClienteDto,
  leerFilasVentas,
  listarDiferencias,
  listarJustificados,
  listarPropuestas,
  listarVentas,
  quitarVentaManual,
  revertirJustificacion,
  VentasRepoError,
  type Alcance,
  type ContappDb,
  type PropuestaFila,
  type Tx,
  type VentaFila,
} from "@contapp/db";
import {
  analizarCorrelatividad,
  claveNormalizada,
  MontoFueraDeRangoError,
  resumirVentas,
  validarFilaVenta,
} from "@contapp/domain";
import {
  filtrosVentasSchema,
  saltoJustificarSchema,
  ventaAgregarSchema,
  type CorrelatividadVentasDto,
  type DiferenciaVentasDto,
  type PaginaVentasDto,
  type PropuestaVentasDto,
  type ResumenVentasDto,
  type SaltoJustificadoDto,
  type VentaDto,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe, esUuid } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { VentasError } from "./errores.js";

/** Periodo AAAAMM con mes 01 a 12. Lo futuro lo rechaza el catálogo de la cola al descargar (008/013 D2). */
const PERIODO = /^[0-9]{4}(?:0[1-9]|1[0-2])$/;
/** SQLSTATE `unique_violation`: la clave (tipo, serie, número) ya está en el periodo (D9). */
const UNICA_VIOLADA = "23505";
/** Tipo de documento de la contraparte cuando no se informa (igual que el persistidor del worker). */
const TIPO_DOC_AUSENTE = "0";
const TAMANO_POR_OMISION = 25;

function periodoDe(valor: string): string {
  if (!PERIODO.test(valor)) throw new AccesoError("solicitud_invalida");
  return valor;
}

/** Un id mal formado en la ruta es un recurso inexistente (404), igual que uno que no existe. */
function idDe(valor: string): string {
  if (!esUuid(valor)) throw new AccesoError("no_encontrado");
  return valor;
}

/**
 * Cliente del alcance (D5). `ClienteScopeGuard` ya filtró la ruta; esto lo repite dentro de la misma transacción
 * (`filtroAlcance` vía `clienteVisible`) y, en una escritura, rechaza al cliente archivado con 409.
 */
async function exigirCliente(
  tx: Tx,
  clienteId: string,
  alcance: Alcance,
  escritura: boolean,
): Promise<void> {
  if (!(await clienteVisible(tx, clienteId, alcance))) throw new AccesoError("no_encontrado");
  if (!escritura) return;
  const cliente = await leerClienteDto(tx, clienteId);
  if (cliente === null) throw new AccesoError("no_encontrado");
  if (cliente.archivado) throw new AccesoError("cliente_archivado");
}

/** Fila de la BD → `VentaDto`: ni la clave interna, ni la propuesta, ni el usuario, ni el estudio. */
function aVentaDto(f: VentaFila): VentaDto {
  return {
    id: f.id,
    origen: f.origen,
    tipo: f.tipo,
    serie: f.serie,
    numero: f.numero,
    fechaEmision: f.fecha,
    tipoDocContraparte: f.tipoDocContraparte,
    docContraparte: f.docContraparte,
    moneda: f.moneda,
    tipoCambio: f.tipoCambio,
    baseGravada: f.baseGravada,
    igv: f.igv,
    exonerada: f.exonerada,
    inafecta: f.inafecta,
    isc: f.isc,
    icbper: f.icbper,
    otros: f.otros,
    total: f.total,
  };
}

function aPropuestaDto(p: PropuestaFila): PropuestaVentasDto {
  return {
    id: p.id,
    fuente: p.fuente,
    filasRecibidas: p.filasRecibidas,
    filasNuevas: p.filasNuevas,
    filasIguales: p.filasIguales,
    filasDistintas: p.filasDistintas,
    creadaEn: p.creadaEn.toISOString(),
  };
}

/**
 * Ventas del periodo (spec 013, D2, D5 a D11). Toda consulta va dentro de `withTenant`. El backend nunca llama a SUNAT:
 * `descargar` solo encola. Los errores salen como códigos (`AccesoError`, `VentasError`) sin eco de filas ni montos, y el
 * dinero se calcula con `Money` (dominio): aquí no hay aritmética.
 */
@Injectable()
export class VentasService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(Encolador) private readonly encolador: Encolador,
  ) {}

  /** D2: encola `sire.propuesta.descargar` con `{ periodo, libro: "ventas" }` y responde sin esperar a nadie. */
  async descargar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<{ trabajoId: string }> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    await this.db.withTenant(ctx, (tx) => exigirCliente(tx, clienteId, alcance, true));
    // Un periodo posterior al mes en curso lo rechaza el catálogo (`ParametrosInvalidosError`: el filtro lo da como 400).
    const r = await this.encolador.encolar(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      {
        tipo: "sire.propuesta.descargar",
        clienteId,
        parametros: { periodo, libro: "ventas" },
        prioridad: "interactivo",
        creadoPor: ctx.userId,
      },
    );
    return { trabajoId: r.trabajo.id };
  }

  /** D10: página filtrada y ordenada en el servidor; los montos del rango son cadenas comparadas como NUMERIC. */
  async listar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    query: unknown,
  ): Promise<PaginaVentasDto> {
    const periodo = periodoDe(periodoCrudo);
    const filtros = filtrosVentasSchema.safeParse(query);
    if (!filtros.success) throw new AccesoError("solicitud_invalida");
    const { pagina = 1, tamano = TAMANO_POR_OMISION, q, tipo, serie, min, max } = filtros.data;
    const resultado = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return listarVentas(tx, clienteId, periodo, {
        pagina,
        tamano: tamano as 10 | 25 | 50 | "todas",
        ...(q === undefined || q === "" ? {} : { q }),
        ...(tipo === undefined ? {} : { tipo }),
        ...(serie === undefined ? {} : { serie }),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      });
    });
    return {
      filas: resultado.filas.map(aVentaDto),
      total: resultado.total,
      pagina,
      tamano,
      avisos: resultado.avisos,
    };
  }

  /** D11: resumen por tipo en soles con `Money`; una suma fuera de NUMERIC(14,2) es un 422 controlado, no un 500. */
  async resumen(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<ResumenVentasDto> {
    const periodo = periodoDe(periodoCrudo);
    const filas = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return leerFilasVentas(tx, clienteId, periodo);
    });
    try {
      const r = resumirVentas(
        filas.map((f) => ({
          clave: f.clave,
          tipo: f.tipo,
          moneda: f.moneda,
          tipoCambio: f.tipoCambio,
          baseGravada: f.baseGravada,
          igv: f.igv,
          exonerada: f.exonerada,
          inafecta: f.inafecta,
          isc: f.isc,
          icbper: f.icbper,
          otros: f.otros,
          total: f.total,
        })),
      );
      return {
        porTipo: r.porTipo.map((t) => ({ ...t })),
        total: { ...r.total },
        sinConvertir: r.sinConvertir.map((s) => ({ clave: s.clave, moneda: s.moneda })),
        avisos: [...r.avisos],
      };
    } catch (e) {
      if (e instanceof MontoFueraDeRangoError) throw new VentasError("resumen_fuera_de_rango");
      throw e;
    }
  }

  /** D7: faltantes por tipo y serie con las justificaciones vigentes; las agregadas a mano cuentan como presentes. */
  async correlatividad(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<CorrelatividadVentasDto> {
    const periodo = periodoDe(periodoCrudo);
    const { filas, justificados } = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return {
        filas: await leerFilasVentas(tx, clienteId, periodo),
        justificados: await listarJustificados(tx, clienteId, periodo),
      };
    });
    const r = analizarCorrelatividad(
      filas.map((f) => ({ tipo: f.tipo, serie: f.serie, numero: f.numero })),
      justificados.map((j) => ({
        tipo: j.tipo,
        serie: j.serie,
        desde: j.desde,
        hasta: j.hasta,
        comentario: j.comentario,
      })),
    );
    return {
      series: r.series.map((s) => ({
        tipo: s.tipo,
        serie: s.serie,
        estado: s.estado,
        faltantes: s.faltantes.map((f) => ({ ...f })),
        noEvaluables: s.noEvaluables,
      })),
    };
  }

  /** D16: historial de descargas e importaciones de ventas del periodo, la más reciente primero. */
  async propuestas(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<PropuestaVentasDto[]> {
    const periodo = periodoDe(periodoCrudo);
    const filas = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return listarPropuestas(tx, clienteId, periodo, "ventas");
    });
    return filas.map(aPropuestaDto);
  }

  /** D16: lo que el SIRE trajo distinto de lo guardado en una propuesta de ESTE cliente, periodo y libro. */
  async diferencias(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    propuestaCruda: string,
  ): Promise<DiferenciaVentasDto[]> {
    const periodo = periodoDe(periodoCrudo);
    const propuestaId = idDe(propuestaCruda);
    const filas = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const propuestas = await listarPropuestas(tx, clienteId, periodo, "ventas");
      if (!propuestas.some((p) => p.id === propuestaId)) throw new AccesoError("no_encontrado");
      return listarDiferencias(tx, propuestaId);
    });
    return filas.map((d) => ({
      clave: d.clave,
      tipo: d.tipo,
      serie: d.serie,
      numero: d.numero,
      origenExistente: d.origenExistente,
      campos: d.campos,
      valoresSire: d.valoresSire,
    }));
  }

  /** D9: agrega una venta a mano. Cuadre exacto (0.00) y clave única en el periodo, también contra el SIRE. */
  async agregar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<VentaDto> {
    const periodo = periodoDe(periodoCrudo);
    const valor = ventaAgregarSchema.safeParse(cuerpo);
    if (!valor.success) throw new AccesoError("solicitud_invalida");
    const validada = validarFilaVenta(valor.data);
    if (!validada.ok) throw new AccesoError("solicitud_invalida");
    if (!validada.cuadra) throw new VentasError("venta_descuadrada");
    const f = validada.fila;
    const ctx = contextoDe(sesion);
    // La serie se guarda en mayúsculas (la clave ya las normaliza) para que no cree una serie aparte en la correlatividad.
    const serie = f.serie.toUpperCase();
    const creada = await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      // Orden de bloqueo (plan): advisory del periodo -> cliente -> filas; así no se cruza con una descarga en curso.
      await bloquearPeriodoLibro(tx, clienteId, periodo, "ventas");
      try {
        return await crearVentaManual(tx, {
          clienteId,
          periodo,
          creadaPor: ctx.userId,
          clave: claveNormalizada(f.tipo, serie, f.numero),
          tipo: f.tipo,
          serie,
          numero: f.numero,
          fecha: f.fechaEmision,
          tipoDocContraparte: f.tipoDocContraparte ?? TIPO_DOC_AUSENTE,
          docContraparte: f.docContraparte,
          moneda: f.moneda,
          tipoCambio: f.tipoCambio ?? null,
          baseGravada: f.baseGravada,
          igv: f.igv,
          exonerada: f.exonerada,
          inafecta: f.inafecta,
          isc: f.isc,
          icbper: f.icbper,
          otros: f.otros,
          total: f.total,
        });
      } catch (e) {
        if (e instanceof VentasRepoError && e.codigo === UNICA_VIOLADA) throw new VentasError("duplicado");
        throw e;
      }
    });
    return aVentaDto(creada);
  }

  /** D4: solo se quita lo agregado a mano de ESTE cliente y periodo; una fila del SIRE es inmutable (409). */
  async quitar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    ventaCruda: string,
  ): Promise<void> {
    const periodo = periodoDe(periodoCrudo);
    const ventaId = idDe(ventaCruda);
    await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      await bloquearPeriodoLibro(tx, clienteId, periodo, "ventas");
      const venta = (await leerFilasVentas(tx, clienteId, periodo)).find((v) => v.id === ventaId);
      if (venta === undefined) throw new AccesoError("no_encontrado");
      if (venta.origen !== "manual") throw new VentasError("venta_no_quitable");
      if (!(await quitarVentaManual(tx, ventaId))) throw new AccesoError("no_encontrado");
    });
  }

  /** D8: justifica un rango que esté DENTRO de un faltante actual de su serie; dos iguales a la vez dejan una vigente. */
  async justificar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<SaltoJustificadoDto> {
    const periodo = periodoDe(periodoCrudo);
    const valor = saltoJustificarSchema.safeParse(cuerpo);
    if (!valor.success) throw new AccesoError("solicitud_invalida");
    const { tipo, serie, desde, hasta, comentario } = valor.data;
    const ctx = contextoDe(sesion);
    const j = await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      const filas = await leerFilasVentas(tx, clienteId, periodo);
      // Sin justificaciones: son los huecos del periodo tal cual (una ya justificada sigue siendo un faltante).
      const grupo = analizarCorrelatividad(
        filas.map((f) => ({ tipo: f.tipo, serie: f.serie, numero: f.numero })),
        [],
      ).series.find((s) => s.tipo === tipo && s.serie === serie);
      if (!grupo?.faltantes.some((f) => f.desde <= desde && hasta <= f.hasta)) {
        throw new VentasError("salto_fuera_de_faltante");
      }
      return justificar(tx, { clienteId, periodo, tipo, serie, desde, hasta, comentario, usuarioId: ctx.userId });
    });
    return { id: j.id, tipo: j.tipo, serie: j.serie, desde: j.desde, hasta: j.hasta, comentario: j.comentario };
  }

  /** D8: revierte una justificación vigente de ESTE cliente y periodo; el registro se conserva con quién y cuándo. */
  async revertir(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    justificacionCruda: string,
  ): Promise<void> {
    const periodo = periodoDe(periodoCrudo);
    const id = idDe(justificacionCruda);
    const ctx = contextoDe(sesion);
    await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      const vigentes = await listarJustificados(tx, clienteId, periodo);
      if (!vigentes.some((j) => j.id === id)) throw new AccesoError("no_encontrado");
      if (!(await revertirJustificacion(tx, id, ctx.userId))) throw new AccesoError("no_encontrado");
    });
  }
}
