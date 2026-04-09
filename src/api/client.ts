import axios, { type AxiosProgressEvent } from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

/** Attach the session token to every request. */
export function setAuthToken(token: string | null) {
  if (token) {
    apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
  } else {
    delete apiClient.defaults.headers.common['Authorization']
  }
}

/** Upload a file using XHR so we get per-file upload progress. */
export function uploadFile(
  url: string,
  file: File,
  token: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const formData = new FormData()
    formData.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${url}`)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.addEventListener('progress', (e: ProgressEvent) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          resolve(xhr.responseText)
        }
      } else {
        const message =
          tryParseError(xhr.responseText) ?? `HTTP ${xhr.status}`
        reject(new ApiError(message, xhr.status))
      }
    })

    xhr.addEventListener('error', () =>
      reject(new ApiError('Network error during upload', 0))
    )
    xhr.addEventListener('abort', () =>
      reject(new ApiError('Upload aborted', 0))
    )

    if (signal) {
      signal.addEventListener('abort', () => xhr.abort())
    }

    xhr.send(formData)
  })
}

function tryParseError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string }
    return parsed.message ?? parsed.error ?? null
  } catch {
    return null
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Axios response interceptor — translate HTTP errors into ApiError
apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0
      const message =
        (error.response?.data as { message?: string })?.message ??
        error.message ??
        'Unknown error'
      throw new ApiError(message, status)
    }
    throw error
  }
)

export type { AxiosProgressEvent }
