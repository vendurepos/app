import { createContext, useContext, useState, type JSX, type ReactNode } from 'react';
import { clearSession, loadSession, saveSession, type Session } from './session';

const SessionContext = createContext<{
  session: Session | null;
  setSignedIn(session: Session): void;
  signOut(): void;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState(loadSession);
  function setSignedIn(nextSession: Session) {
    saveSession(nextSession);
    setSession(nextSession);
  }
  function signOut() {
    clearSession();
    setSession(null);
  }
  return (
    <SessionContext.Provider value={{ session, setSignedIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider');
  return context;
}
