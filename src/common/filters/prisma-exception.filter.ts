import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * Translates known Prisma error codes into meaningful HTTP responses,
 * instead of leaking a raw 500 with database internals to the client.
 *
 * P2002 — unique constraint violation (e.g. duplicate identity value,
 *         see customer_identities' org+type+value uniqueness rule)
 * P2025 — record not found (e.g. update/delete on a non-existent id)
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception.code === 'P2002') {
      const target = (exception.meta?.target as string[])?.join(', ') ?? 'field';
      const body = new ConflictException(`A record with this ${target} already exists.`).getResponse();
      return response.status(409).json(body);
    }

    if (exception.code === 'P2025') {
      const body = new NotFoundException('Resource not found.').getResponse();
      return response.status(404).json(body);
    }

    response.status(500).json({
      statusCode: 500,
      message: 'Unexpected database error.',
      code: exception.code,
    });
  }
}
