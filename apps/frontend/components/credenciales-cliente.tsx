"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  guardarCredencialSireSchema,
  guardarCredencialSolSchema,
  type EstadoCredencial,
} from "@contapp/shared";
import { MENSAJES, fechaCorta, mensajeDeError } from "../lib/acceso";
import { ETIQUETA_ESTADO } from "../lib/clientes";
import {
  MENSAJES_CREDENCIALES,
  guardarCredencial,
  listarCredenciales,
  verificarCredencial,
  type CredencialEstadoDto,
  type TipoCredencial,
} from "../lib/credenciales";

// Sección «Credenciales» del detalle del cliente (spec 007b, D4–D6; CA-4 a CA-6, CA-10).
// Formulario de solo escritura: los campos no son controlados, así el secreto vive en el DOM solo
// mientras se teclea; se lee al enviar y se vacía al instante, antes de la llamada y pase lo que pase
// después. Nunca va a estado de React, `localStorage` ni a un mensaje de error.

const GRUPOS: ReadonlyArray<{
  tipo: TipoCredencial;
  titulo: string;
  campos: ReadonlyArray<{
    nombre: string;
    etiqueta: string;
    secreto: boolean;
  }>;
}> = [
  {
    tipo: "sol",
    titulo: "Credencial SOL",
    campos: [
      { nombre: "usuario", etiqueta: "Usuario SOL", secreto: false },
      { nombre: "clave", etiqueta: "Clave SOL", secreto: true },
    ],
  },
  {
    tipo: "sire_api",
    titulo: "Credencial SIRE",
    campos: [
      { nombre: "clientId", etiqueta: "Client ID", secreto: false },
      { nombre: "clientSecret", etiqueta: "Client secret", secreto: true },
    ],
  },
];

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

type Estados = Partial<Record<TipoCredencial, CredencialEstadoDto>>;

function TextoEstado({
  estado,
  cargado,
}: {
  estado: CredencialEstadoDto | undefined;
  cargado: boolean;
}) {
  if (!estado) {
    return (
      <p className="text-sm">
        {cargado ? "Estado no disponible." : "Cargando…"}
      </p>
    );
  }
  return (
    <p className="text-sm">
      Estado:{" "}
      <span className="font-medium">
        {ETIQUETA_ESTADO[estado.estado as EstadoCredencial]}
      </span>
      {estado.estado === "verificada" && estado.fecha
        ? ` el ${fechaCorta(estado.fecha)}`
        : ""}
      {estado.estado === "invalida" && estado.motivo
        ? `: ${estado.motivo}`
        : ""}{" "}
    </p>
  );
}

export function CredencialesCliente({
  clienteId,
  editable,
}: {
  clienteId: string;
  /** `credenciales.editar` y cliente activo; si no, solo se ven los estados (D3). */
  editable: boolean;
}) {
  const [estados, setEstados] = useState<Estados>({});
  const [cargado, setCargado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [encolada, setEncolada] = useState(false);

  useEffect(() => {
    let vigente = true;
    listarCredenciales(clienteId)
      .then((r) => {
        if (!vigente) return;
        if (r.ok && Array.isArray(r.datos)) {
          const porTipo: Estados = {};
          for (const e of r.datos) porTipo[e.tipo] = e;
          setEstados(porTipo);
        }
        // Si falla, cada grupo dice «Estado no disponible»; no se levanta una alerta por una carga pasiva.
        setCargado(true);
      })
      .catch(() => {
        if (vigente) setCargado(true);
      });
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  function mensajeDeFallo(status: number, datos: unknown): string {
    if (status === 400) return MENSAJES_CREDENCIALES.datosInvalidos;
    if (status === 409 && codigoDe(datos) === "credencial_no_configurada")
      return MENSAJES_CREDENCIALES.noConfigurada;
    if (status === 409 && codigoDe(datos) === "cliente_archivado")
      return MENSAJES_CREDENCIALES.clienteArchivado;
    return mensajeDeError(status, datos);
  }

  async function guardar(
    evento: FormEvent<HTMLFormElement>,
    tipo: TipoCredencial,
  ) {
    evento.preventDefault();
    const formulario = evento.currentTarget;
    setAviso(null);
    setEncolada(false);
    const datos = new FormData(formulario);
    const texto = (nombre: string) => {
      const v = datos.get(nombre);
      return typeof v === "string" ? v : "";
    };
    const valido =
      tipo === "sol"
        ? guardarCredencialSolSchema.safeParse({
            usuario: texto("usuario"),
            clave: texto("clave"),
          })
        : guardarCredencialSireSchema.safeParse({
            clientId: texto("clientId"),
            clientSecret: texto("clientSecret"),
          });
    if (!valido.success) {
      setError(MENSAJES_CREDENCIALES.datosInvalidos);
      return;
    }
    // El secreto ya está en `valido.data`: se vacía el formulario antes de enviar.
    formulario.reset();
    setOcupado(true);
    setError(null);
    try {
      const r = await guardarCredencial(clienteId, tipo, valido.data);
      if (r.ok && r.datos) {
        setEstados((previo) => ({
          ...previo,
          [tipo]: { tipo, estado: r.datos!.estado, fecha: null, motivo: null },
        }));
        setAviso(MENSAJES_CREDENCIALES.guardada);
      } else if (r.status !== 401) {
        setError(mensajeDeFallo(r.status, r.datos));
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function verificar(tipo: TipoCredencial) {
    setAviso(null);
    setEncolada(false);
    setOcupado(true);
    setError(null);
    try {
      const r = await verificarCredencial(clienteId, tipo);
      if (r.ok) {
        setAviso(MENSAJES_CREDENCIALES.verificacionEncolada);
        setEncolada(true);
      } else if (r.status !== 401) {
        setError(mensajeDeFallo(r.status, r.datos));
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section
      aria-label="Credenciales"
      className="flex w-full max-w-xl flex-col gap-4"
    >
      <h2 className="text-lg font-medium">Credenciales</h2>

      {GRUPOS.map((g) => (
        <fieldset
          key={g.tipo}
          className="flex flex-col gap-3 rounded border p-4"
        >
          <legend className="px-1 text-sm font-medium">{g.titulo}</legend>
          <TextoEstado estado={estados[g.tipo]} cargado={cargado} />
          {g.tipo === "sire_api" && (
            <p className="text-sm text-amber-900">
              {MENSAJES_CREDENCIALES.avisoClaveSol}
            </p>
          )}
          {editable && (
            <form
              onSubmit={(e) => void guardar(e, g.tipo)}
              noValidate
              autoComplete="off"
              className="flex flex-col gap-3"
            >
              {g.campos.map((c) => (
                <label key={c.nombre} className="flex flex-col gap-1 text-sm">
                  {c.etiqueta}
                  <input
                    name={c.nombre}
                    type={c.secreto ? "password" : "text"}
                    autoComplete={c.secreto ? "new-password" : "off"}
                    spellCheck={false}
                    disabled={ocupado}
                    className="rounded border px-3 py-2"
                  />
                </label>
              ))}
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={ocupado}
                  className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
                >
                  Guardar
                </button>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => void verificar(g.tipo)}
                  className="rounded border px-4 py-2 disabled:opacity-50"
                >
                  Verificar
                </button>
              </div>
            </form>
          )}
        </fieldset>
      ))}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-sm">
          {aviso}{" "}
          {encolada && (
            <Link href="/trabajos" className="underline">
              {MENSAJES_CREDENCIALES.enlacePanel}
            </Link>
          )}
        </p>
      )}
    </section>
  );
}
