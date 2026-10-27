import { Controller, Get, Inject, Param, Req } from "@nestjs/common";
import { leerCliente, listarClientes, type ClienteLeido, type ClienteListado, type ContappDb } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { DB } from "../auth/inyeccion.js";
import { AccesoError } from "../acceso/errores.js";
import { Permiso, type PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe, contextoDe } from "./contexto.js";

/**
 * Lectura mínima de clientes (D20): el listado se filtra con `filtroAlcance` y el detalle lo protege
 * `ClienteScopeGuard` (inexistente, ajeno y no asignado dan el mismo 404).
 */
@Controller("clientes")
export class ClientesController {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  @Permiso("clientes.ver")
  @Get()
  listar(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso): Promise<ClienteListado[]> {
    const alcance = alcanceDe(req.acceso);
    return this.db.withTenant(contextoDe(sesion), (tx) => listarClientes(tx, alcance));
  }

  @Permiso("clientes.ver")
  @Get(":clienteId")
  async leer(@Sesion() sesion: SesionResuelta, @Param("clienteId") clienteId: string): Promise<ClienteLeido> {
    const c = await this.db.withTenant(contextoDe(sesion), (tx) => leerCliente(tx, clienteId));
    if (c === null) throw new AccesoError("no_encontrado");
    return c;
  }
}
