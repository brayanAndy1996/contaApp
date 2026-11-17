"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  guardarCredencialSireSchema,
  guardarCredencialSolSchema,
  type EstadoCredencial,
} from "@contapp/shared";
import { MENSAJES, fechaCorta, mensajeDeError } from "../lib/acceso";
import { ETIQUETA_ESTADO } from "../lib/clientes";
import {
  MENSAJES_CREDENCIALES,
  TOPE_VERIFICANDO_MS,
  guardarCredencial,
  listarCredenciales,
  textoMotivoCredencial,
  verificarCredencial,
  type CredencialEstadoDto,
  type TipoCredencial,
} from "../lib/credenciales";
import { ESPERA_INICIAL_MS, ESPERA_MAXIMA_MS } from "../lib/trabajos";
import { Alert, Badge, Button, Card, CardTitle, Input, Label, enlace } from "./ui";
import { cn } from "../lib/utils";

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

/**
 * Credenciales con una verificación en curso (spec 020, D-5). Guarda el estado y la fecha que tenía al pulsar
 * «Verificar»: la verificación terminó cuando la lectura trae algo distinto (el worker siempre cambia el estado o
 * la fecha al verificar).
 */
type Verificando = Partial<
  Record<TipoCredencial, { estado: string; fecha: string | null }>
>;

// El estado se distingue por texto y por tono (el color nunca es la única señal).
const TONO_ESTADO: Record<EstadoCredencial, "neutro" | "info" | "ok" | "error"> = {
  no_configurada: "neutro",
  configurada: "info",
  verificada: "ok",
  invalida: "error",
};

const ESTADOS_FINALES: ReadonlySet<string> = new Set([
  "verificada",
  "invalida",
]);

function TextoEstado({
  estado,
  cargado,
  verificando,
}: {
  estado: CredencialEstadoDto | undefined;
  cargado: boolean;
  verificando: boolean;
}) {
  if (verificando) {
    return (
      <p className="m-0 text-sm text-tinta-media">
        Estado: <Badge tono="aviso">Verificando…</Badge>
      </p>
    );
  }
  if (!estado) {
    return (
      <p className="m-0 text-sm text-tinta-media">
        {cargado ? "Estado no disponible." : "Cargando…"}
      </p>
    );
  }
  return (
    <p className="m-0 text-sm text-tinta-media">
      Estado:{" "}
      <Badge tono={TONO_ESTADO[estado.estado as EstadoCredencial] ?? "neutro"}>
        {ETIQUETA_ESTADO[estado.estado as EstadoCredencial]}
      </Badge>
      {estado.estado === "verificada" && estado.fecha
        ? ` el ${fechaCorta(estado.fecha)}`
        : ""}
      {estado.estado === "invalida" && estado.motivo
        ? `: ${textoMotivoCredencial(estado.motivo)}`
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
  const [verificando, setVerificando] = useState<Verificando>({});
  const verificandoRef = useRef<Verificando>({});
  verificandoRef.current = verificando;
  const tiposVerificando = Object.keys(verificando).sort().join(",");

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

  // Refresco de la ficha (D-5): mientras haya una credencial en «Verificando» se vuelve a leer el listado con espera
  // creciente; para al llegar a un estado final, al vencer el tope y al desmontar. No abre otro SSE (límite de 3).
  useEffect(() => {
    if (tiposVerificando === "") return;
    let vigente = true;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let espera = ESPERA_INICIAL_MS;
    let transcurrido = 0;

    const leer = async () => {
      try {
        const r = await listarCredenciales(clienteId);
        if (!vigente) return;
        if (r.ok && Array.isArray(r.datos)) {
          const porTipo: Estados = {};
          for (const e of r.datos) porTipo[e.tipo] = e;
          const terminadas: TipoCredencial[] = [];
          for (const [tipo, base] of Object.entries(
            verificandoRef.current,
          ) as Array<
            [TipoCredencial, { estado: string; fecha: string | null }]
          >) {
            const actual = porTipo[tipo];
            if (
              actual &&
              ESTADOS_FINALES.has(actual.estado) &&
              (actual.estado !== base.estado || actual.fecha !== base.fecha)
            )
              terminadas.push(tipo);
          }
          if (terminadas.length > 0) {
            setEstados((previo) => ({ ...previo, ...porTipo }));
            setVerificando((previo) => {
              const resto = { ...previo };
              for (const t of terminadas) delete resto[t];
              return resto;
            });
          }
        }
      } catch {
        // Una lectura fallida se reintenta en el siguiente turno; no se levanta alerta por un sondeo pasivo.
      }
      if (!vigente) return;
      transcurrido += espera;
      if (transcurrido >= TOPE_VERIFICANDO_MS) {
        setVerificando({});
        return;
      }
      espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
      temporizador = setTimeout(() => void leer(), espera);
    };

    temporizador = setTimeout(() => void leer(), espera);
    return () => {
      vigente = false;
      if (temporizador !== undefined) clearTimeout(temporizador);
    };
  }, [clienteId, tiposVerificando]);

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
        setVerificando((previo) => {
          const resto = { ...previo };
          delete resto[tipo];
          return resto;
        });
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
        const actual = estados[tipo];
        setVerificando((previo) => ({
          ...previo,
          [tipo]: {
            estado: actual?.estado ?? "configurada",
            fecha: actual?.fecha ?? null,
          },
        }));
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
    <Card aria-label="Credenciales" className="w-full max-w-xl">
      <CardTitle>Credenciales</CardTitle>

      {GRUPOS.map((g) => (
        <fieldset
          key={g.tipo}
          className="m-0 flex min-w-0 flex-col gap-3 rounded-control border border-linea-control p-4"
        >
          <legend className="px-1 text-sm font-semibold text-tinta-media">{g.titulo}</legend>
          <TextoEstado
            estado={estados[g.tipo]}
            cargado={cargado}
            verificando={verificando[g.tipo] !== undefined}
          />
          {g.tipo === "sire_api" && (
            <p className="m-0 text-sm text-aviso">
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
                <Label key={c.nombre}>
                  {c.etiqueta}
                  <Input
                    name={c.nombre}
                    type={c.secreto ? "password" : "text"}
                    autoComplete={c.secreto ? "new-password" : "off"}
                    spellCheck={false}
                    disabled={ocupado}
                    className="max-lg:h-11"
                  />
                </Label>
              ))}
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={ocupado} className="max-lg:h-11">
                  Guardar
                </Button>
                <Button
                  type="button"
                  variant="secundario"
                  disabled={ocupado}
                  onClick={() => void verificar(g.tipo)}
                  className="max-lg:h-11"
                >
                  Verificar
                </Button>
              </div>
            </form>
          )}
        </fieldset>
      ))}

      {error && (
        <Alert tono="error" role="alert">
          {error}
        </Alert>
      )}
      {aviso && (
        <Alert tono="ok" role="status">
          <p className="m-0">
            {aviso}{" "}
            {encolada && (
              <Link href="/trabajos" className={cn(enlace, "text-ok hover:text-ok")}>
                {MENSAJES_CREDENCIALES.enlacePanel}
              </Link>
            )}
          </p>
        </Alert>
      )}
    </Card>
  );
}
