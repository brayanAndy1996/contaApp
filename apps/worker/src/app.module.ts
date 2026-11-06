import { Module } from '@nestjs/common';
import { AppService } from './app.service.js';
import { AdaptadoresModule } from './adaptadores/adaptadores.module.js';
import { TrabajosModule } from './trabajos/trabajos.module.js';

@Module({
  imports: [AdaptadoresModule, TrabajosModule],
  providers: [AppService],
})
export class AppModule {}
