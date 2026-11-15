// The shell's one button system. Every button style (Settings, first run, recovery, flyouts, the greeter) comes from
// buttonClass(), so sizes, corner radii, focus rings and disabled states are the same everywhere. The colours are the
// shell's fixed palette classes on purpose: theme-light.css is generated from those literal class names
// (scripts/gen-light-theme.mjs), so light theme and high contrast keep working without per-screen overrides.
import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'glass' | 'subtle' | 'link'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'icon' | 'icon-sm'

/** Keyboard focus: visible only for keyboard users, the same light-blue outline on every control. */
export const focusRing = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FB2FF]'

const BASE = 'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap disabled:cursor-default disabled:opacity-50'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-[#1F6BFF] font-semibold text-white hover:bg-[#3A7DFF] disabled:hover:bg-[#1F6BFF]',
  secondary: 'border border-[rgba(127,178,255,0.25)] font-medium text-[#E8EEFA] hover:bg-white/[0.06] disabled:hover:bg-transparent',
  danger: 'bg-[#D9452B] font-semibold text-white hover:bg-[#E5563C]',
  glass: 'border border-white/10 bg-[rgba(8,20,48,0.5)] text-white hover:bg-[rgba(8,20,48,0.75)]',
  subtle: 'bg-white/[0.07] text-[#E8EEFA] hover:bg-white/10',
  link: 'text-[#7FB2FF] underline-offset-2 hover:text-[#B8D4FF] hover:underline',
}

/** One scale: each size fixes radius, padding and type size together. */
const SIZE: Record<ButtonSize, string> = {
  xs: 'rounded-lg px-2.5 py-1 text-xs',
  sm: 'rounded-[9px] px-3.5 py-[7px] text-[13px]',
  md: 'rounded-[10px] px-5 py-[10px] text-sm',
  lg: 'rounded-[10px] px-7 py-3 text-[15px]',
  xl: 'rounded-xl px-10 py-[15px] text-base',
  icon: 'size-11 shrink-0 rounded-xl',
  'icon-sm': 'size-9 shrink-0 rounded-[9px]',
}

/** Large filled buttons are the screen's main action: they get the soft glow of the design. */
const ELEVATION: Partial<Record<ButtonVariant, string>> = {
  primary: 'shadow-[0_8px_24px_rgba(31,107,255,0.35)] disabled:shadow-none',
  danger: 'shadow-[0_8px_24px_rgba(217,69,43,0.35)] disabled:shadow-none',
}

export function buttonClass({ variant = 'secondary', size = 'md', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  const raised = (size === 'lg' || size === 'xl') && ELEVATION[variant]
  // Links are inline text: no box padding, just a small radius so the focus outline has a shape.
  const sized = variant === 'link' ? 'rounded-sm text-[13px]' : SIZE[size]
  return [BASE, VARIANT[variant], sized, raised || '', focusRing, className ?? ''].filter(Boolean).join(' ')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: ButtonVariant; size?: ButtonSize }

/** A shell button. type defaults to "button" so a button inside a form never submits it by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, className, type = 'button', ...rest }, ref) {
  return <button ref={ref} type={type} className={buttonClass({ variant, size, className })} {...rest} />
})
