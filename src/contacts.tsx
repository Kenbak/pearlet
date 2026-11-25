import { createAsyncStorage } from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

import { markRecent, maxRecentContacts, parseContacts, removeContact, upsertContact, type Contact } from './contacts-core';
import type { PearlNetwork } from './pearl-network';

const storage = createAsyncStorage('lustreSettings');
const key = (network: PearlNetwork) => 'contacts.v1.' + network;
const recentKey = (network: PearlNetwork) => 'contacts.recent.v1.' + network;

/** Saved contacts for one network, stored on this device only. */
export function useContacts(network: PearlNetwork) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void storage.getItem(key(network)).then((raw) => {
      if (alive) setContacts(parseContacts(raw, network));
    }).catch(() => {});
    void storage.getItem(recentKey(network)).then((raw) => {
      const value: unknown = raw ? JSON.parse(raw) : [];
      if (alive && Array.isArray(value)) {
        setRecent(value.filter((item): item is string => typeof item === 'string').slice(0, maxRecentContacts));
      }
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [network]);

  const persist = useCallback((next: Contact[]) => {
    setContacts(next);
    void storage.setItem(key(network), JSON.stringify(next)).catch(() => {});
  }, [network]);

  const save = useCallback((name: string, address: string) => {
    persist(upsertContact(contacts, name, address, network));
  }, [contacts, network, persist]);

  const remove = useCallback((address: string) => {
    persist(removeContact(contacts, address));
  }, [contacts, persist]);

  const markUsed = useCallback((address: string) => {
    setRecent((current) => {
      const next = markRecent(current, address);
      void storage.setItem(recentKey(network), JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [network]);

  return { contacts, recent, save, remove, markUsed };
}

export type { Contact };
