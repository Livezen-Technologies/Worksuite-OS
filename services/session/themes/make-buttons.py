#!/usr/bin/env python3
"""Writes the Labwc title bar button images of the WorkSuite themes (issues #15, #33).

Windows 11 style, in step with the shell's own windows (shell/src/components/ShellWindow.tsx, shell/src/index.css
--ws-win-*): 46 x 32 px buttons, 10 px one-pixel glyphs, a light hover tint and a red Close on hover. Labwc picks
<button>-<active|inactive>.svg and <button>_hover-<active|inactive>.svg from the theme's labwc/ folder.
Run it after changing a colour here; tests/session/window-theme.test.sh checks the files are in step.
"""
import os
import sys

W, H = 46, 32
GLYPH = {
    'iconify': '<path d="M18 16.5h10" stroke="{fg}" stroke-width="1" fill="none"/>',
    'max': '<rect x="18.5" y="11.5" width="9" height="9" rx="1" stroke="{fg}" stroke-width="1" fill="none"/>',
    'max_toggled': '<rect x="18.5" y="13.5" width="7" height="7" rx="1" stroke="{fg}" stroke-width="1" fill="none"/>'
                   '<path d="M20.5 13.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="{fg}" stroke-width="1" fill="none"/>',
    'close': '<path d="M18.5 11.5l9 9M27.5 11.5l-9 9" stroke="{fg}" stroke-width="1" fill="none"/>',
}
THEMES = {
    'WorkSuite': {'active': '#E8EEFA', 'inactive': '#8FA3C8', 'hover': '#FFFFFF', 'hover_alpha': '0.09'},
    'WorkSuite-Light': {'active': '#0F172A', 'inactive': '#4A5B80', 'hover': '#0F172A', 'hover_alpha': '0.07'},
}
CLOSE_HOVER = '#C42B1C'


def svg(body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{body}</svg>\n'


def files(theme):
    c = THEMES[theme]
    out = {}
    for name, glyph in GLYPH.items():
        for state in ('active', 'inactive'):
            fg = c[state]
            out[f'{name}-{state}.svg'] = svg(glyph.format(fg=fg))
            if name == 'close':
                bg = f'<rect width="{W}" height="{H}" fill="{CLOSE_HOVER}"/>'
                out[f'{name}_hover-{state}.svg'] = svg(bg + glyph.format(fg='#FFFFFF'))
            else:
                bg = f'<rect width="{W}" height="{H}" fill="{c["hover"]}" fill-opacity="{c["hover_alpha"]}"/>'
                out[f'{name}_hover-{state}.svg'] = svg(bg + glyph.format(fg=fg))
    return out


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    check = '--check' in sys.argv
    stale = []
    for theme in THEMES:
        d = os.path.join(root, theme, 'labwc')
        os.makedirs(d, exist_ok=True)
        for name, text in files(theme).items():
            p = os.path.join(d, name)
            cur = open(p).read() if os.path.exists(p) else None
            if cur == text:
                continue
            if check:
                stale.append(p)
            else:
                with open(p, 'w') as f:
                    f.write(text)
    if stale:
        print('out of date (run make-buttons.py):', *stale, sep='\n  ')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
