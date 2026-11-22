import { Module } from "@nestjs/common";
import { AprenderService } from "./aprender.service.js";
import { ClienteGastosController } from "./cliente.controller.js";
import { ClienteGastosService } from "./cliente.service.js";
import { DiccionarioController } from "./diccionario.controller.js";
import { DiccionarioService } from "./diccionario.service.js";
import { DiccionarioPlataformaController } from "./plataforma.controller.js";
import { DiccionarioPlataformaService } from "./plataforma.service.js";
import { ReevaluarGastosService } from "./reevaluar.service.js";

/**
 * Gastos no deducibles (spec 027, R-GP completo): diccionario, umbral y globales desactivadas del estudio, categorías por cliente, «Aprender
 * estas palabras», «Volver a evaluar» (solo encola) y el diccionario global del super-admin. La BD, el `Encolador` y el hash de sesión llegan
 * de los módulos globales. El backend NO llama a SUNAT ni consulta el CIIU: solo lee la caché del estudio. El contexto de las evaluaciones
 * (`contexto.ts`) lo usan también `compras/escritura.ts` y `archivos/previo.ts`.
 */
@Module({
  controllers: [DiccionarioController, ClienteGastosController, DiccionarioPlataformaController],
  providers: [DiccionarioService, ClienteGastosService, AprenderService, ReevaluarGastosService, DiccionarioPlataformaService],
})
export class GastosModule {}
