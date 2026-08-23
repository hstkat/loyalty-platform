import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

// Standaardset — de twee publieke websites (met en zonder www) die de
// Mijn Tegoed-portal, de cadeaukaart-widget en de andere WordPress-
// widgets embedden. LET OP: als de backoffice-pagina's (dashboard.html
// etc.) vanaf een ANDER domein worden geopend dan deze lijst, moet dat
// domein ook worden toegevoegd — zie ALLOWED_ORIGINS hieronder.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://hetstrand.nl',
  'https://www.hetstrand.nl',
  'https://het-strand.nl',
  'https://www.het-strand.nl',
  'https://zomersbeachclub.nl',
  'https://www.zomersbeachclub.nl',
];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Voorheen: open (origin: true, elke website mocht deze API
  // aanroepen). Nu ingeperkt tot een vaste lijst domeinen — kan
  // uitgebreid worden via de ALLOWED_ORIGINS environment variable
  // (komma-gescheiden) in Vercel, bijvoorbeeld als de backoffice-
  // pagina's vanaf een eigen domein draaien.
  //
  // 'null' origin wordt bewust ook toegestaan: dat is wat browsers
  // sturen bij het openen van een lokaal HTML-bestand (file://) zonder
  // webserver — precies hoe de backoffice-pagina's nu vermoedelijk
  // lokaal getest worden. Zodra die pagina's op een echt domein staan,
  // is het veiliger om dat domein hieronder toe te voegen en 'null' te
  // verwijderen.
  const envOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS, ...envOrigins];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Niet toegestaan door CORS-beleid: ' + origin), false);
      }
    },
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Loyalty platform API running on http://localhost:${port}`);
}

bootstrap();
