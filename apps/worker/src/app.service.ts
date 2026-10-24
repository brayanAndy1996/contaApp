import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { clearInterval, setInterval } from 'node:timers';
import { saludoSchema } from '@contapp/shared';

@Injectable()
export class AppService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private latido?: NodeJS.Timeout;

  onApplicationBootstrap(): void {
    this.logger.log(saludoSchema.parse({ mensaje: 'Worker iniciado' }).mensaje);
    // Provisional (spec 001, T7): mantiene vivo el proceso hasta SIGINT/SIGTERM.
    this.latido = setInterval(() => undefined, 60_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.latido);
    this.logger.log('Worker detenido');
  }
}
