import type { Logger } from './logger.js';
import { describeError } from './logger.js';

/**
 * Outbound email, via SendGrid's REST API.
 *
 * Deliberately a hand-rolled `fetch` call rather than the SendGrid SDK: one POST
 * with a JSON body is the entire surface this needs, and the SDK is a large
 * dependency in a Lambda bundle for the sake of the same request.
 *
 * Everything here is best-effort and never throws. Mail exists to tell somebody it
 * is their turn; a mail provider having a bad afternoon must not fail the pick that
 * triggered it, because the pick is the thing that actually matters and the site
 * shows whose turn it is regardless.
 *
 * With no API key configured this becomes a no-op that logs what it would have
 * sent, which is what local development and the test suite want.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text only. Nobody in this league needs a templated HTML email. */
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<boolean>;
}

export interface MailerOptions {
  apiKey: string | undefined;
  from: string | undefined;
  fromName?: string | undefined;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export function createMailer({ apiKey, from, fromName, logger, fetchImpl }: MailerOptions): Mailer {
  const send = async (message: EmailMessage): Promise<boolean> => {
    if (!apiKey || !from) {
      /*
        Not an error. A deployment without mail configured still works — this is
        the state the portal ran in for weeks — so it says what it would have done
        and carries on.
      */
      logger.info('email not configured, nothing sent', { subject: message.subject });
      return false;
    }

    try {
      const doFetch = fetchImpl ?? fetch;
      const response = await doFetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: from, ...(fromName ? { name: fromName } : {}) },
          subject: message.subject,
          content: [{ type: 'text/plain', value: message.text }],
        }),
      });

      if (!response.ok) {
        // The body carries SendGrid's reason; the key is in the header, not here.
        const detail = await response.text().catch(() => '');
        logger.warn('email rejected', {
          status: response.status,
          detail: detail.slice(0, 300),
        });
        return false;
      }

      logger.info('email sent', { subject: message.subject });
      return true;
    } catch (error) {
      logger.warn('email failed', describeError(error));
      return false;
    }
  };

  return { send };
}

/** A mailer that records instead of sending, for tests. */
export function recordingMailer(): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message: EmailMessage): Promise<boolean> {
      sent.push(message);
      return true;
    },
  };
}
