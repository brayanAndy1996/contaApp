"use client";

import { PreferenciasCorreo } from "../../../../components/correo/preferencias-correo";
import { EncabezadoPagina } from "../../../../components/ui";
import { MENSAJES_CORREO as M } from "../../../../lib/correo";

// «Mi cuenta → Correo» (spec 028): qué avisos llegan al correo del usuario.
export default function PaginaCorreo() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:px-6">
      <EncabezadoPagina titulo={M.titulo} descripcion={M.descripcion} />
      <PreferenciasCorreo />
    </main>
  );
}
