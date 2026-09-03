// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Minimal Server-Sent-Events frame parser, ported from a sibling chat app.
// Parses a (possibly partial) chunk of an SSE stream into complete events plus
// a remainder to prepend to the next chunk. We only need event + data; the
// optional id is preserved for completeness.

export type ServerEvent = {
  event: string
  data: string
  id?: string
}

export function parseSseChunk(chunk: string): { events: ServerEvent[]; remainder: string } {
  const frames = chunk.split('\n\n')
  const completeFrames = frames.slice(0, -1)
  const remainder = frames.length > 0 ? frames[frames.length - 1] : ''

  const events = completeFrames
    .map((frame): ServerEvent | null => {
      let event = 'message'
      let id: string | undefined
      const data: string[] = []

      for (const line of frame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          event = line.slice(6).trim()
          continue
        }
        if (line.startsWith('id:')) {
          const v = line.slice(3).trim()
          if (v) id = v
          continue
        }
        if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart())
        }
      }

      if (data.length === 0) return null
      const out: ServerEvent = { event, data: data.join('\n') }
      if (id !== undefined) out.id = id
      return out
    })
    .filter((ev): ev is ServerEvent => ev !== null)

  return { events, remainder }
}
