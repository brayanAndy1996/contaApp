"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { contrasenaNuevaSchema } from "@contapp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MENSAJES } from "../../../../lib/acceso";
import { api } from "../../../../lib/api";
import {
  MENSAJES_REGISTRO,
  type ConsultaRegistro,
} from "../../../../lib/registro";
import { reiniciarSesion } from "../../../../lib/sesion";

// Confirmación del registro (spec 006, D3, CA-3, CA-4, CA-10). Como /invitacion (005): el token viaja en
// el fragmento `#t=`; se lee una vez, se borra de la URL y solo vive en memoria. Nunca va en una URL de
// petición, en cabeceras, en el DOM ni en la consola: solo en el cuerpo JSON de los POST. La contraseña
// se lee del formulario al enviar (sin estado controlado) para que no quede en el DOM.

type Fase =
  | "cargando"
  | "invalida"
  | "error"
  | "nueva"
  | "existente"
  | "creada"
  | "conEstudio";

interface EstudioCreado {
  id: string;
  nombre: string;
}

/** Lee `#t=<token>` y borra el fragmento de la URL (no llega al servidor ni al Referer). */
function tomarTokenDelFragmento(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  return token ? token : null;
}

function contrasenaDe(formulario: HTMLFormElement): string {
  return String(new FormData(formulario).get("contrasena") ?? "");
}

