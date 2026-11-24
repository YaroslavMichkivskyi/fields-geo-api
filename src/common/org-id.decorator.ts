import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The organisation the request acts for, from the `x-org-id` header.
 * Stand-in for real auth: every query is scoped to this id.
 */
export const OrgId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<FastifyRequest>().headers['x-org-id'];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException('x-org-id header with an organization uuid is required');
  }
  return value.toLowerCase();
});
