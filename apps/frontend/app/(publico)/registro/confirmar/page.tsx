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
import {
  AvisoFactorExigido,
  PasoCodigo,
} from "../../../../components/seguridad/paso-codigo";
import { MENSAJES_SEGURIDAD } from "../../../../lib/seguridad";
import {
  bloqueadaPorFactor,
  obtenerSesion,
  reiniciarSesion,
} from "../../../../lib/sesion";
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
  | "codigo"
  | "exigido"
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

const REABRIR_ENLACE =
  "Cuando lo hayas activado, vuelve a abrir el enlace del registro.";

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
  // CSRF de la sesión `pendiente` del login con segundo factor: solo en estado, se descarta al terminar.
  const [csrfPendiente, setCsrfPendiente] = useState<string | null>(null);
  // D14: la cuenta ya originó su prueba; el estudio creado no tiene plan (no se presenta como uno con prueba).
  const [sinPlan, setSinPlan] = useState(false);

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
      } else if (r.status === 429) {
        // D15: demasiados intentos de confirmar desde esta IP; el mensaje no repite el código del servidor.
        setError(MENSAJES_REGISTRO.demasiadosConfirmar);
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

  /**
   * Con la sesión ya verificada: si el rol exige el segundo factor y la sesión no lo tiene, se avisa sin
   * llamar al backend (un 403 redirigiría a Seguridad y el token, solo en memoria, se perdería).
   */
  async function crearConSesion(tokenRegistro: string) {
    // Sesión nueva: la llamada siguiente toma de ella el CSRF, no el de antes del login.
    reiniciarSesion();
    const sesion = await obtenerSesion();
    if (sesion && bloqueadaPorFactor(sesion)) {
      setFase("exigido");
      return;
    }
    const r = await api<{ estudio?: EstudioCreado; sinPlan?: boolean }>(
      "/registro/confirmar-con-sesion",
      { method: "POST", body: { token: tokenRegistro } },
    );
    if (r.ok && r.datos?.estudio) {
      setCreado(r.datos.estudio);
      setSinPlan(r.datos.sinPlan === true);
      setFase("conEstudio");
    } else if (r.status === 400) {
      setFase("invalida");
    } else if (r.status !== 401) {
      setError(MENSAJES.errorGeneral);
    }
  }

  async function iniciarYCrear(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!token || !info || enviando) return;
    const contrasena = contrasenaDe(evento.currentTarget);

    setEnviando(true);
    setError(null);
    try {
      const login = await api<{ segundoFactor?: boolean; csrf?: string }>(
        "/auth/login",
        {
          method: "POST",
          body: { correo: info.correo, contrasena },
          sinSesion: true,
        },
      );
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
      if (login.datos?.segundoFactor === true && login.datos.csrf) {
        reiniciarSesion();
        setCsrfPendiente(login.datos.csrf);
        setFase("codigo");
        return;
      }
      await crearConSesion(token);
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

  const alerta = error && <Alert tono="error">{error}</Alert>;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Crear estudio en ContApp
        </h1>
        {fase === "cargando" && <p>Verificando el enlace…</p>}
        {fase === "invalida" && (
          <>
            <Alert tono="error">{MENSAJES_REGISTRO.registroInvalido}</Alert>
            <Link href="/registro" className={ENLACE}>
              Solicitar un registro nuevo
            </Link>
          </>
        )}
        {fase === "error" && (
          <Alert tono="error">{MENSAJES.errorGeneral}</Alert>
        )}
        {fase === "nueva" && info && (
          <form onSubmit={confirmar} className="flex flex-col gap-4">
            {resumen}
            <Label>
              Contraseña
              <Input
                name="contrasena"
                type="password"
                required
                autoComplete="new-password"
                className="max-lg:h-11"
              />
            </Label>
            <p className="text-xs text-tinta-suave">
              Entre 12 y 128 caracteres.
            </p>
            {alerta}
            <Button type="submit" disabled={enviando} className="max-lg:h-11">
              Confirmar y crear estudio
            </Button>
          </form>
        )}
        {fase === "existente" && info && (
          <form onSubmit={iniciarYCrear} className="flex flex-col gap-4">
            {resumen}
            <p className="text-sm">
              Ya tienes una cuenta con este correo: inicia sesión para crear el
              estudio.
            </p>
            <Label>
              Contraseña
              <Input
                name="contrasena"
                type="password"
                required
                autoComplete="current-password"
                className="max-lg:h-11"
              />
            </Label>
            {alerta}
            <Button type="submit" disabled={enviando} className="max-lg:h-11">
              Iniciar sesión y crear estudio
            </Button>
          </form>
        )}
        {fase === "codigo" && csrfPendiente && token && (
          <>
            {resumen}
            <p className="text-sm">
              Ingresa el código de verificación para crear el estudio.
            </p>
            <PasoCodigo
              csrf={csrfPendiente}
              alVerificar={async () => {
                setCsrfPendiente(null);
                await crearConSesion(token);
              }}
              alCaducar={() => {
                setCsrfPendiente(null);
                setError(MENSAJES_SEGURIDAD.sesionCaducada);
                setFase("existente");
              }}
            />
          </>
        )}
        {fase === "exigido" && (
          <>
            <AvisoFactorExigido />
            <p className="text-sm">{REABRIR_ENLACE}</p>
          </>
        )}
        {fase === "creada" && (
          <>
            <Alert tono="ok">{MENSAJES_REGISTRO.registroCreado}</Alert>
            <Link href="/login" className={ENLACE}>
              Ir a iniciar sesión
            </Link>
          </>
        )}
        {fase === "conEstudio" && creado && (
          <>
            <Alert tono="ok">
              {sinPlan
                ? MENSAJES_REGISTRO.sinPlan
                : MENSAJES_REGISTRO.estudioCreado(creado.nombre)}
            </Alert>
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
