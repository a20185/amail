import { z } from "zod";

/** `user@device` — 两段非空、禁空格与多余 @ */
export const AddressSchema = z
  .string()
  .regex(/^[^\s@]+@[^\s@]+$/, "address must be user@device (no spaces, single @)");

export type Address = z.infer<typeof AddressSchema>;

export interface ParsedAddress {
  user: string;
  device: string;
}

export function parseAddress(address: string): ParsedAddress {
  const value = AddressSchema.parse(address);
  const [user, device] = value.split("@");
  return { user, device };
}

export function formatAddress(parsed: ParsedAddress): string {
  return AddressSchema.parse(`${parsed.user}@${parsed.device}`);
}
