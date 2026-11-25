"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "../../components/ui";
import { MENSAJES_SEGURIDAD } from "../../lib/seguridad";
import {
  RUTA_SEGURIDAD,
  bloqueadaPorFactor,
  obtenerSesion,
} from "../../lib/sesion";

type Estado = "cargando" | "libre" | "bloqueada";

// Administración de plataforma (spec 029, CA-4): el rol de plataforma siempre exige el segundo factor. Sin él
// verificado solo se puede enrolar; el servidor responde 403 `segundo_factor_requerido` en cada ruta.
export default function LayoutPlataforma({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>("cargando");

  useEffect(() => {
    let vigente = true;
    obtenerSesion()
      .then((sesion) => {
        if (!vigente) return;
        if (!sesion || sesion.factor === "pendiente") {
          router.replace("/login");
        } else if (bloqueadaPorFactor(sesion)) {
          setEstado("bloqueada");
          router.replace(RUTA_SEGURIDAD);
        } else {
          setEstado("libre");
        }
      })
      .catch(() => {
        // Sin poder leer la sesión se deja pasar: cada petición se valida en el servidor.
        if (vigente) setEstado("libre");
      });
    return () => {
      vigente = false;
    };
  }, [router]);

  if (estado === "bloqueada")
    return (
      <div className="px-4 pt-4 sm:px-6">
        <Alert tono="aviso">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{MENSAJES_SEGURIDAD.exigidoAviso}</AlertDescription>
        </Alert>
      </div>
    );
  return estado === "libre" ? <>{children}</> : null;
}
