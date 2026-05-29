import React, { createContext, useContext } from 'react'
import type { CurrentUser } from './session'

interface UserContextValue {
  user: CurrentUser
  logout: () => Promise<void>
}

const UserContext = createContext<UserContextValue | null>(null)

export function UserProvider({
  user,
  logout,
  children
}: {
  user: CurrentUser
  logout: () => Promise<void>
  children: React.ReactNode
}): React.JSX.Element {
  return <UserContext.Provider value={{ user, logout }}>{children}</UserContext.Provider>
}

/** Access the authenticated user. Only valid inside the authenticated app tree. */
export function useCurrentUser(): UserContextValue {
  const ctx = useContext(UserContext)
  if (!ctx) throw new Error('useCurrentUser must be used within UserProvider')
  return ctx
}
