"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api } from "../../../lib/api";

// El mismo mensaje exista o no el correo (CA-8); nunca se repite el correo escrito.
const ENVIADO =
  "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.";
const ERROR_GENERAL = "No se pudo enviar la solicitud. Inténtalo de nuevo.";

export default function Recuperar() {
  const [correo, setCorreo] = useState("");
  const [mensaje, setMensaje] = useState<{
    texto: string;
    error: boolean;
  } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function pedir(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setEnviando(true);
    setMensaje(null);
    try {
      const r = await api("/auth/recuperar", {
        method: "POST",
        body: { correo },
        sinSesion: true,
      });
      setMensaje(
        r.ok
          ? { texto: ENVIADO, error: false }
          : { texto: ERROR_GENERAL, error: true },
      );
    } catch {
      setMensaje({ texto: ERROR_GENERAL, error: true });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form onSubmit={pedir} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Recuperar contraseña</h1>
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
        {mensaje && (
          <p
            role={mensaje.error ? "alert" : "status"}
            className={mensaje.error ? "text-sm text-red-600" : "text-sm"}
          >
            {mensaje.texto}
          </p>
        )}
        <button
          type="submit"
          disabled={enviando}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          Enviar enlace
        </button>
        <Link href="/login" className="text-sm underline">
          Volver a iniciar sesión
        </Link>
      </form>
    </main>
  );
}
