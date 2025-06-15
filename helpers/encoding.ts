import { fromString } from "uint8arrays";

export function toBytes(signature: string | Uint8Array): Uint8Array {
  if (typeof signature === 'string') {
    // Remove '0x' prefix if present
    const hex = signature.startsWith('0x') ? signature.slice(2) : signature;
    return fromString(hex, 'hex');
  }
  // If it's already a Uint8Array, return it
  if (signature instanceof Uint8Array) {
    return signature;
  }
  throw new Error('Invalid signature format');
}
