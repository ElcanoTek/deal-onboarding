import { AuditResult, FormData } from '../types/deal'

export interface DealChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface DealChatChange {
  path: string
  description: string
}

/** A file the trader attached in the chat composer (already uploaded to
 *  /api/upload). The assistant folds it into the form's domain/app-bundle lists
 *  per the message instruction. */
export interface ChatUploadedFile {
  id: string
  name: string
  size: number
  path: string
  detectedColumn?: string
  headers?: string[]
}

export interface DealChatRequest {
  messages: DealChatMessage[]
  form: FormData
  /** The latest /api/audit response for this form (checks + QA report), so
   *  the assistant sees exactly what is failing. Omitted before the first
   *  audit runs. */
  audit?: AuditResult | null
  uploadedFiles?: ChatUploadedFile[]
  /** Composer model pick — any OpenRouter slug, forwarded verbatim. */
  model?: string
}

/** Opens the streaming deal-chat endpoint and returns the raw Response so the
 *  caller can pump the SSE body. Throws with the server's error message on a
 *  non-OK status (e.g. 503 when OPENROUTER_API_KEY is unset). */
export async function openDealChatStream(body: DealChatRequest, signal: AbortSignal): Promise<Response> {
  const r = await fetch('/api/deal/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok || !r.body) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err && err.error) || `chat failed (${r.status})`)
  }
  return r
}
