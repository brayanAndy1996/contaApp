"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { verificarSegundoFactorSchema } from "@contapp/shared";
import { api } from "../../../lib/api";
import { MENSAJES_SEGURIDAD, codigoDe } from "../../../lib/seguridad";
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

// Mensajes genéricos a propósito (CA-2, P3): el 401 es el mismo sea cual sea la causa.
const CREDENCIALES_INVALIDAS = "Correo o contraseña incorrectos.";
const DEMASIADOS_INTENTOS =
  "Demasiados intentos. Inténtalo de nuevo en unos minutos.";
const ERROR_GENERAL = "No se pudo iniciar sesión. Inténtalo de nuevo.";

interface RespuestaLogin {
  estudioActivo: { id: string; nombre: string } | null;
  requiereEstudio: boolean;
  // Spec 029: con TOTP activo el login deja la sesión «pendiente» y pide el código.
  segundoFactor?: boolean;
  // Solo con `segundoFactor`: CSRF de la sesión `pendiente` (la verificación no puede leer GET /auth/sesion).
  csrf?: string;
}

type ModoCodigo = "totp" | "recuperacion";

export default function Login() {
  const router = useRouter();
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [pidiendoCodigo, setPidiendoCodigo] = useState(false);
  const [modo, setModo] = useState<ModoCodigo>("totp");
  const [codigo, setCodigo] = useState("");
  // Solo en estado (nunca en almacenamiento ni URL); se descarta al verificar, caducar o volver.
  const [csrf, setCsrf] = useState<string | null>(null);

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
      if (r.ok && r.datos?.segundoFactor === true && r.datos.csrf) {
        // La contraseña ya no se necesita ni se conserva; la sesión «pendiente» solo sirve para verificar.
        reiniciarSesion();
        setCsrf(r.datos.csrf);
        setContrasena("");
        setCodigo("");
        setModo("totp");
        setPidiendoCodigo(true);
        return;
      }
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

  function cambiarModo(nuevo: ModoCodigo) {
    setModo(nuevo);
    setCodigo("");
    setError(null);
  }

  async function verificar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const cuerpo =
      modo === "totp"
        ? { codigo: codigo.trim() }
        : { codigoRecuperacion: codigo.trim().toUpperCase() };
    setError(null);
    if (!verificarSegundoFactorSchema.safeParse(cuerpo).success) {
      setError(MENSAJES_SEGURIDAD.codigoIncorrecto);
      return;
    }
    if (!csrf) {
      setPidiendoCodigo(false);
      setError(MENSAJES_SEGURIDAD.sesionCaducada);
      return;
    }
    setEnviando(true);
    try {
      // Sesión `pendiente`: `sinSesion` + `csrf` del login (sin GET /auth/sesion ni X-Estudio); un 401
      // `codigo_invalido` es un dato erróneo y llega a la pantalla sin reintento ni /login.
      const r = await api<RespuestaLogin>("/auth/2fa/verificar", {
        method: "POST",
        body: cuerpo,
        sinSesion: true,
        csrf,
      });
      if (r.ok) {
        setCsrf(null);
        reiniciarSesion();
        router.push(r.datos?.estudioActivo ? "/" : "/estudios");
        return;
      }
      if (r.status === 401 && codigoDe(r.datos) === "sesion_invalida") {
        setPidiendoCodigo(false);
        setCsrf(null);
        setError(MENSAJES_SEGURIDAD.sesionCaducada);
        return;
      }
      setError(
        r.status === 401
          ? MENSAJES_SEGURIDAD.codigoIncorrecto
          : r.status === 429
            ? MENSAJES_SEGURIDAD.demasiadosIntentos
            : ERROR_GENERAL,
      );
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  if (pidiendoCodigo) {
    const recuperacion = modo === "recuperacion";
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
            Verificación en dos pasos
          </h1>
          <form onSubmit={verificar} className="flex flex-col gap-4">
            <Label>
              {recuperacion
                ? "Código de recuperación"
                : "Código de verificación"}
              <Input
                key={modo}
                type="text"
                required
                autoFocus
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                {...(recuperacion
                  ? {
                      autoComplete: "off",
                      autoCapitalize: "characters",
                      spellCheck: false,
                      placeholder: "XXXX-XXXX-XXXX",
                    }
                  : {
                      autoComplete: "one-time-code",
                      inputMode: "numeric" as const,
                      placeholder: "000000",
                    })}
                className="max-lg:h-11"
              />
            </Label>
            {error && <Alert tono="error">{error}</Alert>}
            <Button type="submit" disabled={enviando} className="max-lg:h-11">
              Verificar
            </Button>
            <button
              type="button"
              onClick={() =>
                cambiarModo(recuperacion ? "totp" : "recuperacion")
              }
              className={cn(ENLACE, "self-start text-left")}
            >
              {recuperacion
                ? "Usar el código de mi aplicación"
                : "Usar un código de recuperación"}
            </button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Ingresar a ContApp
        </h1>
        <form onSubmit={ingresar} className="flex flex-col gap-4">
          <Label>
            Correo
            <Input
              type="email"
              autoComplete="username"
              required
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              className="max-lg:h-11"
            />
          </Label>
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
          {error && <Alert tono="error">{error}</Alert>}
          <Button type="submit" disabled={enviando} className="max-lg:h-11">
            Ingresar
          </Button>
          <Link href="/recuperar" className={ENLACE}>
            Olvidé mi contraseña
          </Link>
          <Link href="/registro" className={ENLACE}>
            Crear estudio
          </Link>
        </form>
      </Card>
    </main>
  );
}
