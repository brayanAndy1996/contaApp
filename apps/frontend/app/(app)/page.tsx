import { saludoSchema } from "@contapp/shared";
import { PrimerosPasos } from "../../components/primeros-pasos";
import { UsoPlan } from "../../components/uso-plan";
import { EncabezadoPagina } from "../../components/ui";

export default function Home() {
  const saludo = saludoSchema.parse({ mensaje: "ContApp" });

  return (
    <main className="flex flex-1 flex-col gap-6 p-6 md:p-8">
      <EncabezadoPagina titulo={saludo.mensaje} />
      <UsoPlan />
      <PrimerosPasos />
    </main>
  );
}
