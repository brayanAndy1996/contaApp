import { Inject, Injectable } from "@nestjs/common";
import {
  agregarCompra,
  aplicarAccion,
  descartar,
  leerDetalleCompra,
  leerHallazgosVigentes,
  type Alcance,
  type ContappDb,
  type DetalleCompraLeido,
  type MontosCompra,
  type TransformarCompra,
  type Tx,
} from "@contapp/db";
import { aplicarEdicion, claveComprobante, MontosComprobante, type CambiosMontos } from "@contapp/domain";
import {
  aceptarSugerenciaSchema,
  agregarCompraSchema,
  calcularCompraSchema,
  clasificarCompraSchema,
  descartarCompraSchema,
  editarCompraSchema,
  excluirCompraSchema,
  restaurarCompraSchema,
  type AccionCompraRespuesta,
  type CalcularRespuesta,
  type AgregarCompra,
  type CuadreCompra,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { idDe, periodoDe } from "./apoyo.js";
import { aErrorHttp, aSolicitudInvalida, entornoDeReglas, exigir, exigirEscritura, type EntornoReglas } from "./escritura.js";
import {
  montosACadenas,
  montosDeDominio,
  transformarClasificar,
  transformarEditar,
  transformarExcluir,
  transformarRestaurar,
  transformarSugerencia,
} from "./transformar.js";
import { aFilaVista } from "./vistas.js";

type AccionDeFila = "clasificar" | "editar" | "sugerencia" | "excluir" | "restaurar";

/** El cuadre por celda de una fila, con la misma función pura que editar y calcular (D-5, D-16). */
function cuadreDe(c: Pick<DetalleCompraLeido["compra"], "moneda" | "montos">, cambios: CambiosMontos = {}): CuadreCompra {
  const { cuadre } = aplicarEdicion(montosDeDominio(c), cambios);
  return { cuadra: cuadre.cuadra, celdas: cuadre.celdas.map((x) => ({ ...x })) };
}

/**
 * Acciones sobre UNA compra (spec 014, D-2, D-4 a D-7, D-9, D-11, D-16): clasificar, editar, calcular, aceptar sugerencia,
 * excluir, restaurar, agregar y descartar. Toda escritura va dentro de `withTenant` y comprueba, en este orden, el cliente
 * (alcance y archivado), el estado del periodo con el permiso de la sesión y, ya en `packages/db`, la versión base: una
 * versión nueva y su operación se escriben o no se escribe nada. `packages/db` no depende de `domain`: el cálculo de la
 * versión nueva (`transformar`) y la re-evaluación de reglas (`evaluar`) entran inyectados.
 */
@Injectable()
export class AccionesComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  clasificar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    compraId: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const v = clasificarCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.deFila(sesion, alcance, permisos, clienteId, periodo, compraId, {
      accion: "clasificar",
      versionBase: v.data.versionBase,
      parametros: { destino: v.data.destino },
      armar: () => transformarClasificar,
    });
  }

  editar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    compraId: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const v = editarCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.deFila(sesion, alcance, permisos, clienteId, periodo, compraId, {
      accion: "editar",
      versionBase: v.data.versionBase,
      parametros: { cambios: v.data.cambios },
      armar: () => transformarEditar,
    });
  }

  excluir(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    compraId: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const v = excluirCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.deFila(sesion, alcance, permisos, clienteId, periodo, compraId, {
      accion: "excluir",
      versionBase: v.data.versionBase,
      parametros: v.data.motivo === undefined ? {} : { motivo: v.data.motivo },
      armar: () => transformarExcluir,
      // DU-16: excluir una agregada equivale a descartarla (se quita, no queda `excluida`).
      comoDescarte: v.data.motivo ?? null,
    });
  }

  restaurar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    compraId: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const v = restaurarCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.deFila(sesion, alcance, permisos, clienteId, periodo, compraId, {
      accion: "restaurar",
      versionBase: v.data.versionBase,
      parametros: {},
      armar: () => transformarRestaurar,
    });
  }

  /** D-4: aceptar la sugerencia guardada de la versión base. 409 `revisar_de_nuevo`, 422 `requiere_dato` (con el dato). */
  aceptarSugerencia(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    compraId: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const v = aceptarSugerenciaSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const { regla, confirmar, dato } = v.data;
    const id = compraId;
    return this.deFila(sesion, alcance, permisos, clienteId, periodo, compraId, {
      accion: "sugerencia",
      versionBase: v.data.versionBase,
      parametros: { regla },
      armar: (entorno, tx, alPedirDato) =>
        transformarSugerencia({
          cargarHallazgos: () => leerHallazgosVigentes(tx, [id.toLowerCase()]),
          conocidos: entorno.conocidos,
          evaluar: entorno.evaluar,
          enMasa: false,
          regla,
          confirmar: confirmar === true,
          dato,
          alPedirDato,
        }),
    });
  }

  /** D-16: vista previa. Mismo cálculo y mismo bloqueo por estado que editar, pero sin versión base y sin escribir nada. */
  async calcular(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
    cuerpo: unknown,
  ): Promise<CalcularRespuesta> {
    const periodo = periodoDe(periodoCrudo);
    const v = calcularCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const compraId = idDe(compraCruda);
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: false, archivado: false });
      const previo = exigir(await leerDetalleCompra(tx, clienteId, periodo, compraId));
      try {
        const r = aplicarEdicion(montosDeDominio(previo.compra), v.data.cambios as CambiosMontos);
        return {
          total: r.total.toString(),
          cuadre: { cuadra: r.cuadre.cuadra, celdas: r.cuadre.celdas.map((x) => ({ ...x })) },
        };
      } catch (e) {
        throw aSolicitudInvalida(e);
      }
    });
  }

  /** D-7: alta manual (`origen = agregada`, versión 1). 409 `duplicado` con el id de la existente. */
  async agregar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const periodo = periodoDe(periodoCrudo);
    const v = agregarCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const c = v.data;
    const montos = montosDeAgregada(c);
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: true, archivado: true });
      const entorno = await entornoDeReglas(tx, clienteId, periodo);
      const id = await altaCompra(tx, ctx.userId, clienteId, periodo, c, montos, entorno);
      return respuestaDe(tx, clienteId, periodo, id);
    });
  }

  /** D-7: solo una agregada se descarta (409 `no_descartable` si es del SIRE). No entra en deshacer (DU-14). */
  async descartar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
    cuerpo: unknown,
  ): Promise<AccionCompraRespuesta> {
    const periodo = periodoDe(periodoCrudo);
    const v = descartarCompraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const compraId = idDe(compraCruda);
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: true, archivado: true });
      const previo = exigir(await leerDetalleCompra(tx, clienteId, periodo, compraId));
      try {
        await descartar(tx, { compraId, versionBase: v.data.versionBase, usuarioId: ctx.userId });
      } catch (e) {
        throw aErrorHttp(e);
      }
      return { fila: aFilaVista(previo.compra, previo.proveedorNuevo, previo.hallazgos), cuadre: cuadreDe(previo.compra) };
    });
  }

  private async deFila(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
    o: {
      accion: AccionDeFila;
      versionBase: number;
      parametros: unknown;
      armar: (
        entorno: EntornoReglas,
        tx: Tx,
        alPedirDato: (dato: "gravado" | "destino") => void,
      ) => TransformarCompra;
      /** Excluir: si la fila es una agregada se descarta; el motivo (o `null`) se informa como si estuviera excluida. */
      comoDescarte?: string | null;
    },
  ): Promise<AccionCompraRespuesta> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda);
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: true, archivado: true });
      // La compra de otro cliente, periodo o estudio es 404: `packages/db` busca por id y no conoce el cliente.
      const previo = exigir(await leerDetalleCompra(tx, clienteId, periodo, compraId));
      if (o.comoDescarte !== undefined && previo.compra.origen === "agregada") {
        try {
          await descartar(tx, { compraId, versionBase: o.versionBase, usuarioId: ctx.userId });
        } catch (e) {
          throw aErrorHttp(e);
        }
        const fila = aFilaVista(previo.compra, previo.proveedorNuevo, previo.hallazgos);
        return { fila: { ...fila, excluida: true, motivo: o.comoDescarte }, cuadre: cuadreDe(previo.compra) };
      }
      const entorno = await entornoDeReglas(tx, clienteId, periodo);
      let datoPedido: "gravado" | "destino" | undefined;
      try {
        await aplicarAccion(
          tx,
          { compraId, versionBase: o.versionBase, accion: o.accion, parametros: o.parametros, usuarioId: ctx.userId },
          {
            transformar: o.armar(entorno, tx, (d) => {
              datoPedido = d;
            }),
            evaluar: entorno.evaluar,
          },
        );
      } catch (e) {
        throw aErrorHttp(e, datoPedido);
      }
      return respuestaDe(tx, clienteId, periodo, compraId);
    });
  }
}

