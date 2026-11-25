"use client";

import {
  codigosRecuperacionRespuestaSchema,
  confirmarTotpSchema,
  desactivarTotpSchema,
  enrolarTotpRespuestaSchema,
  enrolarTotpSchema,
  regenerarRecuperacionSchema,
} from "@contapp/shared";
import QRCode from "qrcode";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../lib/api";
import { MENSAJES_SEGURIDAD as M, codigoDe } from "../../lib/seguridad";
import {
  Alert,
  Button,
  Card,
  CardDescription,
  CardTitle,
  Input,
  Label,
} from "../ui";

export interface EstadoTotp {
  totpActivo: boolean;
  factorExigido: boolean;
}

interface Props {
  estado: EstadoTotp;
  /** Vuelve a leer la sesión (el token rota al confirmar y al desactivar). */
  alCambiar: () => Promise<void>;
  /** Entrega los códigos de recuperación para mostrarlos una vez. */
  alMostrarCodigos: (codigos: string[]) => void;
}

type Paso = "inicio" | "contrasena" | "qr";
type Accion = "desactivar" | "regenerar" | null;
interface Mensaje {
  texto: string;
  error: boolean;
}

const CLASE_BOTON = "max-lg:h-11";
const OPCIONES_QR = {
  width: 224,
  margin: 1,
  errorCorrectionLevel: "M",
} as const;

const campoDe = (f: FormData, nombre: string) => String(f.get(nombre) ?? "");

