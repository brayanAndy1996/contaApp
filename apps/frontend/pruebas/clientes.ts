// Soporte de las pruebas de pantallas de 007a (clientes): mensajes visibles, etiquetas y cuerpos de
// ejemplo. Son el contrato de T11a/T11b: las pantallas deben mostrar estos textos exactos. Solo datos
// de prueba (canarios); sin lógica de producción.

export const MENSAJES_CLIENTES = {
  // Alta: error en línea del RUC (D2, `validarRuc`), sin llamar a la API.
  rucInvalido: "El RUC no es válido.",
  // 409 ruc_duplicado (también si el existente está archivado).
  rucDuplicado: "Ya existe un cliente con ese RUC.",
  // 409 cliente_archivado y texto fijo de un cliente archivado (solo lectura, D5).
  clienteArchivado: "El cliente está archivado y es de solo lectura.",
  // 400 de PATCH (valor fuera del catálogo).
  datosInvalidos: "Revisa los datos fiscales.",
  datosGuardados: "Datos guardados.",
} as const;

/** Etiqueta visible de cada estado de credencial (solo estado; ningún secreto). */
export const ETIQUETA_ESTADO = {
  no_configurada: "No configurada",
  configurada: "Configurada",
  verificada: "Verificada",
  invalida: "Inválida",
} as const;

export type EstadoCredencialPrueba = keyof typeof ETIQUETA_ESTADO;

/** RUC válidos (dígito verificador módulo 11) y uno con el dígito errado. */
export const RUC_VALIDO = "20100000009";
export const RUC_VALIDO_OTRO = "20600000005";
export const RUC_DIGITO_ERRADO = "20123456785";

export const PERFIL_BASE = {
  regimen: null,
  zona: "general",
  ventasExoneradas: false,
  ventasMixtas: false,
  monedaHabitual: "PEN",
} as const;

/** `ClienteDto` del plan 007a. */
export function clienteDe(
  parcial: Partial<{
    id: string;
    ruc: string;
    razonSocial: string;
    archivado: boolean;
    perfil: Record<string, unknown>;
    responsable: { usuarioId: string; nombre: string } | null;
    credenciales: {
      sol: EstadoCredencialPrueba;
      sire_api: EstadoCredencialPrueba;
    };
  }> = {},
) {
  return {
    id: parcial.id ?? "c-1",
    ruc: parcial.ruc ?? RUC_VALIDO,
    razonSocial: parcial.razonSocial ?? "Alfa SAC",
    estadoContribuyente: null,
    condicionContribuyente: null,
    perfil: { ...PERFIL_BASE, ...parcial.perfil },
    archivado: parcial.archivado ?? false,
    responsable: parcial.responsable ?? null,
    credenciales: parcial.credenciales ?? {
      sol: "no_configurada",
      sire_api: "no_configurada",
    },
  };
}
