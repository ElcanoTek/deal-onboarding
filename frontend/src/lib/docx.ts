// Word (.docx) text extraction lives on the server (internal/docx) because it
// needs ZIP + OOXML handling we don't want to ship to the browser. Spreadsheets
// and CSV/TSV/TXT are still parsed client-side via SheetJS; this helper is only
// for Word documents.

/** True for a Microsoft Word .docx filename. The legacy binary .doc is not
 *  supported (it's an OLE compound file, not a ZIP). */
export function isDocx(name: string): boolean {
  return /\.docx$/i.test(name.trim())
}

/** Upload a .docx to /api/extract-text and return its plain text. Throws with a
 *  human-readable message on failure (bad file, server error, empty doc). */
export async function extractDocxText(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/extract-text', { method: 'POST', body: fd })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error || `Could not read ${file.name} (${res.status})`)
  }
  return String(body?.text || '')
}
