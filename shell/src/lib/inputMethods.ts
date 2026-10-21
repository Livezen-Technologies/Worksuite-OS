// fcitx5 input-method names → their message keys, shared by Settings › Keyboard and the taskbar switcher (#58).
import type { MessageKey } from '../i18n'

export const IM_KEYS: Record<string, MessageKey> = {
  'keyboard-us': 'per.im.us', m17n_si_wijesekera: 'per.im.siWijesekara', m17n_si_singlish: 'per.im.siPhonetic',
  m17n_ta_tamil99: 'per.im.taTamil99', m17n_ta_phonetic: 'per.im.taPhonetic',
}

/** The taskbar indicator's few letters for a method: its language, like Windows' ENG / සිං / தமி. */
export function imShortKey(id: string | null): MessageKey {
  if (id?.startsWith('m17n_si_')) return 'im.short.si'
  if (id?.startsWith('m17n_ta_')) return 'im.short.ta'
  return 'im.short.en'
}
