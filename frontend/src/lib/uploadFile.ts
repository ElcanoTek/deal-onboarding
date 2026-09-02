import type { UploadedFile } from '../types/deal'

/** POST a single file to /api/upload, reporting upload progress (0–100).
 *  Resolves to an UploadedFile carrying the server `path` (used as the MOC
 *  attachment path) with an empty `inclusionType` for the caller to fill in.
 *  Shared by the deal-CREATE File Uploads section (campaign domain / app-bundle
 *  lists) and the deal-UPDATE attachment picker. */
export function uploadOne(file: File, onProgress: (pct: number) => void): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/upload')
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            id: body.id,
            name: body.name,
            size: body.size,
            path: body.path,
            inclusionType: '',
          })
        } else {
          reject(new Error(body.error || `Upload failed (${xhr.status})`))
        }
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.send(fd)
  })
}
