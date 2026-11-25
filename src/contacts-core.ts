import { validatePearlAddress } from './pearl-keys.ts';
import type { PearlNetwork } from './pearl-network.ts';

export type Contact = { name: string; address: string };

export const maxContactName = 40;
export const maxContacts = 200;

/** Add or rename a contact; the address is the identity. Throws user-facing errors. */
export function upsertContact(contacts: readonly Contact[], name: string, address: string, network: PearlNetwork): Contact[] {
  const cleanName = name.trim().replace(/\s+/g, ' ');
  if (!cleanName) throw new Error('Enter a name for this contact.');
  if (cleanName.length > maxContactName) throw new Error('Use a contact name of ' + maxContactName + ' characters or fewer.');
  const valid = validatePearlAddress(address.trim().toLowerCase(), network);
  if (!valid) throw new Error('This is not a valid address for this network.');
  const rest = contacts.filter((contact) => contact.address !== valid);
  if (rest.length >= maxContacts) throw new Error('Your address book is full.');
  return [...rest, { name: cleanName, address: valid }].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeContact(contacts: readonly Contact[], address: string): Contact[] {
  return contacts.filter((contact) => contact.address !== address);
}

/** Read stored contacts, keeping only valid entries for this network. */
export function parseContacts(raw: string | null, network: PearlNetwork): Contact[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    let contacts: Contact[] = [];
    for (const entry of value) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.address !== 'string') continue;
      try {
        contacts = upsertContact(contacts, entry.name, entry.address, network);
      } catch {
        // Skip entries that are invalid or from another network.
      }
    }
    return contacts;
  } catch {
    return [];
  }
}

export function contactFor(contacts: readonly Contact[], address: string): Contact | undefined {
  return contacts.find((contact) => contact.address === address);
}

export const maxRecentContacts = 8;

/** Move an address to the front of the recent list. */
export function markRecent(recent: readonly string[], address: string): string[] {
  return [address, ...recent.filter((item) => item !== address)].slice(0, maxRecentContacts);
}

/** Up to `limit` contacts for quick picks: recent first, then alphabetical. */
export function quickContacts(contacts: readonly Contact[], recent: readonly string[], limit: number): Contact[] {
  const byAddress = new Map(contacts.map((contact) => [contact.address, contact]));
  const picks = recent.map((address) => byAddress.get(address)).filter((contact): contact is Contact => Boolean(contact));
  for (const contact of contacts) {
    if (picks.length >= limit) break;
    if (!picks.includes(contact)) picks.push(contact);
  }
  return picks.slice(0, limit);
}

/** Contacts whose name or address contains the query, case-insensitively. */
export function searchContacts(contacts: readonly Contact[], query: string): Contact[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...contacts];
  return contacts.filter((contact) => contact.name.toLowerCase().includes(needle) || contact.address.includes(needle));
}
