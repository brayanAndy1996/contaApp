"use client";

import { useState, type FormEvent } from "react";
import { MENSAJES } from "../../lib/acceso";
import { MENSAJES_GASTOS as M, agregarPalabra, validarPalabra } from "../../lib/gastos";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui";
import { CamposPalabra, PALABRA_VACIA, type ValoresPalabra } from "./campos-palabra";

// «Agregar palabra» del estudio (spec 027, R-4): Dialog con la palabra, la categoría y las excepciones. Valida en el formulario
// (el servidor vuelve a validar); un 409 (`palabra_existente`, `limite_palabras`…) o cualquier otro error se muestra dentro del
// diálogo, que sigue abierto con lo escrito.

function Formulario({ alCancelar, alGuardada }: { alCancelar: () => void; alGuardada: () => void }) {
  const [valores, setValores] = useState<ValoresPalabra>(PALABRA_VACIA);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function enviar(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (ocupado) return;
    const v = validarPalabra(valores);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await agregarPalabra(v.cuerpo);
      if (r.ok) {
        alGuardada();
        return;
      }
      if (r.status !== 401) setError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    }
    setOcupado(false);
  }

  return (
    <form onSubmit={(e) => void enviar(e)} noValidate className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{M.agregarPalabra}</DialogTitle>
      </DialogHeader>
      <CamposPalabra valores={valores} alCambiar={setValores} deshabilitado={ocupado} />
      {error && <Alert tono="error">{error}</Alert>}
      <DialogFooter>
        <Button variant="secundario" onClick={alCancelar} disabled={ocupado} className="max-lg:h-11">
          {M.cancelar}
        </Button>
        <Button type="submit" disabled={ocupado} className="max-lg:h-11">
          {M.guardarPalabra}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AgregarPalabra({ alAgregada }: { alAgregada: () => void }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <Dialog open={abierto} onOpenChange={setAbierto}>
      <DialogTrigger asChild>
        <Button className="max-lg:h-11">{M.agregarPalabra}</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-w-md">
        <Formulario
          alCancelar={() => setAbierto(false)}
          alGuardada={() => {
            setAbierto(false);
            alAgregada();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
