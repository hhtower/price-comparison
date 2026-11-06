import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';

function encryptionKey(): Buffer {
  const value = process.env.MCP_KEY_ENCRYPTION_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/u.test(value)) {
    throw new ServiceUnavailableException('请先配置 MCP_KEY_ENCRYPTION_KEY，以便安全保存和查看接入密钥');
  }
  return Buffer.from(value, 'hex');
}

export function encryptMcpKey(value: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // Bind the recoverable secret to the separate hash used for authentication.
  cipher.setAAD(createHash('sha256').update(value).digest());
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptMcpKey(value: string, hash: string): string {
  const key = encryptionKey();
  try {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== '1' || !parts.slice(1).every(part => /^[A-Za-z0-9_-]+$/u.test(part))) throw new Error();
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(hash, 'hex'));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
    if (!/^mcp_[A-Za-z0-9_-]{43}$/u.test(decrypted) || createHash('sha256').update(decrypted).digest('hex') !== hash) throw new Error();
    return decrypted;
  } catch {
    throw new ServiceUnavailableException('无法解密接入密钥，请检查密钥加密配置或重新发放');
  }
}
