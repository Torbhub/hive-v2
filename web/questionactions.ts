import { answerQuestionBatch, cancelQuestionBatch } from '../src/questions.js';

export async function handleQuestionAction(
  root: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  const id = String(body.id ?? '');
  if (pathname === '/api/questions/answer') {
    return { ok: true, batch: await answerQuestionBatch(root, id, body.answers) };
  }
  if (pathname === '/api/questions/cancel') {
    return { ok: true, batch: await cancelQuestionBatch(root, id) };
  }
  return null;
}
