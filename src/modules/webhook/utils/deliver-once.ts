import { Repository } from 'typeorm';
import { withSafeFetch, redactSsrfError, isSsrfProtectionEnabled } from '../../../common/security/ssrf-guard';
import { type LoggerService } from '../../../common/services/logger.service';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { WebhookDelivery } from '../entities/webhook-delivery.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

/**
 * One SSRF-guarded POST + response classification: a non-ok status throws `HTTP <status>: <statusText>`,
 * ok returns the status. This is the byte-level delivery core BOTH paths previously duplicated line
 * for line; extracting it keeps the two sinks one contract: same fetch, same guard, same error
 * shape, same timeout knob.
 */
export async function postWebhookPayload(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetch: typeof withSafeFetch = withSafeFetch,
): Promise<{ status: number; statusText: string }> {
  const { ok, status, statusText } = await fetch(
    url,
    {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    },
    response => ({ ok: response.ok, status: response.status, statusText: response.statusText }),
    { guard: isSsrfProtectionEnabled() },
  );
  if (!ok) throw new Error(`HTTP ${status}: ${statusText}`);
  return { status, statusText };
}

/**
 * Record a terminal webhook delivery failure (all retries exhausted) to the durable table. Shared
 * wrapper so both paths write the identical row shape. Best-effort: never throws back into the
 * delivery result (the caller's semantics depend on that). Returns false when an identical failure
 * was already recorded, so the caller can keep the failure metric in step with the table.
 */
export async function recordTerminalFailure(
  failureRepository: Repository<WebhookDeliveryFailure>,
  logger: LoggerService,
  input: Omit<Parameters<typeof recordWebhookDeliveryFailure>[2], 'lastStatusCode' | 'lastError'> & { error: unknown },
): Promise<boolean> {
  const { error, ...row } = input;
  const errMessage = redactSsrfError(error);
  return recordWebhookDeliveryFailure(failureRepository, logger, {
    ...row,
    lastStatusCode: statusCodeFromError(errMessage),
    lastError: errMessage,
  });
}

/** Upper bound on each truncated text field written to `openwa_gw_webhook_deliveries` per attempt. */
const MAX_LOGGED_FIELD_BYTES = 4096;

function truncate(value: string, max = MAX_LOGGED_FIELD_BYTES): string {
  return Buffer.byteLength(value, 'utf8') <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

export interface DeliveryAttemptLogInput {
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  requestPayload: unknown;
  responseStatus: number | null;
  responseBody: string | null;
  success: boolean;
  attempt: number;
  durationMs: number;
  error: string | null;
}

/**
 * Append one row to `openwa_gw_webhook_deliveries` for a single delivery attempt — success or
 * failure. Shared by both delivery paths (queued processor and the deprecated direct fallback) so
 * an operator can browse what was actually sent and how the receiver answered, not just the
 * terminal failures `recordTerminalFailure` tracks. Best-effort and non-throwing: a logging failure
 * must never affect the delivery outcome it is recording.
 */
export async function recordDeliveryAttempt(
  deliveryRepository: Repository<WebhookDelivery>,
  logger: LoggerService,
  input: DeliveryAttemptLogInput,
): Promise<void> {
  try {
    let requestPayload: string | null;
    try {
      requestPayload = truncate(JSON.stringify(input.requestPayload ?? null));
    } catch {
      requestPayload = null;
    }
    await deliveryRepository.insert({
      webhookId: input.webhookId,
      sessionId: input.sessionId,
      event: input.event,
      url: input.url,
      requestPayload,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody ? truncate(input.responseBody) : null,
      success: input.success,
      attempt: input.attempt,
      durationMs: input.durationMs,
      error: input.error ? truncate(input.error, 2048) : null,
    });
  } catch (err) {
    logger.error('Failed to write webhook delivery log row', err instanceof Error ? err.message : String(err), {
      webhookId: input.webhookId,
      sessionId: input.sessionId,
      action: 'webhook_delivery_log_write_failed',
    });
  }
}
