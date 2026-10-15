import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }
const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
})

export const AIconPlus = ({ size, ...p }: P) => <svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>
export const AIconEye = ({ size, ...p }: P) => <svg {...base(size)} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
export const AIconEyeOff = ({ size, ...p }: P) => <svg {...base(size)} {...p}><path d="M2 2l20 20" /><path d="M6.7 6.7C3.8 8.5 2 12 2 12s3.5 7 10 7c2 0 3.8-.7 5.3-1.7" /><path d="M10 5.2c.6-.1 1.3-.2 2-.2 6.5 0 10 7 10 7s-.8 1.6-2.3 3.3" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
export const AIconNoWifi = ({ size, ...p }: P) => <svg {...base(size)} {...p}><path d="M2 2l20 20" /><path d="M8.5 16.4a5 5 0 0 1 7 0" /><path d="M5 12.9a10 10 0 0 1 5.2-2.8" /><circle cx="12" cy="20" r="1" /></svg>
export const AIconWifi = ({ size, ...p }: P) => <svg {...base(size)} {...p}><path d="M5 12.5a10 10 0 0 1 14 0" /><path d="M8.5 16a5 5 0 0 1 7 0" /><path d="M2 9a15 15 0 0 1 20 0" /><circle cx="12" cy="20" r="1" /></svg>
export const AIconLock = ({ size, ...p }: P) => <svg {...base(size)} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
export const AIconArrowRight = ({ size, ...p }: P) => <svg {...base(size)} strokeWidth={2.5} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
export const AIconCheck = ({ size, ...p }: P) => <svg {...base(size)} {...p}><path d="M20 6L9 17l-5-5" /></svg>
export const AIconAlert = ({ size, ...p }: P) => <svg {...base(size)} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
