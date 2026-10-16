// Bridge of the kiosk exit prompt (electron/kioskExitPreload.ts). Absent outside the kiosk session.
export type KioskExitResult = 'ok' | 'wrong_pin' | 'locked_out' | 'pin_disabled' | 'cancelled' | 'failed'
export interface KioskApi {
  info(): Promise<{ exitPin: boolean }>
  exitWithPin(pin: string): Promise<KioskExitResult>
  exitAsAdmin(): Promise<KioskExitResult>
  cancel(): Promise<void>
}
export function kioskApi(): KioskApi | null {
  return (globalThis as { worksuiteKiosk?: KioskApi }).worksuiteKiosk ?? null
}
