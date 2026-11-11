import { Inject, Injectable } from "@nestjs/common";
import {
  crearVentaManual,
  justificar,
  leerEstadoPeriodoVentas,
  leerFilasVentas,
  listarDiferencias,
  listarJustificados,
  listarPropuestas,
  listarVentas,
  quitarVentaManual,
  revertirJustificacion,
  TIPO_DOC_AUSENTE,
  VentasRepoError,
  type Alcance,
  type ContappDb,
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
  type ResumenVentasVista,
  type SaltoJustificadoDto,
  type VentaDto,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { aPropuestaDto, aVentaDto, exigirCliente, exigirEscrituraVentas, idDe, periodoDe } from "./apoyo.js";
import { aRespuestaEstado } from "./estado.service.js";
import { VentasError } from "./errores.js";

/** SQLSTATE `unique_violation`: la clave (tipo, serie, número) ya está en el periodo (D9). */
const UNICA_VIOLADA = "23505";
const TAMANO_POR_OMISION = 25;

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
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
  ): Promise<{ trabajoId: string }> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    // 012b D5, P-9: el estado se comprueba al encolar (sin bloquear); el worker lo repite bajo el bloqueo.
    await this.db.withTenant(ctx, (tx) => exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo, { bloquear: false }));
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
  ): Promise<ResumenVentasVista> {
    const periodo = periodoDe(periodoCrudo);
    const { todas, bloqueEstado } = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return {
        todas: await leerFilasVentas(tx, clienteId, periodo),
        // P-1 (017): el mismo bloque que revisar y reabrir (`estado`, `por`, `autor`, `en`).
        bloqueEstado: await aRespuestaEstado(tx, await leerEstadoPeriodoVentas(tx, clienteId, periodo)),
      };
    });
    // 012b D12, RF-056: las excluidas no suman; se cuentan aparte.
    const filas = todas.filter((f) => f.exclusion === null);
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
        ...bloqueEstado,
        excluidas: todas.length - filas.length,
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
      series: r.series.map((s) => {
        // Misma elección que el dominio: de las justificaciones de la serie (por `desde`, estable) la primera que cubre sola.
        const delaSerie = justificados
          .filter((j) => j.tipo === s.tipo && j.serie === s.serie)
          .sort((a, b) => a.desde - b.desde);
        return {
          tipo: s.tipo,
          serie: s.serie,
          estado: s.estado,
          faltantes: s.faltantes.map((f) => {
            const sola =
              f.comentario === undefined ? undefined : delaSerie.find((j) => j.desde <= f.desde && j.hasta >= f.hasta);
            return sola === undefined ? { ...f } : { ...f, justificacionId: sola.id };
          }),
          noEvaluables: s.noEvaluables,
        };
      }),
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
      if (!propuestas.some((p) => p.id.toLowerCase() === propuestaId.toLowerCase())) throw new AccesoError("no_encontrado");
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
    permisos: ReadonlySet<string>,
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
      // Cliente (lectura simple), advisory del periodo (así esta escritura no se cruza con una descarga, otra venta ni generar)
      // y estado del periodo (409 `periodo_generado`, 403 `periodo_revisado`; 012b D5, P-9).
      await exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo);
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
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    ventaCruda: string,
  ): Promise<void> {
    const periodo = periodoDe(periodoCrudo);
    await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo);
      const ventaId = idDe(ventaCruda); // un id mal formado es un 404, pero después del estado (plan 012b)
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
    permisos: ReadonlySet<string>,
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
      await exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo);
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
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    justificacionCruda: string,
  ): Promise<void> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    await this.db.withTenant(ctx, async (tx) => {
      await exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo);
      const id = idDe(justificacionCruda);
      const vigentes = await listarJustificados(tx, clienteId, periodo);
      if (!vigentes.some((j) => j.id === id)) throw new AccesoError("no_encontrado");
      if (!(await revertirJustificacion(tx, id, ctx.userId))) throw new AccesoError("no_encontrado");
    });
  }
}
