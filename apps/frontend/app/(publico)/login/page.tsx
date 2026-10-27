"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "../../../lib/api";
import { reiniciarSesion } from "../../../lib/sesion";

// Mensajes genéricos a propósito (CA-2, P3): el 401 es el mismo sea cual sea la causa.
const CREDENCIALES_INVALIDAS = "Correo o contraseña incorrectos.";
const DEMASIADOS_INTENTOS =
  "Demasiados intentos. Inténtalo de nuevo en unos minutos.";
const ERROR_GENERAL = "No se pudo iniciar sesión. Inténtalo de nuevo.";

interface RespuestaLogin {
  estudioActivo: { id: string; nombre: string } | null;
  requiereEstudio: boolean;
}

export default function Login() {
  const router = useRouter();
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function ingresar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const r = await api<RespuestaLogin>("/auth/login", {
        method: "POST",
        body: { correo, contrasena },
        sinSesion: true,
      });
      if (r.ok) {
        reiniciarSesion();
        router.push(r.datos?.estudioActivo ? "/" : "/estudios");
        return;
      }
      setError(
        r.status === 401
          ? CREDENCIALES_INVALIDAS
          : r.status === 429
            ? DEMASIADOS_INTENTOS
            : ERROR_GENERAL,
      );
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form onSubmit={ingresar} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Ingresar a ContApp</h1>
        <label className="flex flex-col gap-1 text-sm">
          Correo
          <input
            type="email"
            autoComplete="username"
            required
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
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
          disabled={enviando}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          Ingresar
        </button>
        <Link href="/recuperar" className="text-sm underline">
          Olvidé mi contraseña
        </Link>
      </form>
    </main>
  );
}