/** Las columnas de la compra agregada: el cuerpo ya validado aplicado sobre una fila en cero. Un monto que el dominio no acepta es 400. */
export function montosDeAgregada(c: AgregarCompra): MontosCompra {
  try {
    const vacia = MontosComprobante.desde(c.moneda, { total: "0.00" });
    return montosACadenas(aplicarEdicion(vacia, c.montos as CambiosMontos).montos);
  } catch (e) {
    throw aSolicitudInvalida(e);
  }
}

/**
 * Alta de la compra `agregada` en versión 1 dentro de la transacción de quien llama (D-7; también «agregar desde XML», 016).
 * Devuelve el id; el comprobante repetido es 409 `duplicado` con el id de la existente.
 */
export async function altaCompra(
  tx: Tx,
  usuarioId: string,
  clienteId: string,
  periodo: string,
  c: AgregarCompra,
  montos: MontosCompra,
  entorno: EntornoReglas,
): Promise<string> {
  const docNumero = c.proveedor.numero.toUpperCase();
  try {
    const { id } = await agregarCompra(
      tx,
      {
        clienteId,
        periodo,
        usuarioId,
        accion: "agregada",
        identidad: {
          clave: claveComprobante(
            { tipo: c.tipo, serie: c.serie, numero: c.numero },
            { tipo: c.proveedor.tipo, numero: docNumero },
          ),
          tipoDoc: c.tipo,
          serie: c.serie,
          numero: c.numero,
          docTipo: c.proveedor.tipo,
          docNumero,
          razonSocial: c.proveedor.razonSocial,
          fecha: c.fecha,
          moneda: c.moneda,
          tipoCambio: c.tipoCambio ?? null,
        },
        montos,
      },
      { evaluar: entorno.evaluar },
    );
    return id;
  } catch (e) {
    throw aErrorHttp(e);
  }
}

/** La fila tal como quedó (versión vigente, hallazgos re-evaluados) y su cuadre. */
export async function respuestaDe(tx: Tx, clienteId: string, periodo: string, compraId: string): Promise<AccionCompraRespuesta> {
  const d = exigir(await leerDetalleCompra(tx, clienteId, periodo, compraId));
  return { fila: aFilaVista(d.compra, d.proveedorNuevo, d.hallazgos), cuadre: cuadreDe(d.compra) };
}
