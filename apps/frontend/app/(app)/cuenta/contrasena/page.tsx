"use client";

import { useState, type FormEvent } from "react";
import { api } from "../../../../lib/api";
import { obtenerSesion, reiniciarSesion } from "../../../../lib/sesion";

const ACTUALIZADA = "Tu contraseña fue actualizada.";
const ACTUAL_INCORRECTA = "La contraseña actual no es correcta.";
const LONGITUD = "La contraseña debe tener entre 12 y 128 caracteres.";
const COMUN = "Esa contraseña es demasiado común. Elige otra.";
const ERROR_GENERAL = "No se pudo cambiar la contraseña. Inténtalo de nuevo.";

function mensajeDeError(
  status: number,
  datos: { codigo?: string; motivo?: string } | null,
): string {
  // El 401 de este formulario es "la actual es incorrecta"; el de sesión caducada ya lo maneja api().
  if (status === 401) return ACTUAL_INCORRECTA;
  if (status === 400 && datos?.codigo === "contrasena_invalida") {
    return datos.motivo === "comun" ? COMUN : LONGITUD;
  }
  return ERROR_GENERAL;
}

export default function CambioContrasena() {
  const [mensaje, setMensaje] = useState<{
    texto: string;
    error: boolean;
  } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function cambiar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    // Campos sin control: así la contraseña no queda en el DOM (atributo value) ni en el estado.
    const formulario = evento.currentTarget;
    const datosForm = new FormData(formulario);
    const actual = String(datosForm.get("actual") ?? "");
    const nueva = String(datosForm.get("nueva") ?? "");
    setEnviando(true);
    setMensaje(null);
    try {
      const r = await api<{ codigo?: string; motivo?: string }>(
        "/auth/contrasena",
        { method: "POST", body: { actual, nueva }, manejar401: false },
      );
      if (r.ok) {
        // La cookie y el token CSRF rotaron: se vuelve a leer la sesión.
        reiniciarSesion();
        await obtenerSesion();
        formulario.reset();
        setMensaje({ texto: ACTUALIZADA, error: false });
      } else if (r.status !== 401 || r.datos?.codigo !== "sesion_invalida") {
        setMensaje({ texto: mensajeDeError(r.status, r.datos), error: true });
      }
    } catch {
      setMensaje({ texto: ERROR_GENERAL, error: true });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form onSubmit={cambiar} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Cambiar contraseña</h1>
        <label className="flex flex-col gap-1 text-sm">
          Contraseña actual
          <input
            type="password"
            name="actual"
            autoComplete="current-password"
            required
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Nueva contraseña
          <input
            type="password"
            name="nueva"
            autoComplete="new-password"
            required
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
          Cambiar contraseña
        </button>
      </form>
    </main>
  );
}
