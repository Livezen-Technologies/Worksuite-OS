// Answers come in Markdown (as on Desktop, worksuite-desktop#150): drawn as React elements, never as HTML, so a model
// can never put markup or links into the shell. Paragraphs, bullet and numbered lists, headings, **bold**, *italic*,
// `code` and fenced code blocks.
import type { ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const s = m[0]
    if (s.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{s.slice(2, -2)}</strong>)
    else if (s.startsWith('`')) out.push(<code key={`${key}-${i++}`} className="rounded bg-white/10 px-1 font-mono text-[12px]">{s.slice(1, -1)}</code>)
    else out.push(<em key={`${key}-${i++}`}>{s.slice(1, -1)}</em>)
    last = m.index + s.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!)
      i++
      blocks.push(<pre key={k++} className="m-0 overflow-x-auto rounded-lg bg-[rgba(4,10,26,0.6)] p-2.5 font-mono text-[12px] leading-[1.5]">{body.join('\n')}</pre>)
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
      const Tag = ordered ? 'ol' : 'ul'
      blocks.push(<Tag key={k++} className={`m-0 flex flex-col gap-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</Tag>)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { blocks.push(<p key={k++} className="m-0 font-semibold">{inline(h[2]!, `h${k}`)}</p>); i++; continue }
    if (!line.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^```|^\s*([-*•]|\d+[.)])\s+|^#{1,4}\s/.test(lines[i]!)) para.push(lines[i++]!)
    blocks.push(<p key={k++} className="m-0 whitespace-pre-wrap">{inline(para.join('\n'), `p${k}`)}</p>)
  }
  return <div className={`flex flex-col gap-2 ${className}`}>{blocks}</div>
}