export default function ConfirmarRegistro() {
  const router = useRouter();
  // El ref evita perder el token si el efecto corre dos veces (StrictMode), como en /invitacion.
  const lectura = useRef<{ token: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [fase, setFase] = useState<Fase>("cargando");
  const [info, setInfo] = useState<ConsultaRegistro | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [creado, setCreado] = useState<EstudioCreado | null>(null);

  useEffect(() => {
    lectura.current ??= { token: tomarTokenDelFragmento() };
    const leido = lectura.current.token;
    setToken(leido);
    if (!leido) {
      setFase("invalida");
      return;
    }
    let vigente = true;
    api<ConsultaRegistro>("/registro/consultar", {
      method: "POST",
      body: { token: leido },
      sinSesion: true,
    })
      .then((r) => {
        if (!vigente) return;
        if (r.ok && r.datos) {
          setInfo(r.datos);
          setFase(r.datos.cuentaExiste ? "existente" : "nueva");
        } else {
          setFase(r.status === 400 ? "invalida" : "error");
        }
      })
      .catch(() => {
        if (vigente) setFase("error");
      });
    return () => {
      vigente = false;
    };
  }, []);

  async function confirmar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!token || enviando) return;
    const contrasena = contrasenaDe(evento.currentTarget);
    if (!contrasenaNuevaSchema.safeParse(contrasena).success) {
      setError(MENSAJES_REGISTRO.contrasenaLongitud);
      return;
    }

    setEnviando(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string; motivo?: string }>(
        "/registro/confirmar",
        { method: "POST", body: { token, contrasena }, sinSesion: true },
      );
      const codigo = r.datos?.codigo;
      if (r.ok) {
        setFase("creada");
      } else if (r.status === 400 && codigo === "contrasena_invalida") {
        setError(
          r.datos?.motivo === "comun"
            ? MENSAJES_REGISTRO.contrasenaComun
            : MENSAJES_REGISTRO.contrasenaLongitud,
        );
      } else if (r.status === 409 && codigo === "requiere_sesion") {
        // La cuenta ya existe: se pasa a iniciar sesión con el mismo token (no se consume).
        setError(null);
        setFase("existente");
      } else if (r.status === 400) {
        setFase("invalida");
      } else if (r.status === 503) {
        setError(MENSAJES_REGISTRO.registroNoDisponible);
      } else {
        setError(MENSAJES.errorGeneral);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  async function iniciarYCrear(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!token || !info || enviando) return;
    const contrasena = contrasenaDe(evento.currentTarget);

    setEnviando(true);
    setError(null);
    try {
      const login = await api("/auth/login", {
        method: "POST",
        body: { correo: info.correo, contrasena },
        sinSesion: true,
      });
      if (!login.ok) {
        setError(
          login.status === 401
            ? MENSAJES_REGISTRO.credencialesInvalidas
            : login.status === 429
              ? MENSAJES_REGISTRO.demasiadosIntentos
              : MENSAJES.errorGeneral,
        );
        return;
      }
      // Sesión nueva: la llamada siguiente toma de ella el CSRF, no el de antes del login.
      reiniciarSesion();
      const r = await api<{ estudio?: EstudioCreado }>(
        "/registro/confirmar-con-sesion",
        { method: "POST", body: { token } },
      );
      if (r.ok && r.datos?.estudio) {
        setCreado(r.datos.estudio);
        setFase("conEstudio");
      } else if (r.status === 400) {
        setFase("invalida");
      } else if (r.status !== 401) {
        setError(MENSAJES.errorGeneral);
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  async function cambiarDeEstudio() {
    if (!creado || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api("/auth/estudio", {
        method: "POST",
        body: { tenantId: creado.id },
      });
      if (!r.ok) {
        if (r.status !== 401) setError(MENSAJES.errorGeneral);
        return;
      }
      reiniciarSesion();
      router.push("/");
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  const resumen = info && (
    <p className="text-sm">
      Estudio: <strong>{info.estudio.nombre}</strong>. Correo del Dueño:{" "}
      <span>{info.correo}</span>.
    </p>
  );

  const alerta = error && (
    <p role="alert" className="text-sm text-red-600">
      {error}
    </p>
  );

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Crear estudio en ContApp</h1>
        {fase === "cargando" && <p>Verificando el enlace…</p>}
        {fase === "invalida" && (
          <>
            <p role="alert">{MENSAJES_REGISTRO.registroInvalido}</p>
            <Link href="/registro" className="text-sm underline">
              Solicitar un registro nuevo
            </Link>
          </>
        )}
        {fase === "error" && (
          <p role="alert" className="text-sm text-red-600">
            {MENSAJES.errorGeneral}
          </p>
        )}
        {fase === "nueva" && info && (
          <form onSubmit={confirmar} className="flex flex-col gap-4">
            {resumen}
            <label className="flex flex-col gap-1 text-sm">
              Contraseña
              <input
                name="contrasena"
                type="password"
                required
                autoComplete="new-password"
                className="rounded border px-3 py-2"
              />
            </label>
            <p className="text-xs text-neutral-600">
              Entre 12 y 128 caracteres.
            </p>
            {alerta}
            <button
              type="submit"
              disabled={enviando}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Confirmar y crear estudio
            </button>
          </form>
        )}
        {fase === "existente" && info && (
          <form onSubmit={iniciarYCrear} className="flex flex-col gap-4">
            {resumen}
            <p className="text-sm">
              Ya tienes una cuenta con este correo: inicia sesión para crear el
              estudio.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Contraseña
              <input
                name="contrasena"
                type="password"
                required
                autoComplete="current-password"
                className="rounded border px-3 py-2"
              />
            </label>
            {alerta}
            <button
              type="submit"
              disabled={enviando}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Iniciar sesión y crear estudio
            </button>
          </form>
        )}
        {fase === "creada" && (
          <>
            <p role="status">{MENSAJES_REGISTRO.registroCreado}</p>
            <Link href="/login" className="text-sm underline">
              Ir a iniciar sesión
            </Link>
          </>
        )}
        {fase === "conEstudio" && creado && (
          <>
            <p role="status">
              {MENSAJES_REGISTRO.estudioCreado(creado.nombre)}
            </p>
            {alerta}
            <button
              type="button"
              disabled={enviando}
              onClick={() => void cambiarDeEstudio()}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Cambiar a este estudio
            </button>
          </>
        )}
      </div>
    </main>
  );
}
