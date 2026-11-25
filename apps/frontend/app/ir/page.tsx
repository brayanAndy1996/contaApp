"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { MENSAJES_CORREO as M, resolverIr } from "../../lib/correo";
import { obtenerSesion, reiniciarSesion } from "../../lib/sesion";

// Entrada de los enlaces de los correos (spec 028, R-7, D-3): `/ir?estudio=<uuid>&pantalla=<clave>[&cliente=<uuid>]`.
// Valida todo antes de tocar nada, cambia de estudio si hace falta y navega solo a rutas del sitio que salen de una lista
// cerrada; cualquier duda lleva a la elección de estudio.

export default function Ir() {
  const router = useRouter();
  const corrida = useRef(false);

  useEffect(() => {
    if (corrida.current) return;
    corrida.current = true;
    (async () => {
      const destino = resolverIr(new URLSearchParams(window.location.search));
      if (!destino) {
        router.replace("/estudios");
        return;
      }
      try {
        const sesion = await obtenerSesion();
        if (!sesion) {
          router.replace("/login");
          return;
        }
        if (sesion.estudioActivo?.id.toLowerCase() !== destino.estudioId.toLowerCase()) {
          const r = await api("/auth/estudio", {
            method: "POST",
            body: { tenantId: destino.estudioId },
            manejar401: false,
          });
          if (!r.ok) {
            router.replace("/estudios");
            return;
          }
          reiniciarSesion();
        }
        router.replace(destino.ruta);
      } catch {
        router.replace("/estudios");
      }
    })();
  }, [router]);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <p role="status" className="m-0 text-tinta-suave">
        {M.irAbriendo}
      </p>
    </main>
  );
}
