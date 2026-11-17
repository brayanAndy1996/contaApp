"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ETIQUETA_ROL, type Rol } from "../../../lib/acceso";
import { api } from "../../../lib/api";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  enlace,
} from "../../../components/ui";
import { cn } from "../../../lib/utils";

const ENLACE = cn(
  enlace,
  "text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center",
);

// Aceptación de una invitación (spec 005, D7, D15, CA-3, CA-14). El token viaja en el fragmento
// `#t=`: se lee una vez, se borra de la URL y solo vive en memoria; nunca se imprime ni se pone en
// una URL de petición (solo en el cuerpo JSON de los POST).

const INVITACION_INVALIDA =
  "La invitación no es válida o venció. Pide una nueva al estudio.";
const CUENTA_CREADA = "Tu cuenta fue creada. Ya puedes iniciar sesión.";
const CREDENCIALES_INVALIDAS = "Correo o contraseña incorrectos.";
const DEMASIADOS_INTENTOS =
  "Demasiados intentos. Inténtalo de nuevo en unos minutos.";
const LONGITUD = "La contraseña debe tener entre 12 y 128 caracteres.";
const COMUN = "Esa contraseña es demasiado común. Elige otra.";
const ERROR_GENERAL = "Ocurrió un error. Inténtalo de nuevo.";
const unidoA = (estudio: string) => `Te uniste a ${estudio}.`;

interface Consulta {
  estudio: { nombre: string };
  rol: Rol;
  correo: string;
  cuentaExiste: boolean;
}

type Fase =
  | "cargando"
  | "invalida"
  | "error"
  | "nueva"
  | "existente"
  | "creada"
  | "unido";

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

export default function Invitacion() {
  const router = useRouter();
  // El token solo vive en memoria; el ref evita perderlo si el efecto corre dos veces (StrictMode).
  const lectura = useRef<{ token: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [fase, setFase] = useState<Fase>("cargando");
  const [info, setInfo] = useState<Consulta | null>(null);
  const [nombre, setNombre] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [estudioUnido, setEstudioUnido] = useState<{
    id: string;
    nombre: string;
  } | null>(null);

  useEffect(() => {
    lectura.current ??= { token: tomarTokenDelFragmento() };
    const leido = lectura.current.token;
    setToken(leido);
    if (!leido) {
      setFase("invalida");
      return;
    }
    let vigente = true;
    api<Consulta & { codigo?: string }>("/invitaciones/consultar", {
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

  function mensajeDeContrasena(motivo?: string): string {
    return motivo === "comun" ? COMUN : LONGITUD;
  }

  async function crearCuenta(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!token) return;
    if (contrasena.length < 12 || contrasena.length > 128) {
      setError(LONGITUD);
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string; motivo?: string }>(
        "/invitaciones/aceptar",
        {
          method: "POST",
          body: { token, nombre, contrasena },
          sinSesion: true,
        },
      );
      if (r.ok) {
        setContrasena("");
        setFase("creada");
      } else if (
        r.status === 400 &&
        r.datos?.codigo === "contrasena_invalida"
      ) {
        setError(mensajeDeContrasena(r.datos.motivo));
      } else if (r.status === 400) {
        setFase("invalida");
      } else if (r.status === 409 && r.datos?.codigo === "requiere_sesion") {
        // La cuenta apareció entre la consulta y la aceptación: se sigue con sesión.
        setContrasena("");
        setInfo((previa) =>
          previa ? { ...previa, cuentaExiste: true } : previa,
        );
        setFase("existente");
      } else {
        setError(ERROR_GENERAL);
      }
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  async function iniciarYAceptar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!token || !info) return;
    setEnviando(true);
    setError(null);
    try {
      const login = await api("/auth/login", {
        method: "POST",
        body: { correo: info.correo, contrasena },
        sinSesion: true,
      });
      setContrasena("");
      if (!login.ok) {
        setError(
          login.status === 401
            ? CREDENCIALES_INVALIDAS
            : login.status === 429
              ? DEMASIADOS_INTENTOS
              : ERROR_GENERAL,
        );
        return;
      }
      reiniciarSesion();
      const r = await api<{ estudio?: { id: string; nombre: string } }>(
        "/invitaciones/aceptar-con-sesion",
        { method: "POST", body: { token } },
      );
      if (r.ok && r.datos?.estudio) {
        setEstudioUnido(r.datos.estudio);
        setFase("unido");
      } else if (r.status === 400) {
        setFase("invalida");
      } else if (r.status !== 401) {
        setError(ERROR_GENERAL);
      }
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  async function cambiarDeEstudio() {
    if (!estudioUnido) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api("/auth/estudio", {
        method: "POST",
        body: { tenantId: estudioUnido.id },
      });
      if (!r.ok) {
        if (r.status !== 401) setError(ERROR_GENERAL);
        return;
      }
      reiniciarSesion();
      router.push("/");
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  const resumen = info && (
    <p className="text-sm">
      Te invitaron a <strong>{info.estudio.nombre}</strong> como{" "}
      <strong>{ETIQUETA_ROL[info.rol] ?? info.rol}</strong>. Correo:{" "}
      <span>{info.correo}</span>
    </p>
  );

  const alerta = error && <Alert tono="error">{error}</Alert>;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Invitación a ContApp
        </h1>
        {fase === "cargando" && <p>Verificando la invitación…</p>}
        {fase === "invalida" && (
          <Alert tono="error">{INVITACION_INVALIDA}</Alert>
        )}
        {fase === "error" && <Alert tono="error">{ERROR_GENERAL}</Alert>}
        {fase === "nueva" && (
          <form onSubmit={crearCuenta} className="flex flex-col gap-4">
            {resumen}
            <Label>
              Nombre
              <Input
                type="text"
                autoComplete="name"
                required
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="max-lg:h-11"
              />
            </Label>
            <Label>
              Contraseña
              <Input
                type="password"
                autoComplete="new-password"
                required
                value={contrasena}
                onChange={(e) => setContrasena(e.target.value)}
                className="max-lg:h-11"
              />
            </Label>
            {alerta}
            <Button type="submit" disabled={enviando} className="max-lg:h-11">
              Crear cuenta y aceptar
            </Button>
          </form>
        )}
        {fase === "existente" && (
          <form onSubmit={iniciarYAceptar} className="flex flex-col gap-4">
            {resumen}
            <p className="text-sm">
              Ya tienes una cuenta: inicia sesión para aceptar.
            </p>
            <Label>
              Contraseña
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={contrasena}
                onChange={(e) => setContrasena(e.target.value)}
                className="max-lg:h-11"
              />
            </Label>
            {alerta}
            <Button type="submit" disabled={enviando} className="max-lg:h-11">
              Iniciar sesión y aceptar
            </Button>
          </form>
        )}
        {fase === "creada" && (
          <>
            <Alert tono="ok">{CUENTA_CREADA}</Alert>
            <Link href="/login" className={ENLACE}>
              Ir a iniciar sesión
            </Link>
          </>
        )}
        {fase === "unido" && estudioUnido && (
          <>
            <Alert tono="ok">{unidoA(estudioUnido.nombre)}</Alert>
            {alerta}
            <Button
              type="button"
              disabled={enviando}
              onClick={() => void cambiarDeEstudio()}
              className="max-lg:h-11"
            >
              Cambiar a este estudio
            </Button>
          </>
        )}
      </Card>
    </main>
  );
}
