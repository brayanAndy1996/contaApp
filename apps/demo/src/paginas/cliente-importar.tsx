import { validarRuc } from "@contapp/shared";
import { useMemo, useState } from "react";
import { ESTUDIO, PADRON_RUC } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { Aviso, Boton, Encabezado, Insignia, Tarjeta, claseInput, ir } from "../ui/comunes";

const EJEMPLO = `ruc,usuario_sol,responsable
20700001203,DEMOESPI,Carlos Demo Rojas
20700001211,,Lucía Demo Flores
20700001220,DEMOHOTE,Ana Demo Quispe
20700001234,DEMOXXXX,Ana Demo Quispe
20700000002,DEMOANDI,Carlos Demo Rojas`;

export function ClienteImportar() {
  const { estado, crearCliente, trabajo, actualizarCliente, notificar } = useDemo();
  const [texto, setTexto] = useState(EJEMPLO);
  const [hecho, setHecho] = useState(false);
  const activos = estado.clientes.filter((c) => c.activo).length;

  const filas = useMemo(() => {
    let cupo = ESTUDIO.limiteRucs - activos;
    const vistos = new Set<string>();
    return texto
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim())
      .map((l, i) => {
        const [ruc = "", usuarioSol = "", responsable = ""] = l.split(",").map((x) => x.trim());
        let error = "";
        if (!validarRuc(ruc)) error = "RUC inválido (dígito verificador)";
        else if (estado.clientes.some((c) => c.ruc === ruc)) error = "Ya es cliente";
        else if (vistos.has(ruc)) error = "Duplicado en el archivo";
        else if (!PADRON_RUC[ruc]) error = "No existe en el padrón simulado";
        else if (cupo <= 0) error = "Supera el cupo del plan";
        vistos.add(ruc);
        if (!error) cupo -= 1;
        return { linea: i + 2, ruc, usuarioSol, responsable: responsable || "Carlos Demo Rojas", error, padron: PADRON_RUC[ruc] };
      });
  }, [texto, estado.clientes, activos]);

  const validas = filas.filter((f) => !f.error);

  const importar = () => {
    for (const f of validas) {
      const c = crearCliente({
        ruc: f.ruc,
        razonSocial: f.padron!.razonSocial,
        regimen: f.padron!.regimen,
        ubicacion: f.padron!.ubicacion,
        actividad: f.padron!.actividad,
        zonaSelva: f.padron!.ubicacion.includes("selva"),
        ventasExoneradas: f.padron!.actividad.toLowerCase().includes("exonerado"),
        responsable: f.responsable,
        credencialSol: f.usuarioSol ? "verificando" : "sin",
        credencialSire: "sin",
        usuarioSol: f.usuarioSol || undefined,
        activo: true,
      });
      if (f.usuarioSol) {
        trabajo("Verificación de credenciales", ["Worker descifra la clave en memoria", "Login de prueba en SOL (simulado)"], {
          cliente: c.razonSocial,
          alTerminar: () => actualizarCliente(c.id, { credencialSol: "valida" }),
        });
      }
    }
    notificar(`Importación terminada: ${validas.length} cliente(s) creados, ${filas.length - validas.length} con errores`, "exito", "#/clientes");
    setHecho(true);
  };

  return (
    <>
      <Encabezado titulo="Importar clientes" subtitulo="Carga masiva desde CSV o Excel, con vista previa y control de cupo del plan" migas={[{ texto: "Clientes", ruta: "/clientes" }, { texto: "Importar" }]} />
      <div className="grid gap-5 lg:grid-cols-5">
        <Tarjeta className="lg:col-span-2" titulo="Archivo">
          <div className="space-y-3 p-4">
            <input
              type="file"
              accept=".csv,.txt"
              className="text-sm"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setTexto(await f.text());
              }}
            />
            <textarea className={`${claseInput} h-56 w-full font-mono text-xs`} value={texto} onChange={(e) => setTexto(e.target.value)} />
            <p className="text-xs text-slate-500">Columnas: ruc, usuario_sol, responsable. Las claves se piden después, nunca dentro del archivo.</p>
          </div>
        </Tarjeta>
        <Tarjeta className="lg:col-span-3" titulo={`Vista previa · ${validas.length} válidas de ${filas.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Línea</th>
                  <th className="px-3 py-2">RUC</th>
                  <th className="px-3 py-2">Razón social (padrón)</th>
                  <th className="px-3 py-2">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.linea} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-500">{f.linea}</td>
                    <td className="px-3 py-2 font-mono text-xs">{f.ruc}</td>
                    <td className="px-3 py-2">{f.padron?.razonSocial ?? "—"}</td>
                    <td className="px-3 py-2">{f.error ? <Insignia tono="rojo">{f.error}</Insignia> : <Insignia tono="verde">Se importará</Insignia>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 p-3">
            <span className="text-xs text-slate-500">
              Cupo disponible: {ESTUDIO.limiteRucs - activos} RUC
            </span>
            {hecho ? (
              <Boton variante="primario" onClick={() => ir("/clientes")}>
                Ver clientes →
              </Boton>
            ) : (
              <Boton variante="primario" disabled={validas.length === 0} onClick={importar}>
                Importar {validas.length} cliente(s)
              </Boton>
            )}
          </div>
          {hecho && (
            <div className="p-3 pt-0">
              <Aviso tono="verde">Importación completada. La verificación de credenciales sigue en segundo plano (mira «Trabajos»).</Aviso>
            </div>
          )}
        </Tarjeta>
      </div>
    </>
  );
}
