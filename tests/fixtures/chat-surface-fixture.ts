/**
 * R4 (H113): a surface's chat turn in a process of its own (tests/chat-one-conversation.test.ts, tests/chat-companion-*.test.ts):
 * it opens the shared chat session (src/agent/chat-session.ts) for the project CHAT_PROJECT on the surface CHAT_SURFACE, as
 * the terminal Workbench or the monitor does, and sends CHAT_TEXT (with the key CHAT_KEY, when given), answering any NEEDS
 * YOU with CHAT_ANSWER (deny unless said). It prints `SENDING <pid>` before the turn and then the turn's result as one JSON
 * line (`RESULT {...}`). The model behind it is the test's FAKE Ollama (the setup in TIMMY_HOME names it); the network is the
 * test's recording fetch (FAKE), loaded with --import.
 */
import { openChatSession } from '../../src/agent/chat-session.js';
import type { ChatSurface } from '../../src/contracts/chat-session.js';

const root = process.env.CHAT_PROJECT ?? '';
const surface = (process.env.CHAT_SURFACE ?? 'workbench') as ChatSurface;
const text = process.env.CHAT_TEXT ?? 'hello';
const key = process.env.CHAT_KEY;
const answer = (process.env.CHAT_ANSWER ?? 'deny') as 'once' | 'session' | 'deny';

const chat = await openChatSession({ project: { name: process.env.CHAT_NAME ?? 'demo', root }, surface });
process.stdout.write(`SENDING ${process.pid}\n`);
const hooks = { onText: () => undefined, askPerson: async () => answer };
const r = key ? await chat.sendOnce(key, text, hooks) : await chat.send(text, hooks);
process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
process.exit(0);
