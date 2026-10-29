// Only explicit shop-level business responses justify disabling automatic fetches.
// HTTP errors, timeouts and malformed payloads remain retryable by the scheduler.
export function isUnavailableShopError(error: string): boolean {
  return /^(?:liandong|16688) goods API: (?:店铺链接不存在|(?:该)?(?:商家|店铺)(?:已被关闭交易|已被封禁|已注销|不存在(?:或已关闭)?))(?:[，,。.!！]|$)/u.test(error);
}
