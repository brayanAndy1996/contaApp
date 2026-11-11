import type { NotificacionVista } from "../../lib/notificaciones";
import { MENSAJES_NOTIFICACIONES } from "../../lib/notificaciones";

// Texto en español de una notificación (spec 017, D-11; CA-16), armado desde `tipo` y `params`. Un tipo o un código
// que este cliente no conoce da un texto genérico: nunca se muestra el código crudo. Todo sale como texto de React
// (sin `dangerouslySetInnerHTML`): una razón social con `<script>` se ve literal.

const CREDENCIALES: Record<string, string> = {
  sol: "clave SOL",
  sire_api: "credencial de la API del SIRE",
};

const TAREAS: Record<string, string> = {
  "cliente.consultar_ruc": "La consulta de datos del RUC",
  "credencial.verificar_sol": "La verificación de la clave SOL",
  "credencial.verificar_sire": "La verificación de la credencial del SIRE",
  "sire.propuesta.descargar": "La descarga de la propuesta del SIRE",
  "archivo.generar": "La generación del archivo",
};

const MOTIVOS: Record<string, string> = {
  sunat_no_responde: "SUNAT no responde",
  credencial_invalida: "la credencial es inválida",
  datos_invalidos: "los datos son inválidos",
  portal_cambio: "el portal de SUNAT cambió",
  interrumpido: "se interrumpió",
  acceso_retirado: "se retiró el acceso",
  cancelado_usuario: "lo canceló un usuario",
  error_interno: "ocurrió un error interno",
};

const RECURSOS: Record<string, string> = {
  rucs: "RUC",
  usuarios: "usuarios",
};

export function textoNotificacion(n: NotificacionVista): string {
  const de = n.cliente ? ` de ${n.cliente.razonSocial}` : "";
  switch (n.tipo) {
    case "credencial_invalida": {
      const cred = CREDENCIALES[n.params.credencial];
      return cred
        ? `La ${cred}${de} fue rechazada por SUNAT. Actualízala para seguir trabajando.`
        : `Una credencial${de} fue rechazada por SUNAT. Actualízala para seguir trabajando.`;
    }
    case "trabajo_terminado": {
      const tarea = TAREAS[n.params.tipoTrabajo] ?? "Un trabajo en segundo plano";
      if (n.params.estado === "completado") return `${tarea}${de} terminó.`;
      const motivo = n.params.motivo ? MOTIVOS[n.params.motivo] : undefined;
      return motivo
        ? `${tarea}${de} terminó con error: ${motivo}.`
        : `${tarea}${de} terminó con error.`;
    }
    case "plan_limite": {
      // La unidad va junto a la cifra («usas 9 de 10 RUC»). Si el aviso del 90 % llega ya con el plan lleno (p. ej. 5 de 5
      // usuarios, junto al del 100 %), no dice «estás por llegar»: dice que se superó el 90 %.
      const recurso = RECURSOS[n.params.recurso] ?? "recursos";
      const { usado, limite, umbral } = n.params;
      const uso = `usas ${usado} de ${limite} ${recurso}`;
      if (umbral >= 100) return `Llegaste al límite de tu plan: ${uso}.`;
      return usado >= limite
        ? `Superaste el 90 % del límite de tu plan: ${uso}.`
        : `Estás por llegar al límite de tu plan: ${uso}.`;
    }
    default:
      return MENSAJES_NOTIFICACIONES.genericoTexto;
  }
}

export function TextoNotificacion({ notificacion }: { notificacion: NotificacionVista }) {
  return <span>{textoNotificacion(notificacion)}</span>;
}
