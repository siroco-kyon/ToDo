import { useEffect } from 'react'
import { useCurrentUser } from '../auth/UserContext'
import { useDesktopTask } from './useDesktopTask'
import { serverClockOffset } from '@renderer/lib/serverClock'

/** The main window supplies the tray state even while hidden. */
export function DesktopCompanion(): null {
  const { user } = useCurrentUser()
  const { todos, running, connected, now } = useDesktopTask()
  const taskTitle = todos.find((todo) => todo.id === running?.todo_id)?.title ?? ''
  useEffect(() => {
    void window.desktop?.publishState({
      userId: user.id,
      taskId: running?.todo_id ?? null,
      taskTitle,
      startTime: running?.start_time ?? null,
      online: connected,
      clockOffsetMs: serverClockOffset()
    })
  }, [user.id, running?.todo_id, running?.start_time, taskTitle, connected, now])
  return null
}
