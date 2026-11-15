// The shell's own desktop entries (shell/apps/*.desktop, installed to /usr/share/applications): its WorkSuite web
// app windows and helpers. Only these are hidden from the installed-app list; every other worksuite-* entry is a real
// app (WorkSuite POS, Desk, FrameFlow …) and is listed with its own name and icon. Shared by the main process
// (ws:installedApps) and the launcher (src/lib/launcher.ts). A test checks it against shell/apps.
export const SHELL_ENTRIES: ReadonlySet<string> = new Set([
  'worksuite-mail', 'worksuite-calendar', 'worksuite-chat', 'worksuite-drive', 'worksuite-tasks', 'worksuite-projects',
  'worksuite-crm', 'worksuite-meet', 'worksuite-pdf-studio', 'worksuite-hr',
  'worksuite-files', 'worksuite-snipping-tool', 'worksuite-url-handler', 'worksuite-windows-app',
])
