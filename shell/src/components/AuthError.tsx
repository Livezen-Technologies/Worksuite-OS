// Sign-in / unlock feedback line shared by the greeter and the lock screen (#25): an error carries an icon and a
// tinted panel as well as colour, and is announced; the hint in its place is plain text. The message never names
// which part was wrong beyond what the form asked for (no account existence, no PAM detail).
import { Icon, P } from './Ws'

export default function AuthError({ id, error, hint }: { id: string; error: string | null; hint: string }) {
  return (
    <div id={id} role={error ? 'alert' : undefined} aria-live={error ? 'assertive' : 'polite'}
      className={`flex min-h-[36px] w-[340px] max-w-full items-center justify-center gap-2 rounded-[10px] px-3 py-2 text-center text-[13px] ${error ? 'border border-[#FF8A7A]/60 bg-[rgba(120,24,16,0.55)] font-medium text-[#FFE1DC]' : 'text-white/70'}`}>
      {error && <Icon d={P.alert} size={16} stroke="#FFB4A8" />}
      <span>{error ?? hint}</span>
    </div>
  )
}
