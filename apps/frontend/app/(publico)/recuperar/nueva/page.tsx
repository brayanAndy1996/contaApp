"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../../../lib/api";

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
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Nueva contraseña</h1>
        {listo ? (
          <>
            <p role="status">{ACTUALIZADA}</p>
            <Link href="/login" className="text-sm underline">
              Ir a iniciar sesión
            </Link>
          </>
        ) : (
          <form onSubmit={cambiar} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Nueva contraseña
              <input
                type="password"
                autoComplete="new-password"
                required
                value={contrasena}
                onChange={(e) => setContrasena(e.target.value)}
                className="rounded border px-3 py-2"
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={enviando || !token}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Cambiar contraseña
            </button>
            {!token && (
              <Link href="/recuperar" className="text-sm underline">
                Solicitar un enlace nuevo
              </Link>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
