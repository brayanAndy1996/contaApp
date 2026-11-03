"use client";

import Link from "next/link";
import { registroSolicitudSchema } from "@contapp/shared";
import { useState, type FormEvent } from "react";
import { MENSAJES } from "../../../lib/acceso";
import { api } from "../../../lib/api";
import { MENSAJES_REGISTRO } from "../../../lib/registro";

// Registro público de un estudio (spec 006, D3, CA-3, CA-4, CA-10). Pide nombre del estudio, RUC
// opcional, nombre y correo del Dueño; no pide contraseña (se fija al confirmar el correo). La respuesta
// es la misma exista o no una cuenta con ese correo, así que la pantalla no distingue casos.

export default function Registro() {
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [errorRuc, setErrorRuc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (enviando) return;
    const campos = new FormData(evento.currentTarget);
    const leer = (nombre: string) => String(campos.get(nombre) ?? "").trim();
    // El RUC solo viaja si se escribió: el esquema de shared no admite cadena vacía.
    const ruc = leer("ruc");
    const entrada = {
      estudio: leer("estudio"),
      ...(ruc ? { ruc } : {}),
      nombre: leer("nombre"),
      correo: leer("correo"),
    };

    setError(null);
    setErrorRuc(null);
    const valida = registroSolicitudSchema.safeParse(entrada);
    if (!valida.success) {
      const problemas = valida.error.issues;
      if (problemas.some((p) => p.path[0] === "ruc")) {
        setErrorRuc(MENSAJES_REGISTRO.rucInvalido);
      }
      if (problemas.some((p) => p.path[0] !== "ruc")) {
        setError(MENSAJES_REGISTRO.solicitudInvalida);
      }
      return;
    }

    setEnviando(true);
    try {
      const r = await api("/registro", {
        method: "POST",
        body: valida.data,
        sinSesion: true,
      });
      if (r.ok) setEnviado(true);
      else if (r.status === 429) setError(MENSAJES_REGISTRO.demasiadosIntentos);
      else if (r.status === 400) setError(MENSAJES_REGISTRO.solicitudInvalida);
      else setError(MENSAJES.errorGeneral);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Crear estudio en ContApp</h1>
        {enviado ? (
          <>
            <p role="status">{MENSAJES_REGISTRO.revisaCorreo}</p>
            <p className="text-sm">{MENSAJES_REGISTRO.enlaceVence}</p>
          </>
        ) : (
          <form onSubmit={enviar} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Nombre del estudio
              <input
                name="estudio"
                type="text"
                required
                autoComplete="organization"
                className="rounded border px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              RUC del estudio (opcional)
              <input
                name="ruc"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={errorRuc ? true : undefined}
                className="rounded border px-3 py-2"
              />
            </label>
            {errorRuc && <p className="text-sm text-red-600">{errorRuc}</p>}
            <label className="flex flex-col gap-1 text-sm">
              Tu nombre
              <input
                name="nombre"
                type="text"
                required
                autoComplete="name"
                className="rounded border px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Correo
              <input
                name="correo"
                type="email"
                required
                autoComplete="email"
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
              Crear estudio
            </button>
          </form>
        )}
        <Link href="/login" className="text-sm underline">
          Ya tengo cuenta
        </Link>
      </div>
    </main>
  );
}
