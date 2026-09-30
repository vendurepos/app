import { Platform } from 'react-native';

// PROTOTYPE (#70, not for merge): ?layout=A|B|C&taxrows=A|B|C picks a narrow layout and a per-rate tax row style.
// Read once at load, web only; anything else is A, today's behaviour.
type Option = 'A' | 'B' | 'C';
const params = Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : undefined;
const pick = (name: string): Option => {
  const value = params?.get(name)?.toUpperCase();
  return value === 'B' || value === 'C' ? value : 'A';
};
export const PROTO_LAYOUT = pick('layout');
export const PROTO_TAXROWS = pick('taxrows');
