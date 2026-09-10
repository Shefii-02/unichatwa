import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { REQUIRED_ROLE_KEY, UNSCOPED_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';

// The aggregate stats routes carry no `:sessionId`, so the ApiKeyGuard's allowedSessions fence
// can't reach them. They enforce access in the handler instead: a session-scoped key gets the
// aggregate over its OWN sessions, an unscoped key must be ADMIN. The per-session route is left
// ungated — its `:sessionId` param already scopes a restricted key.
describe('StatsController access control', () => {
  const reflector = new Reflector();
  const proto = StatsController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

  it.each(['getOverview', 'getMessageStats'] as const)(
    'aggregate route %s carries no static role / unscoped decorator (checked in-handler)',
    method => {
      expect(reflector.get(REQUIRED_ROLE_KEY, proto[method])).toBeUndefined();
      expect(reflector.get(UNSCOPED_KEY, proto[method])).toBeUndefined();
    },
  );

  it('per-session stats is not globally ADMIN-gated (scope-enforced by its :sessionId param)', () => {
    expect(reflector.get(REQUIRED_ROLE_KEY, proto.getSessionStats)).toBeUndefined();
  });

  describe('assertMayReadAggregate', () => {
    const call = (apiKey?: Partial<ApiKey>) => {
      const c = new StatsController({} as never);
      return (c as unknown as { assertMayReadAggregate(k?: Partial<ApiKey>): string[] | null })
        .assertMayReadAggregate(apiKey);
    };

    it('allows a session-scoped key and returns its scope', () => {
      expect(call({ role: ApiKeyRole.OPERATOR, allowedSessions: ['s1', 's2'] })).toEqual(['s1', 's2']);
    });

    it('allows an unscoped ADMIN key with a null (unfiltered) scope', () => {
      expect(call({ role: ApiKeyRole.ADMIN, allowedSessions: null })).toBeNull();
      expect(call({ role: ApiKeyRole.ADMIN, allowedSessions: [] })).toBeNull();
    });

    it('rejects an unscoped non-admin key', () => {
      expect(() => call({ role: ApiKeyRole.OPERATOR, allowedSessions: null })).toThrow(ForbiddenException);
      expect(() => call({ role: ApiKeyRole.VIEWER, allowedSessions: [] })).toThrow(ForbiddenException);
      expect(() => call(undefined)).toThrow(ForbiddenException);
    });
  });
});
