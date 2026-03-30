export interface HttpResponse<T> {
  readonly status: number
  readonly data: T
}

export async function httpPost<TReq, TRes>(
  url: string,
  body: TReq,
  timeoutMs: number = 30_000
): Promise<HttpResponse<TRes>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const data = await response.json() as TRes
    return { status: response.status, data }
  } finally {
    clearTimeout(timer)
  }
}
