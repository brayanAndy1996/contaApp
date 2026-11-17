/**
 * Clases de tokens (spec 038, T7) para estilar los diálogos, menús y enlaces propios de las pantallas
 * sin reemplazarlos por los de Radix (P-6). Solo tokens de `app/globals.css`.
 */

/** Fondo que cubre la página detrás de un diálogo. */
export const velo = "fixed inset-0 z-50 bg-tinta/70";

/** Caja de un diálogo propio, centrada y con desplazamiento interior si no cabe. */
export const panelDialogo =
  "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-dialogo bg-hoja p-6 text-tinta shadow-dialogo";

/** Anillo de foco primario para controles propios (D5). */
export const anilloFoco = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primario";

/** Enlace de texto del estilo A. */
export const enlace =
  "cursor-pointer rounded-control text-primario underline underline-offset-2 hover:text-primario-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primario";

/** Montos (D7): dígitos de igual ancho, a la derecha y sin saltos de línea. */
export const cifra = "cifras whitespace-nowrap text-right";
