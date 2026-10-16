// Emoji and symbols for the Super+V / Super+. panel (components/ClipboardFlyout.tsx): a compact everyday set with
// English search words (the panel also matches the emoji itself), grouped like the Windows emoji panel. The on-screen
// keyboard's emoji page (services/session/osk) is a subset of the first groups.
export interface EmojiGroup { id: 'smileys' | 'people' | 'nature' | 'food' | 'activities' | 'travel' | 'objects' | 'symbols'; items: [string, string][] }

const g = (id: EmojiGroup['id'], s: string): EmojiGroup => ({ id, items: s.trim().split('\n').map((l) => { const [e, ...w] = l.trim().split(' '); return [e, w.join(' ')] as [string, string] }) })

export const EMOJI: EmojiGroup[] = [
  g('smileys', `
😀 grinning smile happy
😃 smile happy
😄 smile laugh
😁 grin
😆 laugh
😅 sweat smile relief
😂 joy tears laugh
🤣 rolling laugh
😊 blush smile
😇 innocent halo
🙂 slight smile
🙃 upside down
😉 wink
😍 heart eyes love
🥰 love hearts
😘 kiss
😋 yum tasty
😎 cool sunglasses
🤓 nerd
🤔 thinking
🤨 raised eyebrow
😐 neutral
😑 expressionless
😶 no mouth silent
🙄 eye roll
😏 smirk
😬 grimace
😌 relieved
😔 pensive
😴 sleeping
😷 mask sick
🤒 thermometer ill
🤯 mind blown
🥳 party
😕 confused
😟 worried
😮 open mouth surprised
😲 astonished
😳 flushed
🥺 pleading
😢 cry sad
😭 sob
😱 scream
😤 triumph huff
😡 angry
🤬 swearing
👍 thumbs up yes ok like
👎 thumbs down no`),
  g('people', `
👋 wave hello bye
🤚 raised back hand
✋ hand stop
👌 ok
✌️ victory peace
🤞 fingers crossed luck
👉 point right
👈 point left
👆 point up
👇 point down
👏 clap applause
🙌 raised hands celebrate
🙏 pray thanks please
🤝 handshake deal
💪 muscle strong
👀 eyes look
🧠 brain
👤 person
👥 people
🧑‍💻 technologist computer
👩‍🏫 teacher
🧑‍⚕️ health worker`),
  g('nature', `
🐶 dog
🐱 cat
🐘 elephant
🦚 peacock
🐢 turtle
🐟 fish
🦋 butterfly
🌸 blossom flower
🌺 hibiscus flower
🌻 sunflower
🌴 palm tree
🌳 tree
🍃 leaf
🌞 sun
🌙 moon night
⭐ star
🌈 rainbow
☔ umbrella rain
⚡ lightning
❄️ snow cold
🔥 fire hot
🌊 wave sea`),
  g('food', `
☕ coffee tea
🍵 tea
🥥 coconut
🍌 banana
🥭 mango
🍍 pineapple
🍎 apple
🍚 rice
🍛 curry rice
🍜 noodles
🍞 bread
🍰 cake
🎂 birthday cake
🍪 cookie
🍫 chocolate
🍕 pizza
🥗 salad
🍽️ meal plate`),
  g('activities', `
🎉 party tada celebrate
🎊 confetti
🎁 gift present
🎈 balloon
🏏 cricket
⚽ football soccer
🏸 badminton
🏆 trophy win
🥇 gold medal first
🎯 target goal
🎮 game
🎵 music note
🎧 headphones
📚 books study
✏️ pencil
🎨 art palette`),
  g('travel', `
🏠 house home
🏢 office building
🏫 school
🏥 hospital
🚗 car
🚌 bus
🛺 tuk tuk auto rickshaw
🚆 train
✈️ plane flight
🚲 bicycle
⛽ fuel
🗺️ map
📍 pin location
🌍 world globe`),
  g('objects', `
💻 laptop computer
🖥️ desktop computer
⌨️ keyboard
🖱️ mouse
📱 phone mobile
📞 telephone call
📧 email mail
✉️ envelope
📎 paperclip attach
📌 pushpin
📅 calendar date
⏰ alarm clock
⌛ hourglass time
💡 idea bulb
🔒 lock locked
🔑 key
🔍 search magnifier
📝 memo note
📄 document page
📁 folder
📊 chart bar
📈 chart up growth
💰 money
🖨️ printer
🔋 battery
🔌 plug`),
  g('symbols', `
❤️ heart love red
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
✅ check done yes
☑️ ballot check
✔️ check mark
❌ cross no wrong
⚠️ warning
❗ exclamation
❓ question
💯 hundred
🆗 ok button
🆕 new
➡️ right arrow
⬅️ left arrow
⬆️ up arrow
⬇️ down arrow
🔁 repeat
🔔 bell
🚫 prohibited
♻️ recycle`),
]

/** Symbols tab: punctuation, currency (with the Sri Lankan rupee in Sinhala and the Tamil rupee sign), maths, arrows. */
export const SYMBOLS: { id: 'punctuation' | 'currency' | 'math' | 'arrows'; items: string[] }[] = [
  { id: 'punctuation', items: ['…', '—', '–', '•', '·', '«', '»', '“', '”', '‘', '’', '„', '§', '¶', '†', '‡', '©', '®', '™', '°', '№', '‰'] },
  { id: 'currency', items: ['රු', '௹', '₹', '$', '€', '£', '¥', '¢', '₩', '₽', '₺', '฿', '₫', '₱'] },
  { id: 'math', items: ['±', '×', '÷', '≈', '≠', '≤', '≥', '∞', '√', '∑', 'π', 'µ', 'Δ', 'Ω', '½', '⅓', '¼', '¾', '²', '³', '‰', '∠'] },
  { id: 'arrows', items: ['→', '←', '↑', '↓', '↔', '↕', '⇒', '⇐', '⇔', '↩', '↪', '➜', '✓', '✗', '★', '☆', '♥', '♦', '♣', '♠'] },
]

/** Emoji whose search words (or the emoji itself) contain every word of the query. */
export function searchEmoji(q: string): [string, string][] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const all = EMOJI.flatMap((x) => x.items)
  if (!words.length) return all
  return all.filter(([e, w]) => words.every((x) => w.includes(x) || e === x))
}
