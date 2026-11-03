import { Module } from '@nestjs/common';
import { AppService } from './app.service.js';
import { TrabajosModule } from './trabajos/trabajos.module.js';

@Module({
  imports: [TrabajosModule],
  providers: [AppService],
})
export class AppModule {}
