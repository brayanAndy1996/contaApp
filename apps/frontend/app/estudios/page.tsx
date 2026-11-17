"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAccesoPlataforma } from "../../lib/plataforma";
import { reiniciarSesion } from "../../lib/sesion";
import { Alert, Button, Card, enlace } from "../../components/ui";
import { cn } from "../../lib/utils";

const ENLACE = cn(
  enlace,
  "text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center",
);

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
  // Quien es super-admin de plataforma (spec 006, D5) ve el acceso a su administración; el servidor valida.
  const acceso = useAccesoPlataforma();
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
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Elige tu estudio
        </h1>
        {estudios?.length === 0 && <p>{SIN_ESTUDIOS}</p>}
        {estudios && estudios.length > 0 && (
          <ul className="flex flex-col gap-2">
            {estudios.map((e) => (
              <li key={e.id}>
                <Button
                  variant="secundario"
                  aria-current={e.ultimoUsado ? "true" : undefined}
                  onClick={() => void elegir(e.id)}
                  className="h-auto min-h-11 w-full justify-start whitespace-normal py-2 text-left aria-[current=true]:border-primario aria-[current=true]:bg-primario-suave aria-[current=true]:font-bold"
                >
                  {e.nombre}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <Alert tono="error">{error}</Alert>}
        {acceso === "admin" && (
          <Link href="/admin" className={ENLACE}>
            Administración de plataforma
          </Link>
        )}
      </Card>
    </main>
  );
}
