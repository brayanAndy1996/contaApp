"use client";

import { Info, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { MenuPrincipal } from "../../components/marco/menu-principal";
import { Campana } from "../../components/notificaciones/campana";
import { Alert, AlertDescription } from "../../components/ui";
import { cargarYo, type Yo } from "../../lib/acceso";
import { api, EVENTO_ESTUDIO_DESFASADO } from "../../lib/api";
import { obtenerSesion, reiniciarSesion, type Sesion } from "../../lib/sesion";

interface Estudio {
  id: string;
  nombre: string;
  ultimoUsado: boolean;
}

const ERROR_CAMBIO = "No se pudo cambiar de estudio. Inténtalo de nuevo.";
const ERROR_CARGA = "No se pudo cargar la sesión. Recarga la página.";
const ERROR_CERRAR = "No se pudo cerrar la sesión. Inténtalo de nuevo.";
const AVISO_DESFASADO =
  "El estudio activo cambió en otra pestaña. Se actualizaron los datos.";

// Misma caja que el `<nav>` del menú (barra inferior en celular; lateral desde 1024 px), sin contenido.
const CAJA_MENU =
  "fixed inset-x-0 bottom-0 z-40 h-[var(--alto-barra-inferior,calc(4.5rem+env(safe-area-inset-bottom)))] border-t border-linea bg-hoja-alterna lg:inset-x-auto lg:inset-y-0 lg:left-0 lg:h-auto lg:w-64 lg:border-r lg:border-t-0";

export default function LayoutApp({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [estudios, setEstudios] = useState<Estudio[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [yo, setYo] = useState<Yo | null>(null);
  // Época de los datos: sube al cambiar de estudio (aquí o en otra pestaña) para remontar la pantalla
  // abierta; así ninguna lista, formulario ni lupa conserva datos del estudio anterior (spec 018, T4a).
  const [epoca, setEpoca] = useState(0);

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
        setEpoca((e) => e + 1);
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
      setEpoca((e) => e + 1);
      router.refresh();
    } catch {
      setError(ERROR_CAMBIO);
    }
  }

  async function cerrarSesion() {
    setError(null);
    setAviso(null);
    try {
      const r = await api("/auth/logout", { method: "POST" });
      if (!r.ok && r.status !== 401) {
        setError(ERROR_CERRAR);
        return;
      }
      reiniciarSesion();
      router.replace("/login");
    } catch {
      setError(ERROR_CERRAR);
    }
  }

  return (
    <>
      {/* `usePathname()` del menú es dato de la URL en tiempo de petición: Next exige un límite de Suspense. El
          fallback es una barra fija vacía con la misma caja, así que el contenido no se mueve. */}
      <Suspense fallback={<div aria-hidden="true" className={CAJA_MENU} />}>
        <MenuPrincipal
          estudioActivoId={sesion?.estudioActivo?.id ?? ""}
          estudios={estudios}
          yo={yo}
          campana={
            sesion ? (
              <Campana key={sesion.estudioActivo?.id ?? "sin-estudio"} />
            ) : null
          }
          alCambiarEstudio={(id) => void cambiarEstudio(id)}
          alCerrarSesion={() => void cerrarSesion()}
        />
      </Suspense>
      {/* Deja espacio al menú lateral (desde 1024 px) y a la barra inferior de celular (su alto real lo publica el menú en `--alto-barra-inferior`). */}
      <div className="min-h-dvh pb-[var(--alto-barra-inferior,calc(4.5rem+env(safe-area-inset-bottom)))] lg:pb-0 lg:pl-64">
        {(aviso || error) && (
          <div className="flex flex-col gap-2 px-4 pt-4 sm:px-6">
            {aviso && (
              <Alert tono="info">
                <Info aria-hidden="true" />
                <AlertDescription>{aviso}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert tono="error">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <Fragment key={epoca}>{children}</Fragment>
      </div>
    </>
  );
}
