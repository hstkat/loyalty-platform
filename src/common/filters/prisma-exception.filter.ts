import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * ÉÉN allesomvattend filter i.p.v. meerdere losse — voorkomt onduidelijkheid
 * over in welke volgorde NestJS meerdere globale filters zou toepassen.
 * Behandelt, in volgorde:
 *   1. Bekende, met opzet gegooide HttpException's (bijv. eigen
 *      BadRequestException) — gewoon doorgeven, geen serverfout.
 *   2. Bekende Prisma-foutcodes (P2002 dubbele waarde, P2025 niet
 *      gevonden) — vertaald naar een nette 409/404.
 *   3. ALLES wat overblijft (elke andere Prisma-fout, of een gewone
 *      programmeerfout) — ALTIJD expliciet gelogd (console.error,
 *      zichtbaar in Vercel → project → Logs) vóórdat een generieke 500
 *      teruggaat. Eerder gaf dit soort fouten HELEMAAL niets in de
 *      server-logs door, waardoor een genuine databasefout (bijv. een
 *      niet-uitgevoerde migratie) alleen als kale "500" zichtbaar was,
 *      zonder enige aanwijzing wat er echt misging.
 */
@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method?: string; url?: string }>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return response.status(status).json(exception.getResponse());
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        const target = (exception.meta?.target as string[])?.join(', ') ?? 'field';
        const body = new ConflictException(`A record with this ${target} already exists.`).getResponse();
        return response.status(409).json(body);
      }
      if (exception.code === 'P2025') {
        const body = new NotFoundException('Resource not found.').getResponse();
        return response.status(404).json(body);
      }
      this.logger.error(
        `Onverwachte Prisma-fout (${exception.code}) bij ${request?.method ?? '?'} ${request?.url ?? '?'}: ${exception.message}`,
        exception.stack,
      );
      return response.status(500).json({ statusCode: 500, message: 'Unexpected database error.', code: exception.code });
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(`Onverwachte fout bij ${request?.method ?? '?'} ${request?.url ?? '?'}: ${message}`, stack);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Er ging iets onverwachts mis op de server.',
    });
  }
}
