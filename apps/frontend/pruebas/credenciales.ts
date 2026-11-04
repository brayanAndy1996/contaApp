// Soporte de las pruebas de la sección de credenciales (spec 007b, T6): mensajes visibles, canarios y
// cuerpos de ejemplo. Son el contrato de T13: la sección debe mostrar estos textos exactos. Solo datos
// de prueba (canarios); sin lógica de producción.

export const MENSAJES_CREDENCIALES = {
  // 200 de PUT: el formulario se vacía y el estado pasa a «Configurada».
  guardada: "Credencial guardada.",
  // 400 de PUT (1–256 bytes UTF-8 por campo).
  datosInvalidos: "Revisa los datos de la credencial.",
  // 202 de POST …/verificar: el trabajo queda visible en el panel (enlace a /trabajos).
  verificacionEncolada: "Verificación encolada.",
  enlacePanel: "Ver en el panel de trabajos",
  // 409 credencial_no_configurada (SIRE sin SOL, o la credencial pedida sin guardar).
  noConfigurada: "Primero guarda la credencial.",
  // D6 / CA-6: aviso fijo del grupo SIRE (se muestra tal cual, con punto final).
  avisoClaveSol:
    "Si cambió la clave SOL, guarde o verifique de nuevo la credencial SIRE.",
} as const;

/** Canarios: cadenas únicas que no deben aparecer en el DOM, `localStorage`, `sessionStorage` ni errores. */
export const CANARIO_USUARIO_SOL = "USR-SOL-CANARIO-9c1e";
export const CANARIO_CLAVE_SOL = "CLAVE-SOL-CANARIO-7f3a";
export const CANARIO_CLIENT_ID = "CLIENT-ID-CANARIO-5b2d";
export const CANARIO_CLIENT_SECRET = "SECRETO-SIRE-CANARIO-3d8e";

/**
 * Fecha ISO de una verificación. La UI la muestra como dd/mm/aaaa (día con o sin cero inicial) en la
 * zona del navegador; a las 10:00 UTC es el 3 de noviembre en casi todas las zonas.
 */
export const FECHA_VERIFICADA = "2026-11-03T10:00:00.000Z";
export const FECHA_VERIFICADA_TEXTO = /0?3\/11\/2026/;
export const MOTIVO_INVALIDA = "Clave rechazada por SUNAT";

export type TipoCredencialPrueba = "sol" | "sire_api";
type EstadoPrueba = "no_configurada" | "configurada" | "verificada" | "invalida";

/** Un elemento de `GET /clientes/:id/credenciales` (nunca sobre ni secreto). */
export function estadoCredencialDe(
  tipo: TipoCredencialPrueba,
  estado: EstadoPrueba,
  extra: { fecha?: string | null; motivo?: string | null } = {},
) {
  return {
    tipo,
    estado,
    fecha:
      extra.fecha ?? (estado === "verificada" ? FECHA_VERIFICADA : null),
    motivo: extra.motivo ?? (estado === "invalida" ? MOTIVO_INVALIDA : null),
  };
}

/** `TrabajoVista` de 008 (respuesta 202 de verificar y elemento de `GET /trabajos`). */
export function trabajoDe(
  parcial: Partial<{
    id: string;
    tipo: string;
    clienteId: string;
    estado: "en_cola" | "ejecutando" | "completado" | "error" | "cancelado";
    posicion: number | null;
    intentos: number;
    motivo: string | null;
    creadoEn: string;
    iniciadoEn: string | null;
    terminadoEn: string | null;
  }> = {},
) {
  return {
    id: parcial.id ?? "00000000-0000-4000-8000-000000000001",
    tipo: parcial.tipo ?? "credencial.verificar_sol",
    clienteId: parcial.clienteId ?? "00000000-0000-4000-8000-0000000000c1",
    estado: parcial.estado ?? "en_cola",
    posicion:
      parcial.posicion ??
      (parcial.estado === undefined || parcial.estado === "en_cola" ? 1 : null),
    intentos: parcial.intentos ?? 0,
    motivo: parcial.motivo ?? null,
    creadoEn: parcial.creadoEn ?? "2026-11-04T10:00:00.000Z",
    iniciadoEn: parcial.iniciadoEn ?? null,
    terminadoEn: parcial.terminadoEn ?? null,
    creadoPor: { usuarioId: "00000000-0000-4000-8000-0000000000a1" },
  };
}

/** Todo el texto que el usuario podría ver u obtener: DOM (texto y valores) y almacenamientos. */
export function superficieVisible(): string {
  const partes: string[] = [document.body.innerHTML];
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    partes.push((el as HTMLInputElement).value);
  });
  for (const almacen of [window.localStorage, window.sessionStorage]) {
    try {
      for (let i = 0; i < almacen.length; i++) {
        const k = almacen.key(i)!;
        partes.push(k, almacen.getItem(k) ?? "");
      }
    } catch {
      // Almacenamiento no disponible: nada que revisar.
    }
  }
  return partes.join("\n");
}
