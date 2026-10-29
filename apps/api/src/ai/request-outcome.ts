/** Explain stored provider failures without exposing arbitrary upstream response content. */
export function unknownRequestReason(error?: string | null): string {
  const message = error ?? '';
  const timeout = /timed out after (\d+)ms/iu.exec(message);
  if (timeout) return `模型请求超时（${Number(timeout[1]) / 1000} 秒），结果未知`;
  if (/timeout|timed out/iu.test(message)) return '模型请求超时，结果未知';
  if (/busy|overload/iu.test(message)) return '模型服务繁忙，未取得完整结果';
  if (/unavailable/iu.test(message)) return '模型上游服务暂时不可用，未取得完整结果';
  if (/stream|terminated|socket|connection/iu.test(message)) return '模型响应连接中断，未取得完整结果';
  if (/openai_error/iu.test(message)) return '模型上游服务返回错误，未取得完整结果';
  return '模型请求结果未能确认，未自动重发；可手动重试';
}
