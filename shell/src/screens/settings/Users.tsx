// Settings › Users (from Settings.tsx).
import { os, type LocalUser } from '../../lib/os'
import { SignInOptions } from './SignIn'
import { Svg, card, chip, rowLine } from '../../components/Dk'
import { AVATAR_GRADIENTS, Avatar } from '../../components/Ws'
import { t } from '../../i18n'
import { SyncProblemsSection } from '../PeripheralSettings'
import { useAvail, H1, Unavail, Note } from './common'
import { LockAfterRow } from './Privacy'
import { CloudAccounts } from './Accounts'

export function UsersPanel() {
  const { r } = useAvail(os.sysUsers)
  const me = r.state === 'ok' ? r.value.users.find((u) => u.login === r.value.current) ?? null : null
  const others = r.state === 'ok' ? r.value.users.filter((u) => u.login !== r.value.current) : []
  return <>
    <H1>{t('settings.nav.Users')}</H1>
    {r.state === 'unavailable' && <Unavail what={t('settings.users.list')} />}
    {r.state === 'ok' && (
      <div className="flex items-center gap-[22px] rounded-[18px] border border-[rgba(127,178,255,0.18)] px-6 py-[22px]" style={{ background: 'radial-gradient(circle at 90% 10%, rgba(24,212,240,0.25), transparent 45%), var(--ws-g-card)' }}>
        <Avatar name={me?.name ?? r.value.current} size={96} font={34} />
        <span className="flex flex-1 flex-col gap-1.5">
          <span className="text-[22px] font-bold">{me?.name ?? r.value.current}</span>
          <span className="font-mono text-xs text-[#8FA3C8]">{r.value.current}</span>
          <span className="mt-0.5 flex gap-1.5">
            {me && <span className="rounded-full px-2 py-[3px] text-[11px] font-semibold bg-[rgba(31,107,255,0.22)] text-[#B8D4FF]">{me.admin ? t('settings.users.admin') : t('settings.users.standard')}</span>}
            <span className="rounded-full px-2 py-[3px] text-[11px] font-semibold bg-[rgba(95,211,154,0.18)] text-[#5FD39A]">{t('settings.signedIn')}</span>
          </span>
        </span>
      </div>
    )}
    <div className="grid grid-cols-2 items-start gap-3">
      <section aria-labelledby="signin" className="flex flex-col gap-2">
        <h2 id="signin" className="m-0 text-sm font-semibold">{t('settings.users.signin')}</h2>
        <div className={`${card} overflow-hidden`}>
          <div className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
            <Svg d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z" size={18} stroke="#7FB2FF" />
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('greeter.password')}</span><span className="text-[11px] text-[#8FA3C8]">{t('settings.users.method')}</span></span>
          </div>
          <div className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
            <Svg d="M13 3h6v18h-6M10 8l4 4-4 4M14 12H3" size={18} stroke="#7FB2FF" />
            <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{t('settings.users.auto')}</span><span className="text-[11px] text-[#8FA3C8]">{t('settings.users.autoHint')}</span></span>
            <span className={chip}>{t('settings.users.notAllowed')}</span>
          </div>
          <LockAfterRow />
        </div>
      </section>
      <SyncProblemsSection />
      <section aria-labelledby="other-users" className="flex flex-col gap-2">
        <h2 id="other-users" className="m-0 text-sm font-semibold">{t('settings.users.othersHere')}</h2>
        {r.state === 'ok' && !others.length && <div className={`${card} px-4 py-3 text-[13px] text-[#8FA3C8]`}>{t('settings.users.noOthers')}</div>}
        {others.length > 0 && <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {others.map((u: LocalUser, i) => (
            <li key={u.login} className={`flex items-center gap-3 px-4 py-3 ${rowLine}`}>
              <Avatar name={u.name} size={38} font={13} bg={AVATAR_GRADIENTS[(i + 1) % AVATAR_GRADIENTS.length]} />
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-[13px] font-medium">{u.name}</span><span className="text-[11px] text-[#8FA3C8]">{u.login}</span></span>
              <span className="rounded-[5px] bg-[rgba(127,178,255,0.12)] px-[7px] py-0.5 text-[11px] text-[#C9D6EE]">{u.admin ? t('settings.users.adminShort') : t('settings.users.standardShort')}</span>
            </li>
          ))}
        </ul>}
      </section>
    </div>
    <SignInOptions />
    <section aria-labelledby="ws-acct" className="flex flex-col gap-2">
      <h2 id="ws-acct" className="m-0 text-sm font-semibold">{t('settings.acct.title')}</h2>
      <div className={`${card} overflow-hidden`}><CloudAccounts /></div>
    </section>
    <Note>{t('settings.users.note')}</Note>
  </>
}
