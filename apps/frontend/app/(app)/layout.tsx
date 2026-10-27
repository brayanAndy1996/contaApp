"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cargarYo, tiene, type Yo } from "../../lib/acceso";
import { api, EVENTO_ESTUDIO_DESFASADO } from "../../lib/api";
import { obtenerSesion, reiniciarSesion, type Sesion } from "../../lib/sesion";

interface Estudio {
  id: string;
  nombre: string;
  ultimoUsado: boolean;
}

const ERROR_CAMBIO = "No se pudo cambiar de estudio. Inténtalo de nuevo.";
const ERROR_CARGA = "No se pudo cargar la sesión. Recarga la página.";
const AVISO_DESFASADO =
  "El estudio activo cambió en otra pestaña. Se actualizaron los datos.";

export default function LayoutApp({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [estudios, setEstudios] = useState<Estudio[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [yo, setYo] = useState<Yo | null>(null);

  // El menú decide por permisos (`GET /acceso/yo`); si falla, simplemente no hay enlaces.
  const refrescarYo = useCallback(async () => {
    try {
      setYo((await cargarYo()).yo);
    } catch {
      setYo(null);
    }
  }, []);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const actual = await obtenerSesion();
      if (!vigente) return;
      if (!actual) return router.replace("/login");
      if (!actual.estudioActivo) return router.replace("/estudios");
      const lista = await api<Estudio[]>("/auth/estudios");
      if (!vigente) return;
      setSesion(actual);
      if (lista.ok && lista.datos) setEstudios(lista.datos);
      await refrescarYo();
    })().catch(() => {
      if (vigente) setError(ERROR_CARGA);
    });
    return () => {
      vigente = false;
    };
  }, [router, refrescarYo]);

  // Otra pestaña cambió de estudio: `api()` ya recargó la sesión; aquí se refleja y se refrescan datos.
  useEffect(() => {
    const alDesfasar = () => {
      void obtenerSesion().then((s) => {
        if (!s) return;
        setSesion(s);
        setAviso(AVISO_DESFASADO);
        void refrescarYo();
        router.refresh();
      });
    };
    window.addEventListener(EVENTO_ESTUDIO_DESFASADO, alDesfasar);
    return () =>
      window.removeEventListener(EVENTO_ESTUDIO_DESFASADO, alDesfasar);
  }, [router, refrescarYo]);

  async function cambiarEstudio(tenantId: string) {
    setError(null);
    setAviso(null);
    try {
      const r = await api("/auth/estudio", {
        method: "POST",
        body: { tenantId },
      });
      if (!r.ok) {
        setError(ERROR_CAMBIO);
        return;
      }
      // La cookie y el token CSRF rotaron: se vuelve a leer la sesión antes de refrescar.
      reiniciarSesion();
      const nueva = await obtenerSesion();
      if (nueva) setSesion(nueva);
      await refrescarYo();
      router.refresh();
    } catch {
      setError(ERROR_CAMBIO);
    }
  }

  return (
    <>
      <nav className="flex items-center gap-3 border-b px-6 py-3 text-sm">
        <label className="flex items-center gap-2">
          Estudio
          <select
            value={sesion?.estudioActivo?.id ?? ""}
            onChange={(e) => void cambiarEstudio(e.target.value)}
            disabled={estudios.length === 0}
            className="rounded border px-2 py-1"
          >
            {estudios.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>
        </label>
        {tiene(yo, "clientes.ver") && <Link href="/clientes">Clientes</Link>}
        {tiene(yo, "usuarios.ver") && <Link href="/usuarios">Usuarios</Link>}
        {aviso && <p role="status">{aviso}</p>}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
      </nav>
      {children}
    </>
  );
}
