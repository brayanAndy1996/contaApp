import { z } from "zod";
import { validarRuc } from "./ruc.js";

export const REGIMENES = ["rg", "rmt", "rer", "nrus"] as const;
export const ZONAS = ["general", "amazonia"] as const;
export const MONEDAS = ["PEN", "USD"] as const;
export const ESTADOS_CREDENCIAL = [
  "no_configurada",
  "configurada",
  "verificada",
  "invalida",
] as const;

export type EstadoCredencial = (typeof ESTADOS_CREDENCIAL)[number];

/** Perfil fiscal del cliente (D1). */
export interface PerfilFiscal {
  regimen: (typeof REGIMENES)[number] | null;
  zona: (typeof ZONAS)[number];
  ventasExoneradas: boolean;
  ventasMixtas: boolean;
  monedaHabitual: (typeof MONEDAS)[number];
}

export interface CrearClienteInput {
  ruc: string;
  razonSocial?: string;
  responsableId?: string;
  perfil?: PerfilFiscal;
}

/** El RUC es inmutable: no viaja en la edición. */
export interface EditarClienteInput {
  razonSocial?: string;
  perfil?: PerfilFiscal;
}

export interface FiltrosClientes {
  responsable?: string;
  credencial?: EstadoCredencial;
  archivados?: boolean;
  q?: string;
}

/** Cliente tal como lo ve la API: solo estados de credencial, ningún secreto. */
export interface ClienteDto {
  id: string;
  ruc: string;
  razonSocial: string;
  estadoContribuyente: string | null;
  condicionContribuyente: string | null;
  perfil: PerfilFiscal;
  archivado: boolean;
  responsable: { id: string; nombre: string | null } | null;
  credenciales: { sol: EstadoCredencial; sire_api: EstadoCredencial };
}

const RAZON_SOCIAL_MAX = 200;
const Q_MAX = 100;

const razonSocialSchema = z.string().min(1).max(RAZON_SOCIAL_MAX);

export const perfilFiscalSchema = z.object({
  regimen: z.enum(REGIMENES).nullable(),
  zona: z.enum(ZONAS),
  ventasExoneradas: z.boolean(),
  ventasMixtas: z.boolean(),
  monedaHabitual: z.enum(MONEDAS),
});

export const clienteCrearSchema = z.object({
  ruc: z.string().refine(validarRuc, { message: "RUC inválido" }),
  razonSocial: razonSocialSchema.optional(),
  responsableId: z.uuid().optional(),
  perfil: perfilFiscalSchema.optional(),
});

export const clienteEditarSchema = z.object({
  razonSocial: razonSocialSchema.optional(),
  perfil: perfilFiscalSchema.optional(),
});

export const filtrosClientesSchema = z.object({
  responsable: z.union([z.literal("ninguno"), z.uuid()]).optional(),
  credencial: z.enum(ESTADOS_CREDENCIAL).optional(),
  archivados: z
    .literal("1")
    .transform(() => true)
    .optional(),
  q: z.string().max(Q_MAX).optional(),
});
