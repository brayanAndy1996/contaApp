"use client";

import { InvitacionResumen } from "../../../components/correo/invitacion-resumen";
import { ListaNotificaciones } from "../../../components/notificaciones/panel-notificaciones";

// Página de notificaciones (spec 017, D-11): historial completo con «cargar más». Encima, la invitación única al
// resumen diario por correo (spec 028, R-15), que no ocupa lugar cuando no corresponde.
export default function PaginaNotificaciones() {
  return (
    <>
      <div className="mx-auto max-w-2xl px-4 pt-6 empty:hidden md:px-6">
        <InvitacionResumen />
      </div>
      <ListaNotificaciones />
    </>
  );
}
