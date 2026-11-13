import { Inject, Injectable } from "@nestjs/common";
import { fijarAporte, fijarReglaMotor, leerReglasMotor, type ContappDb, type Tx } from "@contapp/db";
import { CATALOGO_REGLAS_MOTOR } from "@contapp/domain";
import {
  codigoReglaMotorSchema,
  fijarAporteSchema,
  fijarReglaMotorSchema,
  reglasMotorSchema,
  type ReglasMotor,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";

/**
 * Interruptores del motor y aporte al catálogo del estudio (spec 021, RF-089, P-8, P-10; CA-8). Sin fila guardada, la regla está
 * encendida y el aporte también. Cambiar un interruptor toma el advisory exclusivo del estudio (en `packages/db`).
 */
@Injectable()
export class MotorReglasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async leer(sesion: SesionResuelta): Promise<ReglasMotor> {
    return this.db.withTenant(contextoDe(sesion), (tx) => this.vista(tx));
  }

  async fijar(sesion: SesionResuelta, codigoCrudo: string, cuerpo: unknown): Promise<ReglasMotor> {
    // Un código fuera del catálogo (la prevalidación incluida) es un recurso inexistente.
    const codigo = codigoReglaMotorSchema.safeParse(codigoCrudo);
    if (!codigo.success) throw new AccesoError("no_encontrado");
    const v = fijarReglaMotorSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await fijarReglaMotor(tx, { codigo: codigo.data, activa: v.data.activa, usuarioId: sesion.usuarioId });
      return this.vista(tx);
    });
  }

  async fijarAporte(sesion: SesionResuelta, cuerpo: unknown): Promise<ReglasMotor> {
    const v = fijarAporteSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await fijarAporte(tx, { aportar: v.data.aportar, usuarioId: sesion.usuarioId });
      return this.vista(tx);
    });
  }

  private async vista(tx: Tx): Promise<ReglasMotor> {
    const { filas, aportarCatalogo } = await leerReglasMotor(tx);
    const apagadas = new Set(filas.filter((f) => !f.activa).map((f) => f.codigo));
    return reglasMotorSchema.parse({
      reglas: CATALOGO_REGLAS_MOTOR.map((r) => ({ codigo: r.codigo, descripcion: r.descripcion, activa: !apagadas.has(r.codigo) })),
      aportarCatalogo,
    });
  }
}
