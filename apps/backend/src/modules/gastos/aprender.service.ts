import { Inject, Injectable } from "@nestjs/common";
import { aprender, excepcionesSugeridas, leerDetalleCompra, leerGlosasCompra, type Alcance, type ContappDb, type Tx } from "@contapp/db";
import { proponerTerminos } from "@contapp/domain";
import {
  aprenderRespuestaSchema,
  aprenderSchema,
  propuestaAprenderVistaSchema,
  type AprenderRespuesta,
  type PropuestaAprenderVista,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { exigir } from "../compras/escritura.js";
import { exigirCliente, idDe, periodoDe } from "../compras/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { contextoGastos } from "./contexto.js";
import { aErrorHttp, GastosError } from "./errores.js";
import { normalizarExcepciones, normalizarPalabraGnd } from "./normalizar.js";

/**
 * «Aprender estas palabras» al excluir una compra con XML (spec 027, RF-118, HU-42; R-5, R-7, U-11; CA-9, CA-14). Pedir la propuesta y
 * guardar exigen `reglas.gestionar` sobre un cliente visible. La compra tiene que ser del cliente y del periodo de la ruta (404 igual que
 * una inexistente), estar excluida en su versión vigente (409 `compra_no_excluida`) y tener XML vigente (409 `compra_sin_xml`). Las glosas
 * del XML se leen solo para proponer términos y NUNCA se guardan, se auditan ni se devuelven: salen únicamente palabras normalizadas. Guardar
 * es todo o nada y lo hace `gnd_aprender` (0070); nunca deshace ni bloquea la exclusión.
 */
@Injectable()
export class AprenderService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  /**
   * Hasta 10 términos de las glosas del XML vigente que el diccionario efectivo del estudio aún no coincide y, solo para los que la
   * tienen (su otra forma es otra palabra: «medias» / «media pulgada»), sus frases de excepción sugeridas (0072, H-027-2-3).
   */
  async proponer(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
    compraCruda: string,
  ): Promise<PropuestaAprenderVista> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda).toLowerCase();
    const clienteId = clienteCrudo.toLowerCase();
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      await exigirExcluida(tx, clienteId, periodo, compraId);
      const glosas = await leerGlosasCompra(tx, compraId);
      if (glosas === null) throw new GastosError("compra_sin_xml");
      // Sin proveedores: solo hace falta el diccionario efectivo (el CIIU y el historial no intervienen en la propuesta).
      const { diccionario } = await contextoGastos(tx, clienteId, periodo, []);
      const terminos = proponerTerminos(glosas, diccionario);
      const excepciones = await excepcionesSugeridas(tx, terminos);
      return propuestaAprenderVistaSchema.parse(
        Object.keys(excepciones).length === 0 ? { terminos } : { terminos, excepciones },
      );
    });
  }

  /** Guarda los términos elegidos como palabras propias «aprendidas»; los que el estudio ya tiene se omiten y se informan. */
  async aprender(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
    compraCruda: string,
    cuerpo: unknown,
  ): Promise<AprenderRespuesta> {
    const v = aprenderSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda).toLowerCase();
    const clienteId = clienteCrudo.toLowerCase();
    // Se normaliza ANTES de abrir la transacción: un término que no queda en una palabra válida es 400 y no guarda ninguno (todo o nada).
    // Las frases de excepción (si vienen) con la misma normalización que las de POST /palabras (H-027-2-3).
    const terminos = v.data.terminos.map((t) => ({
      termino: normalizarPalabraGnd(t.termino),
      categoria: t.categoria,
      ...(t.excepciones === undefined ? {} : { excepciones: normalizarExcepciones(t.excepciones) }),
    }));
    const ctx = contextoDe(sesion);
    try {
      const r = await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          await exigirCompra(tx, clienteId, periodo, compraId);
          return aprender(tx, { clienteId, compraId, terminos });
        }),
      );
      return aprenderRespuestaSchema.parse(r);
    } catch (e) {
      throw aErrorHttp(e);
    }
  }
}

/** La compra viva del cliente y periodo de la ruta (404 si es de otro cliente, periodo o estudio, o no existe). */
async function exigirCompra(tx: Tx, clienteId: string, periodo: string, compraId: string) {
  return exigir(await leerDetalleCompra(tx, clienteId, periodo, compraId, { conHistorial: false }));
}

/** Además, con exclusión vigente: aprender solo se ofrece tras excluir (409 `compra_no_excluida`). */
async function exigirExcluida(tx: Tx, clienteId: string, periodo: string, compraId: string): Promise<void> {
  const d = await exigirCompra(tx, clienteId, periodo, compraId);
  if (!d.compra.excluida) throw new GastosError("compra_no_excluida");
}
