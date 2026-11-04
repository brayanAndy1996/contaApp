import { HttpException, Inject, Injectable } from "@nestjs/common";
import { cifrarCredencial } from "@contapp/crypto";
import { guardarSobre, leerClienteDto, leerEstadoCredenciales, type ContappDb } from "@contapp/db";
import {
  guardarCredencialSireSchema,
  guardarCredencialSolSchema,
  tipoCredencialSchema,
  type CredencialEstadoDto,
  type GuardarCredencialRespuesta,
  type TipoCredencial,
  type TrabajoVista,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { KEY_WRAPPER, type ObtenerKeyWrapper } from "./key-wrapper.js";

const TIPOS: readonly TipoCredencial[] = ["sol", "sire_api"];
const TIPO_TRABAJO: Record<TipoCredencial, string> = {
  sol: "credencial.verificar_sol",
  sire_api: "credencial.verificar_sire",
};

/** Un tipo fuera del catálogo es una ruta inexistente: 404 sin eco. */
function tipoDe(valor: string): TipoCredencial {
  const r = tipoCredencialSchema.safeParse(valor);
  if (!r.success) throw new AccesoError("no_encontrado");
  return r.data;
}

/**
 * Credenciales (RF-034, RF-035; spec 007b). El backend solo cifra con la llave pública: nunca descifra ni devuelve
 * el sobre. Lo cifrado se prepara antes de la transacción (no se llama al proveedor de llaves con la BD tomada) y
 * cualquier fallo de cifrado se reduce a un 500 `{codigo}` sin causa, para que ningún valor del cuerpo salga en un log.
 */
@Injectable()
export class CredencialesService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(KEY_WRAPPER) private readonly obtenerWrapper: ObtenerKeyWrapper,
    @Inject(Encolador) private readonly encolador: Encolador,
  ) {}

  async guardar(
    sesion: SesionResuelta,
    clienteId: string,
    tipoCrudo: string,
    cuerpo: unknown,
  ): Promise<GuardarCredencialRespuesta> {
    const tipo = tipoDe(tipoCrudo);
    const ctx = contextoDe(sesion);
    const valor =
      tipo === "sol"
        ? guardarCredencialSolSchema.safeParse(cuerpo)
        : guardarCredencialSireSchema.safeParse(cuerpo);
    if (!valor.success) throw new AccesoError("solicitud_invalida");

    const sobre = await this.cifrar(ctx.tenantId, clienteId, tipo, valor.data);
    await this.db.withTenant(ctx, async (tx) => {
      const cliente = await leerClienteDto(tx, clienteId);
      if (cliente === null) throw new AccesoError("no_encontrado");
      if (cliente.archivado) throw new AccesoError("cliente_archivado");
      await guardarSobre(tx, { clienteId, tipo, sobre });
    });
    return { tipo, estado: "configurada" };
  }

  async estado(sesion: SesionResuelta, clienteId: string): Promise<CredencialEstadoDto[]> {
    const filas = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      if ((await leerClienteDto(tx, clienteId)) === null) throw new AccesoError("no_encontrado");
      return leerEstadoCredenciales(tx, clienteId);
    });
    return TIPOS.map((tipo) => {
      const f = filas.find((x) => x.tipo === tipo);
      return {
        tipo,
        estado: f?.estado ?? "no_configurada",
        fecha: f?.fecha?.toISOString() ?? null,
        motivo: f?.motivo ?? null,
      };
    });
  }

  /** Encola `credencial.verificar_*` (idempotente por cliente). SIRE usa también la clave SOL (D6): exige las dos. */
  async verificar(sesion: SesionResuelta, clienteId: string, tipoCrudo: string): Promise<TrabajoVista> {
    const tipo = tipoDe(tipoCrudo);
    const ctx = contextoDe(sesion);
    await this.db.withTenant(ctx, async (tx) => {
      const cliente = await leerClienteDto(tx, clienteId);
      if (cliente === null) throw new AccesoError("no_encontrado");
      if (cliente.archivado) throw new AccesoError("cliente_archivado");
      const configuradas = new Set((await leerEstadoCredenciales(tx, clienteId)).map((f) => f.tipo));
      const requeridas: TipoCredencial[] = tipo === "sol" ? ["sol"] : ["sol", "sire_api"];
      if (!requeridas.every((t) => configuradas.has(t))) throw new AccesoError("credencial_no_configurada");
    });
    const r = await this.encolador.encolar(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      {
        tipo: TIPO_TRABAJO[tipo],
        clienteId,
        parametros: {},
        prioridad: "interactivo",
        creadoPor: ctx.userId,
      },
    );
    return r.trabajo;
  }

  private async cifrar(
    tenantId: string,
    clienteId: string,
    tipo: TipoCredencial,
    valor: { usuario: string; clave: string } | { clientId: string; clientSecret: string },
  ) {
    try {
      return await cifrarCredencial(this.obtenerWrapper(), { tenantId, clienteId, tipo }, valor);
    } catch {
      // Sin `cause` ni mensaje: el error de cifrado podría arrastrar parte del secreto.
      throw new HttpException({ codigo: "error_interno" }, 500);
    }
  }
}
