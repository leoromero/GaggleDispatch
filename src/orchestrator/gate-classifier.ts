/**
 * Claude-powered gate reply classifier.
 *
 * Replaces the rigid keyword regex for supervised-gate replies so that natural
 * answers to clarifying questions ("Use REST not GraphQL") are recognised as
 * approvals and forwarded to Archon as $LOOP_USER_INPUT, not dropped.
 *
 * Falls back to the regex classifier when no API key is available (CI / tests).
 */

import Anthropic from '@anthropic-ai/sdk';
import { classifyApprovalIntent } from './orchestrator.ts';
import { logger } from '../util/logger.ts';

export interface GateClassification {
  intent: 'approve' | 'reject' | 'ambiguous' | 'create_blocker';
  /** Message to forward to Archon (approve comment or reject reason). */
  message: string;
  /** Populated when intent === 'create_blocker'. */
  blocker?: { title: string; description: string };
}

export interface GateComment {
  author_name: string | null;
  body: string;
}

const SYSTEM_PROMPT = `You classify AI workflow gate messages and human replies.

A gate fires when an AI agent either:
- Needs a clarifying question answered before it can proceed (interactive loop gate).
- Is presenting a plan or action for explicit approval before making changes (approval gate).
- Has discovered it needs work done in another repository before it can continue (blocker gate).

Classify the gate message or the LATEST human reply in the thread:
- "approve": the human wants the work to continue (any reply that isn't a stop or blocker request).
- "reject": the human explicitly wants the work to stop, be cancelled, or restarted.
- "ambiguous": the reply is genuinely unclear even with full conversation context.
- "create_blocker": the gate message starts with CREATE_BLOCKER (agent signalling it needs a dependency resolved in another repo). No human reply is needed — detect this from the gate message itself.

For "create_blocker": extract blocker_title (first non-empty line after CREATE_BLOCKER) and blocker_description (remaining lines).
For "message": include the full conversation thread so Archon has complete context for $LOOP_USER_INPUT.

Respond with JSON only — no prose:
{"intent": "approve"|"reject"|"ambiguous"|"create_blocker", "message": "<thread>", "blocker_title": "<title or null>", "blocker_description": "<description or null>"}`;

function isBot(c: GateComment): boolean {
  if (c.author_name !== null && /symphony|gaggle|bot/i.test(c.author_name)) return true;
  return c.body.trimStart().startsWith('🤖');
}

function formatThread(comments: GateComment[]): string {
  return comments
    .map((c) => `[${isBot(c) ? 'Bot' : 'Human'}] ${c.body.trim()}`)
    .join('\n');
}

function parseBlockerFromMessage(gateMessage: string): { title: string; description: string } | null {
  const lines = gateMessage.trim().split('\n');
  const headerIdx = lines.findIndex((l) => /^CREATE_BLOCKER\s*$/i.test(l.trim()));
  if (headerIdx === -1) return null;
  const rest = lines.slice(headerIdx + 1).filter((l) => l.trim());
  const title = rest[0]?.trim() ?? 'Blocker required';
  const description = rest.slice(1).join('\n').trim();
  return { title, description };
}

export async function classifyGateReply(
  gateMessage: string,
  thread: GateComment[],
  model: string,
  apiKey: string,
): Promise<GateClassification> {
  // Detect CREATE_BLOCKER directly from gate message before any API call.
  const blockerFromMessage = parseBlockerFromMessage(gateMessage);
  if (blockerFromMessage) {
    return { intent: 'create_blocker', message: '', blocker: blockerFromMessage };
  }

  const lastHuman = [...thread].reverse().find((c) => !isBot(c));
  const lastHumanBody = lastHuman?.body ?? '';

  const resolvedKey = apiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!resolvedKey) {
    const intent = classifyApprovalIntent(lastHumanBody);
    return { intent, message: lastHumanBody.trim() };
  }

  try {
    const client = new Anthropic({ apiKey: resolvedKey });
    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Gate context: ${gateMessage}\n\nConversation thread:\n${formatThread(thread)}`,
        },
      ],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as {
      intent?: string;
      message?: string;
      blocker_title?: string;
      blocker_description?: string;
    };

    if (parsed.intent === 'create_blocker' && parsed.blocker_title) {
      return {
        intent: 'create_blocker',
        message: '',
        blocker: {
          title: parsed.blocker_title,
          description: parsed.blocker_description ?? '',
        },
      };
    }

    const intent =
      parsed.intent === 'approve' || parsed.intent === 'reject' ? parsed.intent : 'ambiguous';
    const message = typeof parsed.message === 'string' ? parsed.message : lastHumanBody.trim();
    return { intent, message };
  } catch (err) {
    logger.warn('Gate classifier API call failed — falling back to regex', {
      error: (err as Error).message,
    });
    const intent = classifyApprovalIntent(lastHumanBody);
    return { intent, message: lastHumanBody.trim() };
  }
}
