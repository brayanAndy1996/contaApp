import { Inject, Injectable } from "@nestjs/common";
import {
  AuthRepoError,
  PlataformaReglaError,
  type AuthRepo,
  type ContappDb,
  type PlanFila,
} from "@contapp/db";
import {
  planCrearSchema,
  planEditarSchema,
  suscripcionAsignarSchema,
  type PlanDto,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { idDeRuta, parsearCuerpo } from "../acceso/entrada.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { hashToken } from "../auth/sesion/token.js";

export interface EstudioDto {
  id: string;
  nombre: string;
  plan: { codigo: string; nombre: string } | null;
  estado: "prueba" | "activa" | null;
}

export interface SuscripcionDto {
  estudioId: string;
  plan: { codigo: string; nombre: string };
  estado: "prueba" | "activa";
  rucsExtraContratados: number;
}

/**
 * Traduce los rechazos de las funciones `auth.*` de plataforma a errores HTTP sin eco: sin alta (42501) 403, motivo
 * estable de la regla (P0001) 404/409/400, CHECK (23514) 400, UNIQUE de `codigo` (23505) 409. El resto sigue (500).
 */
function traducir(e: unknown): unknown {
  if (e instanceof PlataformaReglaError) {
    if (e.motivo === "no_encontrado") return new AccesoError("no_encontrado");
    if (e.motivo === "plan_inactivo") return new AccesoError("plan_inactivo");
    return new AccesoError("solicitud_invalida");
  }
  if (e instanceof AuthRepoError) {
    if (e.codigo === "42501") return new AccesoError("permiso_denegado");
    if (e.codigo === "23514") return new AccesoError("solicitud_invalida");
    if (e.codigo === "23505") return new AccesoError("codigo_existente");
  }
  return e;
}

const aDto = (f: PlanFila): PlanDto => ({
  id: f.id,
  codigo: f.codigo,
  nombre: f.nombre,
  precioMensual: f.precioMensual,
  precioAnual: f.precioAnual,
  maxRucs: f.maxRucs,
  maxUsuarios: f.maxUsuarios,
  precioRucExtra: f.precioRucExtra,
  maxRucsExtra: f.maxRucsExtra,
  frecuenciaBuzonMin: f.frecuenciaBuzonMin,
  features: f.features,
  activo: f.activo,
});

/**
 * Planes, estudios y suscripciones del super-admin (D5, D13). Cada operación corre en UN `withAuth` con el hash de la
 * sesión viva: primero `plataforma_yo` (un no-admin recibe el mismo 403 con cualquier cuerpo o id, antes de validar
 * nada) y después la función de plataforma, que vuelve a revalidar el alta. Ningún dato del estudio llega del cuerpo:
 * el único estudio es `:tenantId` de la ruta de asignación.
 */
@Injectable()
export class PlataformaService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withAuth">) {}

  private async ejecutar<T>(
    s: SesionResuelta,
    fn: (a: AuthRepo, hash: Buffer) => Promise<T>,
  ): Promise<T> {
    const hash = hashToken(s.token);
    try {
      return await this.db.withAuth(async (a) => {
        if ((await a.plataformaYo(hash)) === null) {
          throw new AccesoError("permiso_denegado");
        }
        return fn(a, hash);
      });
    } catch (e) {
      throw traducir(e);
    }
  }

  yo(s: SesionResuelta): Promise<{ admin: true }> {
    return this.ejecutar(s, async () => ({ admin: true as const }));
  }

  listarPlanes(s: SesionResuelta): Promise<PlanDto[]> {
    return this.ejecutar(s, async (a, h) => (await a.planListar(h)).map(aDto));
  }

  crearPlan(s: SesionResuelta, cuerpo: unknown): Promise<PlanDto> {
    return this.ejecutar(s, async (a, h) =>
      aDto(await a.planCrear(h, parsearCuerpo(planCrearSchema, cuerpo))),
    );
  }

  editarPlan(
    s: SesionResuelta,
    planId: string | undefined,
    cuerpo: unknown,
  ): Promise<PlanDto> {
    return this.ejecutar(s, async (a, h) =>
      aDto(
        await a.planEditar(
          h,
          idDeRuta(planId),
          parsearCuerpo(planEditarSchema, cuerpo),
        ),
      ),
    );
  }

  listarEstudios(s: SesionResuelta): Promise<EstudioDto[]> {
    return this.ejecutar(s, async (a, h) =>
      (await a.estudiosListar(h)).map((e) => ({
        id: e.id,
        nombre: e.nombre,
        plan: e.plan,
        estado: e.estado,
      })),
    );
  }

  asignarSuscripcion(
    s: SesionResuelta,
    tenantId: string | undefined,
    cuerpo: unknown,
  ): Promise<SuscripcionDto> {
    return this.ejecutar(s, async (a, h) => {
      const id = idDeRuta(tenantId);
      const { planId, rucsExtraContratados } = parsearCuerpo(
        suscripcionAsignarSchema,
        cuerpo,
      );
      const r = await a.suscripcionAsignar(
        h,
        id,
        planId,
        rucsExtraContratados,
      );
      return {
        estudioId: r.tenantId,
        plan: { codigo: r.planCodigo, nombre: r.planNombre },
        estado: r.estado,
        rucsExtraContratados: r.rucsExtraContratados,
      };
    });
  }
}
