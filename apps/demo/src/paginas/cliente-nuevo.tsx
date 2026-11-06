import { validarRuc } from "@contapp/shared";
import { useState } from "react";
import { PADRON_RUC } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { Aviso, Boton, Campo, Encabezado, Tarjeta, claseInput, ir } from "../ui/comunes";

export function ClienteNuevo() {
  const { estado, consultarRuc, crearCliente, trabajo, actualizarCliente, notificar } = useDemo();
  const [ruc, setRuc] = useState("");
  const [consultando, setConsultando] = useState(false);
  const [datos, setDatos] = useState<{ razonSocial: string; ubicacion: string; actividad: string; regimen: string } | null>(null);
  const [error, setError] = useState("");
  const [usuarioSol, setUsuarioSol] = useState("");
  const [claveSol, setClaveSol] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [responsable, setResponsable] = useState(estado.usuarios[1]?.nombre ?? "");

  const consultar = async () => {
    setError("");
    setDatos(null);
    if (!validarRuc(ruc)) return setError("RUC inválido: revisa los 11 dígitos (dígito verificador módulo 11).");
    if (estado.clientes.some((c) => c.ruc === ruc)) return setError("Ese RUC ya es cliente del estudio.");
    setConsultando(true);
    const r = await consultarRuc(ruc);
    setConsultando(false);
    if (!r) return setError("No se encontró en el padrón simulado. Prueba con un RUC de ejemplo de abajo.");
    setDatos(r);
  };

  const guardar = () => {
    if (!datos) return;
    const conCred = usuarioSol.length > 0 && claveSol.length > 0;
    const c = crearCliente({
      ruc,
      razonSocial: datos.razonSocial,
      regimen: datos.regimen,
      ubicacion: datos.ubicacion,
      actividad: datos.actividad,
      zonaSelva: datos.ubicacion.includes("selva"),
      ventasExoneradas: datos.actividad.toLowerCase().includes("exonerado"),
      responsable,
      credencialSol: conCred ? "verificando" : "sin",
      credencialSire: clientId && secret ? "verificando" : "sin",
      usuarioSol: usuarioSol || undefined,
      activo: true,
    });
    if (conCred || (clientId && secret)) {
      trabajo("Verificación de credenciales", ["Backend cifra la clave (AES-256-GCM + DEK envuelta con KEK)", "Worker descifra en memoria", "Login de prueba en SOL (simulado)", "Token SIRE de prueba (simulado)"], {
        cliente: datos.razonSocial,
        alTerminar: () => {
          actualizarCliente(c.id, { credencialSol: conCred ? "valida" : "sin", credencialSire: clientId && secret ? "valida" : "sin" });
          notificar(`Credenciales verificadas: ${datos.razonSocial}`, "exito", `#/clientes/${c.id}`);
        },
      });
    }
    ir(`/clientes/${c.id}`);
  };

  return (
    <>
      <Encabezado titulo="Nuevo cliente" migas={[{ texto: "Clientes", ruta: "/clientes" }, { texto: "Nuevo" }]} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Tarjeta titulo="1. Consulta RUC">
          <div className="space-y-3 p-4">
            <div className="flex gap-2">
              <input className={`${claseInput} flex-1`} placeholder="RUC de 11 dígitos" value={ruc} maxLength={11} onChange={(e) => setRuc(e.target.value.replace(/\D/g, ""))} />
              <Boton variante="primario" onClick={consultar} disabled={ruc.length !== 11 || consultando}>
                {consultando ? "Consultando…" : "Consultar"}
              </Boton>
            </div>
            <div className="text-xs text-slate-500">
              RUC ficticios de prueba:{" "}
              {Object.keys(PADRON_RUC)
                .filter((r) => !estado.clientes.some((c) => c.ruc === r))
                .map((r) => (
                  <button key={r} className="mr-2 font-mono text-teal-700 underline" onClick={() => setRuc(r)}>
                    {r}
                  </button>
                ))}
            </div>
            {error && <Aviso tono="rojo">{error}</Aviso>}
            {datos && (
              <dl className="grid grid-cols-3 gap-x-3 gap-y-2 rounded-lg bg-slate-50 p-3 text-sm">
                <dt className="text-slate-500">Razón social</dt>
                <dd className="col-span-2 font-semibold">{datos.razonSocial}</dd>
                <dt className="text-slate-500">Ubicación</dt>
                <dd className="col-span-2">{datos.ubicacion}</dd>
                <dt className="text-slate-500">Actividad</dt>
                <dd className="col-span-2">{datos.actividad}</dd>
                <dt className="text-slate-500">Régimen</dt>
                <dd className="col-span-2">{datos.regimen}</dd>
              </dl>
            )}
            <Campo etiqueta="Responsable">
              <select className={claseInput} value={responsable} onChange={(e) => setResponsable(e.target.value)}>
                {estado.usuarios.map((u) => (
                  <option key={u.id}>{u.nombre}</option>
                ))}
              </select>
            </Campo>
          </div>
        </Tarjeta>
        <Tarjeta titulo="2. Credenciales (opcional, solo escritura)">
          <div className="space-y-3 p-4">
            <Aviso tono="azul">Las claves se cifran al guardarlas y nunca se vuelven a mostrar. Solo el worker las descifra, en memoria, para hablar con SUNAT.</Aviso>
            <div className="grid grid-cols-2 gap-3">
              <Campo etiqueta="Usuario SOL">
                <input className={claseInput} value={usuarioSol} onChange={(e) => setUsuarioSol(e.target.value.toUpperCase())} placeholder="DEMOUSER" />
              </Campo>
              <Campo etiqueta="Clave SOL">
                <input className={claseInput} type="password" value={claveSol} onChange={(e) => setClaveSol(e.target.value)} placeholder="••••••••" autoComplete="off" />
              </Campo>
              <Campo etiqueta="client_id SIRE">
                <input className={claseInput} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="cualquier texto" />
              </Campo>
              <Campo etiqueta="client_secret SIRE">
                <input className={claseInput} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••" autoComplete="off" />
              </Campo>
            </div>
            <p className="text-xs text-slate-500">En la demo cualquier valor sirve y no se guarda en ningún lado.</p>
          </div>
        </Tarjeta>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Boton onClick={() => ir("/clientes")}>Cancelar</Boton>
        <Boton variante="primario" disabled={!datos} onClick={guardar}>
          Guardar cliente
        </Boton>
      </div>
    </>
  );
}
