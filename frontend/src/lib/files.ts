/** Last path segment of a file reference — uploads can
 *  carry full client-side paths; the UI only ever needs the file name. */
export function fileBasename(name: string): string {
  return name.split(/[\\/]/).pop() || name
}

/** Logical attachment names reserved by the submit pipeline: the server
 *  uploads the structured brief as deal_brief.json alongside the prompt, and
 *  fleet hard-rejects duplicate logical file names on a create (#282.2). */
export const RESERVED_ATTACHMENT_NAMES = ['deal_brief.json']

/** Deterministically dedupe a logical attachment name against the names this
 *  submission already carries plus the RESERVED names: a collision gets a
 *  numeric suffix before the extension ("domains.csv" → "domains-2.csv",
 *  then "-3", …). Every downstream reference (prompt file args, fileNames,
 *  the brief's attachment cross-check) uses the returned name, so the batch
 *  stays internally consistent — the runner would otherwise 400 the whole
 *  submission on the duplicate logical file name after every upload ran. */
export function uniqueLogicalName(desired: string, taken: Iterable<string>): string {
  const used = new Set<string>(RESERVED_ATTACHMENT_NAMES)
  for (const name of taken) used.add(name)
  if (!used.has(desired)) return desired
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`
    if (!used.has(candidate)) return candidate
  }
}
