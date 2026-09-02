import { describe, expect, it } from 'vitest'
import { parseSseChunk } from './sse'

describe('parseSseChunk', () => {
  it('parses a single complete frame', () => {
    const { events, remainder } = parseSseChunk('event: text.delta\ndata: {"text":"hi"}\n\n')
    expect(remainder).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'text.delta', data: '{"text":"hi"}' })
  })

  it('holds a partial trailing frame as remainder', () => {
    const { events, remainder } = parseSseChunk('event: a\ndata: 1\n\nevent: b\ndata: par')
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('a')
    expect(remainder).toBe('event: b\ndata: par')
  })

  it('reassembles across chunks via the remainder', () => {
    const first = parseSseChunk('event: form.update\ndata: {"form"')
    expect(first.events).toHaveLength(0)
    const second = parseSseChunk(first.remainder + ':{}}\n\n')
    expect(second.events).toHaveLength(1)
    expect(second.events[0].data).toBe('{"form":{}}')
  })

  it('joins multi-line data and ignores comments/blank lines', () => {
    const { events } = parseSseChunk(': keep-alive\nevent: x\ndata: line1\ndata: line2\n\n')
    expect(events[0].data).toBe('line1\nline2')
  })

  it('defaults the event name to "message"', () => {
    const { events } = parseSseChunk('data: hello\n\n')
    expect(events[0].event).toBe('message')
  })
})
