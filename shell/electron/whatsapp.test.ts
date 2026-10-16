import { describe, expect, it } from 'vitest'
import {
  chromeUserAgent, downloadPath, mediaKind, unreadFromTitle, whatsappAllowed, whatsappHost, whatsappNav, whatsappPermission, whatsappPopup,
  WHATSAPP_APP_ID, WHATSAPP_PARTITION, WHATSAPP_URL,
} from './whatsapp'
import { parseAppArgs } from './webapps'

describe('WhatsApp navigation allow-list', () => {
  it('keeps WhatsApp/Meta hosts in the window', () => {
    for (const u of [WHATSAPP_URL, 'https://web.whatsapp.com/?lang=si', 'https://static.whatsapp.net/rsrc.php/x.js', 'https://mmg.whatsapp.net/v/t62/a.enc',
      'https://pps.whatsapp.net/v/t61/p.jpg', 'https://media-sin6-1.cdn.whatsapp.net/x', 'https://www.whatsapp.com/', 'https://whatsapp.com/']) expect(whatsappNav(u)).toBe('allow')
  })
  it('sends other links to the default browser and blocks the rest', () => {
    expect(whatsappNav('https://example.com/a')).toBe('external')
    expect(whatsappNav('https://evilwhatsapp.com/')).toBe('external')
    expect(whatsappNav('https://whatsapp.com.evil.io/')).toBe('external')
    expect(whatsappNav('mailto:a@b.lk')).toBe('external')
    expect(whatsappNav('http://web.whatsapp.com/')).toBe('deny')
    expect(whatsappNav('https://user:pw@web.whatsapp.com/')).toBe('deny')
    expect(whatsappNav('file:///etc/passwd')).toBe('deny')
    expect(whatsappNav('javascript:alert(1)')).toBe('deny')
    expect(whatsappNav('worksuite://mail/x')).toBe('deny')
    expect(whatsappHost('https://web.whatsapp.com:8443/')).toBe(false)
  })
  it('never opens a second app window from a link', () => {
    expect(whatsappPopup('https://web.whatsapp.com/')).toBe('external')
    expect(whatsappPopup('https://example.com/')).toBe('external')
    expect(whatsappPopup('file:///x')).toBe('deny')
  })
})

describe('WhatsApp session and identity', () => {
  it('has its own persistent partition, apart from every WorkSuite account partition', () => {
    expect(WHATSAPP_PARTITION).toBe('persist:whatsapp')
    expect(WHATSAPP_PARTITION.startsWith('persist:account-')).toBe(false)
    expect(WHATSAPP_APP_ID).toBe('lk.worksuite.whatsapp')
  })
  it('is started as worksuite-app whatsapp', () => {
    expect(parseAppArgs(['e', '/app', '--worksuite-app=whatsapp'])).toEqual({ id: 'whatsapp', link: null })
  })
  it('uses a desktop Chrome user agent without Electron in it', () => {
    const ua = chromeUserAgent('140.0.7339.249')
    expect(ua).toContain('Chrome/140.0.0.0')
    expect(ua).toContain('X11; Linux x86_64')
    expect(ua).not.toMatch(/Electron|worksuite/i)
  })
})

describe('WhatsApp permissions', () => {
  it('allows notifications, asks for camera/microphone and denies everything else', () => {
    expect(whatsappPermission('notifications', 'https://web.whatsapp.com/')).toBe('allow')
    expect(whatsappPermission('media', 'https://web.whatsapp.com/')).toBe('ask')
    for (const p of ['geolocation', 'display-capture', 'clipboard-read', 'midi', 'hid', 'usb', 'openExternal']) expect(whatsappPermission(p, 'https://web.whatsapp.com/')).toBe('deny')
    expect(whatsappPermission('notifications', 'https://example.com/')).toBe('deny')
  })
  it('says which device a media request is for', () => {
    expect(mediaKind(['audio'])).toBe('microphone')
    expect(mediaKind(['video'])).toBe('camera')
    expect(mediaKind(['audio', 'video'])).toBe('both')
    expect(mediaKind(undefined)).toBe('both')
  })
})

describe('WhatsApp unread badge', () => {
  it('reads the count from the page title', () => {
    expect(unreadFromTitle('(3) WhatsApp')).toBe(3)
    expect(unreadFromTitle('(120) WhatsApp')).toBe(120)
    expect(unreadFromTitle('WhatsApp')).toBe(0)
    expect(unreadFromTitle('(3) Something else')).toBe(0)
    expect(unreadFromTitle('')).toBe(0)
    expect(unreadFromTitle(undefined)).toBe(0)
  })
})

describe('WhatsApp policy and downloads', () => {
  it('is on unless policy turns it off or the device is a kiosk', () => {
    expect(whatsappAllowed(null)).toBe(true)
    expect(whatsappAllowed({ whatsapp: null })).toBe(true)
    expect(whatsappAllowed({ whatsapp: true })).toBe(true)
    expect(whatsappAllowed({ whatsapp: false })).toBe(false)
    expect(whatsappAllowed({ whatsapp: true, kiosk: true })).toBe(false)
  })
  it('saves to Downloads without overwriting or escaping the folder', () => {
    const taken = new Set(['/h/Downloads/photo.jpg', '/h/Downloads/photo (1).jpg'])
    expect(downloadPath('/h/Downloads', 'photo.jpg', (p) => taken.has(p))).toBe('/h/Downloads/photo (2).jpg')
    expect(downloadPath('/h/Downloads/', '../../etc/passwd', () => false)).toBe('/h/Downloads/passwd')
    expect(downloadPath('/h/Downloads', '.bashrc', () => false)).toBe('/h/Downloads/bashrc')
    expect(downloadPath('/h/Downloads', '', () => false)).toBe('/h/Downloads/download')
  })
})
