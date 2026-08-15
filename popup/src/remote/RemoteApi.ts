// HTTP client of the tab cloud backend. Every response uses the
// {code, data, message} envelope; refer to backend/tab_cloud_api.md.
// Network problems (backend down, aws down) are returned as a failure
// envelope instead of throwing, so callers stay simple and the popup
// stays usable while the backend is unreachable.

export interface RemoteResult<T = Record<string, unknown>> {
  code: number
  data?: T
  message?: string
}

export const remoteCodeNetwork = -100
export const remoteRequestTimeoutMs = 8000

export async function remoteCall<T = Record<string, unknown>>(
  endpointUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown> = {}
): Promise<RemoteResult<T>> {
  const urlBase = endpointUrl.replace(/\/+$/, '')
  if (!urlBase) {
    return { code: remoteCodeNetwork, message: 'Backend endpoint URL is not set' }
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), remoteRequestTimeoutMs)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetch(`${urlBase}${path}`, {
      method: path === '/api/status' ? 'GET' : 'POST',
      headers,
      body: path === '/api/status' ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const result = await response.json() as RemoteResult<T>
    if (typeof result?.code !== 'number') {
      return { code: remoteCodeNetwork, message: 'Malformed backend response' }
    }
    return result
  } catch (error) {
    const messageText = error instanceof Error && error.name === 'AbortError'
      ? 'Backend request timed out'
      : `Backend unreachable: ${error instanceof Error ? error.message : String(error)}`
    return { code: remoteCodeNetwork, message: messageText }
  } finally {
    clearTimeout(timeoutId)
  }
}
