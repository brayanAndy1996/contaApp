import { Module } from '@nestjs/common';
import { AppService } from './app.service.js';

@Module({
  imports: [],
  providers: [AppService],
})
export class AppModule {}