/** Activación, desactivación y códigos de recuperación del TOTP (spec 029). Sin cálculos: valida y envía. */
export function TotpCuenta({ estado, alCambiar, alMostrarCodigos }: Props) {
  const [paso, setPaso] = useState<Paso>("inicio");
  // Solo la imagen del QR: el URI `otpauth://` no se guarda en ningún estado.
  const [qr, setQr] = useState<string | null>(null);
  const [accion, setAccion] = useState<Accion>(null);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);
  const [enviando, setEnviando] = useState(false);

  const error = (texto: string) => setMensaje({ texto, error: true });

  /** Ejecuta una petición con el estado de «enviando» y un único manejo de fallos de red. */
  async function enviar(tarea: () => Promise<void>) {
    setEnviando(true);
    setMensaje(null);
    try {
      await tarea();
    } catch {
      error(M.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  function enrolar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const cuerpo = {
      contrasena: campoDe(new FormData(evento.currentTarget), "contrasena"),
    };
    if (!enrolarTotpSchema.safeParse(cuerpo).success) return;
    void enviar(async () => {
      const r = await api<unknown>("/auth/totp/enrolar", {
        method: "POST",
        body: cuerpo,
        manejar401: false,
      });
      if (r.ok) {
        const uri = enrolarTotpRespuestaSchema.safeParse(r.datos);
        if (!uri.success) return error(M.errorGeneral);
        setQr(await QRCode.toDataURL(uri.data.uri, OPCIONES_QR));
        setPaso("qr");
      } else if (r.status === 401 && codigoDe(r.datos) !== "sesion_invalida") {
        error(M.contrasenaIncorrecta);
      } else if (r.status === 429) {
        error(M.demasiadosIntentos);
      } else if (r.status !== 401) {
        error(M.errorGeneral);
      }
    });
  }

  function confirmar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const cuerpo = {
      codigo: campoDe(new FormData(evento.currentTarget), "codigo").trim(),
    };
    if (!confirmarTotpSchema.safeParse(cuerpo).success)
      return error(M.codigoIncorrecto);
    void enviar(async () => {
      const r = await api<unknown>("/auth/totp/confirmar", {
        method: "POST",
        body: cuerpo,
        manejar401: false,
      });
      if (r.ok) {
        const codigos = codigosRecuperacionRespuestaSchema.safeParse(r.datos);
        if (!codigos.success) return error(M.errorGeneral);
        setQr(null);
        setPaso("inicio");
        alMostrarCodigos(codigos.data.codigosRecuperacion);
        await alCambiar();
      } else if (r.status === 400 || r.status === 401) {
        if (codigoDe(r.datos) !== "sesion_invalida") error(M.codigoIncorrecto);
      } else if (r.status === 429) {
        error(M.demasiadosIntentos);
      } else {
        error(M.errorGeneral);
      }
    });
  }

  function desactivar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const f = new FormData(evento.currentTarget);
    const cuerpo = {
      contrasena: campoDe(f, "contrasena"),
      codigo: campoDe(f, "codigo").trim(),
    };
    if (!desactivarTotpSchema.safeParse(cuerpo).success)
      return error(M.contrasenaOCodigo);
    void enviar(async () => {
      const r = await api<unknown>("/auth/totp/desactivar", {
        method: "POST",
        body: cuerpo,
        manejar401: false,
      });
      if (r.ok) {
        setAccion(null);
        await alCambiar();
        setMensaje({ texto: M.desactivada, error: false });
      } else {
        error(mensajeDeAccion(r.status, r.datos));
      }
    });
  }

  function regenerar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const f = new FormData(evento.currentTarget);
    const cuerpo = {
      contrasena: campoDe(f, "contrasena"),
      codigo: campoDe(f, "codigo").trim(),
    };
    if (!regenerarRecuperacionSchema.safeParse(cuerpo).success)
      return error(M.contrasenaOCodigo);
    void enviar(async () => {
      const r = await api<unknown>("/auth/totp/recuperacion", {
        method: "POST",
        body: cuerpo,
        manejar401: false,
      });
      const codigos = r.ok
        ? codigosRecuperacionRespuestaSchema.safeParse(r.datos)
        : null;
      if (codigos?.success) {
        setAccion(null);
        alMostrarCodigos(codigos.data.codigosRecuperacion);
      } else if (r.ok) {
        error(M.errorGeneral);
      } else {
        error(mensajeDeAccion(r.status, r.datos));
      }
    });
  }

  return (
    <Card>
      <div className="flex flex-col gap-1">
        <CardTitle>Verificación en dos pasos</CardTitle>
        <CardDescription>
          Además de tu contraseña, ingresas un código de tu aplicación de
          autenticación.
        </CardDescription>
      </div>
      {mensaje && (
        <Alert tono={mensaje.error ? "error" : "ok"}>{mensaje.texto}</Alert>
      )}
      {!estado.totpActivo ? (
        <>
          {estado.factorExigido && <Alert tono="aviso">{M.exigidoAviso}</Alert>}
          {paso === "inicio" && (
            <Button
              type="button"
              onClick={() => {
                setMensaje(null);
                setPaso("contrasena");
              }}
              className={`self-start ${CLASE_BOTON}`}
            >
              Activar la verificación en dos pasos
            </Button>
          )}
          {paso === "contrasena" && (
            <Formulario
              onSubmit={enrolar}
              enviando={enviando}
              enviar="Continuar"
            >
              <CampoContrasena />
            </Formulario>
          )}
          {paso === "qr" && qr && (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-sm text-tinta-media">
                Escanea el código QR con tu aplicación de autenticación y
                escribe el código de 6 dígitos que muestra.
              </p>
              <img
                src={qr}
                alt="Código QR para la aplicación de autenticación"
                width={224}
                height={224}
                className="self-center rounded-control border border-linea"
              />
              <Formulario
                onSubmit={confirmar}
                enviando={enviando}
                enviar="Confirmar"
              >
                <CampoCodigo />
              </Formulario>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="m-0 text-sm font-semibold text-ok">
            La verificación en dos pasos está activa.
          </p>
          <div className="flex flex-wrap gap-2">
            {!estado.factorExigido && (
              <Button
                type="button"
                variant="secundario"
                onClick={() => {
                  setMensaje(null);
                  setAccion("desactivar");
                }}
                className={CLASE_BOTON}
              >
                Desactivar la verificación en dos pasos
              </Button>
            )}
            <Button
              type="button"
              variant="secundario"
              onClick={() => {
                setMensaje(null);
                setAccion("regenerar");
              }}
              className={CLASE_BOTON}
            >
              Generar códigos de recuperación nuevos
            </Button>
          </div>
          {accion && (
            <Formulario
              key={accion}
              onSubmit={accion === "desactivar" ? desactivar : regenerar}
              enviando={enviando}
              enviar={
                accion === "desactivar"
                  ? "Confirmar desactivación"
                  : "Generar códigos"
              }
              alCancelar={() => setAccion(null)}
            >
              <CampoContrasena />
              <CampoCodigo />
            </Formulario>
          )}
        </>
      )}
    </Card>
  );
}

function mensajeDeAccion(status: number, datos: unknown): string {
  if (status === 409 && codigoDe(datos) === "totp_exigido")
    return M.totpExigido;
  if (status === 401 || status === 400) return M.contrasenaOCodigo;
  if (status === 429) return M.demasiadosIntentos;
  return M.errorGeneral;
}

// Campos sin control: la contraseña y el código no pasan por el estado de React ni quedan en el DOM.
function CampoContrasena() {
  return (
    <Label>
      Contraseña actual
      <Input
        type="password"
        name="contrasena"
        autoComplete="current-password"
        required
        className="max-lg:h-11"
      />
    </Label>
  );
}

function CampoCodigo() {
  return (
    <Label>
      Código de verificación
      <Input
        type="text"
        name="codigo"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="000000"
        required
        className="max-lg:h-11"
      />
    </Label>
  );
}

function Formulario({
  onSubmit,
  enviando,
  enviar,
  alCancelar,
  children,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  enviando: boolean;
  enviar: string;
  alCancelar?: () => void;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {children}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={enviando} className={CLASE_BOTON}>
          {enviar}
        </Button>
        {alCancelar && (
          <Button
            type="button"
            variant="terciario"
            onClick={alCancelar}
            className={CLASE_BOTON}
          >
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
