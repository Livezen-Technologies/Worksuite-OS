// Strings for WhatsApp (WhatsApp Web in its own window, electron/whatsappwindow.ts) and its taskbar badge and policy.
// "WhatsApp" stays as is in every language. Sinhala and Tamil are machine drafts like the rest of their catalogs
// (docs/i18n/README.md). Spread into en.ts, si.ts and ta.ts.
export const whatsappEn = {
  'whatsapp.unread': '{count} unread chats',
  'whatsapp.offTitle': 'WhatsApp is turned off',
  'whatsapp.offBody': 'Your organization has turned off WhatsApp on this device.',
  'whatsapp.media.camera': 'WhatsApp wants to use your camera',
  'whatsapp.media.microphone': 'WhatsApp wants to use your microphone',
  'whatsapp.media.both': 'WhatsApp wants to use your camera and microphone',
  'whatsapp.media.detail': 'Only for calls and voice or video messages. You are asked again the next time WhatsApp starts.',
  'whatsapp.media.allow': 'Allow',
  'whatsapp.media.deny': 'Don\'t allow',
  'panel.unread': '{name}, {count} unread',
  'mdm.whatsappOff': 'WhatsApp is turned off',
}

type Key = keyof typeof whatsappEn

export const whatsappSi: Record<Key, string> = {
  'whatsapp.unread': 'නොකියවූ කතාබස් {count}',
  'whatsapp.offTitle': 'WhatsApp අක්‍රිය කර ඇත',
  'whatsapp.offBody': 'ඔබේ ආයතනය මෙම උපාංගයේ WhatsApp අක්‍රිය කර ඇත.',
  'whatsapp.media.camera': 'WhatsApp ඔබේ කැමරාව භාවිත කිරීමට අවසර ඉල්ලයි',
  'whatsapp.media.microphone': 'WhatsApp ඔබේ මයික්‍රෆෝනය භාවිත කිරීමට අවසර ඉල්ලයි',
  'whatsapp.media.both': 'WhatsApp ඔබේ කැමරාව සහ මයික්‍රෆෝනය භාවිත කිරීමට අවසර ඉල්ලයි',
  'whatsapp.media.detail': 'ඇමතුම් සහ හඬ හෝ වීඩියෝ පණිවිඩ සඳහා පමණි. WhatsApp ඊළඟ වතාවේ ආරම්භ වන විට නැවත අසනු ලැබේ.',
  'whatsapp.media.allow': 'ඉඩ දෙන්න',
  'whatsapp.media.deny': 'ඉඩ නොදෙන්න',
  'panel.unread': '{name}, නොකියවූ {count}',
  'mdm.whatsappOff': 'WhatsApp අක්‍රිය කර ඇත',
}

export const whatsappTa: Record<Key, string> = {
  'whatsapp.unread': '{count} படிக்காத உரையாடல்கள்',
  'whatsapp.offTitle': 'WhatsApp முடக்கப்பட்டுள்ளது',
  'whatsapp.offBody': 'உங்கள் நிறுவனம் இந்தச் சாதனத்தில் WhatsApp-ஐ முடக்கியுள்ளது.',
  'whatsapp.media.camera': 'WhatsApp உங்கள் கேமராவைப் பயன்படுத்த விரும்புகிறது',
  'whatsapp.media.microphone': 'WhatsApp உங்கள் மைக்ரோஃபோனைப் பயன்படுத்த விரும்புகிறது',
  'whatsapp.media.both': 'WhatsApp உங்கள் கேமரா மற்றும் மைக்ரோஃபோனைப் பயன்படுத்த விரும்புகிறது',
  'whatsapp.media.detail': 'அழைப்புகள் மற்றும் குரல் அல்லது வீடியோ செய்திகளுக்கு மட்டும். அடுத்த முறை WhatsApp தொடங்கும்போது மீண்டும் கேட்கப்படும்.',
  'whatsapp.media.allow': 'அனுமதி',
  'whatsapp.media.deny': 'அனுமதிக்க வேண்டாம்',
  'panel.unread': '{name}, {count} படிக்காதவை',
  'mdm.whatsappOff': 'WhatsApp முடக்கப்பட்டுள்ளது',
}
