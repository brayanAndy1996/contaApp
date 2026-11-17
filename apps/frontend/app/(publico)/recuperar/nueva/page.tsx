"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../../../lib/api";
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  enlace,
} from "../../../../components/ui";
import { cn } from "../../../../lib/utils";

const ENLACE = cn(
  enlace,
  "text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center",
);

const ACTUALIZADA = "Tu contraseña fue actualizada.";
const TOKEN_INVALIDO = "El enlace no es válido o venció. Solicita uno nuevo.";
const LONGITUD = "La contraseña debe tener entre 12 y 128 caracteres.";
const COMUN = "Esa contraseña es demasiado común. Elige otra.";
const DEMASIADOS_INTENTOS =
  "Demasiados intentos. Inténtalo de nuevo en unos minutos.";
const ERROR_GENERAL = "No se pudo cambiar la contraseña. Inténtalo de nuevo.";

/** Lee `#t=<token>` y borra el fragmento de la URL (no llega al servidor ni a Referer). */
function tomarTokenDelFragmento(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  return token ? token : null;
}

function mensajeDeError(
  status: number,
  datos: { codigo?: string; motivo?: string } | null,
): string {
  if (status === 429) return DEMASIADOS_INTENTOS;
  if (status === 400 && datos?.codigo === "token_invalido")
    return TOKEN_INVALIDO;
  if (status === 400 && datos?.codigo === "contrasena_invalida") {
    return datos.motivo === "comun" ? COMUN : LONGITUD;
  }
  return ERROR_GENERAL;
}

export default function Nueva() {
  // El token solo vive en memoria; el ref evita perderlo si el efecto corre dos veces (StrictMode).
  const lectura = useRef<{ token: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contrasena, setContrasena] = useState("");
  const [listo, setListo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    lectura.current ??= { token: tomarTokenDelFragmento() };
    const leido = lectura.current.token;
    setToken(leido);
    if (!leido) setError(TOKEN_INVALIDO);
  }, []);

  async function cambiar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!token) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string; motivo?: string }>(
        "/auth/recuperar/restablecer",
        { method: "POST", body: { token, contrasena }, sinSesion: true },
      );
      if (r.ok) setListo(true);
      else setError(mensajeDeError(r.status, r.datos));
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Nueva contraseña
        </h1>
        {listo ? (
          <>
            <Alert tono="ok">{ACTUALIZADA}</Alert>
            <Link href="/login" className={ENLACE}>
              Ir a iniciar sesión
            </Link>
          </>
        ) : (
          <form onSubmit={cambiar} className="flex flex-col gap-4">
            <Label>
              Nueva contraseña
              <Input
                type="password"
                autoComplete="new-password"
                required
                value={contrasena}
                onChange={(e) => setContrasena(e.target.value)}
                className="max-lg:h-11"
              />
            </Label>
            {error && <Alert tono="error">{error}</Alert>}
            <Button
              type="submit"
              disabled={enviando || !token}
              className="max-lg:h-11"
            >
              Cambiar contraseña
            </Button>
            {!token && (
              <Link href="/recuperar" className={ENLACE}>
                Solicitar un enlace nuevo
              </Link>
            )}
          </form>
        )}
      </Card>
    </main>
  );
}
