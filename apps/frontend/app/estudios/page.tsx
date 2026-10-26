"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { reiniciarSesion } from "../../lib/sesion";

interface Estudio {
  id: string;
  nombre: string;
  ultimoUsado: boolean;
}

const SIN_ESTUDIOS =
  "No perteneces a ningún estudio activo. Pide a tu administrador que te agregue a uno.";
const ERROR_CARGA = "No se pudieron cargar tus estudios. Inténtalo de nuevo.";
const ERROR_ELEGIR = "No se pudo cambiar de estudio. Inténtalo de nuevo.";

export default function Estudios() {
  const router = useRouter();
  const [estudios, setEstudios] = useState<Estudio[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    api<Estudio[]>("/auth/estudios")
      .then((r) => {
        if (!vigente) return;
        if (r.ok && r.datos) setEstudios(r.datos);
        else if (r.status !== 401) setError(ERROR_CARGA);
      })
      .catch(() => {
        if (vigente) setError(ERROR_CARGA);
      });
    return () => {
      vigente = false;
    };
  }, []);

  async function elegir(tenantId: string) {
    setError(null);
    try {
      const r = await api("/auth/estudio", {
        method: "POST",
        body: { tenantId },
      });
      if (!r.ok) {
        setError(ERROR_ELEGIR);
        return;
      }
      reiniciarSesion();
      router.push("/");
    } catch {
      setError(ERROR_ELEGIR);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Elige tu estudio</h1>
        {estudios?.length === 0 && <p>{SIN_ESTUDIOS}</p>}
        {estudios && estudios.length > 0 && (
          <ul className="flex flex-col gap-2">
            {estudios.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  aria-current={e.ultimoUsado ? "true" : undefined}
                  onClick={() => void elegir(e.id)}
                  className="w-full rounded border px-4 py-2 text-left aria-[current=true]:border-black aria-[current=true]:font-semibold"
                >
                  {e.nombre}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
