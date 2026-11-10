import { Inject, Injectable } from "@nestjs/common";
import {
  excluirVenta,
  leerClienteDto,
  leerFilasVentas,
  restaurarVenta,
  VentasRepoError,
  type Alcance,
  type ContappDb,
  type Tx,
  type VentaFila,
} from "@contapp/db";
import { erroresDeFilaVenta, ventaAFila } from "@contapp/domain";
import { excluirVentaSchema, restaurarVentaSchema, type VentaDto } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { aVentaDto, exigirEscrituraVentas, idDe, periodoDe } from "./apoyo.js";
import { VentasError } from "./errores.js";

/** SQLSTATE `unique_violation`: el único parcial de vigentes (una sola exclusión vigente por venta). */
const UNICA_VIOLADA = "23505";

/**
 * Excluir y restaurar ventas del SIRE con error de fila (spec 012b, D12, P-8; modelo: excluir y restaurar de 014 D-6). Orden:
 * 400 (cuerpo y periodo) -> guards (permiso, cliente) -> 409 `cliente_archivado` -> advisory del libro y estado del periodo
 * (409 `periodo_generado`, 403 `periodo_revisado`) -> 404 de la venta -> regla de D12 (409). La regla «tiene error» se calcula aquí
 * con la misma función de dominio que usa `prevalidar`, bajo el advisory del libro; como la fila del SIRE es inmutable, el
 * resultado no cambia durante la transacción. El motivo es texto no confiable: se guarda tal cual y NUNCA se registra en logs.
 */
@Injectable()
export class ExclusionVentasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async excluir(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    ventaCruda: string,
    cuerpo: unknown,
  ): Promise<VentaDto> {
    const periodo = periodoDe(periodoCrudo);
    const valor = excluirVentaSchema.safeParse(cuerpo);
    if (!valor.success) throw new AccesoError("solicitud_invalida");
    const { motivo } = valor.data;
    const ctx = contextoDe(sesion);
    const excluida = await this.db.withTenant(ctx, async (tx) => {
      await exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo);
      const venta = await ventaDelPeriodo(tx, clienteId, periodo, ventaCruda);
      if (venta.origen !== "sire") throw new VentasError("no_excluible");
      if (venta.exclusion !== null) throw new VentasError("ya_excluida");
      if (!(await tieneError(tx, clienteId, periodo, venta))) throw new VentasError("no_excluible");
      try {
        const e = await excluirVenta(tx, { clienteId, periodo, ventaId: venta.id, motivo, usuarioId: ctx.userId });
        if (e === null) throw new VentasError("ya_excluida");
        return { ...venta, exclusion: { motivo: e.motivo, por: e.excluidaPor, en: e.excluidaEn } };
      } catch (e) {
        if (e instanceof VentasRepoError && e.codigo === UNICA_VIOLADA) throw new VentasError("ya_excluida");
        throw e;
      }
    });
    return aVentaDto(excluida);
  }

  async restaurar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    ventaCruda: string,
    cuerpo: unknown,
  ): Promise<VentaDto> {
    const periodo = periodoDe(periodoCrudo);
    if (!restaurarVentaSchema.safeParse(cuerpo).success) throw new AccesoError("solicitud_invalida");
    const ctx = contextoDe(sesion);
    const restaurada = await this.db.withTenant(ctx, async (tx) => {
      await exigirEscrituraVentas(tx, alcance, permisos, clienteId, periodo);
      const venta = await ventaDelPeriodo(tx, clienteId, periodo, ventaCruda);
      if (venta.exclusion === null || !(await restaurarVenta(tx, venta.id, ctx.userId))) throw new VentasError("no_excluida");
      return { ...venta, exclusion: null };
    });
    return aVentaDto(restaurada);
  }
}

/** La venta de ESTE cliente y periodo (con su exclusión vigente); un id mal formado, ajeno o de otro periodo es un 404. */
async function ventaDelPeriodo(tx: Tx, clienteId: string, periodo: string, ventaCruda: string): Promise<VentaFila> {
  const ventaId = idDe(ventaCruda);
  const venta = (await leerFilasVentas(tx, clienteId, periodo)).find((v) => v.id === ventaId);
  if (venta === undefined) throw new AccesoError("no_encontrado");
  return venta;
}

/** D12: ¿la fila, por sí sola, tiene al menos un error de prevalidación? (misma función de dominio que `prevalidar`). */
async function tieneError(tx: Tx, clienteId: string, periodo: string, venta: VentaFila): Promise<boolean> {
  const cliente = await leerClienteDto(tx, clienteId);
  if (cliente === null) throw new AccesoError("no_encontrado");
  const errores = erroresDeFilaVenta(
    { rucDeclarante: cliente.ruc, periodo, libro: "ventas" },
    ventaAFila({ ...venta, excluida: false }),
  );
  return errores.length > 0;
}
